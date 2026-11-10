// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DagMessages } from "@graphagent/core/dag/messages"
import { Database } from "@graphagent/core/database/database"
import type { ToolBudget } from "@graphagent/core/session/tool-budget"
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
import type { Handle as ProcessorHandle, SessionProcessor } from "../processor"
import { MessageID, PartID, type SessionID } from "../schema"
import { Session } from "../session"
import type { SessionStatus } from "../status"
import type { SessionSummary } from "../summary"
import { SessionTools } from "../tools"
import type { ToolSourceLedger } from "../tool-source-ledger"
import type { TurnExecution } from "../turns"
import { Decide } from "./decide"
import type { PrepareApi, TurnRequestInput } from "./prepare"
import { Settle } from "./settle"
import { State, type TurnState } from "./state"
import { Stop } from "./stop"

/**
 * Session turn loop (Issue #1019, PR7).
 *
 * The loop owns effects and ordering; `State` holds every mutable turn flag and
 * `Decide` makes the pure transition choice. The two-phase protocol is:
 * `decide` -> `run_stop_hooks` / `check_step_input` -> `decide` again. Each
 * effect runs only when the pre-refactor inline code ran it, so H0 engine
 * counters and admission behavior stay unchanged.
 */

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
  /** H2 seam (#1021 PR3): `false` means this process saw no queued agent
   * message for the session, so the byte-verified mailbox freeze read may be
   * skipped. False positives are allowed (the freeze still governs delivery).
   * E1 installs no provider — the SessionInbox claim protocol that supplies the
   * hint and the "not a node session" exclusion lands with H2. */
  readonly agentInputHint?: (sessionID: SessionID) => boolean
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

type ClaimedSnapshot = {
  readonly messages: SessionV1.WithParts[]
  readonly budget: ToolBudget.Budget
}

function isPendingLocalTool(part: SessionV1.Part) {
  return part.type === "tool" && !part.metadata?.providerExecuted && !Stop.isOrphanedInterruptedTool(part)
}

