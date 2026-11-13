import { Question } from "@/question"
import { HookLifecycle } from "@/hook/lifecycle"
import { SessionAttention } from "@/notification/attention"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionEvent } from "@graphagent/schema/session-event"
import { SessionID, MessageID } from "./schema"
import { SessionAbortReason } from "./abort-reason"
import { SessionCancellation } from "./cancellation"
import { EngineProcess } from "./engine-process"
import { AgentScheduler } from "./agent-scheduler"
import { makeSessionLocks } from "./locks"
import { SessionRevert } from "./revert"
import { makeChildRuns, type ChildRuns } from "./child/run"
import { ChildAdmission } from "./child/admission"
import { ChildRegistry } from "./child/registry"

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
import { Effect, Layer, Option, Scope, Context, DateTime } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { turnOutcomePhase } from "@graphagent/core/lifecycle/vocabulary"
import { ref as stateRef } from "@graphagent/core/lifecycle/state"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { Lifecycle } from "@/lifecycle/service"
import { Todo } from "./todo"
import { TodoReminders } from "./todo-reminders"
import { ToolSourceLedger } from "./tool-source-ledger"
import { SettingsHook } from "@/hook"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@graphagent/core/dag/store"
import { HookStartContext } from "@/hook/start-context"
import { Skill } from "@/skill"
import { Goal } from "@/goal/goal"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Memory } from "@/memory/memory"
import { DagMessages } from "@graphagent/core/dag/messages"

import { makeCommand } from "./command"
import { makeModelSwitch } from "./model-switch"
import type {
  CommandInput,
  LoopInput,
  ModelRef,
  PromptInput,
  ResumeInput,
  SetModelInput,
  ShellInput,
  SummarizeInput,
} from "./prompt-input"
import { makeReasoningRewrite } from "./reasoning-rewrite"
import { makeResume, NoPendingHookInput } from "./resume"
import { makeShell } from "./shell"
import { Admit } from "./turn/admit"
import { AdmissionPersistFailed, ModelSwitchBlocked, Prepare } from "./turn/prepare"
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
  type AdmissionExtras,
  type AdmissionOptions,
  type IdleAdmission,
  type Interface as TurnsInterface,
  type TurnExecution,
  type TurnOrigin,
  type TurnSettled,
  type TurnStart,
} from "./turns"

export type { AdmissionCommit, AdmissionExtras, AdmissionOptions, IdleAdmission } from "./turns"
export {
  CommandInput,
  HookFollowupInput,
  HookPendingInput,
  LoopInput,
  PromptInput,
  ResumeInput,
  SetModelInput,
  ShellInput,
  SummarizeInput,
} from "./prompt-input"
export { NoPendingHookInput }
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
  /**
   * `extras` is what `admit` takes too; a child run's driver sets the
   * credential of the run it prompts under (Issue #1026, PR3b), which
   * admission records.
   */
  readonly prompt: (
    input: PromptInput,
    options?: AdmissionOptions,
    extras?: AdmissionExtras,
  ) => Effect.Effect<SessionV1.WithParts, PromptError>
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
   * classification without awaiting the turn. Automatic sources reach this
   * through `SessionInbox.submit`; plain commands keep using `submit`/`prompt`.
   * `persistAdmission` commits inside the message transaction, so it rolls
   * back with the message. `extras` carries the origin a source stamps on the
   * turn and the cancellation request of an epoch-fenced caller
   * (`admitNowUnderFence`).
   */
  readonly admit: (
    input: PromptInput,
    options?: AdmissionOptions,
    persistAdmission?: Effect.Effect<void, unknown>,
    extras?: AdmissionExtras,
  ) => Effect.Effect<TurnStart, PromptError>
  readonly setModel: (input: SetModelInput) => Effect.Effect<typeof ModelRef.Type, ModelSwitchBlocked>
  /** Drain guidance only for the actual target model at a provider request boundary. */
  readonly restoreModelContext: (sessionID: SessionID) => Effect.Effect<void>
  readonly takeModelSwitchContext: (input: {
    sessionID: SessionID
    apiModelID: string
  }) => Effect.Effect<readonly string[]>
  /**
   * `options.credential` is the credential of the child run a delegation is
   * driven under (Issue #1026, PR3b). The initial hook message, the turn it
   * starts and the saved followup it finishes with are all admitted under it.
   */
  readonly resume: (
    input: ResumeInput,
    options?: Pick<AdmissionOptions, "internalDelegation"> & Pick<AdmissionExtras, "credential">,
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
  /**
   * Child runs (Issue #1026): who owns a child session, whether it is running,
   * how it ended. Assembled here, beside the turns and admission factories, so
   * the task tool never forms a layer cycle with it. Effect-valued so a partial
   * `Layer.mock` of this service (which must spell out every plain-valued
   * member) stays valid.
   */
  readonly children: Effect.Effect<ChildRuns.Interface>
}

