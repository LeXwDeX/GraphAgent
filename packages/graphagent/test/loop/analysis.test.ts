// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { FSUtil } from "@graphagent/core/fs-util"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionProjector } from "@graphagent/core/session/projector"
import { MessageTable, PartTable, SessionTable, TodoTable } from "@graphagent/core/session/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { LLMEvent } from "@graphagent/llm"
import { Config } from "@/config/config"
import { SettingsHook } from "@/hook"
import { LoopAnalysis } from "@/loop/analysis"
import { LoopFeedback } from "@/loop/feedback"
import { LoopTools } from "@/loop/tools"
import { Provider } from "@/provider/provider"
import { AgentScheduler } from "@/session/agent-scheduler"
import { LLM } from "@/session/llm"
import { isInternalOneShot } from "@/session/llm/internal-one-shot"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SystemPrompt } from "@/session/system"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { intent, progress, result } from "./fixture"

// ── harness ────────────────────────────────────────────────────

/** One scripted model response. It sees the request, and may run the request's tools like a real stream. */
type Script = (input: LLM.StreamInput, index: number) => Stream.Stream<LLMEvent, unknown>

const state = { scripts: [] as Script[], inputs: [] as LLM.StreamInput[], hookTriggers: 0 }

/** The scripted fake: request n runs script n, and the last script repeats. Every request is recorded. */
const fakeLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    organizer: () => Effect.succeed(undefined),
    stream: (input) => {
      const index = state.inputs.length
      state.inputs.push({ ...input, messages: [...input.messages] })
      const script = state.scripts[Math.min(index, state.scripts.length - 1)]
      return script ? script(input, index) : Stream.empty
    },
  }),
)

const hooks = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: () =>
      Effect.sync(() => {
        state.hookTriggers++
      }).pipe(Effect.andThen(Effect.die("the analysis must not trigger settings hooks"))),
    list: () =>
      Effect.sync(() => {
        state.hookTriggers++
      }).pipe(Effect.as([])),
  }),
)

const root = LayerNode.group([
  LoopAnalysis.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Config.node,
  LLM.node,
  SystemPrompt.node,
  Database.node,
  CrossSpawnSpawner.node,
  FSUtil.node,
  AgentScheduler.node,
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [LayerNode.replace(SettingsHook.node, hooks), LayerNode.replace(LLM.node, fakeLLM)],
  }),
)

beforeEach(() => {
  state.scripts = []
  state.inputs = []
  state.hookTriggers = 0
})

const USAGE = { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 }

type Call = { readonly id: string; readonly name: string; readonly args: unknown }

/** A response that calls tools (and runs them, as the SDK does) and then ends its step. */
const round =
  (calls: ReadonlyArray<Call>, extra: { text?: string } = {}): Script =>
  (input) =>
    Stream.unwrap(
      Effect.promise(async () => {
        const events: LLMEvent[] = [LLMEvent.stepStart({ index: 0 })]
        if (extra.text !== undefined)
          events.push(
            LLMEvent.textStart({ id: "t0" }),
            LLMEvent.textDelta({ id: "t0", text: extra.text }),
            LLMEvent.textEnd({ id: "t0" }),
          )
        for (const call of calls) {
          events.push(LLMEvent.toolCall({ id: call.id, name: call.name, input: call.args }))
          const tool = input.tools[call.name]
          if (!tool?.execute) throw new Error(`the request carries no ${call.name} tool`)
          // The real stream reports a tool that runs, which is what stops a retry from resending the request.
          input.onAttemptActivity?.("tool-executed")
          await tool.execute(call.args, {
            toolCallId: call.id,
            messages: [],
            abortSignal: new AbortController().signal,
          })
        }
        const reason = calls.length > 0 ? "tool-calls" : "stop"
        events.push(LLMEvent.stepFinish({ index: 0, reason, usage: USAGE }), LLMEvent.finish({ reason, usage: USAGE }))
        return Stream.fromIterable(events)
      }),
    )

const submit = (value: unknown = result(), id = "call_submit"): Script =>
  round([{ id, name: "submit_analysis", args: value }])