function makePrepareStage(deps: LoopDeps) {
  const { status } = deps
  // Runs in the owning request fiber: interruption stops preparation before the
  // next model request. Finalizers only emit timings, so an old attempt cannot
  // overwrite its replacement's status.
  return (sessionID: SessionID) =>
    <A, E, R>(stage: "memory" | "reasoning" | "tools", effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
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
}

interface AgentInputGateInput {
  readonly sessionID: SessionID
  readonly identity: DagMessages.Caller
  readonly modelMessageID: MessageID
  readonly messages: SessionV1.WithParts[]
  readonly budget: ToolBudget.Budget
  readonly state: TurnState
  readonly completed: boolean
}

interface AgentInputGateResult {
  readonly state: TurnState
  readonly snapshot: ClaimedSnapshot
  readonly agentSnapshot: DagMessages.Snapshot | undefined
}

function makeAgentInputGate(deps: LoopDeps) {
  const { sessions, agentMessages, prepareFns, database } = deps
  return Effect.fnUntraced(function* (input: AgentInputGateInput): Effect.fn.Return<AgentInputGateResult> {
    let state = input.state
    let agentSnapshot: DagMessages.Snapshot | undefined
    // H2 seam: a denied hint skips the freeze query for sessions this process
    // observed with no queued agent message. No provider is installed in E1,
    // so the hint is `undefined` and the freeze path below is unchanged; only
    // the transition hook plus the SessionInbox in H2 may narrow it further.
    const hinted = deps.agentInputHint?.(input.sessionID)
    if (
      !agentMessages ||
      state.agentInput === "blocked" ||
      hinted === false ||
      !Decide.shouldFreezeAgentInput(state, input.completed)
    ) {
      return { state, snapshot: { messages: input.messages, budget: input.budget }, agentSnapshot }
    }
    // Agent input cannot outrun the Stop decision for a completed model turn.
    state = State.clearBoundaryApproval(state)
    const frozen = yield* agentMessages.freeze(input.identity, input.modelMessageID)
    if (!frozen.ok) return { state, snapshot: { messages: input.messages, budget: input.budget }, agentSnapshot }
    agentSnapshot = frozen.value
    if (!agentSnapshot.messages.length) {
      return { state, snapshot: { messages: input.messages, budget: input.budget }, agentSnapshot }
    }
    const users = yield* MessageV2.recentUsers({ sessionID: input.sessionID, limit: 1 }).pipe(
      Effect.provideService(Database.Service, database),
      Effect.orDie,
    )
    const user = users.at(-1)?.info
    if (!user || user.role !== "user") throw new Error("Agent messages require an existing user context")
    for (const message of agentSnapshot.messages) {
      const messageID = MessageID.make(message.transcriptID)
      // Stable IDs recover admission crashes without duplicating a logical message.
      const recorded = yield* MessageV2.exists({ sessionID: input.sessionID, messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (!recorded) {
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: input.sessionID,
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
        sessionID: input.sessionID,
        type: "text",
        text: DagMessages.renderMessage(message),
        synthetic: true,
      })
    }
    // A clean result becomes stale when newer accepted input is awaiting the model.
    state = State.clearStopped(state)
    return { state, snapshot: yield* prepareFns.claimSnapshot(input.sessionID), agentSnapshot }
  })
}

type DeferredResumeResult =
  | { readonly kind: "none" }
  | { readonly kind: "continue"; readonly stopped: boolean }
  | { readonly kind: "return"; readonly message: SessionV1.WithParts }

function makeDeferredResumer(deps: LoopDeps) {
  const {
    sessions,
    database,
    agents,
    processor,
    permission,
    registry,
    mcp,
    truncate,
    settingsHook,
    toolSources,
    prepareFns,
    settleFns,
    ops,
    getLastAssistant,
  } = deps
  return Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    session: Session.Info
    msgs: SessionV1.WithParts[]
    lastUser: SessionV1.User
    lastAssistant: SessionV1.Assistant | undefined
    lastAssistantMsg: SessionV1.WithParts | undefined
  }): Effect.fn.Return<DeferredResumeResult> {
    const pendingDeferred = input.lastAssistantMsg?.parts.find(
      (part): part is SessionV1.ToolPart =>
        part.type === "tool" && part.state.status === "pending" && part.state.deferred === true,
    )
    if (
      !pendingDeferred ||
      !input.lastAssistant ||
      !["tool_deferred", "tool_deferred_unavailable"].includes(input.lastAssistant.finish ?? "")
    ) {
      return { kind: "none" }
    }
    const model = yield* prepareFns.getModel(
      input.lastAssistant.providerID,
      input.lastAssistant.modelID,
      input.sessionID,
    )
    const agent = yield* agents.get(input.lastAssistant.agent)
    if (!agent) throw new Error(`Agent not found: "${input.lastAssistant.agent}"`)
    // The snapshot history is frozen; the processor owns a mutable copy of the
    // deferred assistant it is finishing. The stored transcript is updated
    // through `sessions.updateMessage`, not through the view.
    const assistantMessage = structuredClone(input.lastAssistant)
    const handle = yield* processor.create({
      assistantMessage,
      sessionID: input.sessionID,
      model,
    })
    const tools = yield* SessionTools.resolve({
      agent,
      session: input.session,
      model,
      user: input.lastUser,
      processor: handle,
      bypassAgentCheck: false,
      messages: input.msgs,
      promptOps: yield* ops(),
      hooks: settingsHook,
      canDefer: !input.session.parentID && input.lastUser.hookMode !== "interactive" ? () => true : undefined,
      sourceLedger: toolSources,
    }).pipe(
      Effect.provideService(Permission.Service, permission),
      Effect.provideService(ToolRegistry.Service, registry),
      Effect.provideService(MCP.Service, mcp),
      Effect.provideService(Truncate.Service, truncate),
    )
    const tool = tools[pendingDeferred.tool]
    if (!tool?.execute) {
      assistantMessage.finish = "tool_deferred_unavailable"
      yield* sessions.updateMessage(assistantMessage)
      return { kind: "return", message: yield* getLastAssistant(input.sessionID) }
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
    if (handle.message.finish === "tool_deferred")
      return { kind: "return", message: yield* getLastAssistant(input.sessionID) }
    // The resumed call completes the assistant's tool batch, which never ran PostToolBatch while deferred.
    const settledBatch = (yield* MessageV2.parts(input.lastAssistant.id).pipe(
      Effect.provideService(Database.Service, database),
    )).filter(
      (part): part is SessionV1.ToolPart =>
        part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
    )
    if (
      settledBatch.length > 0 &&
      (yield* settleFns.postToolBatch({
        sessionID: input.sessionID,
        batch: settledBatch,
        feedbackMessageID: input.lastUser.id,
      }))
    ) {
      return { kind: "continue", stopped: true }
    }
    // Re-read persisted input and settlement before the next model request.
    return { kind: "continue", stopped: false }
  })
}

type TaskRunResult = { readonly kind: "none" | "continue" | "finish" }

