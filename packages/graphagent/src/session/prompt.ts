import { SessionAdmission } from "@graphagent/core/session/admission"
import { Question } from "@/question"
import { HookLifecycle } from "@/hook/lifecycle"
import { SessionAttention } from "@/notification/attention"
import { Flag } from "@graphagent/core/flag/flag"
import {
  assessCanonicalReasoning,
  makeRewriteBudget,
  ReasoningDistillationPolicy,
  rewriteLogFields,
  runReasoningRewrite,
} from "@graphagent/core/session/reasoning-distillation"
import { ConfigReasoningDistillation } from "@graphagent/core/config/reasoning-distillation"
import { adoptReasoning } from "./reasoning-adoption"
import { makeReasoningQueue } from "./reasoning-queue"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionAbortReason } from "./abort-reason"
import { SessionCancellation } from "./cancellation"
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
import { SHELL_ABORT_NOTE } from "../tool/shell"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { RuntimeContext } from "./runtime-context"
import { Instruction } from "./instruction"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@graphagent/core/util/error"
import { SessionProcessor } from "./processor"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@graphagent/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@graphagent/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Fiber, Latch, Layer, Option, Scope, Context, Schema, Struct } from "effect"
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
import { SessionTools } from "./tools"
import { ToolSourceLedger } from "./tool-source-ledger"
import { SettingsHook, type TriggerResult, type HookPayload } from "@/hook"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@graphagent/core/dag/store"
import { HookStartContext } from "@/hook/start-context"
import { HookTranscript } from "@/hook/transcript"
import { Skill } from "@/skill"
import { Goal } from "@/goal/goal"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Memory } from "@/memory/memory"
import { DagMessages } from "@graphagent/core/dag/messages"
import { ToolBudget } from "@graphagent/core/session/tool-budget"

import { Admit } from "./turn/admit"
import { ModelSwitchBlocked, Prepare } from "./turn/prepare"
import { Settle } from "./turn/settle"
import { Loop } from "./turn/loop"
import { Stop } from "./turn/stop"
import type { QueuedMessageDeleteInput, QueuedMessageEditInput, QueuedMessageError } from "./turn/prepare"
import type { AdmissionCommit, AdmissionOptions, IdleAdmission, ModelBaseline } from "./turns"

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

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