/** A submission whose arguments the SDK rejected before the tool could run (unparsable JSON). */
const brokenSubmit =
  (id = "call_broken"): Script =>
  () =>
    Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolCall({ id, name: "submit_analysis", input: "{broken" }),
      LLMEvent.toolError({
        id,
        name: "submit_analysis",
        message: "Invalid input for tool submit_analysis: JSON parsing failed",
      }),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: USAGE }),
      LLMEvent.finish({ reason: "tool-calls", usage: USAGE }),
    ])
const list: Script = round([{ id: "call_list", name: "list_dir", args: { path: "." } }])
const chat: Script = round([], { text: "I am done thinking out loud." })
/** A response that never ends; `started` completes when the request begins, so a test can act mid-request. */
const hangAfter =
  (started: Deferred.Deferred<void>): Script =>
  () =>
    Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.flatMap(() => Stream.never))

/** A response whose submission is accepted, and whose stream then fails. */
const acceptThenFail =
  (error: unknown): Script =>
  (input) =>
    Stream.unwrap(
      Effect.promise(async () => {
        input.onAttemptActivity?.("tool-executed")
        await input.tools.submit_analysis.execute!(result(), {
          toolCallId: "call_late",
          messages: [],
          abortSignal: new AbortController().signal,
        })
        return Stream.fail(error)
      }),
    )

const providerFailure = (statusCode: number, message: string, retryable: boolean) =>
  new APICallError({
    message,
    url: "http://localhost/v1",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: { message } }),
    isRetryable: retryable,
  })
const fails =
  (error: unknown): Script =>
  () =>
    Stream.fail(error)

const model = (id: string, extra: object = {}) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0 },
  options: {},
  ...extra,
})

const config = {
  formatter: false,
  lsp: false,
  // A side-channel model must not leak into the analysis.
  btw: { model: "test/btw-model" },
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
      models: {
        plain: model("plain"),
        reasoning: model("reasoning", { reasoning: true }),
        custom: model("custom", { variants: { turbo: { reasoningEffort: "high" }, eco: { reasoningEffort: "low" } } }),
        "btw-model": model("btw-model"),
        // A window small enough that a long history does not fit.
        tiny: model("tiny", { limit: { context: 6_000, output: 1_000 } }),
      },
    },
  },
}

const ref = (id: string, variant?: string) => ({
  id: ModelV2.ID.make(id),
  providerID: ProviderV2.ID.make("test"),
  ...(variant === undefined ? {} : { variant }),
})

const withSession = <A, E, R>(
  body: (session: Session.Info, dir: string) => Effect.Effect<A, E, R>,
  options: { model?: ReturnType<typeof ref> } = { model: ref("reasoning") },
) =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "loop analysis",
          ...(options.model ? { model: options.model } : {}),
        })
        return yield* body(session, dir)
      }),
    { config },
  )

const analyse = (sessionID: SessionID, overrides: Partial<LoopAnalysis.RunInput> = {}) =>
  Effect.gen(function* () {
    const analysis = yield* LoopAnalysis.Service
    return yield* analysis.run({
      sessionID,
      firstDescription: "Make the importer idempotent.",
      outcome: { type: "completed" },
      humans: [],
      abort: new AbortController().signal,
      ...overrides,
    })
  })

const ok = (outcome: LoopAnalysis.Outcome) => {
  if (outcome.type !== "ok") throw new Error(`expected an accepted analysis, got ${JSON.stringify(outcome)}`)
  return outcome
}
const failure = (outcome: LoopAnalysis.Outcome) => {
  if (outcome.type !== "failed") throw new Error("expected a failure, got an accepted analysis")
  return outcome.failure
}

const seedUser = (sessionID: SessionID, text: string, modelID = "plain", variant?: string) =>
  Session.Service.use((sessions) =>
    Effect.gen(function* () {
      const info: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make(modelID),
          ...(variant ? { variant } : {}),
        },
      }
      yield* sessions.updateMessage(info)
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID: info.id, type: "text", text })
      return info
    }),
  )

/** The text of the last message of request `index`: a user message, or the output of a tool result. */
const last = (index: number) => {
  const message = state.inputs[index].messages.at(-1)
  if (typeof message?.content === "string") return message.content
  return (message?.content ?? [])
    .map((part) => (part.type === "tool-result" && part.output.type === "text" ? part.output.value : ""))
    .join("\n")
}