function makeTaskRunner(deps: LoopDeps) {
  const { prepareFns, compaction } = deps
  return Effect.fnUntraced(function* (input: {
    task: SessionV1.CompactionPart | SessionV1.SubtaskPart | undefined
    model: Provider.Model
    lastUser: SessionV1.User
    sessionID: SessionID
    session: Session.Info
    msgs: SessionV1.WithParts[]
  }): Effect.fn.Return<TaskRunResult> {
    if (input.task?.type === "subtask") {
      yield* prepareFns.handleSubtask({
        task: input.task,
        model: input.model,
        lastUser: input.lastUser,
        sessionID: input.sessionID,
        session: input.session,
        msgs: input.msgs,
      })
      return { kind: "continue" }
    }
    if (input.task?.type === "compaction") {
      const result = yield* compaction.process({
        messages: input.msgs,
        parentID: input.lastUser.id,
        sessionID: input.sessionID,
        auto: input.task.auto,
        overflow: input.task.overflow,
      })
      return { kind: result === "stop" ? "finish" : "continue" }
    }
    return { kind: "none" }
  })
}

type OverflowGateResult = { readonly kind: "none" | "continue"; readonly state: TurnState }

function makeOverflowGate(deps: LoopDeps) {
  const { compaction, events, reasoningDistillationEnabled } = deps
  return Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    state: TurnState
    lastUser: SessionV1.User
    lastFinished: SessionV1.Assistant | undefined
    msgs: SessionV1.WithParts[]
    model: Provider.Model
    requestOverheads: TurnRequestInput["requestOverheads"]
  }): Effect.fn.Return<OverflowGateResult> {
    if (!input.lastFinished) return { kind: "none", state: input.state }
    const switchedModel =
      input.lastFinished.providerID !== input.model.providerID || input.lastFinished.modelID !== input.model.id
    const lastFinishedIndex = input.msgs.findIndex((message) => message.info.id === input.lastFinished?.id)
    // Message tokens accumulate every request this assistant message made, including the phase-one
    // request a synchronous reasoning split charged before its continuation, so they report cost.
    // The context carries only the latest request: measure that request's step instead, falling back
    // to the accumulated total when no step is persisted.
    const lastRequestTokens =
      (lastFinishedIndex < 0
        ? undefined
        : input.msgs[lastFinishedIndex]?.parts.findLast(
            (part): part is SessionV1.StepFinishPart => part.type === "step-finish",
          )?.tokens) ?? input.lastFinished.tokens
    const observedTokens = input.lastFinished.summary === true || switchedModel ? 0 : measured(lastRequestTokens)
    const newUsers =
      lastFinishedIndex < 0
        ? []
        : input.msgs.slice(lastFinishedIndex + 1).filter((message) => message.info.role === "user")
    // Same-model usage reflects the prior prepared request, including folding. Add new user text and
    // pending tool results below. On a model switch, estimate the active projected history.
    // Media is stripped before either estimate and never logged.
    const freshEstimate = switchedModel || input.lastFinished.summary === true
    const estimateMessages = freshEstimate ? input.msgs : newUsers
    const estimatedTextTokens = estimateMessages.length
      ? Token.estimateReserve(
          JSON.stringify(
            yield* MessageV2.toModelMessagesEffect(estimateMessages, input.model, {
              stripMedia: true,
              reasoningDistillationEnabled: yield* reasoningDistillationEnabled(input.model),
            }),
          ),
        )
      : 0
    // Provider usage already covers the system text and tool schemas of the previous request, but a
    // switch or post-compaction summary discards it. Reuse the overhead measured on the last prepared
    // request so that estimate still includes what the provider actually receives.
    const estimatedRequestOverhead = freshEstimate ? (input.requestOverheads.get(input.sessionID) ?? 0) : 0
    // Provider usage covers the request that produced lastFinished, but not tool results that completed
    // afterward. Each result is still present until a projection actually folds it; text equality alone
    // does not authorize a budget deduction (e.g. bash results are protected from folding).
    const pendingToolOutputTokens = freshEstimate ? 0 : estimatePendingToolOutputTokens(input.msgs, lastFinishedIndex)
    const estimatedInputTokens = freshEstimate
      ? estimatedTextTokens + estimatedRequestOverhead
      : observedTokens + estimatedTextTokens + pendingToolOutputTokens
    // A compaction leaves only its summary for the next estimate, and compaction cannot shrink the
    // fixed system and tool overhead. Judge only the message portion after a summary: a summary that
    // fits is sent once for its real usage, and a retained tail that still does not fit is compacted
    // again. When the overhead alone exceeds the limit, the provider rejects the request and the
    // overflow recovery path handles it. This also covers a pending compaction task from an earlier
    // loop, whose summary would otherwise re-trigger compaction immediately.
    const overflowEstimate = input.lastFinished.summary === true ? estimatedTextTokens : estimatedInputTokens
    const tokens =
      input.lastFinished.summary === true || switchedModel
        ? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        : lastRequestTokens
    const overflow = yield* compaction.isOverflow({
      tokens,
      model: input.model,
      estimatedInputTokens: overflowEstimate,
    })
    const transition = Decide.decideOverflow(input.state, { overflow })
    if (transition.kind === "compact") {
      const state = State.recordAutoCompaction(input.state)
      yield* compaction.create({
        sessionID: input.sessionID,
        agent: input.lastUser.agent,
        model: input.lastUser.model,
        auto: true,
      })
      return { kind: "continue", state }
    }
    if (transition.kind === "finish") {
      const error = new SessionV1.ContextOverflowError({
        message: "Context still exceeds the model limit after repeated automatic compaction",
      })
      yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
      throw error
    }
    return { kind: "none", state: State.resetAutoCompactions(input.state) }
  })
}

