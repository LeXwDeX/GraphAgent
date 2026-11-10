import { SessionAdmission } from "@graphagent/core/session/admission"
import { Question } from "@/question"
import { HookLifecycle } from "@/hook/lifecycle"
import { SessionAttention } from "@/notification/attention"
import { Flag } from "@graphagent/core/flag/flag"
import {
  assessCanonicalReasoning,
  ReasoningDistillationPolicy,
  rewriteLogFields,
  runReasoningRewrite,
} from "@graphagent/core/session/reasoning-distillation"
import { ConfigReasoningDistillation } from "@graphagent/core/config/reasoning-distillation"
import { adoptReasoning } from "./reasoning-adoption"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionEvent } from "@graphagent/schema/session-event"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionAbortReason } from "./abort-reason"
import { SessionCancellation } from "./cancellation"
import { EngineProcess } from "./engine-process"
import { makeSessionLocks } from "./locks"
import { Token } from "@/util/token"
import { SessionRevert } from "./revert"

// #404: headless clients (`opencode run "/init"`, SDK text prompts) deliver
// slash commands as plain text parts to POST /session/:id/message. The TUI
// routes them client-side before calling /command, but nothing server-side
// did, so SessionPrompt.command never ran and Command.Event.Executed never
// fired (project.time_initialized stayed NULL). Mirror the TUI's parse —
// first line carries /command + args, later lines join the arguments — and
// only ever route single-text-part prompts.
function parseCommandPayload(payload: PromptInput) {
  const part = payload.parts.length === 1 ? payload.parts[0] : undefined
  const text = part?.type === "text" && part.text.startsWith("/") ? part.text : undefined
  if (!text) return undefined
  const firstLineEnd = text.indexOf("\n")
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)
  const [token, ...firstLineArgs] = firstLine.split(" ")
  const rest = firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1)
  return {
    command: token.slice(1),
    arguments: firstLineArgs.join(" ") + (rest ? "\n" + rest : ""),
  }
}
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ChildProcessSpawner } from "effect/process"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Command } from "../command"
import { Config } from "@/config/config"
import { SessionSummary } from "./summary"
import { SessionProcessor } from "./processor"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { FSUtil } from "@graphagent/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { Effect, Fiber, Layer, Option, Scope, Context, Schema, Struct } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Todo } from "./todo"
import { TodoReminders } from "./todo-reminders"
import { ToolSourceLedger } from "./tool-source-ledger"
import { SettingsHook, type TriggerResult, type HookPayload } from "@/hook"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@graphagent/core/dag/store"
import { HookStartContext } from "@/hook/start-context"
import { Skill } from "@/skill"
import { Goal } from "@/goal/goal"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Memory } from "@/memory/memory"
import { DagMessages } from "@graphagent/core/dag/messages"

import { makeCommand } from "./command"
import { makeShell } from "./shell"
import { Admit } from "./turn/admit"
import { ModelSwitchBlocked, Prepare } from "./turn/prepare"
import { Settle } from "./turn/settle"
import { Loop } from "./turn/loop"
import { AgentInputHint } from "./turn/agent-input-hint"
import { HistoryCache } from "./history/cache"
import { Stop } from "./turn/stop"
import type { QueuedMessageDeleteInput, QueuedMessageEditInput, QueuedMessageError } from "./turn/prepare"
import {
  dropReverted,
  makeTurns,
  type AdmissionCommit,
  type AdmissionOptions,
  type IdleAdmission,
  type Interface as TurnsInterface,
  type TurnExecution,
  type TurnOrigin,
  type TurnStart,
} from "./turns"