const instruction = (index: number) => {
  const first = state.inputs[index]?.messages.find((message) => message.role === "user")?.content
  return typeof first === "string" ? first : JSON.stringify(first)
}

/** One turn of the real event loop, so the analysis can finish its asynchronous work (disk, processes). */
const turn = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

// The virtual clock moves in small steps and never past 300 seconds in total, so a slow turn of the event loop
// (a busy machine) cannot push it over the analysis's own 600 second limit and turn a retry test into a limit.
const STEP = "250 millis"
const MAX_TURNS = 1_200

/**
 * Runs the virtual clock forward, once the analysis has made its first request, until the forked analysis has
 * finished: retry backoff then costs no real time.
 */
const finish = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let turns = 0; turns < MAX_TURNS; turns++) {
      if (fiber.pollUnsafe() !== undefined) return yield* Fiber.join(fiber)
      yield* turn
      if (state.inputs.length > 0) yield* TestClock.adjust(STEP)
    }
    return yield* Effect.die(new Error("the analysis never finished"))
  })

/** Lets the retry policy's backoff elapse on the virtual clock until request `count` has been made. */
const untilRequests = (count: number) =>
  Effect.gen(function* () {
    for (let turns = 0; state.inputs.length < count; turns++) {
      if (turns >= MAX_TURNS) yield* Effect.die(new Error(`the analysis never made request ${count}`))
      yield* turn
      if (state.inputs.length > 0) yield* TestClock.adjust(STEP)
    }
  })

// ── request shape ──────────────────────────────────────────────

describe("LoopAnalysis request (#1328)", () => {
  it.effect("uses the session model at its highest tier, on the side lane, not small", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [submit()]
        const outcome = ok(yield* analyse(session.id))

        const request = state.inputs[0]
        // The session's model, never the configured side-question model.
        expect(String(request.model.id)).toBe("reasoning")
        expect(request.user.model as unknown).toEqual({ providerID: "test", modelID: "reasoning", variant: "high" })
        expect(request.small).toBe(false)
        expect(request.lane).toBe("side")
        expect(request.purpose).toBe("auxiliary")
        expect(request.agent.name).toBe("loop-steer")
        expect(request.agent.hidden).toBe(true)
        // A background one-shot: it must not open a pooled WebSocket for a session that ends with it.
        expect(isInternalOneShot(request.agent.name)).toBe(true)
        expect(outcome.model as unknown).toEqual({ providerID: "test", modelID: "reasoning", variant: "high" })
        // The analysis is not a turn of the session: it has its own throwaway session id.
        expect(request.sessionID).not.toBe(session.id)
      }),
    ),
  )

  it.effect("a model without variants gets no tier", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          state.scripts = [submit()]
          const outcome = ok(yield* analyse(session.id))
          expect(String(state.inputs[0].model.id)).toBe("plain")
          expect(state.inputs[0].user.model.variant).toBeUndefined()
          expect(outcome.model?.variant).toBeUndefined()
        }),
      { model: ref("plain", "high") },
    ),
  )

  it.effect("a model whose variants are all custom names keeps the session's current tier", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          state.scripts = [submit()]
          ok(yield* analyse(session.id))
          expect(state.inputs[0].user.model as unknown).toEqual({
            providerID: "test",
            modelID: "custom",
            variant: "eco",
          })
        }),
      { model: ref("custom", "eco") },
    ),
  )

  it.effect("custom variants without a session tier send no tier", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          state.scripts = [submit()]
          ok(yield* analyse(session.id))
          expect(state.inputs[0].user.model.variant).toBeUndefined()
        }),
      { model: ref("custom") },
    ),
  )

  it.effect("without a recorded session model it takes the model of the latest human message", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          yield* seedUser(session.id, "first", "plain")
          yield* seedUser(session.id, "second", "reasoning", "low")
          state.scripts = [submit()]
          ok(yield* analyse(session.id))
          expect(String(state.inputs[0].model.id)).toBe("reasoning")
          // The tier is still the highest of that model, not the tier the message carried.
          expect(state.inputs[0].user.model.variant).toBe("high")
        }),
      { model: undefined },
    ),
  )

  it.effect("the analysis can use exactly the five tools", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [submit()]
        ok(yield* analyse(session.id))
        expect(Object.keys(state.inputs[0].tools).toSorted()).toEqual([...LoopTools.NAMES].toSorted())
        expect(state.inputs[0].toolChoice).toBeUndefined()
      }),
    ),
  )

  it.effect("the system text carries the analyst's prompt, the working directory and the date", () =>
    withSession((session, dir) =>
      Effect.gen(function* () {
        state.scripts = [submit()]
        ok(yield* analyse(session.id))
        const request = state.inputs[0]
        expect(request.agent.prompt).toContain("background analyst of an autonomous loop")
        expect(request.system.join("\n")).toContain(dir)
        expect(request.system.join("\n")).toMatch(/\d{4}/)
      }),
    ),
  )
})

