// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded IDs and narrow Effect service mocks exercise only the runtime surface used by these tests.
import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { DagStore } from "@graphagent/core/dag/store"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { makeNodeRow } from "./fixtures"

const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "required_actions"],
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array", items: { type: "string" } },
  },
}

const DIFF_REVIEW_SCHEMA = {
  ...REVIEW_SCHEMA,
  required: [...REVIEW_SCHEMA.required, "implementation_fingerprint"],
  properties: {
    ...REVIEW_SCHEMA.properties,
    implementation_fingerprint: { type: "string" },
  },
}

function assistant(text: string, finish = "stop"): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: "ses_final_child" as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish,
    },
    parts: [{ type: "text", text }] as never,
  }
}

const agent = Layer.mock(Agent.Service, {
  get: () =>
    Effect.succeed({
      name: "build",
      mode: "all",
      permission: [],
      options: {},
      description: "",
      prompt: "",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
      hooks: {},
    }),
})
const sessions = Layer.mock(Session.Service, {
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: () => Effect.succeed({ id: "ses_final_child" as never } as never),
})

interface TrackedEvent {
  type: "completed" | "failed"
  output?: unknown
  reason?: string
  trigger?: string
  errorClass?: string
}

interface SeenPrompt {
  sessionID: string
  text: string
  options: unknown
}

async function run(
  messages: SessionV1.WithParts | SessionV1.WithParts[],
  schema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
) {
  const queue = Array.isArray(messages) ? [...messages] : [messages]
  const events: TrackedEvent[] = []
  const prompts: SeenPrompt[] = []
  const store = {
    tryClaimAdoption: () => Effect.succeed(true),
    getNode: () =>
      Effect.succeed({
        ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
        capturedOutput: undefined,
        capturedOutputPresent: undefined,
      }),
    getWorkflow: () => Effect.succeed({ status: "running", directory: process.cwd() }),
    setCapturedOutput: () => Effect.void,
  } as unknown as DagStore.Interface
  const dag = Layer.mock(Dag.Service, {
    store,
    nodeQueued: () => Effect.void,
    nodeStarted: () => Effect.void,
    nodeCompleted: (_dagID: string, _nodeID: string, output: unknown) =>
      Effect.sync(() => {
        events.push({ type: "completed", output })
      }),
    nodeFailed: (
      _dagID: string,
      _nodeID: string,
      reason: string,
      trigger?: string,
      _attempt?: unknown,
      errorClass?: string,
    ) =>
      Effect.sync(() => {
        events.push({ type: "failed", reason, trigger, errorClass })
      }),
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    prompt: (input, options) =>
      Effect.sync(() => {
        prompts.push({
          sessionID: input.sessionID,
          text: input.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join(""),
          options,
        })
        return queue.length > 1 ? queue.shift()! : queue[0]
      }),
  })
  const provider = Layer.mock(Provider.Service, {
    getModel: () =>
      Effect.succeed({
        id: "test-model",
        providerID: "test",
        api: { id: "test-model", url: "", npm: "@ai-sdk/openai-compatible" },
        name: "Test",
        capabilities: {
          temperature: false,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128_000, output: 384_000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
      } as never),
  })
  const config = Layer.mock(Config.Service, {
    get: () =>
      Effect.succeed({
        provider: { test: { models: { "test-model": { limit: { context: 128_000, output: 384_000 } } } } },
      } as never),
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
          dagID: "wf",
          nodeID: "n",
          node: makeNodeRow({ id: "n" }),
          parentSessionID: "ses_parent",
          promptParts: [{ type: "text", text: "work" }],
          outputSchema: schema,
          ...overrides,
        })
        yield* Fiber.await(result.fiber)
      }).pipe(Effect.provide(Layer.mergeAll(dag, agent, sessions, prompt, provider, config, RuntimeFlags.layer({})))),
    ) as Effect.Effect<never>,
  )
  return { events, prompts }
}

function reviewOutput(verdict: string, summary = "complete") {
  return { verdict, summary, findings: [], required_actions: [] }
}

describe("final-response near-miss repair", () => {
  it("repairs a review PASS to ACCEPT in exactly one bounded turn without echoing the draft", async () => {
    const summary = "R".repeat(20_000)
    const result = await run(
      [
        assistant(JSON.stringify(reviewOutput("PASS", summary))),
        assistant(JSON.stringify(reviewOutput("ACCEPT", summary))),
      ],
      REVIEW_SCHEMA,
    )

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe("completed")
    expect(result.events[0]?.output).toMatchObject({ verdict: "ACCEPT" })
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts.every((prompt) => prompt.sessionID === "ses_final_child")).toBe(true)
    expect(result.prompts[1]?.text).toContain('Field "verdict"')
    expect(result.prompts[1]?.text).toContain('must be one of ["ACCEPT","REJECT"]')
    expect(result.prompts[1]?.text).toContain('got "PASS"')
    expect(result.prompts[1]?.text).not.toContain(summary)
    expect(result.prompts[1]?.text.length).toBeLessThan(600)
    expect(result.prompts[1]?.options).toMatchObject({ continueToolBudget: true, internalDelegation: true })
  })

  it("repairs a present-field type mismatch", async () => {
    const result = await run(
      [
        assistant(JSON.stringify({ ...reviewOutput("ACCEPT"), verdict: 1 })),
        assistant(JSON.stringify(reviewOutput("ACCEPT"))),
      ],
      REVIEW_SCHEMA,
    )

    expect(result.events[0]?.type).toBe("completed")
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toContain('Field "verdict"')
    expect(result.prompts[1]?.text).toContain('must have type "string"')
  })

  it("fails structurally invalid output without a repair turn", async () => {
    const result = await run(assistant(JSON.stringify({ verdict: "ACCEPT" })), REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        errorClass: "schema_invalid",
        reason: expect.stringContaining("missing required field"),
      }),
    ])
  })

  it("fails unparseable output without a repair turn", async () => {
    const result = await run(assistant("not one JSON value"), { type: "object" })

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        errorClass: "schema_invalid",
        reason: expect.stringContaining("one JSON value"),
      }),
    ])
  })

  it("fails a root type mismatch without a repair turn", async () => {
    const result = await run(assistant(JSON.stringify({ verdict: "PASS" })), { type: "string" })

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        errorClass: "schema_invalid",
        reason: expect.stringContaining('expected type "string"'),
      }),
    ])
  })

  it("spends at most one repair turn when the correction still misses", async () => {
    const pass = JSON.stringify(reviewOutput("PASS"))
    const result = await run([assistant(pass), assistant(pass)], REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(2)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        errorClass: "schema_invalid",
        reason: expect.stringContaining('expected one of ["ACCEPT","REJECT"], got "PASS"'),
      }),
    ])
  })

  it("keeps a genuine review-contract failure in verdict_fail", async () => {
    const result = await run(
      assistant(
        JSON.stringify({
          ...reviewOutput("ACCEPT"),
          implementation_fingerprint: "sha256:stale",
        }),
      ),
      DIFF_REVIEW_SCHEMA,
      { reviewImplementationFingerprint: "sha256:current" },
    )

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        reason: expect.stringContaining("fingerprint"),
      }),
    ])
  })
})
