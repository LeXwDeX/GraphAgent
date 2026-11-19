// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Global } from "@graphagent/core/global"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectV2 } from "@graphagent/core/project"
import { ProviderV2 } from "@graphagent/core/provider"
import { GraphAgentPrompt } from "@graphagent/core/system-context/graphagent"
import { DEFAULT_WRITING_STYLE } from "@graphagent/core/system-context/writing-style"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { DagMode } from "@/dag/mode"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { SessionID } from "@/session/schema"
import { RuntimeContext } from "@/session/runtime-context"
import type { Session } from "@/session/session"
import { ToolRegistry, type ToolEntry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

// The size ratchet of what every request carries (Issue #1461): the built-in system prompts and the built-in tool
// definitions, in bytes. A measurement above its baseline, or one the baseline does not list, fails the test. The
// baseline only changes in the PR that has a reason to: a PR that makes a value smaller lowers it, a PR with an
// Issue behind a new or larger value raises it and says so in its `Behavior:` entry.
const BASELINE_PATH = path.join(import.meta.dir, "request-size-baseline.json")
const WRITE = process.env.REQUEST_SIZE_WRITE_BASELINE === "1"

// Bytes do not depend on the platform once the three environment-bound values of the shell tool are fixed; the
// baseline is nevertheless written on Linux, the platform of record.
export const UPDATE_COMMAND =
  "cd packages/graphagent && REQUEST_SIZE_WRITE_BASELINE=1 bun test --timeout 30000 test/session/request-size-ratchet.test.ts (run in a Linux container)"

type Sizes = {
  readonly prompts: Readonly<Record<string, number>>
  readonly tools: Readonly<Record<string, number>>
}
type Baseline = { readonly version: 1 } & Sizes

const PROMPT_KEYS = [
  "graphagent_edit_write",
  "graphagent_apply_patch",
  "writing_style",
  "dag_mode_system",
  "runtime_system_note",
] as const

/** The keys whose measurement is above the baseline, or that the baseline does not list; smaller values pass. */
export function compareSizes(measured: Sizes, baseline: Sizes): string[] {
  const problems: string[] = []
  for (const group of ["prompts", "tools"] as const) {
    for (const [key, size] of Object.entries(measured[group]).toSorted(([a], [b]) => a.localeCompare(b))) {
      const known = baseline[group][key]
      if (known === undefined) problems.push(`${group}.${key}: measured ${size} bytes, not in the baseline`)
      else if (size > known)
        problems.push(`${group}.${key}: measured ${size} bytes, baseline ${known} (+${size - known})`)
    }
  }
  return problems
}

const sorted = (record: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)))

function measurePrompts(): Record<string, number> {
  const size = (text: string) => Buffer.byteLength(text)
  return {
    graphagent_edit_write: size(GraphAgentPrompt.render(["edit", "write"])),
    graphagent_apply_patch: size(GraphAgentPrompt.render(["apply_patch"])),
    writing_style: size(DEFAULT_WRITING_STYLE),
    dag_mode_system: size(DagMode.SYSTEM),
    runtime_system_note: size(RuntimeContext.SYSTEM_NOTE),
  }
}

const mcpLayer = Layer.mock(MCP.Service, {
  clients: () => Effect.succeed({}),
  tools: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
  readResource: () => Effect.succeed(undefined),
})

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
  // The shell tool names its shell in its description; pin it instead of reading `$SHELL`.
  get: () => Effect.succeed({ shell: "/bin/bash" }),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
  LayerNode.replace(MCP.node, mcpLayer),
]
const it = testEffect(LayerNode.buildLayer(root, { replacements }))

/** Set the platform and the temporary directory the shell tool description carries; the result puts them back. */
function setEnvironment(platform: NodeJS.Platform, tmp: string) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  const previous = Global.Path.tmp
  Object.defineProperty(process, "platform", { ...original, value: platform })
  ;(Global.Path as { tmp: string }).tmp = tmp
  return () => {
    if (original) Object.defineProperty(process, "platform", original)
    ;(Global.Path as { tmp: string }).tmp = previous
  }
}

const withEnvironment = <A, E, R>(platform: NodeJS.Platform, tmp: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => setEnvironment(platform, tmp)),
    () => effect,
    (restore) => Effect.sync(restore),
  )

/** The shell tool description carries the platform and the temporary directory; measure it with fixed values. */
const withFixedEnvironment = <A, E, R>(effect: Effect.Effect<A, E, R>) => withEnvironment("linux", "<tmp>", effect)

const toolSize = (entry: ToolEntry) =>
  Buffer.byteLength(entry.description) + Buffer.byteLength(JSON.stringify(entry.jsonSchema))