describe("LoopAnalysis thinking tier (#1328)", () => {
  const variants = (...names: string[]) => ({ variants: Object.fromEntries(names.map((name) => [name, {}])) })

  test("the highest ranked variant wins, whatever the order they are listed in", () => {
    expect(LoopAnalysis.pickVariant(variants("low", "xhigh", "medium", "high"), "low")).toBe("xhigh")
    expect(LoopAnalysis.pickVariant(variants("high", "low"), undefined)).toBe("high")
  })

  test("a custom name next to ranked ones is ignored", () => {
    expect(LoopAnalysis.pickVariant(variants("turbo", "medium"), "turbo")).toBe("medium")
  })

  test("variants that are all custom names keep the session's tier when the model has it", () => {
    expect(LoopAnalysis.pickVariant(variants("turbo", "eco"), "eco")).toBe("eco")
    expect(LoopAnalysis.pickVariant(variants("turbo", "eco"), "gone")).toBeUndefined()
    expect(LoopAnalysis.pickVariant(variants("turbo", "eco"), "default")).toBeUndefined()
    expect(LoopAnalysis.pickVariant(variants("turbo", "eco"), undefined)).toBeUndefined()
  })

  test("no variants means no tier, whatever the session had", () => {
    expect(LoopAnalysis.pickVariant({ variants: {} }, "high")).toBeUndefined()
    expect(LoopAnalysis.pickVariant({}, "high")).toBeUndefined()
  })
})

// ── conversation ───────────────────────────────────────────────

