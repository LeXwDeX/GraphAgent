// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Background intent analysis for the loop (#1328).
 *
 * `run` answers one question for a caller that owns the loop state: given the user's first description,
 * the frozen first analysis, the current state and what happened this round, what does the user really
 * want, how far is the work, and what must the next round do? It returns a result that passed the drift
 * guard (`LoopValidate`), or a classified failure, together with usage and elapsed time either way.
 *
 * The analysis is a side conversation, not a turn. It runs on the session's own model at that model's
 * highest thinking tier, with read-only tools, scheduled on the `side` lane, and leaves no trace in the
 * session: no messages, no todos, no hooks, no events. The caller supplies everything about the loop and
 * decides what to do with the outcome (state, dispatch and events belong to the loop kernel).
 */
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Stream } from "effect"
import type { ModelMessage, Tool } from "ai"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { LoopAnalysisResult } from "@graphagent/schema/loop"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { AgentScheduler } from "@/session/agent-scheduler"
import { applyRevert } from "@/session/btw-context"
import { HistoryView } from "@/session/history/view"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { estimateOverhead, usable } from "@/session/overflow"
import { SessionRetry } from "@/session/retry"
import { RuntimeSlots } from "@/session/runtime-slots"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SystemPrompt } from "@/session/system"
import { Token } from "@/util/token"
import { LoopAgent } from "./agent"
import { LoopFeedback } from "./feedback"
import { LoopInput } from "./input"
import { LoopStep } from "./step"
import { LoopTools } from "./tools"
import { LoopValidate } from "./validate"

/** Model requests one analysis may make, rejected submissions included. */
export const MAX_STEPS = 40
/** Wall clock one analysis may take. */
export const TIME_LIMIT: Duration.Input = "600 seconds"

export interface RunInput {
  readonly sessionID: SessionID
  /** The user's own words that started the loop, verbatim. */
  readonly firstDescription: string
  /** The state after the first committed analysis. Absent means this is the first analysis. */
  readonly prior?: LoopInput.Prior
  readonly declaration?: LoopInput.Declaration
  /** How the round that just ended finished. */
  readonly outcome: LoopInput.Anchor["outcome"]
  /** Human messages since the last committed analysis, oldest first: the only valid basis of a change. */
  readonly humans: ReadonlyArray<LoopInput.Human>
  /** Triggers cancellation. Once it fires no result is returned, whatever the analysis had reached. */
  readonly abort: AbortSignal
}

export interface Usage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
}

export type Failure =
  /** The request, or the setup before it, failed. `error` is the raw error, in the shape the retry policy classifies. */
  | { readonly kind: "provider"; readonly error: SessionRetry.Err }
  /** Every attempt broke the rules, or the model never submitted. `detail` is what the model last read. */
  | {
      readonly kind: "invalid_output"
      readonly detail: string
      readonly violations: ReadonlyArray<LoopValidate.Violation>
    }
  | { readonly kind: "limit"; readonly limit: "steps" | "time" }
  | { readonly kind: "cancelled" }

/** What every call reports, success or not, for the caller's accounting. */
export interface Report {
  readonly usage: Usage
  readonly elapsedMs: number
  /** Model requests made. */
  readonly steps: number
  /** Submissions made, accepted or not, plus stops without one. At most three are allowed. */
  readonly attempts: number
  /** The model and thinking tier used; absent when the call failed before they were chosen. */
  readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
}

export type Outcome =
  | ({ readonly type: "ok"; readonly result: LoopAnalysisResult } & Report)
  | ({ readonly type: "failed"; readonly failure: Failure } & Report)

type Core =
  { readonly type: "ok"; readonly result: LoopAnalysisResult } | { readonly type: "failed"; readonly failure: Failure }

