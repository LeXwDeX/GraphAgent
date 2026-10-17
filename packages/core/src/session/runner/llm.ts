import { adoptReasoning } from "../reasoning-distillation/adopt"
import { assessCanonicalReasoning } from "../reasoning-distillation/canonical"
import { declaresNoReasoning, engineOrganizerCall } from "../reasoning-distillation/engine"
import { makeRewriteBudget, rewriteLogFields, runReasoningRewrite } from "../reasoning-distillation/rewrite"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolOutput,
  TransportReason,
  type ToolContent,
  type ToolResultValue,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Semaphore,
  Stream,
} from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ConfigCompaction } from "../../config/compaction"
import { ConfigReasoningDistillation } from "../../config/reasoning-distillation"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ContextFoldingToolSourceLedger } from "../context-folding/tool-source-ledger"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionHookContext } from "../hook-context"
import { SessionSourceHooks } from "../source-hooks"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTurnHooks } from "../turn-hooks"
import { Prompt } from "../prompt"
import { SessionToolBatch } from "../tool-batch"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessagesWithBindings } from "./to-llm-message"
import { CoreContextFolding } from "./context-folding"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { ToolBudget } from "../tool-budget"
import { SessionDisplayBuffer, type Batch as DisplayBatch } from "./display-buffer"
import { SessionV1 } from "../../v1/session"
import { Snapshot } from "../../snapshot"
import { Flag } from "../../flag/flag"
import { contextFoldingDiagnostic } from "../context-folding"

// Runner-level per-turn provider deadline. This is the runner's own cutoff
// (10 minutes); it is independent of the DAG node timeout
// (packages/opencode/src/dag/dag.ts DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs),
// which is an orchestration concern this package does not reference. Agents
// may override it per session via the `agents.<id>.timeout` config field
// (seconds).
//
// Coverage: the deadline bounds (1) the per-request HTTP transport timeout
// (`request.http.timeout`), (2) the total provider-stream turn below, and (3)
// the tool-fiber wait that follows the stream. (3) uses the same duration but
// is applied separately AFTER the provider turn completes, so a turn lasts at
// most ~2× the deadline — a hung tool can no longer hang a turn forever.
const DEFAULT_PROVIDER_TURN_TIMEOUT = Duration.minutes(10)

const turnTimeoutError = () =>
  new LLMError({
    module: "SessionRunner",
    method: "stream",
    reason: new TransportReason({ message: "Provider turn timed out", kind: "Timeout" }),
  })

const toolWaitTimeoutError = () =>
  new LLMError({
    module: "SessionRunner",
    method: "stream",
    reason: new TransportReason({ message: "Tool execution timed out", kind: "Timeout" }),
  })

