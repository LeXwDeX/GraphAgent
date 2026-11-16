// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { AgentArtifact } from "@/agent/artifact"
import { AgentContract } from "@/agent/contract"
import { ConfigParse } from "@/config/parse"
import { Permission } from "@/permission"
import { ConfigAgentV1 } from "@graphagent/core/v1/config/agent"
import { ConfigErrorV1 } from "@graphagent/core/v1/config/error"

// Rulesets are built the way the built-in agents build theirs: the defaults
// first, then the role's own rules, then whatever the user adds last.
const open = Permission.fromConfig({ "*": "allow" })
const readOnlyRules = Permission.merge(
  open,
  Permission.fromConfig({ "*": "deny", read: "allow", grep: "allow", glob: "allow", bash: "allow" }),
)
const planRules = Permission.merge(
  open,
  Permission.fromConfig({ edit: { "*": "deny", ".agents/plans/*.md": "allow" } }),
)

const agent = (
  name: string,
  options: {
    permission?: typeof open
    contract?: AgentContract.Declared
    native?: boolean
  } = {},
): AgentContract.Subject => ({
  name,
  native: options.native ?? false,
  permission: options.permission ?? readOnlyRules,
  ...(options.contract ? { contract: options.contract } : {}),
})

const compose = (dispatch: string[], fallback: string): NonNullable<AgentContract.Declared["compose"]> => ({
  pattern: "fan_out",
  dispatch,
  fallback,
})

describe("isWriterAgent", () => {
  test("an agent whose rules leave edit open is a writer", () => {
    expect(AgentContract.isWriterAgent(agent("build", { permission: open }))).toBe(true)
  })

  test("denying edit for every path makes an agent read-only", () => {
    expect(AgentContract.isWriterAgent(agent("explore"))).toBe(false)
    expect(
      AgentContract.isWriterAgent(
        agent("denied", { permission: Permission.merge(open, Permission.fromConfig({ edit: "deny" })) }),
      ),
    ).toBe(false)
  })

  test("a blanket deny followed by a user edit allow re-opens the file tools", () => {
    // `edit`, `write` and `apply_patch` share the `edit` key, so one allow is enough. The writer
    // catalog used to probe a retired `patch` key, which the blanket `*` deny kept disabled: an
    // agent like this one was read as read-only there.
    const overridden = Permission.merge(readOnlyRules, Permission.fromConfig({ edit: "allow" }))
    expect(AgentContract.isWriterAgent(agent("explore", { permission: overridden }))).toBe(true)
  })

  test("plan keeps a plan-file allow list and is read-only by profile", () => {
    expect(AgentContract.isWriterAgent(agent("plan", { permission: planRules }))).toBe(false)
    // The exemption is the plan profile, not the allow-list shape: another agent with the same rules is a writer.
    expect(AgentContract.isWriterAgent(agent("custom-planner", { permission: planRules }))).toBe(true)
  })
})