describe("LoopAnalysis conversation (#1328)", () => {
  it.effect("returns the accepted result with usage, elapsed time, steps and attempts", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [submit()]
        const outcome = ok(yield* analyse(session.id))

        expect(outcome.result).toEqual(result())
        expect(outcome.usage).toEqual({ input: 100, output: 20, reasoning: 5 })
        expect(outcome.steps).toBe(1)
        expect(outcome.attempts).toBe(1)
        expect(outcome.elapsedMs).toBe(0)
      }),
    ),
  )

  it.effect("replays a read-only tool call and its result on the next request, then accepts", () =>
    withSession((session, dir) =>
      Effect.gen(function* () {
        yield* (yield* FSUtil.Service).writeFileString(`${dir}/importer.ts`, "export const x = 1")
        state.scripts = [list, submit()]
        const outcome = ok(yield* analyse(session.id))

        expect(state.inputs).toHaveLength(2)
        expect(outcome.steps).toBe(2)
        expect(outcome.usage).toEqual({ input: 200, output: 40, reasoning: 10 })
        const second = state.inputs[1].messages
        expect(second.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        const assistant = JSON.stringify(second[1])
        expect(assistant).toContain('"toolName":"list_dir"')
        expect(assistant).toContain("call_list")
        const tool = JSON.stringify(second[2])
        expect(tool).toContain("importer.ts")
        expect(tool).toContain('"toolCallId":"call_list"')
      }),
    ),
  )

  it.effect("a provider that reuses call ids between responses never gets an old result for a new call", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const echo = (word: string): Script =>
          round([{ id: "call_1", name: "bash", args: { command: `echo ${word}` } }])
        state.scripts = [echo("first"), echo("second"), submit(result(), "call_1")]
        ok(yield* analyse(session.id))

        const tools = state.inputs[2].messages
          .filter((message) => message.role === "tool")
          .map((message) => JSON.stringify(message))
        expect(tools).toHaveLength(2)
        expect(tools[0]).toContain("first")
        expect(tools[0]).not.toContain("second")
        expect(tools[1]).toContain("second")
        expect(tools[1]).not.toContain("first")
      }),
    ),
  )

  it.effect("sends the violated rules back and accepts the corrected result", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const bad = result({ intent: intent({ acceptance: [] }), next_prompt: undefined })
        state.scripts = [submit(bad, "call_bad"), submit(result(), "call_good")]
        const outcome = ok(yield* analyse(session.id))

        expect(outcome.attempts).toBe(2)
        expect(outcome.steps).toBe(2)
        expect(last(1)).toContain("NOT accepted")
        expect(last(1)).toContain("[V1]")
        expect(last(1)).toContain("[V5]")
        expect(JSON.stringify(state.inputs[1].messages.at(-1))).toContain('"toolCallId":"call_bad"')
      }),
    ),
  )

  it.effect("fails with invalid_output after three attempts and keeps what the model last read", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const bad = result({ intent: intent({ acceptance: [] }) })
        state.scripts = [submit(bad)]
        const outcome = yield* analyse(session.id)

        const reported = failure(outcome)
        expect(state.inputs).toHaveLength(3)
        expect(reported.kind).toBe("invalid_output")
        if (reported.kind !== "invalid_output") return
        expect(reported.violations.map((violation) => violation.rule)).toEqual(["V1"])
        expect(reported.detail).toContain("Attempt 3 of 3; no attempts are left")
        expect(outcome.attempts).toBe(3)
        expect(outcome.steps).toBe(3)
      }),
    ),
  )

  it.effect("stopping without a submission counts as an attempt, and the model is told", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [chat]
        const outcome = yield* analyse(session.id)

        expect(failure(outcome).kind).toBe("invalid_output")
        expect(state.inputs).toHaveLength(3)
        expect(last(1)).toBe(LoopFeedback.unsubmitted(1))
        // The plain text the model produced is part of the conversation it continues.
        expect(JSON.stringify(state.inputs[1].messages)).toContain("I am done thinking out loud.")
      }),
    ),
  )

  it.effect("malformed arguments cost an attempt too and are reported without their values", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [submit({ verdict: "paused", reason: 7 }), submit()]
        const outcome = ok(yield* analyse(session.id))

        expect(outcome.attempts).toBe(2)
        expect(last(1)).toContain('["verdict"] invalid value')
        expect(last(1)).not.toContain("paused")
      }),
    ),
  )

  it.effect("a submission the SDK could not parse is an attempt, and the model reads why", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [brokenSubmit(), submit()]
        const outcome = ok(yield* analyse(session.id))

        expect(outcome.attempts).toBe(2)
        expect(last(1)).toContain("JSON parsing failed")
        expect(last(1)).toContain("Attempt 1 of 3; 2 left")
        expect(JSON.stringify(state.inputs[1].messages.at(-1))).toContain('"toolCallId":"call_broken"')

        state.inputs = []
        state.scripts = [brokenSubmit()]
        const exhausted = yield* analyse(session.id)
        expect(failure(exhausted).kind).toBe("invalid_output")
        expect(state.inputs).toHaveLength(3)
      }),
    ),
  )

  it.effect("an accepted submission wins over a stream failure that follows it", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [acceptThenFail(providerFailure(400, "late failure", false))]
        const outcome = ok(yield* analyse(session.id))

        expect(outcome.result).toEqual(result())
        // The failure is not retried either: the submission already ran.
        expect(state.inputs).toHaveLength(1)
      }),
    ),
  )

  it.effect("the first analysis validates as a first analysis and later ones against the latest intent", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const previous = intent()
        // Without a basis the objective may not change.
        const drift = result({ intent: intent({ objective: "Something else entirely" }) })
        state.scripts = [submit(drift), submit(result({ intent: previous }))]
        const outcome = ok(
          yield* analyse(session.id, {
            prior: { firstAnalysis: previous, intent: previous, progress: progress(), recent: [] },
          }),
        )
        expect(outcome.attempts).toBe(2)
        expect(last(1)).toContain("[V2]")

        // A first analysis has nothing to drift from: the same objective change is fine.
        state.inputs = []
        state.scripts = [submit(drift)]
        expect(ok(yield* analyse(session.id)).attempts).toBe(1)
      }),
    ),
  )

  it.effect("a human message in the window can justify a change; one outside it cannot", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const previous = intent()
        const changed = result({
          intent: intent({ objective: "A bigger goal" }),
          intent_change: { changed: true, basis_message_id: "msg_in_window", summary: "wider goal" },
        })
        const prior = { firstAnalysis: previous, intent: previous, progress: progress(), recent: [] }

        state.scripts = [submit(changed)]
        const accepted = yield* analyse(session.id, {
          prior,
          humans: [{ id: "msg_in_window", text: "make it bigger" }],
        })
        expect(ok(accepted).attempts).toBe(1)

        state.inputs = []
        state.scripts = [submit(changed)]
        const rejected = yield* analyse(session.id, { prior, humans: [{ id: "msg_other", text: "make it bigger" }] })
        expect(failure(rejected).kind).toBe("invalid_output")
        expect(last(0)).not.toContain("accepted")
      }),
    ),
  )
})