const serializedText = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The exact text a provider receives for a settled tool call, for PostToolBatch `tool_response`. */
const modelToolResponse = (settlement: { readonly output?: ToolOutput; readonly result: ToolResultValue }) => {
  const result = settlement.output ? ToolOutput.toResultValue(settlement.output) : settlement.result
  if (result.type === "content")
    return result.value.map((item: ToolContent) => (item.type === "text" ? item.text : `[${item.type}]`)).join("\n")
  return serializedText(result.value)
}

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const rewriteBudget = makeRewriteBudget()
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const toolSources = yield* ContextFoldingToolSourceLedger.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const configEntries = yield* config.entries()
    const compaction = SessionCompaction.make({ db, events, llm, config: configEntries })
    const resolveDynamicFolding = Effect.fnUntraced(function* () {
      let dynamic: boolean | undefined
      let prune: boolean | undefined
      for (const entry of yield* config.entries()) {
        if (entry.type !== "document" || entry.info.compaction === undefined) continue
        if (entry.info.compaction.dynamic !== undefined) dynamic = entry.info.compaction.dynamic
        if (entry.info.compaction.prune !== undefined) prune = entry.info.compaction.prune
      }
      return ConfigCompaction.resolveDynamic({
        disabledByEnvironment: Flag.OPENCODE_DISABLE_PRUNE,
        dynamic,
        prune,
        // Core owns no server-plugin loader. Unknown is explicit and must never be promoted to loaded by inference.
        knownExternalDcp: "unknown",
      })
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })

    const reasoningRewriteEnabled = (model: SessionRunnerModel.ResolvedModel) =>
      Effect.suspend(() => config.entries()).pipe(
        Effect.map(
          (entries) =>
            ConfigReasoningDistillation.resolveEnabled({
              disabledByEnvironment: Flag.OPENCODE_DISABLE_REASONING_DISTILLATION,
              enabled: Config.latest(entries, "reasoningDistillation")?.enabled,
              modelEnabled: entries
                .filter((entry): entry is Config.Document => entry.type === "document")
                .map(
                  (entry) =>
                    entry.info.providers?.[model.provider]?.models?.[model.configID ?? model.id]?.reasoningDistillation
                      ?.enabled,
                )
                .findLast((enabled) => enabled !== undefined),
            }).enabled,
        ),
      )

    // Every reasoning part is organized synchronously before the next provider event. There is no background job or
    // send barrier: the stream waits for the organizer result (or its auxiliary timeout) and then continues.
    const rewriteReasoningNow = Effect.fnUntraced(function* (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      reasoningID: string
      model: SessionRunnerModel.ResolvedModel
    }) {
      const stored = yield* store.message(input.messageID)
      const parts =
        stored?.sessionID === input.sessionID && stored.message.type === "assistant"
          ? stored.message.content.filter((item) => item.id === input.reasoningID)
          : []
      const part = parts.length === 1 && parts[0].type === "reasoning" ? parts[0] : undefined
      if (!part) return
      const editability = assessCanonicalReasoning({
        text: part.text,
        metadata: part.providerMetadata,
        settled: true,
        distilled: part.distillation !== undefined,
      })
      if (!editability.editable) {
        yield* Effect.logDebug("reasoning distillation skipped", {
          "reasoning_distillation.runtime": "core-runner",
          "reasoning_distillation.reason": editability.reason,
        })
        return
      }
      const entries = yield* config.entries()
      const auxiliaryModel = yield* models
        // A declared no-reasoning variant keeps the organizer fast; otherwise it requests low effort.
        .resolveSmall(
          ProviderV2.ID.make(input.model.provider),
          Config.latest(entries, "small_model"),
          ModelV2.VariantID.make("none"),
        )
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const outcome = yield* runReasoningRewrite({
        budget: rewriteBudget,
        sessionID: input.sessionID,
        slot: { messageID: input.messageID, partID: part.id, text: part.text },
        language: ConfigReasoningDistillation.resolveLanguage(Config.latest(entries, "reasoningDistillation")),
        call: auxiliaryModel
          ? (signal, onResponseStarted) =>
              engineOrganizerCall({
                llm,
                model: auxiliaryModel,
                effort: declaresNoReasoning(auxiliaryModel) ? "default" : "low",
                timeoutMs: Flag.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS,
                signal,
                onResponseStarted,
              })
          : undefined,
        adopt: (replacement) =>
          adoptReasoning({
            events,
            db,
            sessionID: input.sessionID,
            messageID: input.messageID,
            part,
            replacement,
            canAdopt: reasoningRewriteEnabled(input.model),
          }).pipe(Effect.map((adopted) => (adopted ? (true as const) : undefined))),
      })
      yield* Effect.logInfo(
        "reasoning distillation",
        rewriteLogFields(outcome, {
          runtime: "core-runner",
          ...(auxiliaryModel ? { model: String(auxiliaryModel.id) } : {}),
        }),
      )
    })

    type HistoryCursor = {
      readonly baselineSeq: number
      readonly lastSeq: number
      readonly entries: readonly { readonly seq: number; readonly message: SessionMessage.Message }[]
      readonly snapshots: { last: Snapshot.ID | undefined }
    }
    // Within-drain incremental-read cache. Each session's entry is evicted when
    // its run settles (see `run` below), so this never grows to
    // O(sessions × history) for the location's lifetime. A later run re-reads
    // the full view from the store — one extra read per run, never a
    // correctness change (snapshots are content-addressed, and the baseline
    // revalidation below still guards stale epochs).
    const cursors = new Map<SessionSchema.ID, HistoryCursor>()

    // Resolve the per-agent provider-turn deadline: the `agents.<id>.timeout`
    // config field (seconds) wins, otherwise the runner default. Config entries
    // run lowest-to-highest priority (Config.Interface.entries), so the latest
    // matching document wins — matching Config.latest / options findLast. A
    // value of 0 is treated as unset so it falls back to the default instead of
    // timing the turn out immediately.
    const resolveTurnTimeout = Effect.fnUntraced(function* (agentID: AgentV2.ID) {
      let resolved: number | undefined
      for (const document of yield* config.entries()) {
        if (document.type !== "document") continue
        const timeout = document.info.agents?.[agentID]?.timeout
        if (timeout !== undefined && timeout > 0) resolved = timeout
      }
      return resolved === undefined ? DEFAULT_PROVIDER_TURN_TIMEOUT : Duration.seconds(resolved)
    })

    // Incremental history read for the hot path: the first read (or any epoch
    // baseline change) loads the full runner view and establishes the cursor;
    // later turns read only entries after the cursor. A compaction reset signal
    // replaces the cached entries with the full read returned by the API.
    const readHistory = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, baselineSeq: number) {
      const cached = cursors.get(sessionID)
      if (cached === undefined || cached.baselineSeq !== baselineSeq) {
        const entries = yield* SessionHistory.entriesForRunner(db, sessionID, baselineSeq)
        const cursor: HistoryCursor = {
          baselineSeq,
          lastSeq: entries.at(-1)?.seq ?? 0,
          entries,
          snapshots: { last: cached?.snapshots.last },
        }
        cursors.set(sessionID, cursor)
        return { entries: cursor.entries, snapshots: cursor.snapshots }
      }
      const result = yield* SessionHistory.entriesAfter(db, sessionID, baselineSeq, cached.lastSeq)
      if (result.reset) {
        const cursor: HistoryCursor = {
          baselineSeq,
          lastSeq: result.lastSeq,
          entries: result.entries,
          snapshots: cached.snapshots,
        }
        cursors.set(sessionID, cursor)
        return { entries: cursor.entries, snapshots: cursor.snapshots }
      }
      const entries = [...cached.entries, ...result.entries]
      cursors.set(sessionID, { ...cached, lastSeq: result.lastSeq, entries })
      return { entries, snapshots: cached.snapshots }
    })

    // Batch wrapper for the publisher's durable events: live-only events
    // (streaming deltas) flush the pending durable batch first so pubsub order
    // matches publish order, then publish immediately. Durable events are
    // committed through EventV2.publishMany at deterministic boundaries.
    const withBatch = (events: EventV2.Interface) => {
      let buffer: EventV2.BatchEvent[] = []
      const flush = Effect.fnUntraced(function* () {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const batch = buffer
            buffer = []
            if (batch.length === 0) return
            yield* events.publishMany(batch)
          }),
        )
      })
      const publish = <D extends EventV2.Definition>(
        definition: D,
        data: EventV2.Data<D>,
        options?: EventV2.PublishOptions,
      ) =>
        definition?.durable
          ? Effect.sync(() => {
              buffer.push({ definition, data, options })
              return { id: options?.id ?? EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<D>
            })
          : flush().pipe(Effect.andThen(() => events.publish(definition, data, options)))
      return {
        events: { ...events, publish },
        flush,
      }
    }
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          if (tool.state.status === "running" && tool.state.deferred) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(
        FiberSet.join(fibers),
        // awaitEmpty also succeeds when the last fiber failed: the FiberSet
        // observer deletes from the backing set before completing the join
        // deferred, so both racers become ready in the same tick. Re-check the
        // deferred so a lost race cannot swallow a tool settlement failure.
        FiberSet.awaitEmpty(fibers).pipe(
          Effect.andThen(Deferred.isDone(fibers.deferred)),
          Effect.flatMap((failed) => (failed ? FiberSet.join(fibers) : Effect.void)),
        ),
      )

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, sessionID: SessionSchema.ID, loadBatch?: string) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map(SystemContext.combine),
        Effect.provideService(SessionHookContext.Service, {
          sessionID,
          agentID: agent.id,
          ...(loadBatch ? { loadReason: "compact" as const, loadBatch } : {}),
        }),
      )

    type RunBudget = { budget: ToolBudget.Budget }
    // Resuming a completed, failed or interrupted drain is still the same input.
    // Keep admission state until a new input is promoted, the Session is deleted,
    // or this Location-scoped runner is disposed.
    const budgets = new Map<SessionSchema.ID, RunBudget>()
    // A preflight compaction rebuilds the provider request. Keep feedback from
    // asynchronous hooks until a request is actually sent, across that rebuild.
    const pendingRequestContext = new Map<SessionSchema.ID, string[]>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        budgets.clear()
        pendingRequestContext.clear()
      }),
    )
    yield* events.subscribe(SessionV1.Event.Deleted).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = SessionSchema.ID.make(event.data.sessionID)
          budgets.delete(sessionID)
          pendingRequestContext.delete(sessionID)
          // Pending reasoning rewrites of a deleted session can never adopt; stop their model calls now.
          rewriteBudget.forget(sessionID)
        }),
      ),
      Effect.forkScoped,
    )
    const newBudget = () =>
      config.entries().pipe(Effect.map((entries) => ToolBudget.create(Config.latest(entries, "maxToolCalls"))))

    const landBatchFeedback = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      result: { additionalContext?: string; stop?: string },
    ) {
      if (result.stop !== undefined) {
        // A stopped batch is durable conversation feedback, not another user turn.
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text: [result.additionalContext, result.stop].filter((value) => value !== undefined).join("\n\n"),
        })
        return true
      }
      if (result.additionalContext)
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID,
          prompt: Prompt.make({
            text: result.additionalContext,
            hookMode: yield* SessionInput.currentHookMode(db, sessionID),
          }),
          delivery: "steer",
        })
      return false
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runBudget: RunBudget,
      displayTurnID: string,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
      loadBatch?: string,
    ) {
      const session = yield* getSession(sessionID)
      const turnHooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionTurnHooks.Service))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const sourceHooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionSourceHooks.Service))
      if (sourceHooks) yield* sourceHooks.syncAgent({ sessionID: session.id, agentID: agent.id })
      const turnTimeout = yield* resolveTurnTimeout(agent.id)
      const initialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemContext(agent, session.id, loadBatch),
        session.id,
      )
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      const rawToolBatch = SessionToolBatch.create()
      yield* Effect.addFinalizer(() => Effect.sync(() => rawToolBatch.finish(false)))
      let needsContinuation = false
      let deferredTool = false
      let stoppedTool = false
      let currentStep = step
      const assistantText: string[] = []
      const toolCalls: Array<{
        toolName: string
        toolUseID: string
        toolInput: Record<string, unknown>
        toolResponse?: unknown
      }> = []
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) {
          currentStep = 1
          runBudget.budget = yield* newBudget()
        }
      }
      const requestedDisplayMode = yield* SessionInput.currentHookMode(db, session.id)
      const displayConfig = turnHooks
        ? yield* turnHooks.displayMode(session.id, requestedDisplayMode)
        : { enabled: false, mode: requestedDisplayMode }
      const displayMessageID = crypto.randomUUID()
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id, loadBatch), session.id))
      const model = yield* models.resolve(session)
      if (turnHooks?.beforeRequest) {
        const feedback = yield* turnHooks.beforeRequest({
          sessionID: session.id,
          model: { providerID: model.provider, apiModelID: model.id },
        })
        if (feedback.additionalContext)
          pendingRequestContext.set(session.id, [
            ...(pendingRequestContext.get(session.id) ?? []),
            feedback.additionalContext,
          ])
      }
      const history = yield* readHistory(session.id, system.baselineSeq)
      const entries = history.entries
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const budgetExhausted = runBudget.budget.exhausted
      const toolsDisabled = isLastStep || budgetExhausted
      const toolMaterialization = toolsDisabled ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const reasoningEnabled = yield* reasoningRewriteEnabled(model)
      const conversion = toLLMMessagesWithBindings(context, model, { reasoningDistillationEnabled: reasoningEnabled })
      const expectedMessages = [
        ...conversion.messages,
        ...(toolsDisabled
          ? [
              Message.assistant(
                budgetExhausted ? ToolBudget.renderExhaustedPrompt(runBudget.budget.max) : MAX_STEPS_PROMPT,
              ),
            ]
          : []),
      ]
      const preparedRequest = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        http: { timeout: turnTimeout },
        system: [agent.info?.system, system.baseline, ...(pendingRequestContext.get(session.id) ?? [])]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: expectedMessages,
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: toolsDisabled ? "none" : undefined,
      })
      const dynamicFolding = yield* resolveDynamicFolding()
      const folding = yield* CoreContextFolding.project({
        enabled: dynamicFolding.enabled,
        purpose: "conversation",
        sessionID: session.id,
        sourceMessages: context,
        conversion,
        expectedMessages,
        model,
        request: preparedRequest,
        ledger: toolSources,
        prepare: (request) => llm.prepare(request),
      })
      yield* Effect.logInfo(
        "context folding",
        contextFoldingDiagnostic({
          runtime: "core-runner",
          requestPurpose: "conversation",
          resolution: dynamicFolding,
          projectionPlan: folding.plan,
        }),
      )
      const request = folding.request
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      pendingRequestContext.delete(session.id)
      const startSnapshot = yield* Snapshot.captureDeduped(history.snapshots, snapshots.capture)
      const batch = withBatch(events)
      const publisher = createLLMEventPublisher(batch.events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const displayBuffer = SessionDisplayBuffer.create(displayConfig.mode)
      const displayParts = new Map<string, { display: string; published?: string }>()
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      const publishDisplay = Effect.fnUntraced(function* (textID: string) {
        const part = displayParts.get(textID)
        if (!part || part.published === part.display) return
        part.published = part.display
        yield* withPublication(
          batch.events.publish(SessionEvent.Text.DisplayUpdated, {
            sessionID: session.id,
            assistantMessageID: yield* publisher.startAssistant(),
            timestamp: yield* DateTime.now,
            textID,
            displayText: part.display,
          }),
        )
      })
      const renderDisplay = Effect.fnUntraced(function* (batch: DisplayBatch | undefined) {
        if (!batch || !turnHooks) return
        const rendered = yield* turnHooks.display({
          sessionID: session.id,
          turnID: displayTurnID,
          messageID: displayMessageID,
          index: batch.index,
          final: batch.final,
          delta: batch.delta,
        })
        const part = displayParts.get(batch.textID)
        if (part) {
          part.display += rendered
          yield* publishDisplay(batch.textID)
        }
      })
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            if (event.type === "text-start" && displayConfig.enabled) {
              displayParts.set(event.id, { display: "" })
              displayBuffer.start(event.id)
            }
            if (event.type === "text-delta") assistantText.push(event.text)
            if (event.type === "tool-call") {
              rawToolBatch.add(event.id)
              toolCalls.push({
                toolName: event.name,
                toolUseID: event.id,
                toolInput: Predicate.isObject(event.input) ? event.input : {},
              })
            }
            if (event.type === "tool-result") {
              const call = toolCalls.find((candidate) => candidate.toolUseID === event.id)
              if (call) call.toolResponse = modelToolResponse({ output: event.output, result: event.result })
            }
            yield* publish(event)
            if (event.type === "text-start" && displayConfig.enabled) yield* publishDisplay(event.id)
            if (event.type === "text-delta" && displayConfig.enabled) {
              yield* renderDisplay(displayBuffer.append(event.id, event.text))
            }
            if (event.type === "reasoning-end" && reasoningEnabled) {
              // Persist the settled part before its rewrite job reads it.
              yield* withPublication(batch.flush())
              yield* rewriteReasoningNow({
                sessionID: session.id,
                messageID: yield* publisher.startAssistant(),
                reasoningID: event.id,
                model,
              })
              return
            }
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* publish(
                LLMEvent.toolResult({
                  id: event.id,
                  name: event.name,
                  result: {
                    type: "error",
                    value: budgetExhausted
                      ? ToolBudget.exhaustedMessage(runBudget.budget.max)
                      : "Tools are disabled after the maximum agent steps",
                  },
                }),
              )
              return
            }
            needsContinuation = true
            // Admission is synchronous and precedes settlement, permissions and side effects.
            // Failed, denied and invalid calls consume their admitted slot.
            if (!runBudget.budget.tryReserve()) {
              yield* publish(
                LLMEvent.toolResult({
                  id: event.id,
                  name: event.name,
                  result: { type: "error", value: ToolBudget.exhaustedMessage(runBudget.budget.max) },
                }),
              )
              return
            }
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* withPublication(batch.flush())
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                  ...(requestedDisplayMode === "interactive" ? {} : { batch: rawToolBatch }),
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  Effect.gen(function* () {
                    const call = toolCalls.find((candidate) => candidate.toolUseID === event.id)
                    if (settlement.deferred) {
                      deferredTool = true
                      yield* withPublication(
                        batch.events.publish(SessionEvent.Tool.Deferred, {
                          sessionID: session.id,
                          timestamp: yield* DateTime.now,
                          assistantMessageID,
                          callID: event.id,
                        }),
                      )
                      return
                    }
                    if (settlement.stopped) stoppedTool = true
                    if (settlement.toolInput) {
                      if (call) call.toolInput = settlement.toolInput
                      yield* withPublication(
                        batch.events.publish(SessionEvent.Tool.InputReplaced, {
                          sessionID: session.id,
                          timestamp: yield* DateTime.now,
                          assistantMessageID,
                          callID: event.id,
                          input: settlement.toolInput,
                        }),
                      )
                    }
                    const result: ToolResultValue =
                      settlement.stopped && !settlement.output && settlement.result.type !== "error"
                        ? { type: "error", value: settlement.stopped }
                        : settlement.result
                    if (call) call.toolResponse = modelToolResponse({ output: settlement.output, result })
                    yield* publish(
                      LLMEvent.toolResult({
                        id: event.id,
                        name: event.name,
                        result,
                        output: settlement.output,
                      }),
                      settlement.outputPaths ?? [],
                    )
                  }),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(
          withPublication(
            Effect.gen(function* () {
              yield* publisher.flush()
              yield* batch.flush()
            }),
          ),
        ),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(
            providerStream.pipe(
              Effect.timeoutOrElse({
                duration: turnTimeout,
                orElse: () => Effect.fail(turnTimeoutError()),
              }),
            ),
          ).pipe(Effect.exit)
          rawToolBatch.finish(stream._tag === "Success")
          if (displayConfig.enabled) yield* renderDisplay(displayBuffer.finish())
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          // The tool wait is bounded by the same per-agent deadline, applied
          // separately after the provider turn: a hung tool fails the turn
          // instead of hanging it forever. Remaining tool fibers are
          // interrupted by the runTurnAttempt scope close.
          const settled = yield* restore(
            awaitToolFibers(toolFibers).pipe(
              Effect.timeoutOrElse({
                duration: turnTimeout,
                orElse: () => Effect.fail(toolWaitTimeoutError()),
              }),
            ),
          ).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            yield* withPublication(batch.flush())
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          if (turnHooks && toolCalls.length > 0 && settled._tag === "Success" && !deferredTool && !stoppedTool)
            yield* Effect.gen(function* () {
              const result = yield* turnHooks.postToolBatch({
                sessionID: session.id,
                toolCalls: toolCalls.map((call) => ({ ...call, toolResponse: call.toolResponse ?? null })),
              })
              if (yield* landBatchFeedback(session.id, result)) stoppedTool = true
            })
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* Snapshot.captureDeduped(history.snapshots, snapshots.capture)
            const files =
              startSnapshot === undefined || endSnapshot === undefined
                ? undefined
                : startSnapshot === endSnapshot
                  ? []
                  : yield* snapshots
                      .files({ from: startSnapshot, to: endSnapshot })
                      .pipe(Effect.catch(() => Effect.succeed(undefined)))
            yield* withPublication(
              batch.events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: deferredTool ? "tool_deferred" : stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError() && !deferredTool)
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          yield* withPublication(batch.flush())
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation && !deferredTool && !stoppedTool,
            step: currentStep,
            lastAssistantMessage: assistantText.join("") || undefined,
            usedTool: toolCalls.length > 0,
            failed: publisher.hasProviderError(),
            providerFailure: publisher.providerFailure(),
            deferred: deferredTool,
            stopped: stoppedTool,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runBudget: RunBudget,
      displayTurnID: string,
      loadBatch?: string,
    ) => Effect.Effect<
      {
        readonly needsContinuation: boolean
        readonly step: number
        readonly lastAssistantMessage?: string
        readonly usedTool?: boolean
        readonly failed?: boolean
        readonly providerFailure?: ProviderErrorEvent
        readonly deferred?: boolean
        readonly stopped?: boolean
      },
      RunError
    >

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (sessionID, promotion, step, runBudget, displayTurnID, loadBatch) {
        return yield* runTurnAttempt(sessionID, promotion, step, runBudget, displayTurnID, undefined, loadBatch).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                sessionID,
                undefined,
                defect.transition.step,
                runBudget,
                displayTurnID,
                crypto.randomUUID(),
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(
      function* (sessionID, promotion, step, runBudget, displayTurnID, loadBatch) {
        return yield* runTurnAttempt(
          sessionID,
          promotion,
          step,
          runBudget,
          displayTurnID,
          compaction.compactAfterOverflow,
          loadBatch,
        ).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              yield* Effect.yieldNow
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* runAfterOverflowCompaction(
                  sessionID,
                  undefined,
                  defect.transition.step,
                  runBudget,
                  displayTurnID,
                  crypto.randomUUID(),
                )
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                runBudget,
                displayTurnID,
                crypto.randomUUID(),
              )
            }),
          ),
        )
      },
    )

    /** Continue a saved single call before admitting another prompt or asking the model again. */
    const resumeDeferredTool = Effect.fn("SessionRunner.resumeDeferredTool")(function* (sessionID: SessionSchema.ID) {
      const pending = (yield* getContext(sessionID))
        .flatMap((message) =>
          message.type === "assistant"
            ? message.content.flatMap((part) =>
                part.type === "tool" && part.state.status === "running" && part.state.deferred
                  ? [{ assistant: message, tool: part }]
                  : [],
              )
            : [],
        )
        .at(-1)
      if (!pending) return "none" as const
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const sourceHooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionSourceHooks.Service))
      if (sourceHooks) yield* sourceHooks.syncAgent({ sessionID, agentID: agent.id })
      const materialized = yield* tools.materialize(agent.info?.permissions)
      const base = {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: pending.assistant.id,
        callID: pending.tool.id,
      }
      if (!materialized.definitions.some((definition) => definition.name === pending.tool.name)) {
        yield* events.publish(SessionEvent.Tool.Unavailable, base)
        return "unavailable" as const
      }
      yield* events.publish(SessionEvent.Tool.Resuming, base)
      const rawBatch = SessionToolBatch.create()
      rawBatch.add(pending.tool.id)
      rawBatch.finish()
      const settlement = yield* materialized.settle({
        sessionID,
        agent: agent.id,
        assistantMessageID: pending.assistant.id,
        call: LLMEvent.toolCall({
          id: pending.tool.id,
          name: pending.tool.name,
          input: pending.tool.state.input,
        }),
        batch: rawBatch,
      })
      if (settlement.deferred) {
        yield* events.publish(SessionEvent.Tool.Deferred, { ...base, timestamp: yield* DateTime.now })
        return "deferred" as const
      }
      if (settlement.toolInput)
        yield* events.publish(SessionEvent.Tool.InputReplaced, {
          ...base,
          timestamp: yield* DateTime.now,
          input: settlement.toolInput,
        })
      const postBatch = Effect.fnUntraced(function* (toolResponse: unknown) {
        const turnHooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionTurnHooks.Service))
        if (!turnHooks) return false
        const result = yield* turnHooks.postToolBatch({
          sessionID,
          toolCalls: [
            {
              toolName: pending.tool.name,
              toolUseID: pending.tool.id,
              toolInput:
                settlement.toolInput ?? (pending.tool.state.status === "running" ? pending.tool.state.input : {}),
              toolResponse,
            },
          ],
        })
        return yield* landBatchFeedback(sessionID, result)
      })
      if (settlement.result.type === "error" || (settlement.stopped && !settlement.output)) {
        yield* events.publish(SessionEvent.Tool.Failed, {
          ...base,
          timestamp: yield* DateTime.now,
          error: {
            type: "unknown",
            message: String(settlement.result.type === "error" ? settlement.result.value : settlement.stopped),
          },
          result: settlement.result,
          provider: { executed: false },
        })
        const stopped = settlement.stopped || (yield* postBatch(modelToolResponse({ result: settlement.result })))
        return stopped ? ("stopped" as const) : ("settled" as const)
      }
      const output = settlement.output ?? ToolOutput.fromResultValue(settlement.result)
      if (!output) return yield* Effect.die("Deferred tool produced an unsupported result")
      yield* events.publish(SessionEvent.Tool.Success, {
        ...base,
        timestamp: yield* DateTime.now,
        structured: Predicate.isObject(output.structured) ? output.structured : { value: output.structured },
        content: output.content,
        outputPaths: settlement.outputPaths ?? [],
        provider: { executed: false },
      })
      return settlement.stopped || (yield* postBatch(modelToolResponse({ output, result: settlement.result })))
        ? ("stopped" as const)
        : ("settled" as const)
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      // Drain-body wrapped with cursor eviction: the incremental-read cache is
      // only useful while this drain runs, so its entry is dropped on every
      // exit (success, failure, interrupt, or early no-work return). A later
      // run falls back to a full store read — correct, and one read per run.
      // Concurrent same-session drains (not expected under the run
      // coordinator) degrade to full reads, never to stale history.
      const stateHooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionTurnHooks.Service))
      let started = false
      let completed = false
      let failed = false
      return yield* Effect.gen(function* () {
        const turnHooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionTurnHooks.Service))
        const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
        if (!input.force && !hasSteer && !hasQueue) return
        started = true
        yield* stateHooks?.state?.(input.sessionID, "busy") ?? Effect.void
        yield* failInterruptedTools(input.sessionID)
        const resumed = yield* resumeDeferredTool(input.sessionID)
        if (resumed === "deferred" || resumed === "unavailable" || resumed === "stopped") return
        let promotion: SessionInput.Delivery | undefined =
          resumed === "settled" ? "steer" : hasSteer ? "steer" : hasQueue ? "queue" : undefined
        let shouldRun = input.force || hasSteer || hasQueue
        let stopContinuations = 0
        let stopHookActive = false
        let lastAssistantMessage: string | undefined
        const displayTurnID = crypto.randomUUID()
        while (shouldRun) {
          let paused = false
          let runBudget = budgets.get(input.sessionID)
          if (!runBudget) {
            runBudget = { budget: yield* newBudget() }
            budgets.set(input.sessionID, runBudget)
          }
          let needsContinuation = true
          let step = 1
          while (needsContinuation) {
            const result = yield* runTurn(input.sessionID, promotion, step, runBudget, displayTurnID).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  if (turnHooks && !Cause.hasInterrupts(cause)) {
                    const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
                    yield* turnHooks.stopFailure({
                      sessionID: input.sessionID,
                      error: failure,
                      ...(failure instanceof LLMError ? { displayedError: failure.reason.message } : {}),
                    })
                  }
                  return yield* Effect.failCause(cause)
                }),
              ),
            )
            if (result.failed) failed = true
            lastAssistantMessage = result.lastAssistantMessage
            if (result.usedTool) stopContinuations = 0
            if (result.deferred || result.stopped) paused = true
            needsContinuation = result.needsContinuation
            step = result.step + 1
            promotion = "steer"
            if (result.failed && turnHooks)
              yield* turnHooks.stopFailure({
                sessionID: input.sessionID,
                error: result.providerFailure,
                displayedError: result.providerFailure?.message,
              })
            if (!needsContinuation && !paused)
              needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
            if (!needsContinuation && !result.failed && !paused && turnHooks) {
              const stopped = yield* turnHooks.stop({
                sessionID: input.sessionID,
                stopHookActive,
                lastAssistantMessage,
              })
              if (stopped.continueWith && stopContinuations < 8) {
                stopContinuations++
                stopHookActive = true
                yield* SessionInput.admit(db, events, {
                  id: SessionMessage.ID.create(),
                  sessionID: input.sessionID,
                  prompt: Prompt.make({
                    text: stopped.continueWith,
                    hookMode: yield* SessionInput.currentHookMode(db, input.sessionID),
                  }),
                  delivery: "steer",
                })
                needsContinuation = true
              }
            }
          }
          if (paused) return
          shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
          promotion = shouldRun ? "queue" : undefined
        }
        completed = !failed
      }).pipe(
        Effect.onExit((exit) =>
          started && stateHooks?.state
            ? stateHooks.state(input.sessionID, completed && exit._tag === "Success" ? "idle" : "cancelled")
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            cursors.delete(input.sessionID)
            pendingRequestContext.delete(input.sessionID)
          }),
        ),
      )
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer
