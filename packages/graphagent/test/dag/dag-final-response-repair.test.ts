// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded IDs and narrow Effect service mocks exercise only the runtime surface used by these tests.
import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { DagStore } from "@graphagent/core/dag/store"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { makeNodeRow } from "./fixtures"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

/** The per-workflow child-run schedule the loop hands to `spawnNode`. */
const spawnSchedule = <T extends { readonly dagID: string }>(input: T, cap: number) => ({
  limit: { kind: "workflow" as const, workflowID: input.dagID },
  cap,
})

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
  const prompt = mockSessionPrompt({
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
        const input: NodeSpawnInput = {
          dagID: "wf",
          nodeID: "n",
          node: makeNodeRow({ id: "n" }),
          parentSessionID: "ses_parent",
          promptParts: [{ type: "text", text: "work" }],
          outputSchema: schema,
          ...overrides,
        }
        const result = yield* spawnNode(spawnSchedule(input, 1), input)
        yield* Fiber.await(result.fiber)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            dag,
            agent,
            sessions,
            prompt,
            provider,
            config,
            RuntimeFlags.layer({}),
            AgentScheduler.defaultLayer,
          ),
        ),
      ),
    ) as Effect.Effect<never>,
  )
  return { events, prompts }
}

function reviewOutput(verdict: string, summary = "complete") {
  return { verdict, summary, findings: [], required_actions: [] }
}

const CORRECTION_TAIL =
  "Do not redo the work. Resubmit the same result as exactly one JSON value, with no Markdown fence and no surrounding prose."

