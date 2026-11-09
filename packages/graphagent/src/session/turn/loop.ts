import { DagMessages } from "@graphagent/core/dag/messages"
import { Database } from "@graphagent/core/database/database"
import { NamedError } from "@graphagent/core/util/error"
import { SessionV1 } from "@graphagent/core/v1/session"
import { randomUUID } from "node:crypto"
import { asSchema } from "ai"
import { Cause, Effect, Exit, Option, type Scope } from "effect"
import type { Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook } from "@/hook"
import { HookToolBatch } from "@/hook/tool-batch"
import { TaskSubagents } from "@/hook/task-subagents"
import { Permission } from "@/permission"
import type { Provider } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { Token } from "@/util/token"
import type { Agent } from "../../agent/agent"
import { MCP } from "../../mcp"
import type { SessionCompaction } from "../compaction"
import type { Instruction } from "../instruction"
import { MessageV2 } from "../message-v2"
import { measured } from "../overflow"
import type { SessionProcessor } from "../processor"
import { MessageID, PartID, type SessionID } from "../schema"
import { Session } from "../session"
import type { SessionStatus } from "../status"
import type { SessionSummary } from "../summary"
import { SessionTools } from "../tools"
import type { ToolSourceLedger } from "../tool-source-ledger"
import type { PrepareApi, TurnRequestInput } from "./prepare"
import { Settle } from "./settle"
import { Stop } from "./stop"

function estimatePendingToolOutputTokens(messages: SessionV1.WithParts[], messageIndex: number) {
  const current = messages[messageIndex]
  if (!current || current.info.role !== "assistant") return 0

  let pending = 0
  for (const part of current.parts) {
    if (part.type !== "tool") continue
    const content =
      part.state.status === "completed" && part.state.time.compacted === undefined
        ? part.state.output
        : part.state.status === "error"
          ? part.state.error
          : undefined
    if (content) pending += Token.estimate(content)
  }
  return pending
}

export interface LoopDeps {
  readonly sessions: Session.Interface
  readonly status: SessionStatus.Interface
  readonly summary: SessionSummary.Interface
  readonly agents: Agent.Interface
  readonly processor: SessionProcessor.Interface
  readonly compaction: SessionCompaction.Interface
  readonly permission: Permission.Interface
  readonly registry: ToolRegistry.Interface
  readonly mcp: MCP.Interface
  readonly truncate: Truncate.Interface
  readonly instruction: Instruction.Interface
  readonly toolSources: ToolSourceLedger.Interface
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly agentMessages: DagMessages.Interface | undefined
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly database: Database.Interface
  readonly db: Database.Interface["db"]
  readonly scope: Scope.Scope
  readonly prepareFns: PrepareApi
  readonly settleFns: ReturnType<typeof Settle.makeSettle>
  readonly stopFns: ReturnType<typeof Stop.makeStop>
  readonly ops: () => Effect.Effect<TaskPromptOps>
  readonly queueReasoning: (input: {
    sessionID: SessionID
    part: SessionV1.ReasoningPart
    model: Provider.Model
  }) => Effect.Effect<void>
  readonly reasoningDistillationEnabled: (model: Provider.Model) => Effect.Effect<boolean>
  readonly getLastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  readonly readRequestOverheads: () => Effect.Effect<TurnRequestInput["requestOverheads"]>
  readonly readRuntimeContexts: () => Effect.Effect<TurnRequestInput["runtimeContexts"]>
  readonly drainRewrites: (sessionID: SessionID) => Effect.Effect<void>
  readonly readScopedAgents: () => Effect.Effect<Map<SessionID, string>>
}