/** Maps an admission cancellation to the prompt's typed rejected-command error. */
function mapAdmissionBlocked<A, E, R>(
  effect: Effect.Effect<A, E | SessionAdmission.Blocked, R>,
): Effect.Effect<A, E | ModelSwitchBlocked, R> {
  return effect.pipe(
    Effect.catchIf(
      (error): error is SessionAdmission.Blocked => error instanceof SessionAdmission.Blocked,
      (error) => Effect.fail(new ModelSwitchBlocked({ message: error.reason })),
    ),
  )
}

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
  readonly prepareIfIdle: (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void>,
    options?: AdmissionOptions,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<Option.Option<IdleAdmission>, PromptError>
  readonly promptIfIdle: (
    input: PromptInput,
    options?: AdmissionOptions,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, PromptError>
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
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
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
    // Budgets and organizer jobs belong to the directory, independently of each turn.
    const rewriteState = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const budget = makeRewriteBudget()
        const queue = yield* makeReasoningQueue
        yield* Effect.acquireRelease(
          events.listen((event) => {
            if (event.type !== Session.Event.Deleted.type) return Effect.void
            const data = event.data
            if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
            const sessionID = data.sessionID
            if (typeof sessionID !== "string") return Effect.void
            return queue.cancel(sessionID).pipe(Effect.ensuring(Effect.sync(() => budget.forget(sessionID))))
          }),
          (unsubscribe) => unsubscribe,
        )
        return { budget, queue }
      }),
    )
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
      InstanceState.useEffect(rewriteState, ({ budget, queue }) =>
        queue.enqueue(
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
            if (budget.admit(input.sessionID) !== "ok") return undefined
            const cfg = yield* config.get()
            const organizer = yield* llm.organizer({ model: input.model })
            if (!organizer) return undefined
            const outcome = yield* runReasoningRewrite({
              budget,
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
        ),
      )
    const backgroundJobs = yield* BackgroundJob.Service
    const workflowStore = yield* DagStore.Service
    const agentMessages = Option.getOrUndefined(yield* Effect.serviceOption(DagMessages.Service))
    const { db } = database
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
    const modelSwitches = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const pending = new Map<
          SessionID,
          { target: string; epoch: number; fiber: Fiber.Fiber<TriggerResult>; unregister: () => void }
        >()
        yield* Effect.acquireRelease(
          events.listen((event) =>
            Effect.gen(function* () {
              if (event.type !== Session.Event.Deleted.type) return
              const data = event.data
              if (typeof data !== "object" || data === null || !("info" in data)) return
              if (
                typeof data.info !== "object" ||
                data.info === null ||
                !("id" in data.info) ||
                typeof data.info.id !== "string"
              )
                return
              const id = SessionID.make(data.info.id)
              const entry = pending.get(id)
              pending.delete(id)
              if (entry) {
                entry.unregister()
                yield* Fiber.interrupt(entry.fiber)
              }
            }),
          ),
          (unsubscribe) => unsubscribe,
        )
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            pending.values(),
            (entry) => Effect.sync(entry.unregister).pipe(Effect.andThen(Fiber.interrupt(entry.fiber))),
            { concurrency: "unbounded", discard: true },
          ),
        )
        return pending
      }),
    )
    const queueModelSwitch = Effect.fn("SessionPrompt.queueModelSwitch")(function* (
      sessionID: SessionID,
      payload: Extract<HookPayload, { event: "PreModelSwitch" | "PostModelSwitch" }>,
    ) {
      if (!settingsHook) return
      const request = SessionCancellation.request(sessionID)
      yield* Effect.gen(function* () {
        const pending = yield* InstanceState.get(modelSwitches)
        const context = yield* Effect.context()
        const generation = yield* InstanceState.currentGeneration
        const directory = yield* InstanceState.directory
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
      const pending = yield* InstanceState.get(modelSwitches)
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
    const scopedAgents = yield* InstanceState.make(() => Effect.succeed(new Map<SessionID, string>()))
    // The loop checks the context limit before it prepares a request, so the system text and tool schemas
    // of the request it is about to send do not exist yet. Keep the measured overhead of the previous
    // prepared request per session, and include it when provider usage cannot cover it.
    const requestOverheads = yield* InstanceState.make(() => Effect.succeed(new Map<SessionID, number>()))
    // Runtime-context blocks already sent per session, so later requests re-send them at the same positions.
    const runtimeContexts = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const ledgers = new Map<SessionID, readonly RuntimeContext.Entry[]>()
        yield* Effect.acquireRelease(
          events.listen((event) => {
            if (event.type !== Session.Event.Deleted.type) return Effect.void
            const data = event.data
            if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
            const sessionID = data.sessionID
            if (typeof sessionID !== "string") return Effect.void
            return Effect.sync(() => ledgers.delete(SessionID.make(sessionID)))
          }),
          (unsubscribe) => unsubscribe,
        )
        return ledgers
      }),
    )
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
      const active = yield* InstanceState.get(scopedAgents)
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
    const followupAdmissions = SessionCancellation.admissions
    const withRunRequest = <A, E, R>(
      sessionID: SessionID,
      use: (request: ReturnType<typeof SessionCancellation.request>) => Effect.Effect<A, E, R>,
      admitted?: ReturnType<typeof SessionCancellation.request>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        if (admitted) return use(admitted)
        const request = SessionCancellation.request(sessionID)
        return request.wait.pipe(
          Effect.andThen(Effect.suspend(() => use(request))),
          Effect.ensuring(Effect.sync(() => request.release())),
        )
      })
    // App-layer model-write epochs for sessions with a pending command. This is
    // not directory state: one AppLayer shares it across workspaces. Entries
    // exist only while at least one command is pending and are removed on the
    // last release. No cross-process/restart claim is made.
    type ModelWriteState = { epoch: number; refs: number }
    const modelWrites = new Map<SessionID, ModelWriteState>()
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
    const toolBudgets = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const budgets = new Map<SessionID, { active?: ToolBudget.Budget; pending: Map<MessageID, ToolBudget.Budget> }>()
        yield* Effect.acquireRelease(
          events.listen((event) =>
            Effect.sync(() => {
              if (event.type !== Session.Event.Deleted.type) return
              const data = event.data
              if (typeof data !== "object" || data === null || !("sessionID" in data)) return
              if (typeof data.sessionID === "string") budgets.delete(SessionID.make(data.sessionID))
            }),
          ),
          (unsubscribe) => unsubscribe,
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => budgets.clear()))
        return budgets
      }),
    )
    const budgetState = Effect.fnUntraced(function* (sessionID: SessionID) {
      const budgets = yield* InstanceState.get(toolBudgets)
      let state = budgets.get(sessionID)
      if (!state) {
        state = { pending: new Map() }
        budgets.set(sessionID, state)
      }
      return state
    })

    const dropPendingBudget = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID) {
      const budgets = yield* InstanceState.get(toolBudgets)
      budgets.get(sessionID)?.pending.delete(messageID)
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
      summary,
      settingsHook,
      hookLifecycle,
      agentMessages,
      backgroundJobs,
      workflowStore,
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* prepareFns.currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          // Reassign part to mutable for hook updates
          let mutablePart = part
          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          // effectiveCommand mirrors input.command but is mutable: a PreToolUse hook
          // with `updatedInput` may rewrite it. args / part display / PostToolUse toolInput
          // all read effectiveCommand so a rewrite is reflected end-to-end.
          let effectiveCommand = input.command
          let args = Shell.args(sh, effectiveCommand, cwd)
          let output = ""
          let aborted = false
          let finalMetadata: Record<string, unknown> = {}
          let finalAttachments: SessionV1.FilePart[] | undefined

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", SHELL_ABORT_NOTE, "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (mutablePart.state.status === "running") {
                mutablePart.state = {
                  status: "completed",
                  time: { ...mutablePart.state.time, end: completed },
                  input: mutablePart.state.input,
                  title: "",
                  metadata: { ...finalMetadata, output },
                  attachments: finalAttachments,
                  output,
                }
                yield* sessions.updatePart(mutablePart)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
              const agent = yield* agents.get(input.agent)
              if (!agent) throw new Error(`Agent not found: "${input.agent}"`)
              // Keep explicit-shell spawning and streaming, but use the same
              // validated hook/permission boundary as model-invoked tools.
              const definition = {
                id: "bash",
                description: "Execute an explicit user shell command",
                parameters: Schema.Struct({ command: Schema.String }),
                execute: (parameters: { command: string }, context: import("./tools").DirectToolContext) =>
                  Effect.gen(function* () {
                    yield* context.ask({
                      permission: "bash",
                      patterns: [parameters.command],
                      always: ["*"],
                      metadata: {},
                    })
                    effectiveCommand = parameters.command
                    args = Shell.args(sh, effectiveCommand, cwd)
                    const baseEnvironment = { ...process.env }
                    const sessionEnvironment = HookTranscript.applyEnvironment(
                      baseEnvironment,
                      yield* HookTranscript.environment(input.sessionID, undefined, baseEnvironment),
                    )
                    const command = ChildProcess.make(sh, args, {
                      cwd,
                      extendEnv: false,
                      env: { ...sessionEnvironment, TERM: "dumb" },
                      stdin: "ignore",
                      forceKillAfter: "3 seconds",
                    })
                    const handle = yield* spawner.spawn(command)
                    yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                      Effect.gen(function* () {
                        output += chunk
                        if (mutablePart.state.status === "running") {
                          mutablePart.state.metadata = { output }
                          yield* sessions.updatePart(mutablePart)
                        }
                      }),
                    )
                    const code = yield* handle.exitCode
                    return { title: "", output, metadata: { output, exit: code } }
                  }).pipe(Effect.scoped),
              }
              const tools = yield* SessionTools.resolve({
                agent,
                session,
                messages: [],
                promptOps: yield* ops(),
                bypassAgentCheck: false,
                hooks: settingsHook,
                sourceLedger: toolSources,
                directTool: definition,
                processor: {
                  message: msg,
                  updateToolCall: (_id, update) =>
                    Effect.gen(function* () {
                      mutablePart = yield* sessions.updatePart(update(mutablePart))
                      return mutablePart
                    }),
                  completeToolCall: () => Effect.void,
                },
              }).pipe(
                Effect.provideService(Permission.Service, permission),
                Effect.provideService(ToolRegistry.Service, registry),
                Effect.provideService(MCP.Service, mcp),
                Effect.provideService(Truncate.Service, truncate),
              )
              const result = yield* Effect.tryPromise({
                try: (signal) =>
                  Promise.resolve(
                    tools.bash.execute!(
                      { command: input.command },
                      {
                        toolCallId: mutablePart.callID,
                        messages: [],
                        abortSignal: signal,
                      },
                    ),
                  ),
                catch: (error) => error,
              })
              output = result.output
              finalMetadata = result.metadata
              finalAttachments = result.attachments
            }).pipe(Effect.scoped),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            if (Cause.hasDies(exit.cause)) {
              yield* finish
              return yield* Effect.die(Cause.squash(exit.cause))
            }
            mutablePart = yield* sessions.updatePart({
              ...mutablePart,
              state: {
                status: "error",
                input: mutablePart.state.input,
                error: String(Cause.squash(exit.cause)),
                time: { start: part.state.status === "running" ? part.state.time.start : Date.now(), end: Date.now() },
              },
            })
          }

          yield* finish

          return { info: msg, parts: [mutablePart] }
        }),
      )
    })

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
      withRunRequest,
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
      runLoop: (sessionID) => runLoop(sessionID),
      lastAssistant: (sessionID) => lastAssistant(sessionID),
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
      readRequestOverheads: () => InstanceState.get(requestOverheads),
      readRuntimeContexts: () => InstanceState.get(runtimeContexts),
      drainRewrites: (sessionID) => InstanceState.useEffect(rewriteState, ({ queue }) => queue.drain(sessionID)),
      readScopedAgents: () => InstanceState.get(scopedAgents),
    })

    const runLoop = (sessionID: SessionID): Effect.Effect<SessionV1.WithParts> => loopFns.runLoop(sessionID)

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      const result = yield* withRunRequest(input.sessionID, (request) =>
        promptLocks.withLock(input.sessionID)(
          state.ensureRunningHandle(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID), request),
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
                  const history = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
                  if (history.some((message) => message.info.id === item.messageID)) {
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
                ? command({ ...pending.input, ...shared }, { skipHookStart: true })
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
                    const history = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
                    if (history.some((message) => message.info.id === pending.messageID))
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
            withRunRequest(input.sessionID, (request) =>
              promptLocks.withLock(input.sessionID)(
                Effect.gen(function* () {
                  if (!request.valid()) return yield* Effect.interrupt
                  const target = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
                  const contexts = yield* admit.resumeContexts(target)
                  if (startContext) for (const context of contexts) yield* startContext.append(input.sessionID, context)
                  const initial =
                    input.hookMode !== "interactive" && hookLifecycle
                      ? yield* hookLifecycle.consumeInitial(input.sessionID)
                      : undefined
                  const history = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
                  const initialTurn = initial && !history.some((message) => message.info.role === "user")
                  const latest = history.findLast((message) => message.info.role === "assistant")
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
                    const user = history.findLast((message) => message.info.role === "user")?.info
                    if (user?.role === "user" && user.hookMode !== input.hookMode)
                      yield* sessions.updateMessage({ ...user, hookMode: input.hookMode })
                  }
                  if (!initialTurn && !deferred) return lastAssistant(input.sessionID)
                  // Fork the runner under the same commit lock as the owner check:
                  // a cancel cannot land between the check and the fork. Wait outside
                  // the prompt lock; runLoop claims it for its snapshot.
                  return yield* commit(
                    state.ensureRunningHandle(
                      input.sessionID,
                      lastAssistant(input.sessionID),
                      runLoop(input.sessionID),
                      request,
                    ),
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

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      const result = yield* withRunRequest(input.sessionID, (request) =>
        promptLocks.withLock(input.sessionID)(
          state.startShellHandle(
            input.sessionID,
            lastAssistant(input.sessionID),
            shellImpl(input, ready),
            ready,
            request,
          ),
        ),
      )
      return yield* result
    })

    // #409: early-return command dispatches (/memory, /goal non-kick)
    // must still drive the busy→idle status transition — the run CLI exits its
    // event loop on the idle event, which only the runner's onIdle publishes.
    // startIfIdle keeps today's inline semantics while another turn is running
    // (no queueing, no second idle); the in-flight turn re-emits idle itself.
    const commandTurn = Effect.fnUntraced(function* (sessionID: SessionID, work: Effect.Effect<SessionV1.WithParts>) {
      return yield* withRunRequest(sessionID, (request) =>
        promptLocks.withLock(sessionID)(
          Effect.gen(function* () {
            if (!request.valid()) return yield* Effect.interrupt
            const handle = yield* state.startIfIdle(sessionID, lastAssistant(sessionID), work, request)
            if (!request.valid()) return yield* Effect.interrupt
            return yield* Option.getOrElse(handle, () => work)
          }),
        ),
      )
    })

    const commandBody = Effect.fnUntraced(function* (
      input: CommandInput,
      options: { skipHookStart?: boolean } | undefined,
      commitAdmission: AdmissionCommit | undefined,
      epoch: number,
    ) {
      if (attention) yield* attention.input(input.sessionID)
      // Capture the durable model selection and the app-layer write epoch
      // before the expansion hook. The command commit compares both inside its
      // transaction and skips the old ModelSwitched/post-switch hook if a newer
      // user write landed meanwhile (including no-op and ABA writes).
      const modelBaseline: ModelBaseline = { ...(yield* prepareFns.modelSelection(input.sessionID)), epoch }
      if (!options?.skipHookStart && input.hookMode !== "interactive") {
        const { sessionID, ...followup } = input
        const initial = yield* resume({
          sessionID,
          agent: input.agent,
          variant: input.variant,
          hookMode: "noninteractive",
          initialOnly: true,
          followup: { kind: "command", ...followup },
        })
        if (initial) return initial
      }
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      if (input.command === "memory") {
        return yield* commandTurn(
          input.sessionID,
          Effect.gen(function* () {
            const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
            const argument = input.arguments.trim()
            // #396: anything that is not an exact on/off is a status query —
            // report the true state instead of a hardcoded "remains off".
            const result = memory
              ? argument === "on"
                ? yield* memory.setEnabled(true)
                : argument === "off"
                  ? yield* memory.setEnabled(false)
                  : yield* memory.status()
              : "Memory remains off"
            const model = yield* prepareFns.currentModel(input.sessionID)
            const agentName = input.agent ?? (yield* agents.defaultAgent())
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: agentName,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const commandPart: SessionV1.TextPart = {
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              type: "text",
              text: `/memory ${input.arguments}`.trim(),
              metadata: { command: "memory" },
            }
            yield* sessions.updatePart(commandPart)
            const now = Date.now()
            // time.end set so run-mode consumers print the response (run CLI
            // only renders text parts once ended).
            const responsePart: SessionV1.TextPart = {
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              type: "text",
              text: result,
              time: { start: now, end: now },
            }
            yield* sessions.updatePart(responsePart)
            yield* sessions.touch(input.sessionID)
            return { info: userMsg, parts: [commandPart, responsePart] }
          }),
        )
      }
      // Goal/Subgoal command dispatch — early return BEFORE command registry lookup
      if (goal && (input.command === "goal" || input.command === "subgoal")) {
        const dispatch = input.command === "goal" ? goal.dispatch : goal.dispatchSubgoal
        // Dispatch runs OUTSIDE any runner turn: its busy guards read the true
        // session status, which a commandTurn busy marker would corrupt.
        const dispatchResult = yield* dispatch(input.sessionID, input.arguments).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("goal dispatch failed", { command: input.command, cause: String(cause) })
              return undefined
            }),
          ),
        )
        if (dispatchResult?.type === "kick" && input.command === "goal") {
          const m = yield* prepareFns.currentModel(input.sessionID)
          const agentName = input.agent ?? (yield* agents.defaultAgent())
          // Resume is decided before the command message exists ("earlier messages" excludes it)
          // and outside the uninterruptible commit so a slow hook stays cancellable.
          const goalResumeTexts = yield* admit.resumeContexts(yield* sessions.get(input.sessionID).pipe(Effect.orDie))
          // Persist the input and register its budget before any snapshot can
          // claim it. Run the model only after releasing the admission lock.
          yield* promptLocks.withLock(input.sessionID)(
            Effect.gen(function* () {
              const budget = ToolBudget.create((yield* config.get()).maxToolCalls)
              const userMsg: SessionV1.User = {
                id: input.messageID ?? MessageID.ascending(),
                role: "user",
                sessionID: input.sessionID,
                time: { created: Date.now() },
                agent: agentName,
                model: { providerID: m.providerID, modelID: m.modelID },
              }
              yield* sessions.updateMessage(userMsg)
              const dispatchText = dispatchResult.announce ?? dispatchResult.text
              const cmdText: SessionV1.TextPart = {
                id: PartID.ascending(),
                messageID: userMsg.id,
                sessionID: input.sessionID,
                type: "text",
                text: `/${input.command} ${input.arguments}`.trim(),
                metadata: { command: input.command },
              }
              yield* sessions.updatePart(cmdText)
              // Non-synthetic so UserMessage renders it — the command confirmation
              // (e.g. "⏸ 目标已暂停") must be visible. Matches the goal "done" case
              // (loop.ts), which emits visible goal messages as non-synthetic parts.
              const responsePart: SessionV1.TextPart = {
                id: PartID.ascending(),
                messageID: userMsg.id,
                sessionID: input.sessionID,
                type: "text",
                text: dispatchText,
              }
              yield* sessions.updatePart(responsePart)
              yield* sessions.touch(input.sessionID)
              // GOAL-TURN-SCOPE: this loop() is a goal-driven turn (kick or
              // resume-kick) — mark it so ESC maps to a goal pause.
              yield* goal?.markTurnDriven(input.sessionID)
              // Drain SessionStart hook contexts before loop
              if (startContext) {
                const contexts = [...goalResumeTexts, ...(yield* startContext.consume(input.sessionID))]
                for (const ctx of contexts) {
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: responsePart.messageID,
                    sessionID: input.sessionID,
                    type: "text",
                    text: ctx,
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                }
              }
              const state = yield* budgetState(input.sessionID)
              state.pending.set(userMsg.id, budget)
            }).pipe(Effect.uninterruptible),
          )
          return yield* loop({ sessionID: input.sessionID })
        }
        return yield* commandTurn(
          input.sessionID,
          Effect.gen(function* () {
            const m = yield* prepareFns.currentModel(input.sessionID)
            const agentName = input.agent ?? (yield* agents.defaultAgent())
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: agentName,
              model: { providerID: m.providerID, modelID: m.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            if (!dispatchResult) {
              // Dispatch failed — return error message to user instead of silent fallthrough
              const now = Date.now()
              // time.end set so run-mode consumers print the response (run CLI
              // only renders text parts once ended).
              const errorPart: SessionV1.TextPart = {
                id: PartID.ascending(),
                messageID: userMsg.id,
                sessionID: input.sessionID,
                type: "text",
                ignored: true,
                text: `⚠️ /${input.command} 执行失败，请检查日志。`,
                synthetic: true,
                time: { start: now, end: now },
              }
              yield* sessions.updatePart(errorPart)
              yield* sessions.touch(input.sessionID)
              return { info: userMsg, parts: [errorPart] }
            }
            const dispatchText = dispatchResult.announce ?? dispatchResult.text
            const cmdText: SessionV1.TextPart = {
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              type: "text",
              ignored: true,
              text: `/${input.command} ${input.arguments}`.trim(),
              metadata: { command: input.command },
            }
            yield* sessions.updatePart(cmdText)
            // Non-synthetic so UserMessage renders it — the command confirmation
            // (e.g. "⏸ 目标已暂停") must be visible. Matches the goal "done" case
            // (loop.ts), which emits visible goal messages as non-synthetic parts.
            const now = Date.now()
            // time.end set so run-mode consumers print the response (run CLI
            // only renders text parts once ended).
            const responsePart: SessionV1.TextPart = {
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              type: "text",
              ignored: true,
              text: dispatchText,
              time: { start: now, end: now },
            }
            yield* sessions.updatePart(responsePart)
            yield* sessions.touch(input.sessionID)
            return { info: userMsg, parts: [cmdText, responsePart] }
          }),
        )
      }

      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent
      const expansion = settingsHook
        ? yield* settingsHook.trigger(
            {
              event: "UserPromptExpansion",
              commandName: input.command,
              commandArgs: input.arguments,
              commandSource: cmd.source ?? "command",
              expansionType: cmd.source === "mcp" ? "mcp_prompt" : "slash_command",
              prompt: `/${input.command}${input.arguments ? ` ${input.arguments}` : ""}`,
            },
            { sessionID: input.sessionID },
          )
        : undefined
      if (expansion?.blocked || expansion?.preventContinuation) {
        // This branch returns before the normal landing point below, so notices
        // from the hook that stopped the command must be published here.
        if (expansion) yield* SettingsHook.landSystemMessages(expansion, { sessionID: input.sessionID })
        return yield* withRunRequest(input.sessionID, (request) =>
          promptLocks.withLock(input.sessionID)(
            Effect.gen(function* () {
              if (!request.valid()) return yield* Effect.interrupt
              // A command cancelled while this blocked notice is being admitted
              // must surface as the normal rejected-command error, not a defect
              // that the HTTP layer reports as 500.
              const message = yield* prepareFns
                .createUserMessage(
                  {
                    sessionID: input.sessionID,
                    messageID: input.messageID,
                    agent: input.agent,
                    parts: [
                      {
                        type: "text",
                        text: `[Hook stopped] ${expansion.stopReason ?? expansion.blocked?.reason ?? "Command expansion blocked"}`,
                        ignored: true,
                      },
                    ],
                  },
                  undefined,
                  commitAdmission,
                  modelBaseline,
                )
                .pipe(
                  Effect.catchTag("SessionConversationHookBlocked", (error) =>
                    Effect.fail(new ModelSwitchBlocked({ message: error.reason })),
                  ),
                )
              const handle = yield* state.startIfIdle(
                input.sessionID,
                lastAssistant(input.sessionID),
                Effect.succeed(message),
                request,
              )
              return yield* Option.getOrElse(handle, () => Effect.succeed(message))
            }),
          ),
        )
      }

      const templateCommand = yield* Effect.promise(async () => cmd.template)
      let template = expandCommandTemplate(templateCommand, input.arguments)

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* prepareFns.currentModel(input.sessionID)
      })

      yield* prepareFns.getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* prepareFns.resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [
            {
              type: "text" as const,
              text: `/${input.command}${input.arguments ? ` ${input.arguments}` : ""}`,
              // Marks the invocation so consumers (Memory) can tell commands from pasted paths.
              metadata: { command: input.command },
            },
            ...uniqueTemplateParts.map((part) => (part.type === "text" ? { ...part, synthetic: true } : part)),
            ...(input.parts ?? []),
          ]

      if (expansion) {
        yield* SettingsHook.landSystemMessages(expansion, { sessionID: input.sessionID })
        for (const text of expansion.additionalContexts) {
          parts.push({ type: "text", text, synthetic: true } as (typeof parts)[number])
        }
      }
      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* prepareFns.currentModel(input.sessionID)
        : taskModel

      const result = yield* admit.promptImpl(
        {
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          variant: input.variant,
          hookMode: input.hookMode,
        },
        { skipHookStart: true },
        commitAdmission,
        modelBaseline,
      )
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })
    const commandImpl = Effect.fnUntraced(function* (
      input: CommandInput,
      options: { skipHookStart?: boolean } | undefined,
      commitAdmission?: AdmissionCommit,
    ) {
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => modelWriteBegin(input.sessionID)),
        (scope) => commandBody(input, options, commitAdmission, scope.epoch),
        (scope) => Effect.sync(scope.release),
      )
    })
    // The expansion hook can run for a long time before the message is admitted.
    // Register the admission owner before any hook so an abort fences this command
    // even while it is still expanding, and so its commit cannot land afterwards.
    const command: (
      input: CommandInput,
      options?: { skipHookStart?: boolean },
    ) => Effect.Effect<SessionV1.WithParts, PromptError> = Effect.fn("SessionPrompt.command")(
      function* (input, options) {
        if (options?.skipHookStart)
          return yield* mapAdmissionBlocked<SessionV1.WithParts, PromptError, never>(commandImpl(input, options))
        const admitted = followupAdmissions.run(input.sessionID, (commit) => commandImpl(input, options, commit))
        return yield* mapAdmissionBlocked<SessionV1.WithParts, PromptError, never>(admitted)
      },
    )

    const submit: Interface["submit"] = Effect.fn("SessionPrompt.submit")(function* (input, options) {
      if (options?.localGrant) {
        const grant = permission.grantHookBypass
        if (grant) yield* grant(input.sessionID)
      }
      const parsed = parseCommandPayload(input)
      if (parsed && (yield* commands.get(parsed.command))) {
        return yield* command({
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
      yield* revert.cleanup(current)
      const messages = yield* sessions.messages({ sessionID: input.sessionID })
      const defaultAgent = yield* agents.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent
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
      prepareIfIdle: admit.prepareIfIdle,
      promptIfIdle: admit.promptIfIdle,
      setModel: prepareFns.setModel,
      restoreModelContext: prepareFns.restoreModelContext,
      takeModelSwitchContext: (input) => modelSwitchContext(input.sessionID, input.apiModelID),
      resume,
      followupAdmissionOwnerCount: (sessionID) => followupAdmissions.ownerCount(sessionID),
      loop,
      shell,
      command,
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

const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

/** @internal Exported for command-template regression tests. */
export function expandCommandTemplate(template: string, input: string) {
  const args = (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
  const placeholders = template.match(placeholderRegex) ?? []
  const last = placeholders.reduce((max, item) => Math.max(max, Number(item.slice(1))), 0)
  const expanded = template
    .replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    .replaceAll("$ARGUMENTS", input)

  if (placeholders.length > 0 || template.includes("$ARGUMENTS") || !input.trim()) return expanded
  return `${expanded}\n\n${input}`
}

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

export { admitIfIdle } from "./turn/admit"

export * as SessionPrompt from "./prompt"
