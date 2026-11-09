// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import type { Database } from "@graphagent/core/database/database"
import { Shell } from "@graphagent/core/shell"
import { NamedError } from "@graphagent/core/util/error"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { ulid } from "ulid"
import { ChildProcess } from "effect/process"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Cause, Effect, Exit, Latch, Schema, Stream } from "effect"
import type { Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook } from "@/hook"
import { HookTranscript } from "@/hook/transcript"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { SHELL_ABORT_NOTE } from "../tool/shell"
import { ShellID } from "@/tool/shell/id"
import type { Agent } from "../agent/agent"
import { MCP } from "../mcp"
import type { Config } from "@/config/config"
import type { SessionCancellation } from "./cancellation"
import type { SessionRevert } from "./revert"
import type { SessionRunState } from "./run-state"
import { MessageID, PartID, type SessionID } from "./schema"
import { Session } from "./session"
import { SessionTools } from "./tools"
import type { ToolSourceLedger } from "./tool-source-ledger"
import type { PrepareApi } from "./turn/prepare"
import { dropReverted } from "./turns"
import type { ShellInput } from "./prompt"

export interface ShellDeps {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly config: Config.Interface
  readonly db: Database.Interface["db"]
  readonly revert: SessionRevert.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly toolSources: ToolSourceLedger.Interface
  readonly permission: Permission.Interface
  readonly registry: ToolRegistry.Interface
  readonly mcp: MCP.Interface
  readonly truncate: Truncate.Interface
  readonly spawner: ChildProcessSpawner["Service"]
  readonly prepareFns: PrepareApi
  readonly ops: () => Effect.Effect<TaskPromptOps>
  readonly promptLocks: KeyedMutex.KeyedMutex<SessionID>
  readonly withRunRequest: <A, E, R>(
    sessionID: SessionID,
    use: (request: ReturnType<typeof SessionCancellation.request>) => Effect.Effect<A, E, R>,
    admitted?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<A, E, R>
  readonly state: SessionRunState.Interface
  readonly lastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
}

export function makeShell(deps: ShellDeps) {
  const {
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
    ops,
    promptLocks,
    withRunRequest,
    state,
    lastAssistant,
  } = deps

  const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
        const { msg, part, cwd } = yield* Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          if (session.revert) {
            yield* dropReverted({ db, sessions }, session)
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

  return { shell }
}

export * as Shell from "./shell"