describe("final-response correction turn", () => {
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

  it("gives a missing required field one correction turn", async () => {
    const result = await run(
      [assistant(JSON.stringify({ verdict: "ACCEPT" })), assistant(JSON.stringify(reviewOutput("ACCEPT")))],
      REVIEW_SCHEMA,
    )

    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.sessionID).toBe("ses_final_child")
    expect(result.prompts[1]?.text).toBe(`Your final response was rejected: missing required field: "summary". ${CORRECTION_TAIL}`)
    expect(result.prompts[1]?.options).toMatchObject({ continueToolBudget: true, internalDelegation: true })
  })

  it("gives a Markdown fence around the JSON one correction turn", async () => {
    const fenced = "```json\n" + JSON.stringify(reviewOutput("ACCEPT")) + "\n```"
    const result = await run([assistant(fenced), assistant(JSON.stringify(reviewOutput("ACCEPT")))], REVIEW_SCHEMA)

    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toBe(
      `Your final response was rejected: the final response is not exactly one JSON value. ${CORRECTION_TAIL}`,
    )
  })

  it("gives prose around the JSON one correction turn", async () => {
    const result = await run(
      [assistant(`Here is the review: ${JSON.stringify(reviewOutput("ACCEPT"))}`), assistant(JSON.stringify(reviewOutput("ACCEPT")))],
      REVIEW_SCHEMA,
    )

    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.prompts).toHaveLength(2)
  })

  it("gives an unexpected additional property one correction turn", async () => {
    const strict = { ...REVIEW_SCHEMA, additionalProperties: false }
    const result = await run(
      [assistant(JSON.stringify({ ...reviewOutput("ACCEPT"), extra: 1 })), assistant(JSON.stringify(reviewOutput("ACCEPT")))],
      strict,
    )

    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toContain('unexpected additional property: "extra"')
  })

  it("gives an array item of the wrong type one correction turn", async () => {
    const result = await run(
      [
        assistant(JSON.stringify({ ...reviewOutput("ACCEPT"), required_actions: ["fine", 7] })),
        assistant(JSON.stringify(reviewOutput("ACCEPT"))),
      ],
      REVIEW_SCHEMA,
    )

    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toContain("item[1]")
  })

  it("gives a root type mismatch one correction turn", async () => {
    const result = await run([assistant(JSON.stringify({ verdict: "PASS" })), assistant(JSON.stringify("done"))], {
      type: "string",
    })

    expect(result.events).toEqual([expect.objectContaining({ type: "completed", output: "done" })])
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toContain('expected type "string"')
  })

  it("fails a structural miss as schema_invalid when the one correction still misses", async () => {
    const result = await run(assistant(JSON.stringify({ verdict: "ACCEPT" })), REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(2)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        errorClass: "schema_invalid",
        reason: expect.stringContaining("missing required field"),
      }),
    ])
  })

  it("fails unparseable output as schema_invalid when the one correction still misses", async () => {
    const result = await run(assistant("not one JSON value"), { type: "object" })

    expect(result.prompts).toHaveLength(2)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        errorClass: "schema_invalid",
        reason: expect.stringContaining("one JSON value"),
      }),
    ])
  })

  it("fails a root type mismatch as schema_invalid when the one correction still misses", async () => {
    const result = await run(assistant(JSON.stringify({ verdict: "PASS" })), { type: "string" })

    expect(result.prompts).toHaveLength(2)
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

  it("does not correct empty output and leaves it unclassified", async () => {
    const result = await run(assistant(""), REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({ type: "failed", trigger: "verdict_fail", reason: "provider returned empty output" }),
    ])
    expect(result.events[0]?.errorClass).toBeUndefined()
  })

  it("does not correct a turn that did not end normally and leaves it unclassified", async () => {
    const result = await run(assistant("working on it", "tool-calls"), REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        reason: "child model turn did not end normally (tool-calls)",
      }),
    ])
    expect(result.events[0]?.errorClass).toBeUndefined()
  })

  it("leaves a correction turn that comes back empty unclassified", async () => {
    const result = await run([assistant(JSON.stringify({ verdict: "ACCEPT" })), assistant("")], REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(2)
    expect(result.events).toEqual([expect.objectContaining({ type: "failed", reason: "provider returned empty output" })])
    expect(result.events[0]?.errorClass).toBeUndefined()
  })

  it("reports a correction turn that ends at the output cap as the cap, not as schema_invalid", async () => {
    const pass = JSON.stringify(reviewOutput("PASS"))
    const result = await run([assistant(pass), assistant(pass, "length")], REVIEW_SCHEMA)

    expect(result.prompts).toHaveLength(2)
    expect(result.events).toEqual([expect.objectContaining({ type: "failed", trigger: "verdict_fail" })])
    expect(result.events[0]?.reason).toContain("output token cap")
    expect(result.events[0]?.errorClass).toBeUndefined()
  })

  it("neither corrects nor classifies a failure of the validation facility", async () => {
    // Catastrophic backtracking exceeds the worker's host budget: the validator, not the model, failed.
    const result = await run(assistant(JSON.stringify("a".repeat(99_999) + "!")), {
      type: "string",
      pattern: "^(a|a?)+$",
    })

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        reason: expect.stringContaining("host resource budget"),
      }),
    ])
    expect(result.events[0]?.errorClass).toBeUndefined()
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

