// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { AgentArtifact } from "@/agent/artifact"
import type { Subject } from "@/agent/contract"
import { ResultContract } from "@/agent/result-contract"
import { answer, valid } from "./artifact-fixtures"

function contractOf(artifact: string): ResultContract.Contract {
  const resolved = ResultContract.resolve({ contract: { output: { artifact } } })
  if (resolved.kind !== "contract") throw new Error(`expected a contract for ${artifact}`)
  return resolved.contract
}

describe("result contract of a worker", () => {
  it("resolves to nothing for an agent that declares no artifact", () => {
    expect(ResultContract.resolve({})).toEqual({ kind: "none" })
    expect(ResultContract.resolve({ contract: { role: "worker", visibility: "public" } })).toEqual({ kind: "none" })
  })

  it("resolves a declared artifact to its catalog schema, as a final response contract", () => {
    const resolved = ResultContract.resolve({ contract: { output: { artifact: "research_findings" } } })
    expect(resolved).toEqual({
      kind: "contract",
      contract: {
        kind: "final_response",
        artifact: "research_findings",
        schema: AgentArtifact.schema("research_findings")!,
      },
    })
  })

  it("owes nothing to a task call when the contract opts out with output.task false", () => {
    expect(ResultContract.resolve({ contract: { output: { artifact: "code_findings", task: false } } })).toEqual({
      kind: "none",
    })
    // The opt-out also spares the call an artifact name the catalog does not hold: the catalog diagnoses that.
    expect(ResultContract.resolve({ contract: { output: { artifact: "no_such_type", task: false } } })).toEqual({
      kind: "none",
    })
  })

  it("keeps the contract when the flag says true or says nothing", () => {
    for (const output of [{ artifact: "code_findings" }, { artifact: "code_findings", task: true }]) {
      const resolved = ResultContract.resolve({ contract: { output } })
      expect(resolved.kind).toBe("contract")
    }
  })

  it("reports an artifact the catalog does not hold, naming the agent and what is known", () => {
    expect(ResultContract.resolve({ contract: { output: { artifact: "no_such_type" } } })).toEqual({
      kind: "unknown",
      artifact: "no_such_type",
    })
    const message = ResultContract.unknownMessage("oddity", "no_such_type")
    expect(message).toContain('"oddity"')
    expect(message).toContain('"no_such_type"')
    for (const name of AgentArtifact.names()) expect(message).toContain(name)
  })

  it("tells the worker the artifact, the schema and what becomes of a miss, after the caller's own request", () => {
    const text = ResultContract.prompt(contractOf("code_findings"))
    expect(text.startsWith("\n\n[OUTPUT CONTRACT]")).toBe(true)
    expect(text).toContain('"code_findings" artifact')
    expect(text).toContain(JSON.stringify(AgentArtifact.schema("code_findings"), null, 2))
    expect(text).toContain("no Markdown fence or surrounding prose")
    expect(text).toContain("once for correction")
    expect(text).toContain("not_examined")
  })

  it("accepts exactly one JSON value that satisfies the schema", () => {
    const contract = contractOf("project_map")
    expect(ResultContract.check(answer("project_map"), contract)).toEqual({ ok: true })
    // Whitespace around the one value is not prose.
    expect(ResultContract.check(`\n  ${answer("project_map")}\n`, contract)).toEqual({ ok: true })
  })

  it("refuses what is not one JSON value: prose, a fence, two values, an empty answer", () => {
    const contract = contractOf("project_map")
    const json = answer("project_map")
    for (const text of ["The map is in packages/core.", "```json\n" + json + "\n```", `${json}\n${json}`, ""]) {
      expect(ResultContract.check(text, contract), text.slice(0, 20)).toEqual({
        ok: false,
        reason: "the final answer is not one JSON value",
      })
    }
  })

  it("names the schema violation when the value parses but is not the artifact", () => {
    const contract = contractOf("project_map")
    const missing = valid("project_map")
    delete missing.not_examined
    expect(ResultContract.check(JSON.stringify(missing), contract)).toEqual({
      ok: false,
      reason: 'missing required field: "not_examined"',
    })
    expect(ResultContract.check("[]", contract)).toMatchObject({ ok: false, reason: expect.stringContaining("object") })
    expect(ResultContract.check("null", contract)).toMatchObject({ ok: false })
  })

  it("words the correction and the failure around the artifact and the reason", () => {
    const contract = contractOf("prototype")
    const repair = ResultContract.repairPrompt(contract, 'missing required field: "evidence"')
    expect(repair).toContain('"prototype" artifact contract')
    expect(repair).toContain('missing required field: "evidence"')
    expect(repair).toContain("Do not redo the work")
    expect(repair).toContain("exactly one JSON value")
    const failure = ResultContract.failureMessage(contract, 'missing required field: "evidence"')
    expect(failure).toContain('"prototype" artifact contract')
    expect(failure).toContain("after one correction")
    expect(failure).toContain('missing required field: "evidence"')
  })
})