export type PromptError =
  | Image.Error
  | ModelSwitchBlocked
  | NoPendingHookInput
  | AdmissionPersistFailed
  | ChildAdmission.Refused

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
    const scheduler = yield* AgentScheduler.Service
    const events = yield* EventV2Bridge.Service
    // Optional so tests and embedders that compose SessionPrompt without the
    // lifecycle service keep working; mirrors the ToolSourceLedger seam.
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(Lifecycle.Service))
    const flags = yield* RuntimeFlags.Service
    // Every session cache below is process-wide: one ManagedRuntime cannot
    // see another's InstanceState, but cancellations and followups cross them.
    const runtimes = EngineProcess.runtimes
    const database = yield* Database.Service
    const { reasoningDistillationEnabled, queueReasoning } = makeReasoningRewrite({
      config,
      sessions,
      llm,
      scheduler,
      events,
      database,
      runtimes,
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
    // Cancelling a child's turn goes through admission, which is built below;
    // the late-bound closure resolves once the layer is up.
    const children = yield* makeChildRuns({
      db,
      scope,
      cancelSession: (sessionID, options) => admit.cancel(sessionID, options),
      // Late-bound the same way: `prepareFns` and `admit` exist once the layer is up.
      driver: {
        prompt: (input, options, extras) => admit.prompt(input, options, extras).pipe(Effect.catch(Effect.die)),
        resolvePromptParts: (template) => prepareFns.resolvePromptParts(template),
      },
    })
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
            yield* children.forget(SessionID.make(sessionID))
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
    const { queueModelSwitch, modelSwitchContext } = makeModelSwitch({ settingsHook, runtimes, scope })
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
      children,
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
        prompt: (input: PromptInput, options?: AdmissionOptions) => {
          // The shell/watch_pr notice prompts its own session; a child session
          // carries the credential of its active run (zero reads). A run that
          // already ended leaves none, and the guard refuses as for any other
          // driver that lost its run.
          const credential = ChildRegistry.credentialOf(input.sessionID)
          return admit
            .prompt(input, options, credential ? { credential } : undefined)
            .pipe(Effect.catch(Effect.die))
        },
        children,
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

    // Live settlement notification: the durable turn row already exists when
    // this runs (`Turns.track` calls it after the ended write). The transient
    // event feeds clients; the lifecycle service records the same observation
    // in the shared vocabulary when that layer is present.
    const onSettled = (settled: TurnSettled) =>
      Effect.gen(function* () {
        yield* events.publish(LifecycleEvent.TurnSettled, {
          sessionID: settled.sessionID,
          turnID: settled.turnID,
          outcome: settled.outcome,
          steps: settled.steps,
          timeEnded: DateTime.makeUnsafe(settled.timeEnded),
        })
        if (!lifecycle) return
        const phase = turnOutcomePhase(settled.outcome.type)
        yield* lifecycle.transition({
          ref: stateRef("turn", settled.turnID),
          expect: "running",
          to: "ended",
          ...(phase === undefined ? {} : { phase }),
          sessionID: settled.sessionID,
        })
      })

    turnsRef = makeTurns({
      db,
      sessions,
      state,
      scope,
      withRunRequest,
      withPromptLock: locks.withPromptLock,
      goal,
      settingsHook,
      onSettled,
      admitPrompt: admit.admitPrompt,
      fenceRewake: admit.fenceRewake,
      runLoop: runTurn,
      lastAssistant: (sessionID) => lastAssistant(sessionID),
      cancel: (sessionID, options) => admit.cancel(sessionID, options),
    })

    const loop: (input: LoopInput, origin?: TurnOrigin) => Effect.Effect<SessionV1.WithParts> = Effect.fn(
      "SessionPrompt.loop",
    )(function* (input: LoopInput, origin: TurnOrigin = { kind: "user", via: "command" }) {
      // The credential of the run that drives this session, if any. The run
      // was registered through `ChildRuns` before its driver prompts or
      // continues; reading it from the process registry costs no query, which
      // the loop junction must keep (PR5 refuses a child turn without one).
      const credential = ChildRegistry.credentialOf(input.sessionID)
      const admittedOrigin: TurnOrigin =
        origin.kind === "child_run" && credential !== undefined ? { ...origin, childRunID: credential.runID } : origin
      // Register the runner under the prompt lock, then wait outside it: the
      // loop machine claims the same lock for its snapshot.
      const result = yield* withRunRequest(input.sessionID, (request, witness) =>
        locks.withPromptLock(witness, input.sessionID, () =>
          Effect.gen(function* () {
            const handle = turns().begin(input.sessionID, admittedOrigin)
            const tracked = turns()
              .track(
                handle,
                ChildAdmission.observe("loop", { id: input.sessionID }, credential, admittedOrigin).pipe(
                  Effect.orDie,
                  Effect.andThen(runTurn(input.sessionID)),
                ),
              )
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

    const { resume } = makeResume({
      sessions,
      state,
      database,
      hookLifecycle,
      startContext,
      locks,
      followupAdmissions,
      admit,
      command: (input, options) => commandFns.command(input, options),
      turns,
      runTurn,
      lastAssistant,
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
      children: Effect.succeed(children),
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
        AgentScheduler.defaultLayer,
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
export const node = LayerNode.make(layer, [
  SessionStatus.node,
  Session.node,
  Agent.node,
  AgentScheduler.node,
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

export { admitIdleUnderFence, admitNowUnderFence } from "./turn/admit"

export * as SessionPrompt from "./prompt"