// #1556: a block review decision whose dispositions contradict its lanes is the model's to correct, once.
describe("review decision correction turn", () => {
  const DECISION_SCHEMA = {
    ...DIFF_REVIEW_SCHEMA,
    required: [...DIFF_REVIEW_SCHEMA.required, "dispositions", "resolved"],
    properties: { ...DIFF_REVIEW_SCHEMA.properties, dispositions: { type: "array" }, resolved: { type: "array" } },
  }
  // The lane reaches the decision under the key `intent_review`, never under its node id.
  const lanes = [
    { nodeID: "decision--intent", output: { verdict: "REJECT", required_actions: ["Fix A"] }, keys: ["intent_review"] },
  ]
  const arbitration = {
    verdictEvidence: lanes,
    reviewArbitration: true as const,
    reviewImplementationFingerprint: "sha256:current",
  }
  const entry = (node: string, index = 0) => ({
    node,
    index,
    novelty: "new",
    decision: "upheld",
    evidence: "reproduced",
  })
  const decision = (dispositions: unknown[], extra: Record<string, unknown> = {}) =>
    assistant(
      JSON.stringify({
        verdict: "REJECT",
        summary: "REJECT",
        findings: [],
        required_actions: ["Fix A"],
        implementation_fingerprint: "sha256:current",
        dispositions,
        resolved: [],
        ...extra,
      }),
    )
  const MISSING = "dispositions miss lane required action(s): decision--intent[0]"

  it("completes in one turn when the decision names its lane by the key it was shown, and stores the node id", async () => {
    const result = await run(decision([entry("intent_review")]), DECISION_SCHEMA, arbitration)

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.events[0]?.output).toMatchObject({ dispositions: [{ node: "decision--intent", index: 0 }] })
  })

  it("gives a decision that contradicts its lanes one correction turn that carries the error text", async () => {
    const result = await run([decision([]), decision([entry("intent_review")])], DECISION_SCHEMA, arbitration)

    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.sessionID).toBe("ses_final_child")
    expect(result.prompts[1]?.text).toBe(
      `Your final response was rejected: ${MISSING}. Do not redo the work. Correct exactly what is listed and resubmit the full result as exactly one JSON value, with no Markdown fence and no surrounding prose.`,
    )
    expect(result.prompts[1]?.options).toMatchObject({ continueToolBudget: true, internalDelegation: true })
    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])
    expect(result.events[0]?.output).toMatchObject({ dispositions: [{ node: "decision--intent", index: 0 }] })
  })

  it("quotes every error of the contract and bounds the text it quotes", async () => {
    const result = await run(
      [
        decision([entry("somewhere_else", 0)], { resolved: [{ ref: "x", how: "fixed", evidence: "e" }] }),
        decision([entry("decision--intent")]),
      ],
      DECISION_SCHEMA,
      arbitration,
    )

    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toContain(MISSING)
    expect(result.prompts[1]?.text).toContain("dispositions name unknown lane required action(s): somewhere_else[0]")
    expect(result.prompts[1]?.text).toContain("resolved names ref(s) that are not prior findings: x")
    expect(result.events).toEqual([expect.objectContaining({ type: "completed" })])

    const many = Array.from({ length: 400 }, (_, index) => entry("bogus_lane", index))
    const long = await run([decision(many), decision(many)], DECISION_SCHEMA, arbitration)
    expect(long.prompts).toHaveLength(2)
    expect(long.prompts[1]?.text.length).toBeLessThan(2400)
  })

  it("fails as verdict_fail, not schema_invalid, when the correction still contradicts the lanes", async () => {
    const result = await run([decision([]), decision([entry("nowhere")])], DECISION_SCHEMA, arbitration)

    expect(result.prompts).toHaveLength(2)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        reason: expect.stringContaining("Verdict consistency contract failed"),
      }),
    ])
    expect(result.events[0]?.reason).toContain("nowhere[0]")
    expect(result.events[0]?.errorClass).toBeUndefined()
  })

  it("spends the one correction turn on a schema failure and a contradiction together", async () => {
    const result = await run(
      [assistant(JSON.stringify({ verdict: "REJECT" })), decision([]), decision([entry("intent_review")])],
      DECISION_SCHEMA,
      arbitration,
    )

    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]?.text).toContain("missing required field")
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        reason: expect.stringContaining(MISSING),
      }),
    ])
  })

  it("gives a review that is not a block decision no correction for the same contradiction", async () => {
    const result = await run(decision([], { verdict: "ACCEPT", required_actions: [] }), DECISION_SCHEMA, {
      verdictEvidence: lanes,
      reviewImplementationFingerprint: "sha256:current",
    })

    expect(result.prompts).toHaveLength(1)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "failed",
        trigger: "verdict_fail",
        reason: expect.stringContaining("ACCEPT leaves required actions unrefuted"),
      }),
    ])
  })
})