// ── input assembly through the service ─────────────────────────

describe("LoopAnalysis input (#1328)", () => {
  it.effect("the instruction carries the anchor verbatim and the session history after it", () =>
    withSession((session) =>
      Effect.gen(function* () {
        yield* seedUser(session.id, "Please make the importer idempotent")
        const frozen = intent({ objective: "Idempotent importer" })
        state.scripts = [submit(result({ intent: frozen }))]
        ok(
          yield* analyse(session.id, {
            firstDescription: "Make the importer idempotent.\nKeep `--dry-run`.",
            prior: { firstAnalysis: frozen, intent: frozen, progress: progress(), prompt: "Run it twice.", recent: [] },
            humans: [{ id: "msg_h", text: "also no new dependency" }],
          }),
        )

        const text = instruction(0)
        expect(text).toContain("Make the importer idempotent.\nKeep `--dry-run`.")
        expect(text).toContain("msg_h")
        expect(text).toContain("also no new dependency")
        expect(text).toContain("Idempotent importer")
        expect(text.indexOf("## 5.")).toBeLessThan(text.indexOf("## 6."))
        expect(text.slice(text.indexOf("## 6."))).toContain("Please make the importer idempotent")
      }),
    ),
  )

  it.effect("the first analysis tells the model earlier agent output is progress evidence only", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [submit()]
        ok(yield* analyse(session.id, { humans: [{ id: "msg_after_start", text: "one more thing" }] }))
        const text = instruction(0)
        expect(text).toContain("progress evidence only")
        expect(text).toContain("msg_after_start")
      }),
    ),
  )

  it.effect("a history that does not fit loses its oldest messages, never the anchor", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          for (let index = 0; index < 8; index++)
            yield* seedUser(session.id, `message ${index} ${"filler ".repeat(500)}`)
          yield* seedUser(session.id, "the newest message")
          state.scripts = [submit()]
          ok(yield* analyse(session.id, { firstDescription: "The user's own words" }))

          const text = instruction(0)
          expect(text).toContain("The user's own words")
          expect(text).toContain("older message(s) omitted")
          expect(text).toContain("the newest message")
          expect(text).not.toContain("message 0 ")
        }),
      { model: ref("tiny") },
    ),
  )

  it.effect("a request that overflows the context restarts once with half the transcript", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          for (let index = 0; index < 8; index++)
            yield* seedUser(session.id, `message ${index} ${"filler ".repeat(200)}`)
          const overflow = providerFailure(400, "This model's maximum context length is 1000 tokens", false)
          state.scripts = [fails(overflow), submit()]
          ok(yield* analyse(session.id))

          expect(state.inputs).toHaveLength(2)
          const kept = (index: number) => (instruction(index).match(/message \d /g) ?? []).length
          expect(kept(1)).toBeGreaterThan(0)
          expect(kept(1)).toBeLessThan(kept(0))
          expect(instruction(1)).toContain("older message(s) omitted")
        }),
      { model: ref("tiny") },
    ),
  )

  it.effect("overflowing again fails as a provider error carrying the raw error", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const overflow = providerFailure(400, "This model's maximum context length is 1000 tokens", false)
        state.scripts = [fails(overflow)]
        const outcome = yield* analyse(session.id)

        expect(state.inputs).toHaveLength(2)
        const reported = failure(outcome)
        expect(reported.kind).toBe("provider")
        if (reported.kind !== "provider") return
        expect(reported.error.name).toBe("ContextOverflowError")
      }),
    ),
  )
})

