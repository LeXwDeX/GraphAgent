// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionAdmission } from "@graphagent/core/session/admission"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { NamedError } from "@graphagent/core/util/error"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { fileURLToPath } from "url"
import { Effect, Option } from "effect"
import type { Context } from "effect"
import { ConfigMarkdown } from "@/config/markdown"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { SettingsHook } from "@/hook"
import { Memory } from "@/memory/memory"
import { shellVerdict } from "@/project/trust/command-shell"
import { ProjectTrust } from "@/project/trust/service"
import { Provider } from "@/provider/provider"
import { Process } from "@/util/process"
import { Shell } from "@graphagent/core/shell"
import { Command } from "../command"
import type { Agent } from "../agent/agent"
import type { Config } from "@/config/config"
import type { Goal } from "@/goal/goal"
import type { HookStartContext } from "@/hook/start-context"
import type { SessionAttention } from "@/notification/attention"
import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import type { PromptLockWitness, Request, RunRequestWitness } from "./locks"
import { MessageID, PartID, type SessionID } from "./schema"
import { Session } from "./session"
import type { SessionRunState } from "./run-state"
import type { Admit } from "./turn/admit"
import { ModelSwitchBlocked } from "./turn/prepare"
import type { PrepareApi } from "./turn/prepare"
import type { AdmissionCommit, ModelBaseline } from "./turns"
import type { ChildRunCredential } from "./child/types"
import type { CommandInput, Interface, LoopInput, PromptError } from "./prompt"

export interface CommandDeps {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly config: Config.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly commands: Command.Interface
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly attention: SessionAttention.Interface | undefined
  readonly goal: Goal.Interface | undefined
  readonly startContext: HookStartContext.Interface | undefined
  readonly prepareFns: PrepareApi
  readonly resume: Interface["resume"]
  readonly admit: ReturnType<typeof Admit.makeAdmit>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly budgetState: (sessionID: SessionID) => Effect.Effect<{
    active?: ToolBudget.Budget
    pending: Map<MessageID, ToolBudget.Budget>
  }>
  readonly promptLocks: KeyedMutex.KeyedMutex<SessionID>
  readonly withRunRequest: <A, E, R>(
    sessionID: SessionID,
    use: (request: Request, witness: RunRequestWitness) => Effect.Effect<A, E, R>,
    admitted?: Request,
  ) => Effect.Effect<A, E, R>
  readonly withPromptLock: <A, E, R>(
    witness: RunRequestWitness,
    sessionID: SessionID,
    use: (witness: PromptLockWitness) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly state: SessionRunState.Interface
  readonly lastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  readonly modelWriteBegin: (sessionID: SessionID) => { epoch: number; release: () => void }
  readonly followupAdmissions: ReturnType<typeof SessionAdmission.make>
}

/**
 * Options of one command invocation. `credential` is the live child-run
 * credential a resumed followup carries (Issue #1026, PR5): the command's own
 * admission through `promptImpl` refuses a child session without it.
 */
interface CommandOptions {
  readonly skipHookStart?: boolean
  readonly credential?: ChildRunCredential
}

/** The extras of a command admission: its origin, and the credential of the child run replaying it. */
const commandExtras = (credential: ChildRunCredential | undefined) => ({
  origin: { kind: "user" as const, via: "command" as const },
  ...(credential ? { credential } : {}),
})

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

/**
 * `/memory`: toggle or report the memory feature, then record the exchange as
 * a command message with a visible response.
 */
function memoryCommandMessage(deps: Pick<CommandDeps, "sessions" | "agents" | "prepareFns">, input: CommandInput) {
  const { sessions, agents, prepareFns } = deps
  return Effect.gen(function* () {
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
  })
}

/**
 * `cmd` carries the skill-promotion provenance (#1040) that lets
 * `shellVerdict` fail closed on a project-owned skill outside
 * `.agents/skills` instead of falling through as "no declaration found".
 */
const shellVerdictInput = (root: string, name: string, template: string, cmd: Command.Info) => ({
  root,
  command: name,
  template,
  skill: Command.skillCommandOrigin(cmd),
})

export function makeCommand(deps: CommandDeps) {
  const {
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
    resume,
    admit,
    loop,
    budgetState,
    promptLocks,
    withRunRequest,
    withPromptLock,
    state,
    lastAssistant,
    modelWriteBegin,
    followupAdmissions,
  } = deps

  // #409: early-return command dispatches (/memory, /goal non-kick)
  // must still drive the busy→idle status transition — the run CLI exits its
  // event loop on the idle event, which only the runner's onIdle publishes.
  // startIfIdle keeps today's inline semantics while another turn is running
  // (no queueing, no second idle); the in-flight turn re-emits idle itself.
  const commandTurn = Effect.fnUntraced(function* (sessionID: SessionID, work: Effect.Effect<SessionV1.WithParts>) {
    return yield* withRunRequest(sessionID, (request, witness) =>
      withPromptLock(witness, sessionID, () =>
        Effect.gen(function* () {
          if (!request.valid()) return yield* Effect.interrupt
          const handle = yield* state.startIfIdle(sessionID, lastAssistant(sessionID), work, request)
          if (!request.valid()) return yield* Effect.interrupt
          return yield* Option.getOrElse(handle, () => work)
        }),
      ),
    )
  })

  // Inline `!`shell`` segments execute host commands. A project command
  // declares them for trust review; only the exact declared segments may run,
  // and only while trusted. User and builtin commands have no project-level
  // declaration and are unaffected.
  const commandShellVerdict = Effect.fnUntraced(function* (name: string, template: string, cmd: Command.Info) {
    const trust = Option.getOrUndefined(yield* Effect.serviceOption(ProjectTrust.Service))
    if (!trust) return { type: "allow" as const }
    const ctx = yield* InstanceRef
    if (!ctx || ctx.trustProject === true) return { type: "allow" as const }
    return yield* shellVerdict(shellVerdictInput(ctx.root, name, template, cmd), trust.gate)
  })

  const commandBody = Effect.fnUntraced(function* (
    input: CommandInput,
    options: CommandOptions | undefined,
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
    if (input.command === "memory") return yield* commandTurn(input.sessionID, memoryCommandMessage(deps, input))
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
      return yield* withRunRequest(input.sessionID, (request, witness) =>
        withPromptLock(witness, input.sessionID, () =>
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
    // Shell segments are matched, trusted and executed on the declared
    // template; arguments expand only afterwards, so `$ARGUMENTS` can never
    // introduce or rewrite a command.
    let template = templateCommand

    const shellMatches = ConfigMarkdown.shell(template)
    if (shellMatches.length > 0) {
      const verdict = yield* commandShellVerdict(input.command, template, cmd)
      if (verdict.type === "refuse") {
        const error = new NamedError.Unknown({
          message: `Command "/${input.command}" did not run its embedded shell: ${verdict.reason} Run /trust to review project commands.`,
        })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
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
    template = expandCommandTemplate(template, input.arguments).trim()

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
      commandExtras(options?.credential),
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
    options: CommandOptions | undefined,
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
    options?: CommandOptions,
  ) => Effect.Effect<SessionV1.WithParts, PromptError> = Effect.fn("SessionPrompt.command")(function* (input, options) {
    if (options?.skipHookStart)
      return yield* mapAdmissionBlocked<SessionV1.WithParts, PromptError, never>(commandImpl(input, options))
    const admitted = followupAdmissions.run(input.sessionID, (commit) => commandImpl(input, options, commit))
    return yield* mapAdmissionBlocked<SessionV1.WithParts, PromptError, never>(admitted)
  })

  return { command }
}

export * as Command from "./command"