export interface Interface {
  /** Never fails: every failure is an `Outcome`. Interrupting the fiber interrupts the analysis. */
  readonly run: (input: RunInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/LoopAnalysis") {}

const failed = (failure: Failure): Core => ({ type: "failed", failure })

interface Meter {
  steps: number
  readonly usage: { input: number; output: number; reasoning: number }
  readonly submission: LoopTools.Submission
  model: Report["model"]
}

interface Ready {
  readonly input: RunInput
  readonly meter: Meter
  readonly model: Provider.Model
  readonly user: SessionV1.User
  readonly sessionID: SessionID
  readonly system: string[]
  readonly tools: Record<string, Tool>
  readonly outputs: Map<string, string>
  readonly toolBudget: ToolBudget.Budget
  readonly entries: LoopInput.Entry[]
  readonly anchor: string
  /** Tokens the transcript may take in the first request. */
  readonly budget: number
}

type Converse = Core | { readonly type: "overflow"; readonly error: SessionRetry.Err }

/**
 * The thinking tier of the analysis: the model's highest ranked variant. A model whose variants are all
 * custom names has no ranking, so the session's current tier stays; a model without variants gets none.
 */
export function pickVariant(model: Pick<Provider.Model, "variants">, current: string | undefined) {
  const variants = model.variants ?? {}
  if (Object.keys(variants).length === 0) return undefined
  const highest = ProviderTransform.highestVariant(model)
  if (highest !== undefined) return highest
  return current !== undefined && current in variants ? current : undefined
}

/** The model-visible history of a session, with a stashed revert applied and unfinished work left out. */
function visible(history: SessionV1.WithParts[], revert: Session.Info["revert"]) {
  return applyRevert(history, revert).filter(
    (message) => !(message.info.role === "assistant" && message.info.time.completed === undefined),
  )
}

const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const llm = yield* LLM.Service
    const systemPrompt = yield* SystemPrompt.Service
    const database = yield* Database.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    // Optional so narrow test layers keep working; production always has the scheduler.
    const scheduler = Option.getOrUndefined(yield* Effect.serviceOption(AgentScheduler.Service))

    const providerFailure = (error: unknown, providerID = "unknown") =>
      failed({ kind: "provider", error: MessageV2.fromError(error, { providerID: ProviderV2.ID.make(providerID) }) })

    /** Reads the session and assembles everything a request needs. Failures here are provider failures. */
    const prepare = Effect.fn("LoopAnalysis.prepare")(function* (input: RunInput, meter: Meter, signal: AbortSignal) {
      const session = yield* sessions.get(input.sessionID)
      const history = yield* HistoryView.tail(input.sessionID).pipe(Effect.provideService(Database.Service, database))
      const view = visible(history, session.revert)

      // The session's model; without one, the model of the latest human message.
      const human = view.findLast(LoopInput.isHuman)
      const recorded =
        session.model !== undefined
          ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant }
          : human?.info.role === "user"
            ? human.info.model
            : undefined
      if (!recorded)
        return yield* Effect.fail(new Error("The session has no recorded model and no human message to take one from."))

      const model = yield* provider.getModel(ProviderV2.ID.make(recorded.providerID), ModelV2.ID.make(recorded.modelID))
      const variant = pickVariant(model, recorded.variant)
      meter.model = { providerID: model.providerID, modelID: model.id, ...(variant === undefined ? {} : { variant }) }

      const sessionID = SessionID.descending()
      const user: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: LoopAgent.NAME,
        model: { providerID: model.providerID, modelID: model.id, ...(variant === undefined ? {} : { variant }) },
      }

      const ctx = yield* InstanceState.context
      const cfg = yield* config.get()
      const environment = (yield* systemPrompt.environment(model))[0]
      const slots = [
        RuntimeSlots.environment({ directory: ctx.directory, root: ctx.root, git: ctx.project.vcs === "git" }),
        RuntimeSlots.date(yield* DateTime.nowAsDate),
      ].flatMap((slot) => slot.parts)
      const system = [...(environment === undefined ? [] : [environment]), ...slots]

      const basis = new Set(input.humans.map((item) => item.id))
      const check = (result: LoopAnalysisResult) =>
        LoopValidate.check(
          input.prior === undefined
            ? { result, basisMessageIDs: basis, first: true }
            : { result, basisMessageIDs: basis, first: false, previous: input.prior.intent },
        )
      const outputs = new Map<string, string>()
      const tools = LoopTools.build({
        spawner,
        fs,
        signal,
        cwd: ctx.directory,
        submission: meter.submission,
        check,
        outputs,
      })

      const anchor = LoopInput.anchor({
        firstDescription: input.firstDescription,
        prior: input.prior,
        declaration: input.declaration,
        outcome: input.outcome,
        humans: input.humans,
      })
      // The transcript may take the model's usable window (context minus the output reserve), less a share
      // kept for tool results, less what the request carries besides the transcript.
      const usableTokens = usable({ cfg, model })
      const window = Math.floor(
        (usableTokens > 0 ? usableTokens : LoopInput.UNKNOWN_WINDOW_TOKENS) * LoopInput.HISTORY_SHARE,
      )
      const fixed =
        estimateOverhead({ system: [LoopAgent.AGENT.prompt ?? "", ...system], tools }) + Token.estimateReserve(anchor)

      return {
        type: "ready" as const,
        ready: {
          input,
          meter,
          model,
          user,
          sessionID,
          system,
          tools,
          outputs,
          toolBudget: ToolBudget.create(0),
          entries: LoopInput.entries(view),
          anchor,
          budget: Math.max(0, window - fixed),
        } satisfies Ready,
      }
    })

    /**
     * One model request, through the shared retry policy. The stream may fail after a tool already ran
     * (a read-only tool, or the submission itself): then it is not resent, the failure is returned and
     * the driver decides, because a submission that was accepted is a result whatever happened after.
     */
    const request = Effect.fn("LoopAnalysis.request")(function* (ready: Ready, messages: ModelMessage[]) {
      const { model, input } = ready
      let current = LoopStep.collected()
      let executed = false
      const attempt = Effect.suspend(() => {
        const state = (current = LoopStep.collected())
        executed = false
        return llm
          .stream({
            agent: LoopAgent.AGENT,
            user: ready.user,
            system: ready.system,
            small: false,
            tools: ready.tools,
            toolBudget: ready.toolBudget,
            model,
            sessionID: ready.sessionID,
            // Retries belong to the shared policy below; the transport must not spend its own first.
            retries: 0,
            sessionRetry: true,
            messages: [...messages],
            // A background request the user did not type, scheduled like a side question rather than
            // behind every child run.
            lane: "side",
            purpose: "auxiliary",
            onAttemptActivity: (activity) => {
              if (activity === "tool-executed") executed = true
            },
            // Nothing is persisted, so there is nothing to settle.
            onThinkingInvalidated: () => Effect.void,
          })
          .pipe(
            Stream.runForEach((event) => {
              const failure = LoopStep.add(state, event)
              return failure === undefined ? Effect.void : Effect.fail(failure)
            }),
          )
      })
      const error = yield* attempt.pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: model.providerID,
            parse: (cause) =>
              MessageV2.fromError(cause, { providerID: model.providerID, aborted: input.abort.aborted }),
            shouldRetry: () => !input.abort.aborted && !executed,
            onRateLimit: ({ retryAfterMs }) =>
              scheduler ? scheduler.penalize(model.providerID, model.id, retryAfterMs) : Effect.void,
            set: () => Effect.void,
          }),
        ),
        Effect.map((): { readonly cause: unknown } | undefined => undefined),
        Effect.catch((cause) => Effect.succeed({ cause })),
      )
      return { collected: current, error }
    })

    const invalid = (meter: Meter): Core =>
      failed({
        kind: "invalid_output",
        detail: meter.submission.last?.text ?? "The model never submitted an analysis.",
        violations: meter.submission.last?.violations ?? [],
      })

    /** The conversation: model requests until an analysis is accepted or something stops it. */
    const converse = Effect.fn("LoopAnalysis.converse")(function* (ready: Ready, instruction: string) {
      const { meter, input, model } = ready
      const { submission } = meter
      const messages: ModelMessage[] = [{ role: "user", content: instruction }]
      while (true) {
        if (meter.steps >= MAX_STEPS) return failed({ kind: "limit", limit: "steps" }) satisfies Converse
        meter.steps += 1
        // Tool results are replayed once, with the request after their call. Providers may reuse call ids
        // from one response to the next, so an earlier step's results must not answer for this one.
        ready.outputs.clear()
        const step = yield* request(ready, messages)
        if (step.collected.usage) {
          meter.usage.input += step.collected.usage.input
          meter.usage.output += step.collected.usage.output
          meter.usage.reasoning += step.collected.usage.reasoning
        }

        // Attempts are capped where they are counted and where a submission is accepted (the tool), so a result
        // is only ever accepted inside the cap. Exhaustion is decided first so that stays true here too: attempts
        // that ran out never end as a success, whatever else the response held.
        if (LoopTools.exhausted(submission)) return invalid(meter) satisfies Converse
        if (submission.accepted) return { type: "ok", result: submission.accepted } satisfies Converse
        if (step.error) {
          const error = MessageV2.fromError(step.error.cause, {
            providerID: model.providerID,
            aborted: input.abort.aborted,
          })
          if (SessionV1.ContextOverflowError.isInstance(error)) return { type: "overflow", error } satisfies Converse
          return failed({ kind: "provider", error }) satisfies Converse
        }
        // A submission whose arguments the SDK rejected never reached the tool: still an attempt.
        for (const call of LoopStep.calls(step.collected)) {
          if (call.name !== LoopTools.SUBMIT || ready.outputs.has(call.id)) continue
          const detail = step.collected.failures.get(call.id) ?? "the arguments could not be parsed"
          ready.outputs.set(
            call.id,
            LoopTools.reject(submission, (attempt) => LoopFeedback.malformed(attempt, detail)),
          )
        }
        if (LoopTools.exhausted(submission)) return invalid(meter) satisfies Converse

        const turn = LoopStep.assistant(step.collected)
        const results = LoopStep.results(step.collected, ready.outputs)
        if (turn) messages.push(turn)
        if (results) {
          messages.push(results)
          continue
        }
        // The model stopped without calling submit_analysis: that is an attempt too.
        const nudge = LoopTools.reject(submission, LoopFeedback.unsubmitted)
        if (LoopTools.exhausted(submission)) return invalid(meter) satisfies Converse
        messages.push({ role: "user", content: nudge })
      }
    })

    /** Prepare, then converse; a request that overflows the context restarts once with half the transcript. */
    const analyse = Effect.fn("LoopAnalysis.analyse")(function* (input: RunInput, meter: Meter) {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (item) => Effect.sync(() => item.abort()),
      )
      const prepared = yield* prepare(input, meter, controller.signal).pipe(
        Effect.catch((error) => Effect.succeed({ type: "failed" as const, core: providerFailure(error) })),
      )
      if (prepared.type === "failed") return prepared.core
      const { ready } = prepared
      let budget = ready.budget
      let halved = false
      while (true) {
        const fitted = LoopInput.fit(ready.entries, budget)
        const outcome = yield* converse(ready, LoopInput.frame(ready.anchor, fitted.text))
        if (outcome.type !== "overflow") return outcome
        if (halved) return failed({ kind: "provider", error: outcome.error })
        halved = true
        budget = Math.floor(budget / 2)
      }
    })

    const run = Effect.fn("LoopAnalysis.run")(function* (input: RunInput) {
      const started = yield* Clock.currentTimeMillis
      const meter: Meter = {
        steps: 0,
        usage: { input: 0, output: 0, reasoning: 0 },
        submission: LoopTools.submission(),
        model: undefined,
      }
      const report = Effect.fnUntraced(function* (core: Core) {
        const now = yield* Clock.currentTimeMillis
        const { submission } = meter
        return {
          ...core,
          usage: { ...meter.usage },
          elapsedMs: now - started,
          steps: meter.steps,
          attempts: submission.rejected + (submission.accepted ? 1 : 0),
          ...(meter.model ? { model: meter.model } : {}),
        } satisfies Outcome
      })

      const cancelled = failed({ kind: "cancelled" })
      if (input.abort.aborted) return yield* report(cancelled)
      const core = yield* Effect.raceFirst(
        analyse(input, meter).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: TIME_LIMIT,
            orElse: () => Effect.succeed(failed({ kind: "limit", limit: "time" })),
          }),
        ),
        aborted(input.abort).pipe(Effect.as(cancelled)),
      )
      // The signal wins over a result that finished in the same moment: no result after a cancel.
      return yield* report(input.abort.aborted ? cancelled : core)
    })

    return Service.of({ run })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(AgentScheduler.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Session.node,
  Provider.node,
  Config.node,
  LLM.node,
  SystemPrompt.node,
  Database.node,
  CrossSpawnSpawner.node,
  FSUtil.node,
  AgentScheduler.node,
])

export * as LoopAnalysis from "./analysis"