// ── failures ───────────────────────────────────────────────────

describe("LoopAnalysis failures (#1328)", () => {
  it.effect("an interface error is a provider failure with the raw error", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [fails(providerFailure(400, "Bad request", false))]
        const outcome = yield* finish(yield* analyse(session.id).pipe(Effect.forkChild))

        const reported = failure(outcome)
        expect(reported.kind).toBe("provider")
        if (reported.kind !== "provider") return
        expect(reported.error.name).toBe("APIError")
        expect(JSON.stringify(reported.error)).toContain("Bad request")
        // The shared policy resends an HTTP failure five times before giving up; none of it is another step.
        expect(state.inputs).toHaveLength(6)
        expect(outcome.steps).toBe(1)
        expect(outcome.attempts).toBe(0)
      }),
    ),
  )

  it.effect("a transient error goes through the shared retry policy and the analysis completes", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [fails(providerFailure(503, "Service Unavailable", true)), submit()]
        const running = yield* analyse(session.id).pipe(Effect.forkChild)
        yield* untilRequests(2)
        const outcome = ok(yield* Fiber.join(running))

        expect(state.inputs).toHaveLength(2)
        // A retry resends the same request: it is not another model step.
        expect(outcome.steps).toBe(1)
        expect(outcome.attempts).toBe(1)
        expect(state.inputs[1].messages).toEqual(state.inputs[0].messages)
        expect(state.inputs[1].lane).toBe("side")
        expect(state.inputs[1].purpose).toBe("auxiliary")
      }),
    ),
  )

  it.effect("a session that does not exist is a provider failure", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          state.scripts = [submit()]
          const outcome = yield* analyse(SessionID.make("ses_missing"))
          expect(failure(outcome).kind).toBe("provider")
          expect(state.inputs).toHaveLength(0)
          expect(outcome.model).toBeUndefined()
          expect(outcome.steps).toBe(0)
        }),
      { config },
    ),
  )

  it.effect("a session with no model and no human message is a provider failure", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          state.scripts = [submit()]
          const reported = failure(yield* analyse(session.id))
          expect(reported.kind).toBe("provider")
          expect(JSON.stringify(reported)).toContain("no recorded model")
          expect(state.inputs).toHaveLength(0)
        }),
      { model: undefined },
    ),
  )

  it.effect("a model that is not configured is a provider failure", () =>
    withSession(
      (session) =>
        Effect.gen(function* () {
          state.scripts = [submit()]
          const reported = failure(yield* analyse(session.id))
          expect(reported.kind).toBe("provider")
          expect(state.inputs).toHaveLength(0)
        }),
      { model: ref("not-configured") },
    ),
  )
})

// ── limits and cancellation ────────────────────────────────────