type ModelStepResult = { readonly state: TurnState; readonly outcome: "break" | "continue" }

function makeModelStep(deps: LoopDeps) {
  const { prepareFns, settleFns, instruction } = deps
  return Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    session: Session.Info
    identity: DagMessages.Caller
    lastUser: SessionV1.User
    model: Provider.Model
    msgs: SessionV1.WithParts[]
    budget: ToolBudget.Budget
    state: TurnState
    msg: SessionV1.Assistant
    handle: ProcessorHandle
    agent: Agent.Info
    toolBatch: ReturnType<typeof HookToolBatch.create>
    toolsDisabled: boolean
    isLastStep: boolean
    toolLimitReached: boolean
    agentSnapshot: DagMessages.Snapshot | undefined
    requestOverheads: TurnRequestInput["requestOverheads"]
    runtimeContexts: TurnRequestInput["runtimeContexts"]
    prepareStage: TurnRequestInput["prepareStage"]
    finalizeFailedAssistant: (cause: Cause.Cause<never>) => Effect.Effect<void>
  }): Effect.fn.Return<ModelStepResult> {
    // A later input must produce its own structured response.
    let state = State.clearStructured(input.state)
    let structured: unknown
    const outcome: "break" | "continue" = yield* Effect.gen(function* () {
      const format = input.lastUser.format ?? { type: "text" as const }
      const { processInput } = yield* prepareFns.buildTurnRequest({
        sessionID: input.sessionID,
        session: input.session,
        messages: input.msgs,
        budget: input.budget,
        model: input.model,
        format,
        toolBatch: input.toolBatch,
        toolsDisabled: input.toolsDisabled,
        user: input.lastUser,
        agent: input.agent,
        handle: input.handle,
        toolLimitReached: input.toolLimitReached,
        identity: input.identity,
        agentSnapshot: input.agentSnapshot,
        prepareStage: input.prepareStage,
        requestOverheads: input.requestOverheads,
        runtimeContexts: input.runtimeContexts,
        onStructured: (output) => {
          structured = output
        },
      })
      const modelStarted = performance.now()
      const result = yield* input.handle.process(processInput).pipe(
        Effect.onExit((exit) =>
          Effect.logDebug("session model request", {
            "session.id": input.sessionID,
            durationMs: performance.now() - modelStarted,
            outcome: Exit.isSuccess(exit) ? "completed" : Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
          }),
        ),
      )
      const settled = yield* settleFns.settleAttempt({
        sessionID: input.sessionID,
        lastUser: input.lastUser,
        msg: input.msg,
        handle: input.handle,
        format,
        result,
        structured,
        toolsDisabled: input.toolsDisabled,
        isLastStep: input.isLastStep,
        toolLimitReached: input.toolLimitReached,
        agentInputBlocked: state.agentInput === "blocked",
        agentSnapshot: input.agentSnapshot,
        identity: input.identity,
      })
      if (settled.resetStopContinuations) state = State.resetStopContinuations(state)
      if (settled.agentInputBlocked) state = State.blockAgentInput(state)
      return settled.outcome
    }).pipe(Effect.ensuring(instruction.clear(input.handle.message.id)), Effect.onError(input.finalizeFailedAssistant))
    state = structured === undefined ? State.clearStructured(state) : State.setStructured(state, structured)
    return { state, outcome }
  })
}

type AttemptRunResult =
  | { readonly kind: "continue"; readonly state: TurnState }
  | { readonly kind: "return"; readonly message: SessionV1.WithParts; readonly state: TurnState }