describe("effective", () => {
  test("an agent without a contract is a private worker", () => {
    expect(AgentContract.effective(agent("explore"))).toEqual({
      role: "worker",
      visibility: "private",
      failure: "skip",
    })
  })

  test("failure defaults to fail for a writer and skip for a read-only agent", () => {
    expect(AgentContract.effective(agent("build", { permission: open })).failure).toBe("fail")
    expect(AgentContract.effective(agent("explore")).failure).toBe("skip")
  })

  test("a declared failure wins over the derived default", () => {
    expect(AgentContract.effective(agent("auditor", { contract: { failure: "fail" } })).failure).toBe("fail")
    expect(AgentContract.effective(agent("build", { permission: open, contract: { failure: "skip" } })).failure).toBe(
      "skip",
    )
  })

  test("a read-only agent keeps the visibility it declares", () => {
    expect(AgentContract.effective(agent("explore", { contract: { visibility: "public" } })).visibility).toBe("public")
    expect(AgentContract.effective(agent("review", { contract: { visibility: "private" } })).visibility).toBe("private")
  })

  test("a writer that declares public is treated as private", () => {
    const writer = agent("builder", { permission: open, contract: { visibility: "public" } })
    expect(AgentContract.effective(writer).visibility).toBe("private")
  })

  test("role, output and compose pass through", () => {
    const declared = {
      role: "composer",
      visibility: "private",
      output: { artifact: "survey_report" },
      compose: compose(["explore"], "explore"),
    } satisfies AgentContract.Declared
    // The task flag is a default the effective view fills: on.
    expect(AgentContract.effective(agent("surveyor", { contract: declared }))).toEqual({
      role: "composer",
      visibility: "private",
      failure: "skip",
      output: { artifact: "survey_report", task: true },
      compose: compose(["explore"], "explore"),
    })
  })

  test("an artifact is owed to task calls unless the contract says output.task is false", () => {
    const outputOf = (output: NonNullable<AgentContract.Declared["output"]>) =>
      AgentContract.effective(agent("worker", { contract: { output } })).output
    expect(outputOf({ artifact: "code_findings" })).toEqual({ artifact: "code_findings", task: true })
    expect(outputOf({ artifact: "code_findings", task: true })).toEqual({ artifact: "code_findings", task: true })
    expect(outputOf({ artifact: "code_findings", task: false })).toEqual({ artifact: "code_findings", task: false })
    // No artifact, nothing owed.
    expect(AgentContract.effective(agent("worker")).output).toBeUndefined()
  })

  test("taskArtifact names what a task call owes: the declared artifact, unless the agent opts out", () => {
    const owed = (contract?: AgentContract.Declared) => AgentContract.taskArtifact(agent("worker", { contract }))
    expect(owed()).toBeUndefined()
    expect(owed({ role: "worker" })).toBeUndefined()
    expect(owed({ output: { artifact: "research_findings" } })).toBe("research_findings")
    expect(owed({ output: { artifact: "research_findings", task: true } })).toBe("research_findings")
    expect(owed({ output: { artifact: "code_findings", task: false } })).toBeUndefined()
    // The flag is read from the declaration alone: it needs no rules to be evaluated.
    expect(AgentContract.taskArtifact({ contract: { output: { artifact: "code_findings" } } })).toBe("code_findings")
  })

  test("isComposer reads the declared role without evaluating rules", () => {
    expect(AgentContract.isComposer(agent("surveyor", { contract: { role: "composer" } }))).toBe(true)
    expect(AgentContract.isComposer(agent("explore"))).toBe(false)
    expect(AgentContract.isComposer(agent("explore", { contract: { role: "worker" } }))).toBe(false)
  })
})

describe("merge", () => {
  test("inherits the base contract and rewrites it field by field", () => {
    const base = { role: "worker", visibility: "public" } satisfies AgentContract.Declared
    expect(AgentContract.merge(base, { failure: "fail" })).toEqual({
      role: "worker",
      visibility: "public",
      failure: "fail",
    })
    expect(AgentContract.merge(base, { visibility: "private" })).toEqual({ role: "worker", visibility: "private" })
  })

  test("compose is replaced as a unit, never merged field by field", () => {
    const base = { role: "composer", compose: compose(["explore", "researcher"], "researcher") } as const
    const merged = AgentContract.merge(base, { compose: compose(["explore"], "explore") })
    expect(merged?.compose).toEqual(compose(["explore"], "explore"))
  })

  test("output is replaced as a unit, the task flag with it", () => {
    const base = { output: { artifact: "code_findings", task: false } } satisfies AgentContract.Declared
    // Restating the artifact without the flag drops the opt-out: the default, owed to task calls, applies again.
    expect(AgentContract.merge(base, { output: { artifact: "code_findings" } })?.output).toEqual({
      artifact: "code_findings",
    })
    expect(AgentContract.merge(base, { output: { artifact: "project_map", task: true } })?.output).toEqual({
      artifact: "project_map",
      task: true,
    })
    // An override that says nothing about output keeps the opt-out.
    expect(AgentContract.merge(base, { failure: "fail" })?.output).toEqual({ artifact: "code_findings", task: false })
  })

  test("a missing side keeps the other and does not mutate its inputs", () => {
    const base = { role: "worker", visibility: "public" } satisfies AgentContract.Declared
    expect(AgentContract.merge(undefined, undefined)).toBeUndefined()
    expect(AgentContract.merge(base, undefined)).toEqual(base)
    expect(AgentContract.merge(undefined, { failure: "skip" })).toEqual({ failure: "skip" })
    AgentContract.merge(base, { failure: "fail" })
    expect(base).toEqual({ role: "worker", visibility: "public" })
  })
})

