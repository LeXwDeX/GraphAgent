import { adoptReasoning } from "../reasoning-distillation/adopt"
import { assessCanonicalReasoning } from "../reasoning-distillation/canonical"
import { declaresNoReasoning, engineOrganizerCall } from "../reasoning-distillation/engine"
import { makeRewriteBudget, rewriteLogFields, runReasoningRewrite } from "../reasoning-distillation/rewrite"
import { makeRewriteScheduler } from "../reasoning-distillation/schedule"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  TransportReason,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Deferred, Duration, Effect, FiberSet, Layer, Option, Scope, Semaphore, Stream } from "effect"
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
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessagesWithBindings } from "./to-llm-message"
import { CoreContextFolding } from "./context-folding"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { ToolBudget } from "../tool-budget"
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
    const scope = yield* Scope.Scope
    const rewrites = makeRewriteScheduler<true>(scope, {
      settleMs: () => Flag.OPENCODE_REASONING_DISTILLATION_SETTLE_MS,
    })
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
    const compaction = SessionCompaction.make({ events, llm, config: configEntries })
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
              modelID: model.configID ?? model.id,
              apiModelID: model.id,
            }).enabled,
        ),
      )

    // Start rewriting a reasoning part as soon as it ends, overlapping the rest of the step and its tools. The next
    // provider request of the session settles these jobs first (see runTurnAttempt).
    const scheduleReasoningRewrite = Effect.fnUntraced(function* (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      reasoningID: string
      model: SessionRunnerModel.ResolvedModel
    }) {
      const source = yield* store.message(input.messageID)
      const reasoning =
        source?.sessionID === input.sessionID && source.message.type === "assistant"
          ? source.message.content.find((part) => part.id === input.reasoningID && part.type === "reasoning")
          : undefined
      if (reasoning?.type !== "reasoning") return
      yield* rewrites.submit({
        sessionID: input.sessionID,
        key: JSON.stringify([input.messageID, input.reasoningID]),
        inputCharacters: reasoning.text.length,
        enabled: reasoningRewriteEnabled(input.model),
        run: (canAdopt, onResponseStarted) =>
          Effect.gen(function* () {
            const stored = yield* store.message(input.messageID)
            const parts =
              stored?.sessionID === input.sessionID && stored.message.type === "assistant"
                ? stored.message.content.filter((item) => item.id === input.reasoningID)
                : []
            const part = parts.length === 1 && parts[0].type === "reasoning" ? parts[0] : undefined
            if (!part) return undefined
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
              return undefined
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
              onResponseStarted,
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
                  canAdopt,
                }).pipe(Effect.map((adopted) => (adopted ? (true as const) : undefined))),
            })
            yield* Effect.logInfo(
              "reasoning distillation",
              rewriteLogFields(outcome, {
                runtime: "core-runner",
                ...(auxiliaryModel ? { model: String(auxiliaryModel.id) } : {}),
              }),
            )
            return outcome.adopted
          }),
      })
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

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    type RunBudget = { budget: ToolBudget.Budget }
    // Resuming a completed, failed or interrupted drain is still the same input.
    // Keep admission state until a new input is promoted, the Session is deleted,
    // or this Location-scoped runner is disposed.
    const budgets = new Map<SessionSchema.ID, RunBudget>()
    yield* Effect.addFinalizer(() => Effect.sync(() => budgets.clear()))
    yield* events.subscribe(SessionV1.Event.Deleted).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = SessionSchema.ID.make(event.data.sessionID)
          budgets.delete(sessionID)
          // Pending reasoning rewrites of a deleted session can never adopt; stop their model calls now.
          rewriteBudget.forget(sessionID)
          yield* rewrites.cancel(sessionID)
        }),
      ),
      Effect.forkScoped,
    )
    const newBudget = () =>
      config.entries().pipe(Effect.map((entries) => ToolBudget.create(Config.latest(entries, "maxToolCalls"))))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runBudget: RunBudget,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const turnTimeout = yield* resolveTurnTimeout(agent.id)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
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
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session)
      // Send barrier: adopt finished reasoning rewrites before this request reads history; seal the rest so a part is
      // rewritten before its first resend or never. Adoption changes earlier messages, so drop the incremental cursor.
      if ((yield* rewrites.settle(session.id)).length > 0) cursors.delete(session.id)
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
        system: [agent.info?.system, system.baseline]
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
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
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
            yield* publish(event)
            if (event.type === "reasoning-end" && reasoningEnabled) {
              // Persist the settled part before its rewrite job reads it.
              yield* withPublication(batch.flush())
              yield* scheduleReasoningRewrite({
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
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
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
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          yield* withPublication(batch.flush())
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runBudget: RunBudget,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, runBudget) {
      return yield* runTurnAttempt(sessionID, promotion, step, runBudget).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, runBudget)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, runBudget) {
      return yield* runTurnAttempt(sessionID, promotion, step, runBudget, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, runBudget)
            return yield* runTurn(sessionID, undefined, defect.transition.step, runBudget)
          }),
        ),
      )
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
      return yield* Effect.gen(function* () {
        const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
        if (!input.force && !hasSteer && !hasQueue) return
        yield* failInterruptedTools(input.sessionID)
        let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
        let shouldRun = input.force || hasSteer || hasQueue
        while (shouldRun) {
          let runBudget = budgets.get(input.sessionID)
          if (!runBudget) {
            runBudget = { budget: yield* newBudget() }
            budgets.set(input.sessionID, runBudget)
          }
          let needsContinuation = true
          let step = 1
          while (needsContinuation) {
            const result = yield* runTurn(input.sessionID, promotion, step, runBudget)
            needsContinuation = result.needsContinuation
            step = result.step + 1
            promotion = "steer"
            if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          }
          shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
          promotion = shouldRun ? "queue" : undefined
        }
      }).pipe(Effect.ensuring(Effect.sync(() => cursors.delete(input.sessionID))))
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer
