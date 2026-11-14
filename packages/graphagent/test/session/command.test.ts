// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M1: /dag-mode dispatch, receipt shape and argument grammar.
//
// The command body is exercised with stubbed dependencies: these tests pin the
// exchange the TUI renders (two ignored parts, one localized receipt) and the
// state writes, not the session/database stack (covered by session.test.ts).
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { makeCommand, parseDagModeCommand, type CommandDeps } from "@/session/command"
import { SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_dag_mode_command")
const model = { providerID: "test", modelID: "test-model" }

// The command body reads a small slice of each dependency; a full layer graph
// would test the session/database stack instead of the receipt contract.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- partial test double
const asDeps = (value: Record<string, unknown>) => value as unknown as CommandDeps

function harness(overrides: {
  parentID?: string
  arguments: string
  mode?: "on" | "off"
  budget?: number | null
}) {
  const info = {
    id: sessionID,
    parentID: overrides.parentID,
    agent: "build",
    dagMode: overrides.mode ?? "off",
    dagBudgetTokens: overrides.budget ?? null,
    permission: [],
  }
  const parts: SessionV1.Part[] = []
  const state = { mode: info.dagMode, budget: info.dagBudgetTokens }
  const deps = asDeps({
    sessions: {
      get: () => Effect.succeed(info),
      updateMessage: (message: SessionV1.Info) => Effect.succeed(message),
      updatePart: (part: SessionV1.Part) => {
        parts.push(part)
        return Effect.succeed(part)
      },
      touch: () => Effect.void,
      setDagMode: (input: { mode: "on" | "off" }) => {
        state.mode = input.mode
        return Effect.void
      },
      setDagBudget: (input: { tokens: number | null }) => {
        state.budget = input.tokens
        return Effect.void
      },
    },
    agents: {
      defaultAgent: () => Effect.succeed("build"),
      get: () => Effect.succeed(undefined),
      defaultInfo: () => Effect.succeed({ name: "build", mode: "primary" }),
      list: () => Effect.succeed([{ name: "worker", mode: "subagent" }]),
      permissionPolicy: () => Effect.succeed({ native: [], rules: [] }),
    },
    config: { get: () => Effect.succeed({}), dagGlobal: () => Effect.succeed({ concurrency: 3, max_total_nodes: 40 }) },
    events: { publish: () => Effect.void },
    commands: {
      get: () => Effect.succeed({ name: "dag-mode", template: "", hints: ["$ARGUMENTS"] }),
      list: () => Effect.succeed([]),
    },
    prepareFns: {
      currentModel: () => Effect.succeed(model),
      modelSelection: () => Effect.succeed({}),
    },
    providers: {
      defaultModel: () => Effect.succeed(model),
      getModel: () => Effect.succeed({ capabilities: { toolcall: true } }),
    },
    dagStore: { listBySession: () => Effect.succeed([]), getNodes: () => Effect.succeed([]) },
    scheduler: {
      capacity: () =>
        Effect.succeed({
          children: { running: 0, cap: 4, dagRunning: 1, dagCap: 2 },
          requests: { inflight: 0, cap: 4 },
          providers: {},
          laneQueued: {},
        }),
    },
    state: { startIfIdle: () => Effect.succeed(Option.none()) },
    withRunRequest: (_sessionID: SessionID, use: (request: unknown, witness: unknown) => Effect.Effect<unknown>) =>
      use({ valid: () => true }, {}),
    withPromptLock: (
      _witness: unknown,
      _sessionID: SessionID,
      use: (witness: unknown) => Effect.Effect<unknown>,
    ) => use({}),
    lastAssistant: () => Effect.succeed({ info: {}, parts: [] }),
    budgetState: () => Effect.succeed({ pending: new Map() }),
    modelWriteBegin: () => ({ epoch: 0, release: () => {} }),
  })
  const command = makeCommand(deps).command
  return {
    state,
    run: () =>
      Effect.runPromise(
        command({ sessionID, command: "dag-mode", arguments: overrides.arguments, agent: "build" }, { skipHookStart: true }),
      ),
    parts,
  }
}

const textParts = (result: SessionV1.WithParts): SessionV1.TextPart[] =>
  result.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

describe("parseDagModeCommand", () => {
  test("parses the four verbs and the budget forms", () => {
    expect(parseDagModeCommand("on")).toEqual({ kind: "on" })
    expect(parseDagModeCommand("off")).toEqual({ kind: "off" })
    expect(parseDagModeCommand("status")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("budget 1200")).toEqual({ kind: "budget", tokens: 1200 })
    expect(parseDagModeCommand("budget off")).toEqual({ kind: "budget", tokens: null })
  })

  test("unknown or malformed arguments fall back to status", () => {
    expect(parseDagModeCommand("")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("what")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("budget")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("budget 0")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("budget -5")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("budget 1.5")).toEqual({ kind: "status" })
    expect(parseDagModeCommand("on now")).toEqual({ kind: "status" })
  })
})

describe("/dag-mode exchange", () => {
  test("on writes the mode and returns an ignored receipt", async () => {
    const test = harness({ arguments: "on" })
    const result = await test.run()
    const [command, receipt] = textParts(result)

    expect(test.state.mode).toBe("on")
    expect(command?.ignored).toBe(true)
    expect(command?.metadata).toEqual({ command: "dag-mode" })
    expect(receipt?.ignored).toBe(true)
    expect(receipt?.synthetic).toBeUndefined()
    expect(receipt?.time?.end).toBeDefined()
    const metadata = receipt?.metadata
    expect(metadata?.["command"]).toBe("dag-mode")
    expect(metadata?.["receipt"]?.kind).toBe("on")
    expect(metadata?.["receipt"]?.values?.cap).toBe(2)
    expect(metadata?.["receipt"]?.values?.nodes).toBe(40)
    expect(metadata?.["receipt"]?.values?.noBudget).toBe(true)
  })

  test("off reports the running workflow count", async () => {
    const test = harness({ arguments: "off", mode: "on" })
    const result = await test.run()
    const receipt = textParts(result)[1]
    expect(test.state.mode).toBe("off")
    expect(receipt?.metadata?.["receipt"]?.kind).toBe("off")
    expect(receipt?.metadata?.["receipt"]?.values?.n).toBe(0)
  })

  test("budget sets the token limit and reports the budget receipt", async () => {
    const test = harness({ arguments: "budget 900" })
    const result = await test.run()
    const receipt = textParts(result)[1]
    expect(test.state.budget).toBe(900)
    expect(receipt?.metadata?.["receipt"]).toEqual({ kind: "budget", values: { N: 900, k: 0 } })
  })

  test("status reports the current mode without writing it", async () => {
    const test = harness({ arguments: "", mode: "on" })
    const result = await test.run()
    const receipt = textParts(result)[1]
    expect(test.state.mode).toBe("on")
    const metadata = receipt?.metadata
    expect(metadata?.["receipt"]?.kind).toBe("status")
    expect(metadata?.["receipt"]?.values?.state).toBe("on")
    expect(metadata?.["receipt"]?.values?.running).toBe(1)
  })

  test("a child session gets an ignored explanation and no receipt", async () => {
    const test = harness({ arguments: "on", parentID: "ses_parent" })
    const result = await test.run()
    const [command, receipt] = textParts(result)
    expect(test.state.mode).toBe("off")
    expect(command?.ignored).toBe(true)
    expect(receipt?.ignored).toBe(true)
    expect(receipt?.metadata).toBeUndefined()
    expect(receipt?.text).toContain("主会话")
  })
})