const measureTools = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const build = yield* agents.get("build")
  if (!build) throw new Error("build agent not found")
  const directory = yield* InstanceState.directory
  const session = {
    id: SessionID.make("ses_request_size"),
    slug: "request-size",
    role: "root",
    projectID: ProjectV2.ID.global,
    directory,
    title: "request size",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  } as Session.Info
  const builtins = (model: ReturnType<typeof ProviderTest.model>) =>
    registry
      .resolve({ model, agent: build, session })
      .pipe(Effect.map((entries) => entries.filter((entry) => entry.source.kind === "builtin")))
  const tools: Record<string, number> = {}
  // `test-model` has no patch tool and `gpt-5.2` has no edit or write: the two resolutions together cover the set.
  const general = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })
  for (const entry of yield* builtins(general)) tools[entry.id] = toolSize(entry)
  for (const entry of yield* builtins(ProviderTest.model({ id: ModelV2.ID.make("gpt-5.2") })))
    if (entry.id === "apply_patch") tools[entry.id] = toolSize(entry)
  return tools
}).pipe(withFixedEnvironment)

const measure = Effect.gen(function* () {
  return { prompts: sorted(measurePrompts()), tools: sorted(yield* measureTools) } satisfies Sizes
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("request size ratchet", () => {
  it.instance("built-in system prompts and tool definitions stay within the baseline", () =>
    Effect.gen(function* () {
      const measured = yield* measure
      if (WRITE) {
        const baseline: Baseline = { version: 1, ...measured }
        yield* Effect.promise(() => Bun.write(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n"))
        return
      }
      const baseline: Baseline = yield* Effect.promise(() => Bun.file(BASELINE_PATH).json())
      expect(baseline.version).toBe(1)
      const problems = compareSizes(measured, baseline)
      if (problems.length > 0)
        throw new Error(
          [
            "The request size ratchet failed: a built-in prompt or tool definition grew, or is new.",
            ...problems.map((line) => `  ${line}`),
            "Only growth with an Issue behind it may raise the baseline; run the update command and name the keys, the",
            `old and new bytes and the Issue in the PR description's "Behavior:" entry. Update command: ${UPDATE_COMMAND}`,
          ].join("\n"),
        )
    }),
  )

  it.instance("measures the five prompts and the built-in tools", () =>
    Effect.gen(function* () {
      const measured = yield* measure
      expect(Object.keys(measured.prompts)).toEqual([...PROMPT_KEYS].toSorted())
      for (const size of Object.values(measured.prompts)) expect(size).toBeGreaterThan(0)
      expect(Object.keys(measured.tools)).toEqual(expect.arrayContaining(["read", "edit", "write", "apply_patch"]))
      for (const size of Object.values(measured.tools)) expect(size).toBeGreaterThan(0)
    }),
  )

  it.instance("measures the same bytes whatever the platform, shell and temporary directory of the machine", () =>
    Effect.gen(function* () {
      const first = yield* measure
      const previous = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      try {
        const other = yield* withEnvironment("darwin", "/a/much/longer/temporary/directory/of/another/machine", measure)
        expect(other).toEqual(first)
      } finally {
        if (previous === undefined) delete process.env.SHELL
        else process.env.SHELL = previous
      }
    }),
  )

  test("a measurement above its baseline fails and names the key, the measured and the baseline bytes", () => {
    const baseline = { prompts: { writing_style: 100 }, tools: { read: 500 } }
    const problems = compareSizes({ prompts: { writing_style: 101 }, tools: { read: 500 } }, baseline)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("prompts.writing_style")
    expect(problems[0]).toContain("101")
    expect(problems[0]).toContain("100")
  })

  test("a key the baseline does not list fails", () => {
    const baseline = { prompts: { writing_style: 100 }, tools: { read: 500 } }
    const problems = compareSizes(
      { prompts: { writing_style: 100, brand_new: 10 }, tools: { read: 500, fresh: 20 } },
      baseline,
    )
    expect(problems).toHaveLength(2)
    expect(problems.join("\n")).toContain("prompts.brand_new")
    expect(problems.join("\n")).toContain("tools.fresh")
    expect(problems.join("\n")).toContain("not in the baseline")
  })

  test("a smaller value passes, and so does a key that is no longer measured", () => {
    const baseline = { prompts: { writing_style: 100, gone: 5 }, tools: { read: 500 } }
    expect(compareSizes({ prompts: { writing_style: 40 }, tools: { read: 499 } }, baseline)).toEqual([])
    expect(compareSizes({ prompts: { writing_style: 100, gone: 5 }, tools: { read: 500 } }, baseline)).toEqual([])
  })

  test("the update command is the documented one", () => {
    expect(UPDATE_COMMAND).toContain("REQUEST_SIZE_WRITE_BASELINE=1")
    expect(UPDATE_COMMAND).toContain("test/session/request-size-ratchet.test.ts")
  })
})