function makeAttemptRunner(deps: LoopDeps) {
  const {
    sessions,
    agents,
    processor,
    settingsHook,
    agentMessages,
    events,
    settleFns,
    queueReasoning,
    getLastAssistant,
  } = deps
  const modelStep = makeModelStep(deps)
  return Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    session: Session.Info
    identity: DagMessages.Caller
    lastUser: SessionV1.User
    modelMessageID: MessageID
    model: Provider.Model
    msgs: SessionV1.WithParts[]
    budget: ToolBudget.Budget
    state: TurnState
    step: number
    displayTurnID: string
    agentSnapshot: DagMessages.Snapshot | undefined
    requestOverheads: TurnRequestInput["requestOverheads"]
    runtimeContexts: TurnRequestInput["runtimeContexts"]
    prepareStage: TurnRequestInput["prepareStage"]
    cwd: string
    root: string
  }): Effect.fn.Return<AttemptRunResult> {
    const agent = yield* agents.get(input.lastUser.agent)
    if (!agent) {
      const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${input.lastUser.agent}".${hint}` })
      yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
      throw error
    }
    const maxSteps = agent.steps ?? Infinity
    const isLastStep = input.step >= maxSteps
    const toolLimitReached = input.budget.exhausted
    const toolsDisabled = isLastStep || toolLimitReached

    const msg: SessionV1.Assistant = {
      id: input.modelMessageID,
      parentID: input.lastUser.id,
      role: "assistant",
      mode: agent.name,
      agent: agent.name,
      variant: input.lastUser.model.variant,
      path: { cwd: input.cwd, root: input.root },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model.id,
      providerID: input.model.providerID,
      time: { created: Date.now() },
      sessionID: input.sessionID,
    }
    yield* sessions.updateMessage(msg)
    const finalizeFailedAssistant = (cause: Cause.Cause<never>) =>
      settleFns.finalizeFailed({
        cause,
        sessionID: input.sessionID,
        msg,
        identity: input.identity,
        modelMessageID: input.modelMessageID,
        agentSnapshot: input.agentSnapshot,
      })

    const toolBatch = HookToolBatch.create()
    const displayEnabled = settingsHook?.hasEvent
      ? yield* settingsHook.hasEvent("MessageDisplay", input.sessionID)
      : false
    const displayMessageID = randomUUID()
    const handle = yield* processor
      .create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model: input.model,
        onReasoningSettled: (part) => queueReasoning({ sessionID: input.sessionID, part, model: input.model }),
        displayMode: input.lastUser.hookMode ?? "noninteractive",
        ...(displayEnabled && settingsHook
          ? {
              onTextDisplay: (batch: { delta: string; index: number; final: boolean }) =>
                settingsHook
                  .trigger(
                    {
                      event: "MessageDisplay",
                      turnID: input.displayTurnID,
                      messageID: displayMessageID,
                      ...batch,
                    },
                    { sessionID: input.sessionID },
                  )
                  .pipe(Effect.map((result) => result.displayContent ?? batch.delta)),
            }
          : {}),
      })
      .pipe(Effect.onError(finalizeFailedAssistant))

    const step = yield* modelStep({
      sessionID: input.sessionID,
      session: input.session,
      identity: input.identity,
      lastUser: input.lastUser,
      model: input.model,
      msgs: input.msgs,
      budget: input.budget,
      state: input.state,
      msg,
      handle,
      agent,
      toolBatch,
      toolsDisabled,
      isLastStep,
      toolLimitReached,
      agentSnapshot: input.agentSnapshot,
      requestOverheads: input.requestOverheads,
      runtimeContexts: input.runtimeContexts,
      prepareStage: input.prepareStage,
      finalizeFailedAssistant,
    })
    let state = step.state
    // Semantic errors can be assigned after the processor returns (for example
    // a missing structured response). They share the same permanent stop
    // boundary as transport errors and cannot re-admit late input.
    if (state.agentInput !== "blocked" && (handle.message.error || isLastStep)) {
      state = State.blockAgentInput(state)
      if (agentMessages) {
        const reason = handle.message.error ? "model_error" : "budget_exhausted"
        if (input.agentSnapshot) {
          yield* agentMessages.markStopped(input.identity, input.agentSnapshot.id, reason)
        }
        yield* agentMessages.discardPending(input.identity, reason)
      }
    }
    if (handle.message.finish === "tool_deferred") {
      return { kind: "return", message: yield* getLastAssistant(input.sessionID), state }
    }
    // The turn finished (outcome "break") or is ongoing (tool calls). Either way
    // loop back: the finished-check at the top of the next iteration fires the
    // Stop hook and returns once the agent is truly done. `stopped` covers
    // blocked turns (permission rejected) whose finish is still "tool-calls".
    state = State.afterAttempt(state, { broke: step.outcome === "break", error: handle.message.error })
    return { kind: "continue", state }
  })
}

type StopGateResult =
  | { readonly kind: "step" | "continue"; readonly state: TurnState }
  | { readonly kind: "finish"; readonly state: TurnState; readonly outcome: Decide.TurnOutcome }