export function makeLoop(deps: LoopDeps) {
  const {
    sessions,
    status,
    summary,
    agents,
    processor,
    compaction,
    permission,
    registry,
    mcp,
    truncate,
    instruction,
    toolSources,
    settingsHook,
    agentMessages,
    events,
    database,
    db,
    scope,
    prepareFns,
    settleFns,
    stopFns,
    ops,
    queueReasoning,
    reasoningDistillationEnabled,
    getLastAssistant,
    readRequestOverheads,
    readRuntimeContexts,
    drainRewrites,
    readScopedAgents,
  } = deps

  const runLoopImpl: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
    function* (sessionID: SessionID) {
      const ctx = yield* InstanceState.context
      let structured: unknown
      let step = 0
      const displayTurnID = randomUUID()
      // Error carried by the assistant message when the turn loop breaks — drives
      // Stop vs StopFailure hook selection at loop exit.
      let turnError: SessionV1.Assistant["error"]
      // stop_hook_active signal: true when this turn is a continuation after a Stop
      // hook returned block. Resets naturally on the next runLoop invocation (a new
      // user prompt starts a fresh turn). See CC stop-hook anti-loop semantics.
      let stopHookBlocked = false
      // Stop-hook continuation counter: caps how many times a blocked Stop hook may
      // drive another model turn, guarding against a hook that ignores
      // stop_hook_active (mirrors task.ts SubagentStop hard limit).
      let stopContinuationCount = 0
      const stopHookContinuationCap = SettingsHook.stopHookBlockCap()
      // When a Stop hook blocks, the agent gets another model turn; this flag skips
      // the "already finished" exit for one iteration so the turn can actually run.
      let forceContinue = false
      // Set when the previous iteration's processor outcome was "break" (turn
      // finished or was blocked, e.g. permission rejected). The top-of-loop
      // finished-check alone misses blocked turns whose finish is "tool-calls",
      // so this flag forces the exit path (and its Stop hook) to fire.
      let turnStopped = false
      let agentInputBlocked = false
      let agentBoundaryApproved = false
      let consecutiveAutoCompactions = 0
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const requestOverheadBySession = yield* readRequestOverheads()
      const runtimeContextBySession = yield* readRuntimeContexts()

      // Runs in the owning request fiber: interruption stops preparation before the next model request.
      // Finalizers only emit timings, so an old attempt cannot overwrite its replacement's status.
      const prepare = <A, E, R>(stage: "memory" | "reasoning" | "tools", effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const startedAt = Date.now()
          const started = performance.now()
          yield* status.set(sessionID, { type: "busy", preparation: { stage, startedAt } })
          const value = yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.logDebug("session preparation", {
                "session.id": sessionID,
                stage,
                durationMs: performance.now() - started,
                outcome: Exit.isSuccess(exit) ? "completed" : Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
              }),
            ),
          )
          yield* status.set(sessionID, { type: "busy" })
          return value
        })

      // Temporary turn boundary until H1 (#1019) lands session turns: the
      // initial user message of this loop invocation identifies the turn.
      let turnUserID: MessageID | undefined

      while (true) {
        yield* status.set(sessionID, { type: "busy" })
        yield* Effect.logInfo("loop", { "session.id": sessionID, step })

        const modelMessageID = MessageID.ascending()
        const identity = { projectID: ctx.project.id, directory: ctx.directory, sessionID }
        let agentSnapshot: DagMessages.Snapshot | undefined
        yield* drainRewrites(sessionID)
        let snapshot = yield* prepareFns.claimSnapshot(sessionID)
        let msgs = snapshot.messages
        let budget = snapshot.budget
        const previous = MessageV2.latest(msgs)
        if (!turnUserID && previous.user) turnUserID = previous.user.id
        const previousParts = msgs.findLast((message) => message.info.id === previous.assistant?.id)?.parts
        const needsStop =
          turnStopped ||
          (previous.assistant?.finish &&
            previous.assistant.finish !== "tool-calls" &&
            !previousParts?.some(
              (part) =>
                part.type === "tool" && !part.metadata?.providerExecuted && !Stop.isOrphanedInterruptedTool(part),
            ) &&
            previous.user &&
            MessageV2.before(previous.user, previous.assistant))
        // Agent input cannot outrun the Stop decision for a completed model turn.
        if (agentMessages && !agentInputBlocked && (!needsStop || agentBoundaryApproved || forceContinue)) {
          agentBoundaryApproved = false
          const frozen = yield* agentMessages.freeze(identity, modelMessageID)
          if (frozen.ok) {
            agentSnapshot = frozen.value
            if (agentSnapshot.messages.length) {
              const history = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
              const user = history.findLast((message) => message.info.role === "user")?.info
              if (!user || user.role !== "user") throw new Error("Agent messages require an existing user context")
              for (const message of agentSnapshot.messages) {
                const messageID = MessageID.make(message.transcriptID)
                // Stable IDs recover admission crashes without duplicating a logical message.
                if (!history.some((existing) => existing.info.id === messageID)) {
                  yield* sessions.updateMessage({
                    id: messageID,
                    sessionID,
                    role: "user",
                    agent: user.agent,
                    model: user.model,
                    format: user.format,
                    system: user.system,
                    tools: user.tools,
                    time: { created: message.timeCreated },
                  })
                }
                yield* sessions.updatePart({
                  id: PartID.make(message.partID),
                  messageID,
                  sessionID,
                  type: "text",
                  text: DagMessages.renderMessage(message),
                  synthetic: true,
                })
              }
              // A clean result becomes stale when newer accepted input is awaiting the model.
              turnStopped = false
              snapshot = yield* prepareFns.claimSnapshot(sessionID)
              msgs = snapshot.messages
              budget = snapshot.budget
            }
          }
        }

        const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

        if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

        const lastAssistantMsg = msgs.findLast(
          (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
        )
        const pendingDeferred = lastAssistantMsg?.parts.find(
          (part): part is SessionV1.ToolPart =>
            part.type === "tool" && part.state.status === "pending" && part.state.deferred === true,
        )
        if (
          pendingDeferred &&
          lastAssistant &&
          ["tool_deferred", "tool_deferred_unavailable"].includes(lastAssistant.finish ?? "")
        ) {
          const model = yield* prepareFns.getModel(lastAssistant.providerID, lastAssistant.modelID, sessionID)
          const agent = yield* agents.get(lastAssistant.agent)
          if (!agent) throw new Error(`Agent not found: "${lastAssistant.agent}"`)
          const handle = yield* processor.create({ assistantMessage: lastAssistant, sessionID, model })
          const tools = yield* SessionTools.resolve({
            agent,
            session,
            model,
            user: lastUser,
            processor: handle,
            bypassAgentCheck: false,
            messages: msgs,
            promptOps: yield* ops(),
            hooks: settingsHook,
            canDefer: !session.parentID && lastUser.hookMode !== "interactive" ? () => true : undefined,
            sourceLedger: toolSources,
          }).pipe(
            Effect.provideService(Permission.Service, permission),
            Effect.provideService(ToolRegistry.Service, registry),
            Effect.provideService(MCP.Service, mcp),
            Effect.provideService(Truncate.Service, truncate),
          )
          const tool = tools[pendingDeferred.tool]
          if (!tool?.execute) {
            lastAssistant.finish = "tool_deferred_unavailable"
            yield* sessions.updateMessage(lastAssistant)
            return yield* getLastAssistant(sessionID)
          }
          yield* handle.resumeToolCall(
            pendingDeferred,
            Effect.tryPromise({
              try: async (signal) => {
                const schema = asSchema(tool.inputSchema)
                const validation = await schema.validate?.(pendingDeferred.state.input)
                if (validation && !validation.success) throw validation.error
                return await tool.execute!(pendingDeferred.state.input, {
                  toolCallId: pendingDeferred.callID,
                  messages: [],
                  abortSignal: signal,
                })
              },
              catch: (error) => error,
            }),
          )
          if (handle.message.finish === "tool_deferred") return yield* getLastAssistant(sessionID)
          // The resumed call completes the assistant's tool batch, which never ran PostToolBatch while deferred.
          const settledBatch = (yield* MessageV2.parts(lastAssistant.id).pipe(
            Effect.provideService(Database.Service, database),
          )).filter(
            (part): part is SessionV1.ToolPart =>
              part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
          )
          if (
            settledBatch.length > 0 &&
            (yield* settleFns.postToolBatch({ sessionID, batch: settledBatch, feedbackMessageID: lastUser.id }))
          ) {
            turnStopped = true
          }
          // Re-read persisted input and settlement before the next model request.
          continue
        }
        const stopped: Stop.StopAttemptResult = yield* stopFns.stopAttempt({
          sessionID,
          session,
          identity,
          lastUser,
          lastAssistant,
          lastAssistantMsg,
          turnUserID,
          turnError,
          turnStopped,
          forceContinue,
          agentInputBlocked,
          agentBoundaryApproved,
          stopHookBlocked,
          stopContinuationCount,
          stopHookContinuationCap,
        })
        // Write the turn-local flags back at the original statement position
        // before acting on the transition, so the next iteration observes the
        // same values and order as the inlined block did.
        forceContinue = stopped.forceContinue
        turnStopped = stopped.turnStopped
        agentBoundaryApproved = stopped.agentBoundaryApproved
        stopHookBlocked = stopped.stopHookBlocked
        stopContinuationCount = stopped.stopContinuationCount
        if (stopped.kind === "continue") continue
        if (stopped.kind === "exit") return yield* getLastAssistant(sessionID)

        forceContinue = false
        step++
        if (step === 1)
          yield* prepareFns
            .ensureTitle({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            })
            .pipe(Effect.ignore, Effect.forkIn(scope))

        const model = yield* prepareFns.getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
        const task = tasks.pop()

        if (task?.type === "subtask") {
          yield* prepareFns.handleSubtask({ task, model, lastUser, sessionID, session, msgs })
          continue
        }

        if (task?.type === "compaction") {
          const result = yield* compaction.process({
            messages: msgs,
            parentID: lastUser.id,
            sessionID,
            auto: task.auto,
            overflow: task.overflow,
          })
          if (result === "stop") break
          continue
        }

        if (lastFinished) {
          const switchedModel = lastFinished.providerID !== model.providerID || lastFinished.modelID !== model.id
          const lastFinishedIndex = msgs.findIndex((message) => message.info.id === lastFinished.id)
          // Message tokens accumulate every request this assistant message made, including the phase-one
          // request a synchronous reasoning split charged before its continuation, so they report cost.
          // The context carries only the latest request: measure that request's step instead, falling back
          // to the accumulated total when no step is persisted.
          const lastRequestTokens =
            (lastFinishedIndex < 0
              ? undefined
              : msgs[lastFinishedIndex]?.parts.findLast(
                  (part): part is SessionV1.StepFinishPart => part.type === "step-finish",
                )?.tokens) ?? lastFinished.tokens
          const observedTokens = lastFinished.summary === true || switchedModel ? 0 : measured(lastRequestTokens)
          const newUsers =
            lastFinishedIndex < 0
              ? []
              : msgs.slice(lastFinishedIndex + 1).filter((message) => message.info.role === "user")
          // Same-model usage reflects the prior prepared request, including folding. Add new user text and
          // pending tool results below. On a model switch, estimate the active projected history.
          // Media is stripped before either estimate and never logged.
          const freshEstimate = switchedModel || lastFinished.summary === true
          const estimateMessages = freshEstimate ? msgs : newUsers
          const estimatedTextTokens = estimateMessages.length
            ? Token.estimateReserve(
                JSON.stringify(
                  yield* MessageV2.toModelMessagesEffect(estimateMessages, model, {
                    stripMedia: true,
                    reasoningDistillationEnabled: yield* reasoningDistillationEnabled(model),
                  }),
                ),
              )
            : 0
          // Provider usage already covers the system text and tool schemas of the previous request, but a
          // switch or post-compaction summary discards it. Reuse the overhead measured on the last prepared
          // request so that estimate still includes what the provider actually receives.
          const estimatedRequestOverhead = freshEstimate ? (requestOverheadBySession.get(sessionID) ?? 0) : 0
          // Provider usage covers the request that produced lastFinished, but not tool results that completed
          // afterward. Each result is still present until a projection actually folds it; text equality alone
          // does not authorize a budget deduction (e.g. bash results are protected from folding).
          const pendingToolOutputTokens = freshEstimate ? 0 : estimatePendingToolOutputTokens(msgs, lastFinishedIndex)
          const estimatedInputTokens = freshEstimate
            ? estimatedTextTokens + estimatedRequestOverhead
            : observedTokens + estimatedTextTokens + pendingToolOutputTokens
          // A compaction leaves only its summary for the next estimate, and compaction cannot shrink the
          // fixed system and tool overhead. Judge only the message portion after a summary: a summary that
          // fits is sent once for its real usage, and a retained tail that still does not fit is compacted
          // again. When the overhead alone exceeds the limit, the provider rejects the request and the
          // overflow recovery path handles it. This also covers a pending compaction task from an earlier
          // loop, whose summary would otherwise re-trigger compaction immediately.
          const overflowEstimate = lastFinished.summary === true ? estimatedTextTokens : estimatedInputTokens
          const tokens =
            lastFinished.summary === true || switchedModel
              ? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
              : lastRequestTokens
          const overflow = yield* compaction.isOverflow({
            tokens,
            model,
            estimatedInputTokens: overflowEstimate,
          })
          if (overflow) {
            if (consecutiveAutoCompactions >= 3) {
              const error = new SessionV1.ContextOverflowError({
                message: "Context still exceeds the model limit after repeated automatic compaction",
              })
              yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
              throw error
            }
            consecutiveAutoCompactions++
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }
          consecutiveAutoCompactions = 0
        }

        const agent = yield* agents.get(lastUser.agent)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
          yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
          throw error
        }
        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps
        const toolLimitReached = budget.exhausted
        const toolsDisabled = isLastStep || toolLimitReached

        const msg: SessionV1.Assistant = {
          id: modelMessageID,
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.model.variant,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
          sessionID,
        }
        yield* sessions.updateMessage(msg)
        const finalizeFailedAssistant = (cause: Cause.Cause<never>) =>
          settleFns.finalizeFailed({ cause, sessionID, msg, identity, modelMessageID, agentSnapshot })

        const toolBatch = HookToolBatch.create()
        const displayEnabled = settingsHook?.hasEvent
          ? yield* settingsHook.hasEvent("MessageDisplay", sessionID)
          : false
        const displayMessageID = randomUUID()
        const handle = yield* processor
          .create({
            assistantMessage: msg,
            sessionID,
            model,
            onReasoningSettled: (part) => queueReasoning({ sessionID, part, model }),
            displayMode: lastUser.hookMode ?? "noninteractive",
            ...(displayEnabled && settingsHook
              ? {
                  onTextDisplay: (batch: { delta: string; index: number; final: boolean }) =>
                    settingsHook
                      .trigger(
                        {
                          event: "MessageDisplay",
                          turnID: displayTurnID,
                          messageID: displayMessageID,
                          ...batch,
                        },
                        { sessionID },
                      )
                      .pipe(Effect.map((result) => result.displayContent ?? batch.delta)),
                }
              : {}),
          })
          .pipe(Effect.onError(finalizeFailedAssistant))

        // A later input must produce its own structured response.
        structured = undefined

        const outcome: "break" | "continue" = yield* Effect.gen(function* () {
          const format = lastUser.format ?? { type: "text" as const }
          const { processInput } = yield* prepareFns.buildTurnRequest({
            sessionID,
            session,
            messages: msgs,
            budget,
            model,
            format,
            toolBatch,
            toolsDisabled,
            user: lastUser,
            agent,
            handle,
            toolLimitReached,
            identity,
            agentSnapshot,
            prepareStage: prepare,
            requestOverheads: requestOverheadBySession,
            runtimeContexts: runtimeContextBySession,
            onStructured: (output) => {
              structured = output
            },
          })
          const modelStarted = performance.now()
          const result = yield* handle.process(processInput).pipe(
            Effect.onExit((exit) =>
              Effect.logDebug("session model request", {
                "session.id": sessionID,
                durationMs: performance.now() - modelStarted,
                outcome: Exit.isSuccess(exit) ? "completed" : Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
              }),
            ),
          )
          const settled = yield* settleFns.settleAttempt({
            sessionID,
            lastUser,
            msg,
            handle,
            format,
            result,
            structured,
            toolsDisabled,
            isLastStep,
            toolLimitReached,
            agentInputBlocked,
            agentSnapshot,
            identity,
          })
          if (settled.resetStopContinuations) stopContinuationCount = 0
          agentInputBlocked = settled.agentInputBlocked
          return settled.outcome
        }).pipe(Effect.ensuring(instruction.clear(handle.message.id)), Effect.onError(finalizeFailedAssistant))
        // Semantic errors can be assigned after the processor returns (for
        // example a missing structured response). They share the same permanent
        // stop boundary as transport errors and cannot re-admit late input.
        if (!agentInputBlocked && (handle.message.error || isLastStep)) {
          agentInputBlocked = true
          if (agentMessages) {
            const reason = handle.message.error ? "model_error" : "budget_exhausted"
            if (agentSnapshot) yield* agentMessages.markStopped(identity, agentSnapshot.id, reason)
            yield* agentMessages.discardPending(identity, reason)
          }
        }
        if (handle.message.finish === "tool_deferred") return yield* getLastAssistant(sessionID)

        // The turn finished (outcome "break") or is ongoing (tool calls). Either way
        // loop back: the finished-check at the top of the next iteration fires the
        // Stop hook and returns once the agent is truly done. turnStopped covers
        // blocked turns (permission rejected) whose finish is still "tool-calls".
        turnStopped = outcome === "break"
        if (outcome === "break") turnError = handle.message.error
        continue
      }
      // The compaction "stop" task breaks out of the step loop; it is still a
      // successful turn exit, so summarize here as well.
      if (turnUserID) yield* summary.summarizeTurn({ sessionID, userMessageIDs: [turnUserID] }).pipe(Effect.ignore)
      return yield* getLastAssistant(sessionID)
    },
  )

  const runLoop = (sessionID: SessionID): Effect.Effect<SessionV1.WithParts> =>
    runLoopImpl(sessionID).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionID).pipe(Effect.option)
          if (Option.isNone(session) || !session.value.parentID || TaskSubagents.delegateStop(sessionID)) return
          const active = yield* readScopedAgents()
          const origin = active.get(sessionID)
          if (origin && settingsHook?.unregisterScoped) yield* settingsHook.unregisterScoped(sessionID, origin)
          active.delete(sessionID)
        }),
      ),
      Effect.onError((cause: Cause.Cause<never>) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                if (!agentMessages || Cause.hasInterrupts(cause)) return
                const ctx = yield* InstanceState.context
                const identity = { projectID: ctx.project.id, directory: ctx.directory, sessionID }
                const latest = yield* agentMessages.latestSnapshot(identity)
                if (!latest.ok || !latest.value) return
                const input = latest.value
                yield* agentMessages.markStopped(
                  identity,
                  input.id,
                  input.associated ? "model_error" : "preparation_failed",
                )
                if (input.associated) yield* agentMessages.discardPending(identity, "model_error")
                const history = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
                if (history.some((message) => message.info.id === input.logicalTurnID)) return
                const user = history.findLast((message) => message.info.role === "user")?.info
                if (!user || user.role !== "user") return
                const now = Date.now()
                // Earlier preparation failures precede processor creation. Record
                // their exact turn so a retained inbox cannot reset it on every wake.
                yield* sessions.updateMessage({
                  id: MessageID.make(input.logicalTurnID),
                  parentID: user.id,
                  role: "assistant",
                  mode: user.agent,
                  agent: user.agent,
                  variant: user.model.variant,
                  path: { cwd: ctx.directory, root: ctx.worktree },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: user.model.modelID,
                  providerID: user.model.providerID,
                  time: { created: now, completed: now },
                  sessionID,
                  error: MessageV2.fromError(Cause.squash(cause), { providerID: user.model.providerID }),
                })
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.orDie,
            Effect.catchCause((failure) =>
              Effect.logWarning("failed to record DAG input preparation error", {
                sessionID,
                cause: Cause.pretty(failure),
              }),
            ),
          ),
      ),
    )

  return { runLoop }
}

export * as Loop from "./loop"