export type { AdmissionCommit, AdmissionOptions, IdleAdmission } from "./turns"
export {
  createStructuredOutputTool,
  ModelSwitchBlocked,
  QueuedMessageConflict,
  QueuedMessageDeleteInput,
  QueuedMessageEditInput,
  QueuedMessageExpected,
  QueuedMessageInvalid,
  QueuedMessageNotFound,
  selectPromptModel,
} from "./turn/prepare"
export type { PromptModelSelection, QueuedMessageError } from "./turn/prepare"
export { isClosingOnlyCause } from "./turn/settle"
export { expandCommandTemplate } from "./command"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export interface Interface {
  readonly cancel: (
    sessionID: SessionID,
    options?: { readonly reason?: SessionAbortReason.Info },
  ) => Effect.Effect<void>
  readonly prompt: (input: PromptInput, options?: AdmissionOptions) => Effect.Effect<SessionV1.WithParts, PromptError>
  /** Run a short commit while idle, serialized with prompt admission. Never start or await a turn here. */
  readonly withIdle: <A, E, R>(
    sessionID: SessionID,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>
  /**
   * Reserve the two-phase idle admission for exclusive-goal/DAG owners. The
   * caller activates the returned admission after committing its durable
   * transition. Never starts or awaits a turn here.
   */
  readonly prepareTurn: (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void>,
    options?: AdmissionOptions,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<Option.Option<IdleAdmission>, PromptError>
  /**
   * Admit a prompt immediately: commit the user message and return the turn
   * classification without awaiting the turn. Ledger-less sources reach this
   * through `SessionInbox.submit`; plain commands keep using `submit`/`prompt`.
   */
  readonly admit: (input: PromptInput, options?: AdmissionOptions) => Effect.Effect<TurnStart, PromptError>
  readonly setModel: (input: SetModelInput) => Effect.Effect<typeof ModelRef.Type, ModelSwitchBlocked>
  /** Drain guidance only for the actual target model at a provider request boundary. */
  readonly restoreModelContext: (sessionID: SessionID) => Effect.Effect<void>
  readonly takeModelSwitchContext: (input: {
    sessionID: SessionID
    apiModelID: string
  }) => Effect.Effect<readonly string[]>
  readonly resume: (
    input: ResumeInput,
    options?: Pick<AdmissionOptions, "internalDelegation">,
  ) => Effect.Effect<SessionV1.WithParts | null, PromptError | NoPendingHookInput>
  /** Read-only diagnostic: followup admission owners still registered for a session. */
  readonly followupAdmissionOwnerCount: (sessionID: SessionID) => Effect.Effect<number>
  readonly loop: (input: LoopInput, origin?: TurnOrigin) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, PromptError>
  /** Parses `/command` text, grants a one-shot local startup permission, and routes to command or prompt. */
  readonly submit: (
    input: PromptInput,
    options?: { readonly localGrant?: boolean },
  ) => Effect.Effect<SessionV1.WithParts, PromptError>
  /** Revert cleanup, compaction creation, and the summarizing turn in one operation. */
  readonly summarize: (input: SummarizeInput) => Effect.Effect<void, Session.NotFound>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  readonly editQueuedMessage: (input: QueuedMessageEditInput) => Effect.Effect<SessionV1.WithParts, QueuedMessageError>
  readonly deleteQueuedMessage: (input: QueuedMessageDeleteInput) => Effect.Effect<boolean, QueuedMessageError>
}

export type PromptError = Image.Error | ModelSwitchBlocked | NoPendingHookInput

export class NoPendingHookInput extends Schema.TaggedError<NoPendingHookInput>()("NoPendingHookInput", {
  message: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const toolSources =
      Option.getOrUndefined(yield* Effect.serviceOption(ToolSourceLedger.Service)) ?? ToolSourceLedger.unavailable
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    // Every session cache below is process-wide: one ManagedRuntime cannot
    // see another's InstanceState, but cancellations and followups cross them.
    const runtimes = EngineProcess.runtimes
    const reasoningDistillationEnabled = (model: Provider.Model) =>
      config.get().pipe(
        Effect.map(
          (cfg) =>
            ConfigReasoningDistillation.resolveEnabled({
              disabledByEnvironment: Flag.GRAPHAGENT_DISABLE_REASONING_DISTILLATION,
              enabled: cfg.reasoningDistillation?.enabled,
              modelEnabled: cfg.provider?.[model.providerID]?.models?.[model.id]?.reasoningDistillation?.enabled,
            }).enabled,
        ),
      )
    const database = yield* Database.Service
    const queueReasoning = (input: { sessionID: SessionID; part: SessionV1.ReasoningPart; model: Provider.Model }) =>
      Effect.gen(function* () {
        const directory = yield* InstanceState.directory
        const rewrite = runtimes.directory(directory)
        runtimes.own(input.sessionID, directory)
        return yield* rewrite.queue.enqueue(
          input.sessionID,
          input.part.id,
          Effect.gen(function* () {
            if (!(yield* reasoningDistillationEnabled(input.model))) return undefined
            const part = yield* sessions.getPart({
              sessionID: input.sessionID,
              messageID: input.part.messageID,
              partID: input.part.id,
            })
            if (part?.type !== "reasoning") return undefined
            const editability = assessCanonicalReasoning({
              text: part.text,
              metadata: part.metadata,
              settled: part.time.end !== undefined,
              distilled: part.distillation !== undefined,
            })
            if (
              !editability.editable ||
              Token.estimate(part.text) < ReasoningDistillationPolicy.tokens.minimumInputTokens
            )
              return undefined
            if (rewrite.budget.admit(input.sessionID) !== "ok") return undefined
            const cfg = yield* config.get()
            const organizer = yield* llm.organizer({ model: input.model })
            if (!organizer) return undefined
            const outcome = yield* runReasoningRewrite({
              budget: rewrite.budget,
              sessionID: input.sessionID,
              slot: { messageID: part.messageID, partID: part.id, text: part.text },
              language: ConfigReasoningDistillation.resolveLanguage(cfg.reasoningDistillation),
              call: organizer.call,
              // Organization only queues a candidate; the next step commits it before reading history.
              adopt: (replacement) => Effect.succeed(replacement),
            })
            yield* Effect.logInfo(
              "reasoning distillation",
              rewriteLogFields(outcome, {
                runtime: "opencode",
                mode: "async",
                "session.id": input.sessionID,
                model: organizer.model,
                transport: organizer.transport,
              }),
            )
            if (!outcome.adopted) return undefined
            return adoptReasoning({
              sessionID: input.sessionID,
              part,
              replacement: outcome.adopted,
              canAdopt: reasoningDistillationEnabled(input.model),
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.provideService(Session.Service, sessions),
              Effect.provideService(EventV2Bridge.Service, events),
            )
          }),
        )
      })
    const backgroundJobs = yield* BackgroundJob.Service
    const workflowStore = yield* DagStore.Service
    const agentMessages = Option.getOrUndefined(yield* Effect.serviceOption(DagMessages.Service))
    const { db } = database
    const agentInputHint = agentMessages
      ? yield* AgentInputHint.make({
          changed: agentMessages.changed,
          dataVersion: HistoryCache.dataVersion(database),
        })
      : undefined
    // The event fan-out runs without InstanceRef: only process-wide state and
    // the hint's layer-scoped Refs may be touched here.
    yield* Effect.acquireRelease(
      events.listen((event) => {
        if (event.type === Session.Event.Deleted.type) {
          const data = event.data
          if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
          const sessionID = data.sessionID
          if (typeof sessionID !== "string") return Effect.void
          return Effect.gen(function* () {
            if (agentInputHint) yield* agentInputHint.forget(SessionID.make(sessionID))
            yield* runtimes.remove(SessionID.make(sessionID))
          })
        }
        if (event.type === SessionEvent.Moved.type) {
          const data = event.data
          if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
          const sessionID = data.sessionID
          if (typeof sessionID !== "string") return Effect.void
          // The cached fragment belongs to the old directory's tool set.
          runtimes.forgetToolsJson(SessionID.make(sessionID))
        }
        return Effect.void
      }),
      (unsubscribe) => unsubscribe,
    )
    // The hook engine derives transcript, environment, prompt identity and
    // permission mode lazily for every trigger (D1 PR2): callers only name the
    // session, and a trigger that matches no handler touches no session state.
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const hookLifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
    const hookSkills = Option.getOrUndefined(yield* Effect.serviceOption(Skill.Service))
    const hookQuestions = Option.getOrUndefined(yield* Effect.serviceOption(Question.Service))
    const startContext = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    const goal = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))
    const modelSwitches = runtimes.modelSwitches
    const queueModelSwitch = Effect.fn("SessionPrompt.queueModelSwitch")(function* (
      sessionID: SessionID,
      payload: Extract<HookPayload, { event: "PreModelSwitch" | "PostModelSwitch" }>,
    ) {
      if (!settingsHook) return
      const request = SessionCancellation.request(sessionID)
      yield* Effect.gen(function* () {
        const pending = modelSwitches
        const context = yield* Effect.context()
        const generation = yield* InstanceState.currentGeneration
        const directory = yield* InstanceState.directory
        runtimes.own(sessionID, directory)
        const previous = pending.get(sessionID)
        if (previous) {
          pending.delete(sessionID)
          previous.unregister()
          yield* Fiber.interrupt(previous.fiber)
        }
        if (!request.current()) return
        const fiber = yield* Effect.suspend(() =>
          request.current()
            ? settingsHook.trigger({ ...payload, event: "PostModelSwitch" }, { sessionID })
            : Effect.interrupt,
        ).pipe(
          Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
          Effect.forkIn(scope),
        )
        const entry = { target: payload.toModel, epoch: request.epoch, fiber, unregister: () => {} }
        const unregister = request.register(
          () =>
            InstanceState.withGeneration(
              generation,
              Effect.suspend(() => {
                if (pending.get(sessionID) === entry) pending.delete(sessionID)
                entry.unregister()
                return Fiber.interrupt(fiber).pipe(Effect.asVoid)
              }),
            ).pipe(Effect.provide(context)),
          directory,
        )
        if (!unregister) {
          yield* Fiber.interrupt(fiber)
          return
        }
        entry.unregister = unregister
        const prior = pending.get(sessionID)
        pending.set(sessionID, entry)
        if (prior) {
          prior.unregister()
          yield* Fiber.interrupt(prior.fiber)
        }
      }).pipe(Effect.ensuring(Effect.sync(() => request.release())))
    })
    const modelSwitchContext = Effect.fn("SessionPrompt.modelSwitchContext")(function* (
      sessionID: SessionID,
      apiModelID: string,
    ) {
      const pending = modelSwitches
      const entry = pending.get(sessionID)
      if (!entry || entry.target !== apiModelID) return [] as string[]
      const result = yield* Fiber.join(entry.fiber).pipe(Effect.timeoutOption("5 seconds"))
      if (Option.isNone(result) || pending.get(sessionID) !== entry) return [] as string[]
      const current = SessionCancellation.epoch(sessionID) === entry.epoch
      pending.delete(sessionID)
      entry.unregister()
      if (!current) return [] as string[]
      yield* SettingsHook.landSystemMessages(result.value, {
        sessionID,
        shouldLand: () => SessionCancellation.epoch(sessionID) === entry.epoch,
      })
      return SessionCancellation.epoch(sessionID) === entry.epoch ? result.value.additionalContexts : []
    })
    const scopedAgents = runtimes.scopedAgents
    // The loop checks the context limit before it prepares a request, so the system text and tool schemas
    // of the request it is about to send do not exist yet. Keep the measured overhead of the previous
    // prepared request per session, and include it when provider usage cannot cover it.
    const requestOverheads = runtimes.requestOverheads
    // Runtime-context blocks already sent per session, so later requests re-send them at the same positions.
    const runtimeContexts = runtimes.runtimeContexts
    // Optional so callers that do not compose the todo reminder service keep working.
    const todoReminders = yield* Effect.serviceOption(TodoReminders.Service)
    const activateAgentHooks = Effect.fn("SessionPrompt.activateAgentHooks")(function* (
      session: Session.Info,
      name?: string,
    ) {
      if (!settingsHook?.registerScoped) return
      const selected = name ? yield* agents.get(name) : yield* agents.defaultInfo()
      if (!selected) return
      const origin = selected.hookOrigin ? `agent:${selected.hookOrigin}` : `agent-config:${selected.name}`
      const directory = yield* InstanceState.directory
      runtimes.own(session.id, directory)
      const active = scopedAgents
      const previous = active.get(session.id)
      if (previous && (previous !== origin || selected.hooks === undefined) && settingsHook.unregisterScoped)
        yield* settingsHook.unregisterScoped(session.id, previous)
      if (selected.hooks !== undefined) {
        yield* settingsHook.registerScoped(session.id, {
          kind: "agent",
          origin,
          source: selected.hookSource,
          hooks: selected.hooks,
          child: !!session.parentID,
        })
        active.set(session.id, origin)
      } else active.delete(session.id)
    })
    const promptLocks = KeyedMutex.makeUnsafe<SessionID>()
    const locks = makeSessionLocks(promptLocks)
    const followupAdmissions = SessionCancellation.admissions
    const withRunRequest = locks.withRunRequest
    // App-layer model-write epochs for sessions with a pending command. This is
    // not directory state: one AppLayer shares it across workspaces. Entries
    // exist only while at least one command is pending and are removed on the
    // last release. No cross-process/restart claim is made.
    const modelWrites = runtimes.modelWrites
    const modelWriteBegin = (sessionID: SessionID) => {
      const state = modelWrites.get(sessionID) ?? { epoch: 0, refs: 0 }
      state.refs++
      modelWrites.set(sessionID, state)
      let released = false
      return {
        epoch: state.epoch,
        release: () => {
          if (released) return
          released = true
          const current = modelWrites.get(sessionID)
          if (!current) return
          current.refs--
          if (current.refs <= 0) modelWrites.delete(sessionID)
        },
      }
    }
    const modelWriteEpoch = (sessionID: SessionID) => modelWrites.get(sessionID)?.epoch
    const modelWriteBump = (sessionID: SessionID) => {
      const state = modelWrites.get(sessionID)
      if (state) state.epoch++
    }
    // A cancel also fences followups started by a different layer graph.
    const cancelEpoch = SessionCancellation.epoch
    const toolBudgets = runtimes.toolBudgets
    const budgetState = Effect.fnUntraced(function* (sessionID: SessionID) {
      const directory = yield* InstanceState.directory
      runtimes.own(sessionID, directory)
      let state = toolBudgets.get(sessionID)
      if (!state) {
        state = { pending: new Map() }
        toolBudgets.set(sessionID, state)
      }
      return state
    })

    const dropPendingBudget = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID) {
      toolBudgets.get(sessionID)?.pending.delete(messageID)
    })
    const prepareFns = Prepare.makePrepare({
      sessions,
      agents,
      provider,
      config,
      permission,
      fsys,
      mcp,
      lsp,
      registry,
      truncate,
      image,
      instruction,
      events,
      flags,
      llm,
      sys,
      database,
      db,
      promptLocks,
      settingsHook,
      toolSources,
      todoReminders,
      agentMessages,
      reasoningDistillationEnabled,
      queueModelSwitch,
      modelWriteEpoch,
      modelWriteBump,
      modelSwitchContext,
      budgetState,
      dropPendingBudget,
      hookQuestions,
      ops: () => ops(),
    })

    const settleFns = Settle.makeSettle({
      sessions,
      events,
      database,
      compaction,
      settingsHook,
      agentMessages,
    })

    const stopFns = Stop.makeStop({
      sessions,
      settingsHook,
      hookLifecycle,
      agentMessages,
      backgroundJobs,
      workflowStore,
    })

    // Late-bound so admission can call the turns service while turns calls
    // admission back. Both exist before any runtime entry point runs.
    let turnsRef: TurnsInterface | undefined
    const turns = (): TurnsInterface => {
      if (!turnsRef) throw new Error("session turns are not initialized")
      return turnsRef
    }

    const admit = Admit.makeAdmit({
      sessions,
      status,
      state,
      revert,
      config,
      scope,
      db,
      promptLocks,
      followupAdmissions,
      settingsHook,
      startContext,
      hookSkills,
      attention,
      goal,
      agentMessages,
      activateAgentHooks,
      createUserMessage: prepareFns.createUserMessage,
      budgetState: (sessionID) => budgetState(sessionID),
      restoreModelContext: prepareFns.restoreModelContext,
      resume: (input, options) => resume(input, options),
      turns,
    })

    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => admit.cancel(sessionID),
        resolvePromptParts: (template: string) => prepareFns.resolvePromptParts(template),
        prompt: (input: PromptInput, options?: AdmissionOptions) =>
          admit.prompt(input, options).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const loopFns = Loop.makeLoop({
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
      agentInputHint: agentInputHint?.hint,
      agentInputChecked: agentInputHint?.checked,
      events,
      database,
      db,
      scope,
      prepareFns,
      settleFns,
      stopFns,
      ops: () => ops(),
      queueReasoning: (input) => queueReasoning(input),
      reasoningDistillationEnabled: (model) => reasoningDistillationEnabled(model),
      getLastAssistant: (sessionID) => lastAssistant(sessionID),
      readRequestOverheads: () => Effect.succeed(requestOverheads),
      readRuntimeContexts: () => Effect.succeed(runtimeContexts),
      drainRewrites: (sessionID) =>
        Effect.gen(function* () {
          const directory = yield* InstanceState.directory
          const rewrite = runtimes.directory(directory)
          runtimes.own(sessionID, directory)
          yield* rewrite.queue.drain(sessionID)
        }),
      readScopedAgents: () => Effect.succeed(scopedAgents),
    })

    const runTurn = (sessionID: SessionID): Effect.Effect<TurnExecution> => loopFns.runTurn(sessionID)

    turnsRef = makeTurns({
      db,
      sessions,
      state,
      scope,
      withRunRequest,
      withPromptLock: locks.withPromptLock,
      goal,
      settingsHook,
      admitPrompt: admit.admitPrompt,
      fenceRewake: admit.fenceRewake,
      runLoop: runTurn,
      lastAssistant: (sessionID) => lastAssistant(sessionID),
      cancel: (sessionID, options) => admit.cancel(sessionID, options),
    })

    const loop: (input: LoopInput, origin?: TurnOrigin) => Effect.Effect<SessionV1.WithParts> = Effect.fn(
      "SessionPrompt.loop",
    )(function* (input: LoopInput, origin: TurnOrigin = { kind: "user", via: "command" }) {
      // Register the runner under the prompt lock, then wait outside it: the
      // loop machine claims the same lock for its snapshot.
      const result = yield* withRunRequest(input.sessionID, (request, witness) =>
        locks.withPromptLock(witness, input.sessionID, () =>
          Effect.gen(function* () {
            const handle = turns().begin(input.sessionID, origin)
            const tracked = turns()
              .track(handle, runTurn(input.sessionID))
              .pipe(Effect.map((turn) => turn.message))
            const result = yield* state.ensureRunningHandle(
              input.sessionID,
              lastAssistant(input.sessionID),
              tracked,
              request,
            )
            // A join can discard this request's work before `track`; settle
            // the handle so it does not stay `running` forever.
            yield* turns().watch(handle, result)
            return result
          }),
        ),
      )
      return yield* result
    })

    const pendingMessageID = (metadata: Session.Info["metadata"]) => {
      const saved = (metadata ?? {}).hookPendingInput
      if (typeof saved !== "object" || saved === null || !("messageID" in saved)) return undefined
      return typeof saved.messageID === "string" ? saved.messageID : undefined
    }
    const writePendingInput = Effect.fnUntraced(function* (
      sessionID: SessionID,
      pending: typeof HookPendingInput.Type | undefined,
      guard?: (current: Session.Info) => boolean,
    ) {
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const metadata = { ...current.metadata }
      if (pending) metadata.hookPendingInput = pending
      else delete metadata.hookPendingInput
      // The guard runs inside setMetadata, after any delayed commit barrier, so
      // a cancel that lands while this write is queued still wins.
      yield* sessions.setMetadata({ sessionID, metadata }, guard)
    })
    const pendingInput = (metadata: Session.Info["metadata"]) =>
      metadata?.hookPendingInput === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(HookPendingInput)(metadata.hookPendingInput).pipe(
            Effect.mapError(
              () =>
                new NoPendingHookInput({
                  message:
                    "The saved hook followup has an unsupported or corrupt format. Inspect it before resubmitting.",
                }),
            ),
          )
    const finishPendingInput = Effect.fnUntraced(function* (
      sessionID: SessionID,
      completed: SessionV1.WithParts | null,
      epoch: number,
    ) {
      if (
        !completed ||
        completed.info.role !== "assistant" ||
        completed.info.error ||
        completed.info.finish === "tool_deferred" ||
        completed.info.finish === "tool_deferred_unavailable"
      )
        return completed
      return yield* followupAdmissions
        .run(sessionID, (commit) =>
          Effect.gen(function* () {
            const pending = yield* promptLocks.withLock(sessionID)(
              commit(
                Effect.gen(function* () {
                  if (cancelEpoch(sessionID) !== epoch) return undefined
                  const item = yield* pendingInput((yield* sessions.get(sessionID).pipe(Effect.orDie)).metadata)
                  if (!item) return undefined
                  const recorded = yield* MessageV2.exists({
                    sessionID,
                    messageID: item.messageID,
                  }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
                  if (recorded) {
                    yield* writePendingInput(sessionID, undefined, (current) => {
                      const saved = pendingMessageID(current.metadata)
                      return saved === undefined || saved === item.messageID
                    })
                    return undefined
                  }
                  // A crash after claiming a command may have happened before its message was
                  // recorded. Preserve that uncertain outcome instead of repeating side effects.
                  if (item.phase === "started")
                    return yield* new NoPendingHookInput({
                      message:
                        "The saved followup was already started but has no recorded message. Inspect the session before resubmitting it.",
                    })
                  yield* writePendingInput(sessionID, { ...item, phase: "started" }, (current) => {
                    return cancelEpoch(sessionID) === epoch && pendingMessageID(current.metadata) === item.messageID
                  })
                  // The guard can only skip the write; confirm the claim survived
                  // before running the pending followup.
                  const claimed = yield* pendingInput((yield* sessions.get(sessionID).pipe(Effect.orDie)).metadata)
                  if (!claimed || claimed.phase !== "started" || claimed.messageID !== item.messageID) return undefined
                  return item
                }),
              ),
            )
            if (!pending) return completed
            const shared = { sessionID, messageID: pending.messageID, hookMode: "noninteractive" as const }
            return yield* (
              pending.input.kind === "command"
                ? commandFns.command({ ...pending.input, ...shared }, { skipHookStart: true })
                : admit.prompt(
                    { ...pending.input, ...shared },
                    {
                      skipHookStart: true,
                      ...(pending.internalDelegation ? { internalDelegation: true as const } : {}),
                    },
                  )
            ).pipe(
              Effect.ensuring(
                promptLocks.withLock(sessionID)(
                  Effect.gen(function* () {
                    const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
                    const saved = yield* pendingInput(current.metadata).pipe(Effect.option)
                    if (Option.isNone(saved) || saved.value?.messageID !== pending.messageID) return
                    const recorded = yield* MessageV2.exists({
                      sessionID,
                      messageID: pending.messageID,
                    }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
                    if (recorded)
                      yield* writePendingInput(sessionID, undefined, (current) => {
                        return pendingMessageID(current.metadata) === pending.messageID
                      })
                  }),
                ),
              ),
            )
          }),
        )
        .pipe(Effect.catchTag("SessionConversationHookBlocked", () => Effect.succeed(completed)))
    })

    const resume: Interface["resume"] = Effect.fn("SessionPrompt.resume")(function* (input, options) {
      const epoch = cancelEpoch(input.sessionID)
      // Register the owner before waiting on the prompt lock. Cancel then fences
      // a followup that has not reached the lock yet, and a resume started after
      // cancel returns registers a fresh owner as a new request.
      const result = followupAdmissions
        .run(
          input.sessionID,
          (commit): Effect.Effect<Effect.Effect<SessionV1.WithParts | null>, PromptError | SessionAdmission.Blocked> =>
            withRunRequest(input.sessionID, (request, witness) =>
              locks.withPromptLock(witness, input.sessionID, () =>
                Effect.gen(function* () {
                  if (!request.valid()) return yield* Effect.interrupt
                  const target = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
                  const contexts = yield* admit.resumeContexts(target)
                  if (startContext) for (const context of contexts) yield* startContext.append(input.sessionID, context)
                  const initial =
                    input.hookMode !== "interactive" && hookLifecycle
                      ? yield* hookLifecycle.consumeInitial(input.sessionID)
                      : undefined
                  const users = yield* MessageV2.recentUsers({ sessionID: input.sessionID, limit: 1 }).pipe(
                    Effect.provideService(Database.Service, database),
                    Effect.orDie,
                  )
                  const initialTurn = !!initial && users.length === 0
                  const latest = Option.getOrUndefined(
                    yield* sessions
                      .findMessage(input.sessionID, (message) => message.info.role === "assistant")
                      .pipe(Effect.orDie),
                  )
                  const deferred = latest?.parts.some(
                    (part) => part.type === "tool" && part.state.status === "pending" && part.state.deferred,
                  )
                  const saved = yield* pendingInput(target.metadata)
                  if (!initialTurn && !deferred && !saved) {
                    if (input.initialOnly) return Effect.succeed<SessionV1.WithParts | null>(null)
                    return yield* new NoPendingHookInput({
                      message: "No initial hook message or deferred tool call is pending",
                    })
                  }
                  if (input.followup) {
                    if (saved)
                      return yield* new NoPendingHookInput({
                        message: "No initial hook message or deferred tool call is pending",
                      })
                  }
                  if (input.followup) {
                    if (saved)
                      return yield* new NoPendingHookInput({
                        message: "A supplied followup is already saved for this session",
                      })
                    yield* commit(
                      writePendingInput(
                        input.sessionID,
                        {
                          version: 1,
                          messageID: input.followup.messageID ?? MessageID.ascending(),
                          phase: "pending",
                          input: input.followup,
                          ...(options?.internalDelegation ? { internalDelegation: true } : {}),
                        },
                        (current) =>
                          cancelEpoch(input.sessionID) === epoch && pendingMessageID(current.metadata) === undefined,
                      ),
                    )
                  }
                  if (initialTurn) {
                    const admitted = yield* admit
                      .admitPrompt(
                        {
                          ...input,
                          parts: [{ type: "text", text: initial }],
                          hookMode: input.hookMode ?? "noninteractive",
                        },
                        undefined,
                        options?.internalDelegation ? { internalDelegation: true } : undefined,
                      )
                      .pipe(Effect.catchTag("SessionConversationHookBlocked", (error) => Effect.die(error)))
                    if (!admitted.run) return Effect.succeed<SessionV1.WithParts | null>(admitted.message)
                  } else if (input.hookMode) {
                    const user = users[0]?.info
                    if (user?.role === "user" && user.hookMode !== input.hookMode)
                      yield* sessions.updateMessage({ ...user, hookMode: input.hookMode })
                  }
                  if (!initialTurn && !deferred) return lastAssistant(input.sessionID)
                  // Fork the runner under the same commit lock as the owner check:
                  // a cancel cannot land between the check and the fork. Wait outside
                  // the prompt lock; the loop machine claims it for its snapshot.
                  const origin: TurnOrigin = options?.internalDelegation
                    ? { kind: "child_run" }
                    : input.followup?.kind === "command"
                      ? { kind: "user", via: "command" }
                      : { kind: "user", via: "prompt" }
                  const handle = turns().begin(input.sessionID, origin)
                  return yield* commit(
                    Effect.gen(function* () {
                      const result = yield* state.ensureRunningHandle(
                        input.sessionID,
                        lastAssistant(input.sessionID),
                        turns()
                          .track(handle, runTurn(input.sessionID))
                          .pipe(Effect.map((turn) => turn.message)),
                        request,
                      )
                      // Same settlement as `loop`: a join drops this request's
                      // tracked work before it can write or settle a row.
                      yield* turns().watch(handle, result)
                      return result
                    }),
                  )
                }),
              ),
            ),
        )
        .pipe(
          Effect.flatten,
          Effect.catchTag("SessionConversationHookBlocked", (error) =>
            Effect.fail(new NoPendingHookInput({ message: error.reason })),
          ),
        )
      return yield* finishPendingInput(input.sessionID, yield* result, epoch)
    })

    const shellFns = makeShell({
      sessions,
      agents,
      config,
      db,
      revert,
      events,
      settingsHook,
      toolSources,
      permission,
      registry,
      mcp,
      truncate,
      spawner,
      prepareFns,
      ops: () => ops(),
      withRunRequest,
      withPromptLock: locks.withPromptLock,
      state,
      lastAssistant: (sessionID) => lastAssistant(sessionID),
    })

    const commandFns = makeCommand({
      sessions,
      agents,
      config,
      events,
      commands,
      settingsHook,
      attention,
      goal,
      startContext,
      prepareFns,
      resume: (input, options) => resume(input, options),
      admit,
      loop: (input) => loop(input),
      budgetState: (sessionID) => budgetState(sessionID),
      promptLocks,
      withRunRequest,
      withPromptLock: locks.withPromptLock,
      state,
      lastAssistant: (sessionID) => lastAssistant(sessionID),
      modelWriteBegin,
      followupAdmissions,
    })

    const submit: Interface["submit"] = Effect.fn("SessionPrompt.submit")(function* (input, options) {
      if (options?.localGrant) {
        const grant = permission.grantHookBypass
        if (grant) yield* grant(input.sessionID)
      }
      const parsed = parseCommandPayload(input)
      if (parsed && (yield* commands.get(parsed.command))) {
        return yield* commandFns.command({
          sessionID: input.sessionID,
          command: parsed.command,
          arguments: parsed.arguments,
          messageID: input.messageID,
          agent: input.agent,
          variant: input.variant,
          hookMode: input.hookMode,
          ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
        })
      }
      return yield* admit.prompt(input)
    })

    const summarize: Interface["summarize"] = Effect.fn("SessionPrompt.summarize")(function* (input) {
      const current = yield* sessions.get(input.sessionID)
      // Drop the reverted turns before their anchor messages disappear.
      yield* dropReverted({ db, sessions }, current)
      yield* revert.cleanup(current)
      const latestUser = yield* MessageV2.recentUsers({ sessionID: input.sessionID, limit: 1 }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      const defaultAgent = yield* agents.defaultAgent()
      const currentAgent = latestUser.at(-1)?.info.agent ?? defaultAgent
      yield* compaction.create({
        sessionID: input.sessionID,
        agent: currentAgent,
        model: { providerID: input.providerID, modelID: input.modelID },
        auto: input.auto ?? false,
      })
      yield* loop({ sessionID: input.sessionID })
    })

    return Service.of({
      cancel: admit.cancel,
      prompt: admit.prompt,
      withIdle: admit.withIdle,
      prepareTurn: admit.prepareTurn,
      admit: admit.admit,
      setModel: prepareFns.setModel,
      restoreModelContext: prepareFns.restoreModelContext,
      takeModelSwitchContext: (input) => modelSwitchContext(input.sessionID, input.apiModelID),
      resume,
      followupAdmissionOwnerCount: (sessionID) => followupAdmissions.ownerCount(sessionID),
      loop,
      shell: shellFns.shell,
      command: commandFns.command,
      submit,
      summarize,
      resolvePromptParts: prepareFns.resolvePromptParts,
      editQueuedMessage: prepareFns.editQueuedMessage,
      deleteQueuedMessage: prepareFns.deleteQueuedMessage,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Layer.mergeAll(Goal.defaultLayer, SessionRunState.defaultLayer)),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Agent.defaultLayer,
        Database.defaultLayer,
        DagMessages.defaultLayer,
        DagStore.defaultLayer,
        BackgroundJob.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.defaultLayer,
        EventV2Bridge.defaultLayer,
        HookStartContext.defaultLayer,
        HookLifecycle.defaultLayer,
        SessionAttention.layer,
        Skill.defaultLayer,
        Question.defaultLayer,
        SettingsHook.defaultLayer,
        Todo.defaultLayer,
        ToolSourceLedger.defaultLayer,
      ),
    ),
  ),
)
const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export const SummarizeInput = Schema.Struct({
  sessionID: SessionID,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export type SummarizeInput = typeof SummarizeInput.Type

export const SetModelInput = Schema.Struct({
  sessionID: SessionID,
  model: Schema.optional(ModelRef),
  variant: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "picker", "sdk"])),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
})
export type SetModelInput = typeof SetModelInput.Type

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