function makeStopGate(deps: LoopDeps) {
  const { stopFns, agentMessages } = deps
  return Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    session: Session.Info
    identity: DagMessages.Caller
    lastUser: SessionV1.User
    lastAssistant: SessionV1.Assistant | undefined
    lastAssistantMsg: SessionV1.WithParts | undefined
    budget: ToolBudget.Budget
    state: TurnState
  }): Effect.fn.Return<StopGateResult> {
    const completion: Decide.CompletionSignals = {
      assistantFinished: !!input.lastAssistant?.finish && input.lastAssistant.finish !== "tool-calls",
      userBeforeAssistant: !!input.lastAssistant && MessageV2.before(input.lastUser, input.lastAssistant),
      pendingLocalTools: input.lastAssistantMsg?.parts.some(isPendingLocalTool) ?? false,
    }
    if (!Decide.isCompletionCandidate(input.state, completion)) return { kind: "step", state: input.state }
    const orphan = input.lastAssistantMsg?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && Stop.isOrphanedInterruptedTool(part),
    )
    if (orphan) {
      yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
        "session.id": input.sessionID,
        messageID: input.lastAssistant?.id,
        tool: orphan.tool,
        callID: orphan.callID,
      })
    }
    // A granted Stop-block continuation runs exactly one more model step. A
    // blocked input owner keeps the grant unconsumed and falls through to exit.
    if (input.state.continuing === "stop_block" && input.state.agentInput !== "blocked") {
      return { kind: "step", state: input.state }
    }
    yield* Effect.logInfo("exiting loop", { "session.id": input.sessionID })
    const resolved = yield* stopFns.resolvePolicy({
      sessionID: input.sessionID,
      session: input.session,
      error: input.state.error,
    })
    let signals: Decide.Signals = {
      ...completion,
      stopHook: "not_run",
      stepInputPending: false,
      // With no mailbox there is nothing to query; the old code skipped the
      // queued-input check entirely and could never continue from it.
      stepInputChecked: agentMessages === undefined,
      ownerDefersStop: resolved.ownerDefersStop,
      stopPolicy: resolved.policy,
      budgetExhausted: input.budget.exhausted,
      assistantFinish: input.lastAssistant?.finish,
    }
    let transition = Decide.decide(input.state, signals)
    if (transition.kind === "run_stop_hooks") {
      const result = yield* stopFns.runStopHooks({
        sessionID: input.sessionID,
        session: input.session,
        identity: input.identity,
        lastUser: input.lastUser,
        lastAssistant: input.lastAssistant,
        lastAssistantMsg: input.lastAssistantMsg,
        event: transition.event,
        error: input.state.error,
        stopHookActive: input.state.stop.active,
      })
      signals = {
        ...signals,
        stopHook: {
          blocked: result.blocked !== undefined,
          preventContinuation: result.preventContinuation === true,
        },
      }
      transition = Decide.decide(input.state, signals)
      // Feedback consumes the hook output before the queued-input check, and
      // knows whether this block granted a continuation.
      yield* stopFns.applyStopFeedback({
        sessionID: input.sessionID,
        lastUser: input.lastUser,
        result,
        continuing: transition.kind === "continue" && transition.source === "stop_block",
      })
      // Capped by SettingsHook.stopHookBlockCap(): a hook that ignores
      // stop_hook_active cannot loop forever; at the limit warn and exit.
      if (
        signals.stopHook !== "not_run" &&
        signals.stopHook.blocked &&
        !signals.stopHook.preventContinuation &&
        Decide.continuationAllowed(input.state) &&
        input.state.stop.continuations >= input.state.stop.cap
      ) {
        yield* Effect.logWarning("Stop hook continuation limit reached; forcing exit", {
          "session.id": input.sessionID,
          limit: input.state.stop.cap,
        })
      }
    }
    if (transition.kind === "check_step_input") {
      if (!agentMessages) return { kind: "finish", state: input.state, outcome: Decide.outcomeOfExit(input.state) }
      const incoming = yield* agentMessages.revisions(input.identity)
      signals = {
        ...signals,
        stepInputChecked: true,
        stepInputPending: incoming.ok && incoming.value.queued > 0,
      }
      transition = Decide.decide(input.state, signals)
    }
    if (transition.kind === "continue") {
      return {
        kind: "continue",
        state:
          transition.source === "stop_block"
            ? State.continueFromStopBlock(input.state)
            : State.continueFromQueuedInput(input.state),
      }
    }
    if (transition.kind === "finish") return { kind: "finish", state: input.state, outcome: transition.outcome }
    return { kind: "step", state: input.state }
  })
}

function makeTurnFinisher(deps: LoopDeps) {
  const { summary, getLastAssistant } = deps
  return Effect.fnUntraced(function* (sessionID: SessionID, turnUserID: MessageID | undefined) {
    if (turnUserID) yield* summary.summarizeTurn({ sessionID, userMessageIDs: [turnUserID] }).pipe(Effect.ignore)
    return yield* getLastAssistant(sessionID)
  })
}