// #1453: explore and general answer task calls in free text. They are asked for a bounded final message in three
// sections instead of an artifact; the agents that declare their own return, or are not built in, are asked nothing.
describe("free-text return contract", () => {
  type Owed = Pick<Subject, "name" | "native" | "contract">
  // The built-in agents as `Agent` declares them: explore keeps its artifact for composed runs only.
  const explore: Owed = {
    name: "explore",
    native: true,
    contract: { role: "worker", visibility: "public", output: { artifact: "code_findings", task: false } },
  }
  const general: Owed = { name: "general", native: true }

  it("is owed by the built-in explore and general, whose task calls owe no artifact", () => {
    expect(ResultContract.owesFreeText(explore)).toBe(true)
    expect(ResultContract.owesFreeText(general)).toBe(true)
  })

  it("is not owed by review, auditor or an agent that declares an artifact for task calls", () => {
    const others: Owed[] = [
      { name: "review", native: true, contract: { role: "worker", visibility: "private" } },
      { name: "auditor", native: true, contract: { role: "worker", visibility: "public", failure: "fail" } },
      {
        name: "researcher",
        native: true,
        contract: { role: "worker", visibility: "public", output: { artifact: "research_findings" } },
      },
      { name: "build", native: true },
    ]
    for (const agent of others) expect(ResultContract.owesFreeText(agent), agent.name).toBe(false)
  })

  it("is not owed once explore or general is configured to owe an artifact to task calls", () => {
    expect(ResultContract.owesFreeText({ ...explore, contract: { output: { artifact: "code_findings" } } })).toBe(false)
    expect(
      ResultContract.owesFreeText({ ...general, contract: { output: { artifact: "research_findings", task: true } } }),
    ).toBe(false)
    // An artifact the catalog does not hold is diagnosed by the task tool; no free text is asked meanwhile.
    expect(ResultContract.owesFreeText({ ...general, contract: { output: { artifact: "no_such_type" } } })).toBe(false)
  })

  it("is not owed by an agent that is not built in, whatever its name", () => {
    expect(ResultContract.owesFreeText({ name: "explore" })).toBe(false)
    expect(ResultContract.owesFreeText({ name: "general", native: false })).toBe(false)
    expect(ResultContract.owesFreeText({ ...explore, native: false })).toBe(false)
  })

  it("is worded as three sections, in order, after the caller's own request", () => {
    expect(ResultContract.freeTextPrompt()).toBe(
      [
        "",
        "",
        "[RETURN CONTRACT] Your final message is all the caller receives; do not ask the user questions. Write exactly these sections, in order:",
        "Conclusion: the answer, at most 1200 characters.",
        'Evidence: at most 20 lines, each a path:line or a URL, optionally followed by " - " and a one-line note.',
        'Unresolved: what you did not examine or could not verify, or "none".',
      ].join("\n"),
    )
  })
})