export const HookFollowupInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prompt"), ...Struct.omit(PromptInput.fields, ["sessionID"]) }),
  Schema.Struct({ kind: Schema.Literal("command"), ...Struct.omit(CommandInput.fields, ["sessionID"]) }),
])
export const HookPendingInput = Schema.Struct({
  version: Schema.Literal(1),
  messageID: MessageID,
  phase: Schema.Literals(["pending", "started"]),
  input: HookFollowupInput,
  /** Runtime-delegated child input skips UserPromptSubmit when replayed. Records without it replay as user input. */
  internalDelegation: Schema.optional(Schema.Boolean),
})

export const ResumeInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
  initialOnly: Schema.optional(Schema.Boolean),
  followup: Schema.optional(HookFollowupInput),
})
export type ResumeInput = typeof ResumeInput.Type

export const node = LayerNode.make(layer, [
  SessionStatus.node,
  Session.node,
  Agent.node,
  Provider.node,
  SessionProcessor.node,
  SessionCompaction.node,
  Command.node,
  Config.node,
  Permission.node,
  FSUtil.node,
  MCP.node,
  LSP.node,
  ToolRegistry.node,
  Truncate.node,
  Image.node,
  CrossSpawnSpawner.node,
  Instruction.node,
  SessionRunState.node,
  SessionRevert.node,
  SessionSummary.node,
  SystemPrompt.node,
  LLM.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Database.node,
  DagMessages.node,
  DagStore.node,
  BackgroundJob.node,
  Memory.node,
  Todo.node,
  HookStartContext.node,
  HookLifecycle.node,
  SessionAttention.node,
  Skill.node,
  Question.node,
  SettingsHook.node,
  Goal.node,
  ToolSourceLedger.node,
])

export { admitIdleUnderFence } from "./turn/admit"

export * as SessionPrompt from "./prompt"