describe("LoopAnalysis limits and cancellation (#1328)", () => {
  it.effect("stops after 40 model requests with limit steps", () =>
    withSession((session) =>
      Effect.gen(function* () {
        state.scripts = [list]
        const outcome = yield* analyse(session.id)

        expect(failure(outcome)).toEqual({ kind: "limit", limit: "steps" })
        expect(state.inputs).toHaveLength(LoopAnalysis.MAX_STEPS)
        expect(LoopAnalysis.MAX_STEPS).toBe(40)
        expect(outcome.steps).toBe(40)
        expect(outcome.usage.input).toBe(40 * 100)
      }),
    ),
  )

  it.effect("rejected submissions and retries share the same 40 steps", () =>
    withSession((session) =>
      Effect.gen(function* () {
        // Alternating read and rejected submissions: the rejections are capped at three attempts, so the
        // analysis ends as invalid output long before 40 requests.
        const bad = result({ intent: intent({ acceptance: [] }) })
        state.scripts = [list, submit(bad)]
        const outcome = yield* analyse(session.id)
        expect(failure(outcome).kind).toBe("invalid_output")
        expect(state.inputs.length).toBeLessThan(LoopAnalysis.MAX_STEPS)
      }),
    ),
  )

  it.effect("stops after 600 seconds with limit time and keeps the usage so far", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        state.scripts = [list, hangAfter(started)]
        const running = yield* analyse(session.id).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* TestClock.adjust("600 seconds")
        const outcome = yield* Fiber.join(running)

        expect(failure(outcome)).toEqual({ kind: "limit", limit: "time" })
        expect(outcome.elapsedMs).toBeGreaterThanOrEqual(600_000)
        expect(outcome.usage.input).toBe(100)
        expect(outcome.steps).toBe(2)
        expect(LoopAnalysis.TIME_LIMIT).toBe("600 seconds")
      }),
    ),
  )

  it.effect("the abort signal ends the analysis as cancelled and nothing is returned", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const started = yield* Deferred.make<void>()
        state.scripts = [hangAfter(started)]
        const running = yield* analyse(session.id, { abort: controller.signal }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        controller.abort()
        const outcome = yield* Fiber.join(running)

        expect(outcome.type).toBe("failed")
        expect(failure(outcome)).toEqual({ kind: "cancelled" })
        expect(outcome.steps).toBe(1)
      }),
    ),
  )

  it.effect("a signal that fired before the call returns cancelled without a request", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const controller = new AbortController()
        controller.abort()
        state.scripts = [submit()]
        const outcome = yield* analyse(session.id, { abort: controller.signal })

        expect(failure(outcome)).toEqual({ kind: "cancelled" })
        expect(state.inputs).toHaveLength(0)
        expect(outcome.steps).toBe(0)
      }),
    ),
  )

  it.effect("an analysis accepted in the same moment as the abort is not returned", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const controller = new AbortController()
        state.scripts = [
          (input, index) => {
            const accepted = submit()(input, index)
            return accepted.pipe(Stream.tap(() => Effect.sync(() => controller.abort())))
          },
        ]
        const outcome = yield* analyse(session.id, { abort: controller.signal })
        expect(failure(outcome)).toEqual({ kind: "cancelled" })
      }),
    ),
  )

  it.effect("interrupting the fiber interrupts the model request", () =>
    withSession((session) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        state.scripts = [
          (input, index) =>
            hangAfter(started)(input, index).pipe(Stream.ensuring(Deferred.succeed(released, undefined))),
        ]
        const running = yield* analyse(session.id).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(running)
        yield* Deferred.await(released)
      }),
    ),
  )
})

// ── no trace in the session ────────────────────────────────────

const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    sessions: yield* db.select().from(SessionTable).all(),
    messages: yield* db.select().from(MessageTable).all(),
    parts: yield* db.select().from(PartTable).all(),
    todos: yield* db.select().from(TodoTable).all(),
    events: yield* db.select().from(EventTable).all(),
    sequences: yield* db.select().from(EventSequenceTable).all(),
  }
})

describe("LoopAnalysis leaves no trace (#1328)", () => {
  it.effect("writes no rows, triggers no hook and changes no todo", () =>
    withSession((session, dir) =>
      Effect.gen(function* () {
        yield* seedUser(session.id, "do the work")
        yield* (yield* FSUtil.Service).writeFileString(`${dir}/importer.ts`, "export const x = 1")
        state.scripts = [list, submit(result({ intent: intent({ acceptance: [] }) }), "call_bad"), submit()]

        const before = yield* snapshot
        const outcome = ok(yield* analyse(session.id))
        const after = yield* snapshot

        expect(outcome.steps).toBe(3)
        expect(after).toEqual(before)
        expect(after.todos).toEqual(before.todos)
        expect(state.hookTriggers).toBe(0)
      }),
    ),
  )
})