type StepRunResult =
  | { readonly kind: "continue"; readonly state: TurnState }
  | { readonly kind: "finish"; readonly state: TurnState; readonly outcome: Decide.TurnOutcome }
  | { readonly kind: "return"; readonly state: TurnState; readonly message: SessionV1.WithParts }

function makeStepRunner(deps: LoopDeps) {
  const { prepareFns, scope } = deps
  const taskRunner = makeTaskRunner(deps)
  const overflowGate = makeOverflowGate(deps)
  const attemptRunner = makeAttemptRunner(deps)
  const prepareStage = makePrepareStage(deps)

  return Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    session: Session.Info
    identity: DagMessages.Caller
    lastUser: SessionV1.User
    modelMessageID: MessageID
    lastFinished: SessionV1.Assistant | undefined
    tasks: (SessionV1.CompactionPart | SessionV1.SubtaskPart)[]
    msgs: SessionV1.WithParts[]
    budget: ToolBudget.Budget
    state: TurnState
    displayTurnID: string
    agentSnapshot: DagMessages.Snapshot | undefined
    requestOverheads: TurnRequestInput["requestOverheads"]
    runtimeContexts: TurnRequestInput["runtimeContexts"]
    cwd: string
    root: string
  }): Effect.fn.Return<StepRunResult> {
    let state = State.incrementStep(State.beginStep(input.state))
    if (state.step === 1) {
      yield* prepareFns
        .ensureTitle({
          session: input.session,
          modelID: input.lastUser.model.modelID,
          providerID: input.lastUser.model.providerID,
          history: input.msgs,
        })
        .pipe(Effect.ignore, Effect.forkIn(scope))
    }
    const model = yield* prepareFns.getModel(
      input.lastUser.model.providerID,
      input.lastUser.model.modelID,
      input.sessionID,
    )
    const task = yield* taskRunner({
      task: input.tasks.pop(),
      model,
      lastUser: input.lastUser,
      sessionID: input.sessionID,
      session: input.session,
      msgs: input.msgs,
    })
    if (task.kind === "continue") return { kind: "continue", state }
    if (task.kind === "finish") return { kind: "finish", state, outcome: { type: "completed" } }
    const overflow = yield* overflowGate({
      sessionID: input.sessionID,
      state,
      lastUser: input.lastUser,
      lastFinished: input.lastFinished,
      msgs: input.msgs,
      model,
      requestOverheads: input.requestOverheads,
    })
    state = overflow.state
    if (overflow.kind === "continue") return { kind: "continue", state }
    const attempt = yield* attemptRunner({
      sessionID: input.sessionID,
      session: input.session,
      identity: input.identity,
      lastUser: input.lastUser,
      modelMessageID: input.modelMessageID,
      model,
      msgs: input.msgs,
      budget: input.budget,
      state,
      step: state.step,
      displayTurnID: input.displayTurnID,
      agentSnapshot: input.agentSnapshot,
      requestOverheads: input.requestOverheads,
      runtimeContexts: input.runtimeContexts,
      prepareStage: prepareStage(input.sessionID),
      cwd: input.cwd,
      root: input.root,
    })
    if (attempt.kind === "return") return { kind: "return", state: attempt.state, message: attempt.message }
    return { kind: "continue", state: attempt.state }
  })
}