describe("composerAvailability", () => {
  const publicReadOnly = (name: string) => agent(name, { contract: { role: "worker", visibility: "public" } })
  const composer = (dispatch: string[], fallback: string) =>
    agent("surveyor", {
      contract: { role: "composer", visibility: "private", compose: compose(dispatch, fallback) },
    })

  test("is available when the dispatch list holds expandable agents", () => {
    const catalog = [
      composer(["explore", "researcher", "build", "ghost", "scratch"], "researcher"),
      publicReadOnly("explore"),
      publicReadOnly("researcher"),
      agent("build", { permission: open, contract: { visibility: "public" } }),
      agent("scratch"),
    ]
    expect(AgentContract.composerAvailability(catalog, "surveyor")).toEqual({
      available: true,
      dispatch: ["explore", "researcher"],
    })
  })

  test("is unavailable when no dispatch entry can be expanded", () => {
    const catalog = [
      composer(["explore", "ghost", "scratch"], "explore"),
      agent("explore", {
        native: true,
        permission: Permission.merge(readOnlyRules, Permission.fromConfig({ edit: "allow" })),
        contract: { role: "worker", visibility: "public" },
      }),
      agent("scratch"),
    ]
    const result = AgentContract.composerAvailability(catalog, "surveyor")
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain("surveyor")
    // Every entry names itself and its own reason; the override reads like the Issue's example.
    expect(result.reason).toContain('"explore" was overridden to allow writing files')
    expect(result.reason).toContain("public read-only")
    expect(result.reason).toContain('"ghost" does not exist')
    expect(result.reason).toContain('"scratch" is not public')
  })

  test("is unavailable when the fallback cannot be expanded", () => {
    const catalog = [composer(["explore", "scratch"], "scratch"), publicReadOnly("explore"), agent("scratch")]
    const result = AgentContract.composerAvailability(catalog, "surveyor")
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('fallback "scratch"')
    expect(result.reason).toContain('"scratch" is not public')
  })

  test("is unavailable when the fallback is not part of the dispatch list", () => {
    const catalog = [composer(["explore"], "researcher"), publicReadOnly("explore"), publicReadOnly("researcher")]
    const result = AgentContract.composerAvailability(catalog, "surveyor")
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('fallback "researcher" is not listed in dispatch')
  })

  test("is unavailable without a compose block", () => {
    const result = AgentContract.composerAvailability(
      [agent("surveyor", { contract: { role: "composer" } })],
      "surveyor",
    )
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain("declares no compose block")
  })

  test("a composer cannot be dispatched by another composer", () => {
    const catalog = [
      composer(["mapper"], "mapper"),
      agent("mapper", {
        contract: { role: "composer", visibility: "public", compose: compose(["explore"], "explore") },
      }),
    ]
    const result = AgentContract.composerAvailability(catalog, "surveyor")
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('"mapper" is a composer')
  })

  test("names that are missing or not composers are reported as such", () => {
    const catalog = [publicReadOnly("explore")]
    const missing = AgentContract.composerAvailability(catalog, "surveyor")
    expect(missing).toEqual({ available: false, reason: 'agent "surveyor" does not exist' })
    const worker = AgentContract.composerAvailability(catalog, "explore")
    expect(worker).toEqual({ available: false, reason: 'agent "explore" is not a composer' })
  })
})

describe("diagnose", () => {
  test("a catalog without problems has no diagnostics", () => {
    const catalog = [
      agent("explore", { native: true, contract: { visibility: "public" } }),
      agent("build", { native: true, permission: open }),
    ]
    expect(AgentContract.diagnose(catalog)).toEqual([])
  })

  test("reports a public agent whose rules allow writing, naming the agent and the cause", () => {
    const overridden = agent("explore", {
      native: true,
      permission: Permission.merge(readOnlyRules, Permission.fromConfig({ edit: "allow" })),
      contract: { role: "worker", visibility: "public" },
    })
    const diagnostics = AgentContract.diagnose([overridden])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.agent).toBe("explore")
    expect(diagnostics[0]?.code).toBe("public_writable")
    expect(diagnostics[0]?.message).toContain('"explore" was overridden to allow writing files')
    expect(diagnostics[0]?.message).toContain("treated as private")
  })

  test("a custom agent gets the declared-versus-effective wording", () => {
    const diagnostics = AgentContract.diagnose([
      agent("builder", { permission: open, contract: { visibility: "public" } }),
    ])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.message).toContain('"builder"')
    expect(diagnostics[0]?.message).toContain("treated as private")
    expect(diagnostics[0]?.message).not.toContain("overridden")
  })

  test("reports an unavailable composer once, with the reason", () => {
    const diagnostics = AgentContract.diagnose([
      agent("surveyor", {
        contract: { role: "composer", compose: compose(["ghost"], "ghost") },
      }),
    ])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.agent).toBe("surveyor")
    expect(diagnostics[0]?.code).toBe("composer_unavailable")
    expect(diagnostics[0]?.message).toContain('composer "surveyor" is unavailable')
    expect(diagnostics[0]?.message).toContain('"ghost" does not exist')
  })

  test("reports an output artifact the catalog does not hold, naming the agent and the artifact", () => {
    const diagnostics = AgentContract.diagnose([
      agent("oddity", { contract: { output: { artifact: "no_such_type" } } }),
    ])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.agent).toBe("oddity")
    expect(diagnostics[0]?.code).toBe("artifact_unknown")
    expect(diagnostics[0]?.message).toContain('agent "oddity"')
    expect(diagnostics[0]?.message).toContain('"no_such_type"')
    // It says what the catalog does hold, so the fix is a lookup away.
    for (const name of AgentArtifact.names()) expect(diagnostics[0]?.message).toContain(name)
  })

  test("an artifact the catalog holds is no diagnostic, and opting out of task calls does not hide an unknown one", () => {
    expect(
      AgentContract.diagnose([agent("scribe", { contract: { output: { artifact: "project_map", task: false } } })]),
    ).toEqual([])
    // A composed run reads the same declaration, so an unknown type is wrong whether or not task calls owe it.
    const diagnostics = AgentContract.diagnose([
      agent("scribe", { contract: { output: { artifact: "no_such_type", task: false } } }),
    ])
    expect(diagnostics.map((item) => [item.agent, item.code])).toEqual([["scribe", "artifact_unknown"]])
  })

  test("reports each problem of one agent, ordered by code", () => {
    const diagnostics = AgentContract.diagnose([
      agent("builder", { permission: open, contract: { visibility: "public", output: { artifact: "no_such_type" } } }),
    ])
    expect(diagnostics.map((item) => item.code)).toEqual(["artifact_unknown", "public_writable"])
  })

  test("is ordered by agent name so repeated builds log the same lines", () => {
    const diagnostics = AgentContract.diagnose([
      agent("zeta", { permission: open, contract: { visibility: "public" } }),
      agent("alpha", { permission: open, contract: { visibility: "public" } }),
    ])
    expect(diagnostics.map((item) => item.agent)).toEqual(["alpha", "zeta"])
  })
})