function makeTurnLoop(deps: LoopDeps) {
  const { sessions, status, prepareFns, drainRewrites, readRequestOverheads, readRuntimeContexts } = deps
  const agentInputGate = makeAgentInputGate(deps)
  const deferredResumer = makeDeferredResumer(deps)
  const stopGate = makeStopGate(deps)
  const stepRunner = makeStepRunner(deps)
  const finishTurn = makeTurnFinisher(deps)

  return Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID): Effect.fn.Return<TurnExecution> {
    const ctx = yield* InstanceState.context
    const displayTurnID = randomUUID()
    let state = State.initial({ stopCap: SettingsHook.stopHookBlockCap() })
    // The initial user message of this loop invocation identifies the turn.
    let turnUserID: MessageID | undefined
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    const requestOverheadBySession = yield* readRequestOverheads()
    const runtimeContextBySession = yield* readRuntimeContexts()
    const execution = (message: SessionV1.WithParts, outcome: Decide.TurnOutcome): TurnExecution => ({
      message,
      outcome,
      steps: state.step,
      userMessageID: turnUserID,
      lastAssistantID: message.info.role === "user" ? undefined : message.info.id,
    })

    while (true) {
      yield* status.set(sessionID, { type: "busy" })
      yield* Effect.logInfo("loop", { "session.id": sessionID, step: state.step })

      const modelMessageID = MessageID.ascending()
      const identity = { projectID: ctx.project.id, directory: ctx.directory, sessionID }
      yield* drainRewrites(sessionID)
      let snapshot: ClaimedSnapshot = yield* prepareFns.claimSnapshot(sessionID)
      let msgs = snapshot.messages
      let budget = snapshot.budget
      const previous = MessageV2.latest(msgs)
      if (!turnUserID && previous.user) turnUserID = previous.user.id
      const previousParts = msgs.findLast((message) => message.info.id === previous.assistant?.id)?.parts
      const gate = yield* agentInputGate({
        sessionID,
        identity,
        modelMessageID,
        messages: msgs,
        budget,
        state,
        completed: Decide.isCompletionCandidate(state, {
          assistantFinished: !!previous.assistant?.finish && previous.assistant.finish !== "tool-calls",
          userBeforeAssistant:
            !!previous.user && !!previous.assistant && MessageV2.before(previous.user, previous.assistant),
          pendingLocalTools: previousParts?.some(isPendingLocalTool) ?? false,
        }),
      })
      state = gate.state
      snapshot = gate.snapshot
      msgs = snapshot.messages
      budget = snapshot.budget
      const agentSnapshot = gate.agentSnapshot

      const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)
      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      const lastAssistantMsg = msgs.findLast(
        (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
      )

      const resume = yield* deferredResumer({
        sessionID,
        session,
        msgs,
        lastUser,
        lastAssistant,
        lastAssistantMsg,
      })
      if (resume.kind === "return") return execution(resume.message, Decide.outcomeOfExit(state))
      if (resume.kind === "continue") {
        if (resume.stopped) state = State.markStopped(state)
        continue
      }

      const stopped = yield* stopGate({
        sessionID,
        session,
        identity,
        lastUser,
        lastAssistant,
        lastAssistantMsg,
        budget,
        state,
      })
      state = stopped.state
      if (stopped.kind === "continue") continue
      if (stopped.kind === "finish") return execution(yield* finishTurn(sessionID, turnUserID), stopped.outcome)

      const step = yield* stepRunner({
        sessionID,
        session,
        identity,
        lastUser,
        modelMessageID,
        lastFinished,
        tasks,
        msgs,
        budget,
        state,
        displayTurnID,
        agentSnapshot,
        requestOverheads: requestOverheadBySession,
        runtimeContexts: runtimeContextBySession,
        cwd: ctx.directory,
        root: ctx.worktree,
      })
      state = step.state
      if (step.kind === "return") return execution(step.message, Decide.outcomeOfExit(state))
      if (step.kind === "finish") return execution(yield* finishTurn(sessionID, turnUserID), step.outcome)
      continue
    }
  })
}

function makeScopedAgentCleanup(deps: LoopDeps) {
  const { sessions, settingsHook, readScopedAgents } = deps
  return (sessionID: SessionID) =>
    Effect.gen(function* () {
      const session = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(session) || !session.value.parentID || TaskSubagents.delegateStop(sessionID)) return
      const active = yield* readScopedAgents()
      const origin = active.get(sessionID)
      if (origin && settingsHook?.unregisterScoped) yield* settingsHook.unregisterScoped(sessionID, origin)
      active.delete(sessionID)
    })
}

function makeErrorRecorder(deps: LoopDeps) {
  const { db, database, agentMessages, sessions } = deps
  return (sessionID: SessionID) => (cause: Cause.Cause<never>) =>
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
            const recorded = yield* MessageV2.exists({
              sessionID,
              messageID: MessageID.make(input.logicalTurnID),
            }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
            if (recorded) return
            const users = yield* MessageV2.recentUsers({ sessionID, limit: 1 }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.orDie,
            )
            const user = users.at(-1)?.info
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
      )
}

export function makeLoop(deps: LoopDeps) {
  const runLoopImpl = makeTurnLoop(deps)
  const cleanupScopedAgent = makeScopedAgentCleanup(deps)
  const recordPreparationError = makeErrorRecorder(deps)
  // Rich entry point: Turns records steps and the terminal outcome alongside
  // the final message. Cleanup and preparation-error recording stay identical
  // to the historical message-only wrapper.
  const runTurn = (sessionID: SessionID): Effect.Effect<TurnExecution> =>
    runLoopImpl(sessionID).pipe(
      Effect.ensuring(cleanupScopedAgent(sessionID)),
      Effect.onError(recordPreparationError(sessionID)),
    )
  const runLoop = (sessionID: SessionID): Effect.Effect<SessionV1.WithParts> =>
    runTurn(sessionID).pipe(Effect.map((turn) => turn.message))

  return { runTurn, runLoop }
}

export * as Loop from "./loop"