describe("config schema", () => {
  const parse = (input: unknown) => ConfigParse.schema(ConfigAgentV1.Info, input, "agent.test.json")

  test("accepts a partial contract and keeps the key out of options", () => {
    const parsed = parse({ contract: { visibility: "private" }, description: "x" })
    expect(parsed.contract).toEqual({ visibility: "private" })
    expect(parsed.options).not.toHaveProperty("contract")
  })

  test("accepts a complete composer declaration", () => {
    const parsed = parse({
      contract: {
        role: "composer",
        visibility: "private",
        output: { artifact: "survey_report" },
        failure: "fail",
        compose: { pattern: "recursive_split", dispatch: ["explore"], fallback: "explore" },
      },
    })
    expect(parsed.contract?.compose).toEqual({ pattern: "recursive_split", dispatch: ["explore"], fallback: "explore" })
  })

  const rejected = (input: unknown) => {
    try {
      parse(input)
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigErrorV1.InvalidError)
      return JSON.stringify(error instanceof ConfigErrorV1.InvalidError ? error.data : error)
    }
    throw new Error("expected the agent config to be rejected")
  }

  test("accepts the task flag on an output, and rejects anything but a boolean there", () => {
    expect(parse({ contract: { output: { artifact: "code_findings", task: false } } }).contract?.output).toEqual({
      artifact: "code_findings",
      task: false,
    })
    expect(parse({ contract: { output: { artifact: "code_findings" } } }).contract?.output).toEqual({
      artifact: "code_findings",
    })
    rejected({ contract: { output: { artifact: "code_findings", task: "no" } } })
    // The flag qualifies an artifact; it cannot stand alone.
    rejected({ contract: { output: { task: false } } })
  })

  test("rejects a fallback that is not part of dispatch", () => {
    const message = rejected({
      contract: { role: "composer", compose: { pattern: "fan_out", dispatch: ["explore"], fallback: "researcher" } },
    })
    expect(message).toContain("fallback")
    expect(message).toContain("dispatch")
  })

  test("rejects an empty dispatch list, since no fallback can belong to it", () => {
    rejected({ contract: { role: "composer", compose: { pattern: "fan_out", dispatch: [], fallback: "explore" } } })
  })

  test("rejects a compose block that is missing fields", () => {
    rejected({ contract: { role: "composer", compose: { pattern: "fan_out", dispatch: ["explore"] } } })
    rejected({ contract: { role: "composer", compose: { dispatch: ["explore"], fallback: "explore" } } })
  })

  test("rejects values outside the fixed vocabularies", () => {
    rejected({ contract: { role: "orchestrator" } })
    rejected({ contract: { visibility: "internal" } })
    rejected({ contract: { failure: "ignore" } })
    rejected({
      contract: { role: "composer", compose: { pattern: "pipeline", dispatch: ["explore"], fallback: "explore" } },
    })
  })
})
