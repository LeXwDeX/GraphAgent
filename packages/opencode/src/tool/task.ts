import { HookTranscript } from "@/hook/transcript"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import * as Option from "effect/Option"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { promptIdentity } from "@/hook/prompt-identity"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { HookStartContext } from "@/hook/start-context"
import { TaskSubagents } from "@/hook/task-subagents"
import { HookTurnContext } from "@/hook/turn-context"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput, options?: SessionPrompt.AdmissionOptions): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function repairBackgroundArgument(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  if (!Object.hasOwn(value, "background")) return value
  const background = Reflect.get(value, "background")
  if (background !== "true" && background !== "false") return value
  return { ...value, background: background === "true" }
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const workflows = Option.getOrUndefined(yield* Effect.serviceOption(DagStore.Service))
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    // Build-phase serviceOption is SAFE here, unlike tool/goal.ts: SettingsHook
    // arrives via Layer.provideMerge (app-runtime.ts), whose output is visible to
    // the ToolRegistry mergeAll group during construction, so this resolves Some.
    // Goal.Service, by contrast, is a mergeAll sibling and invisible at build.
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    // SubagentStart additionalContext is queued here for the child session; prompt
    // admission drains it into synthetic text parts (same pattern as share/session.ts).
    const startCtx = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const parent = yield* sessions.get(ctx.sessionID)
      if (parent.parentID) {
        return yield* Effect.fail(
          new Error("Task delegation is available only to the main conversation, not child agents"),
        )
      }
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id !== undefined ? yield* sessions.get(SessionID.make(params.task_id)) : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const scopedAgent = next
      const scopedOrigin = scopedAgent.hookOrigin ? `agent:${scopedAgent.hookOrigin}` : `agent-config:${next.name}`
      let retainScopedAgent = runInBackground

      const transcript = Effect.fn("TaskTool.hookTranscript")(function* (sessionID: SessionID) {
        return yield* HookTranscript.materialize({
          sessionID,
          directory: yield* InstanceState.directory,
          messages: yield* sessions.messages({ sessionID }).pipe(Effect.orDie),
        }).pipe(Effect.orDie)
      })
      // This tool resolves the raw SettingsHook service, bypassing the
      // prompt-runtime wrapper that derives prompt-scoped fields. Derive the
      // same parent-prompt identity here for SubagentStart/SubagentStop.
      const hookIdentity = Effect.fn("TaskTool.hookIdentity")(function* () {
        const messages = yield* sessions.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
        return promptIdentity(messages as unknown as readonly HookTranscript.Message[])
      })
      let stopToolCount = 0
      const countTools = (messages: readonly SessionV1.WithParts[]) =>
        messages.reduce((count, message) => count + message.parts.filter((part) => part.type === "tool").length, 0)
      const stopPayload = Effect.fn("TaskTool.subagentStopPayload")(function* (active: boolean) {
        const messages = yield* sessions.messages({ sessionID: nextSession.id }).pipe(Effect.orDie)
        stopToolCount = countTools(messages)
        const last = messages.findLast((message) => message.info.role === "assistant")
        return {
          event: "SubagentStop" as const,
          stopHookActive: active,
          agentID: nextSession.id,
          agentType: next.name,
          agentTranscriptPath: yield* transcript(nextSession.id),
          lastAssistantMessage: last?.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          backgroundTasks: yield* HookTurnContext.backgroundTasks(ctx.sessionID, { jobs: background, workflows }),
          sessionCrons: [],
        }
      })
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        if (scopedAgent.hooks !== undefined && settingsHook?.registerScoped)
          yield* settingsHook.registerScoped(nextSession.id, {
            kind: "agent",
            origin: scopedOrigin,
            hooks: scopedAgent.hooks,
            source: scopedAgent.hookSource,
            child: true,
          })
        // SubagentStart hook
        let startContexts: readonly string[] = []
        if (settingsHook) {
          const result = yield* settingsHook
            .trigger(
              { event: "SubagentStart", agentID: nextSession.id, agentType: next.name },
              {
                sessionID: ctx.sessionID,
                transcriptPath: yield* transcript(ctx.sessionID),
                ...(yield* hookIdentity()),
              },
            )
            .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
          yield* SettingsHook.landSystemMessages(result, { sessionID: nextSession.id })
          startContexts = result.additionalContexts
        }
        const parts = yield* ops.resolvePromptParts(params.prompt)
        // Queue immediately before ops.prompt (after parts resolved) so a failed resolve leaves no
        // stale queued context; admission of the child's first message drains it.
        if (startCtx) {
          for (const text of startContexts) {
            if (text) yield* startCtx.append(nextSession.id, text)
          }
        }
        const result = yield* ops.prompt(
          {
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            variant: next.model ? undefined : variant,
            agent: next.name,
            parts,
          },
          { internalDelegation: true },
        )
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        return text
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt(
            {
              sessionID: ctx.sessionID,
              agent: currentParent.agent ?? ctx.agent,
              variant,
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text: renderOutput({
                    sessionID: nextSession.id,
                    state,
                    summary:
                      state === "completed"
                        ? `Background task completed: ${params.description}`
                        : `Background task failed: ${params.description}`,
                    text,
                  }),
                },
              ],
            },
            { continueToolBudget: true },
          )
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result.info?.status !== "completed" && result.info?.status !== "error") return undefined
              const { SessionAttention } = yield* Effect.promise(() => import("@/notification/attention"))
              const { Notification } = yield* Effect.promise(() => import("@/notification"))
              const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
              const notification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
              if (attention && notification && (yield* attention.viewing(ctx.sessionID)))
                yield* notification.notify({
                  sessionID: nextSession.id,
                  notificationType: "agent_completed",
                  message: "A background agent finished",
                })
              return yield* result.info.status === "completed"
                ? inject("completed", result.info.output ?? "")
                : inject("error", result.info.error ?? "")
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      // Foreground task call: this tool fires SubagentStop for the child, so the
      // child's own prompt loop must skip the main-agent Stop (see TaskSubagents).
      // Released at promotion to background or when the foreground wait ends.
      const subagent = runInBackground ? undefined : yield* TaskSubagents.register(nextSession.id)
      const releaseSubagent = subagent?.release ?? Effect.void
      const info = yield* background
        .start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          onPromote: Effect.all([
            ctx.metadata({
              title: params.description,
              metadata: { ...metadata, background: true, jobId: nextSession.id },
            }),
            notify(nextSession.id),
            // From here the child is a background task and fires its own Stop.
            releaseSubagent,
          ]),
          run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
        })
        .pipe(Effect.onError(() => releaseSubagent))

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make().pipe(Effect.onError(() => releaseSubagent))
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.gen(function* () {
        let output = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            ctx.abort.addEventListener("abort", onAbort)
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.raceFirst(
                background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
                background.waitForPromotion(nextSession.id),
              )
              if (result?.metadata?.background === true) return backgroundResult()
              if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
              if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
              return {
                title: params.description,
                metadata,
                output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
              }
            }),
          (_, exit) =>
            Effect.gen(function* () {
              if (Exit.hasInterrupts(exit))
                yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.abort.removeEventListener("abort", onAbort)
                }),
              ),
            ),
        )
        // SubagentStop hook with continuation: a blocked SubagentStop re-prompts the
        // subagent for another turn; the next SubagentStop then carries
        // stop_hook_active=true so a well-behaved hook stops blocking (anti-loop,
        // mirroring the prompt.ts Stop path). Skipped when promoted to background
        // (the subagent is still running, not stopped); promotion released the
        // TaskSubagents registration, so the child's own loop fires Stop.
        const promoted = Boolean((output.metadata as { background?: boolean } | undefined)?.background)
        retainScopedAgent = promoted
        // Promotion raced a clean child exit that had already skipped its own
        // Stop for this call: deliver SubagentStop once (no continuation, the
        // task now runs in the background).
        if (settingsHook && promoted && subagent && (yield* subagent.stopDelegated)) {
          const stopResult = yield* settingsHook
            .trigger(yield* stopPayload(false), {
              sessionID: ctx.sessionID,
              transcriptPath: yield* transcript(ctx.sessionID),
              ...(yield* hookIdentity()),
            })
            .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
          yield* SettingsHook.landSystemMessages(stopResult, { sessionID: ctx.sessionID })
          // A `continue:false` stopReason is user-visible, like the V1 Stop path.
          if (
            stopResult.preventContinuation &&
            stopResult.stopReason &&
            !stopResult.systemMessages.includes(stopResult.stopReason)
          )
            yield* SettingsHook.landSystemMessages(
              { additionalContexts: [], systemMessages: [stopResult.stopReason] },
              { sessionID: ctx.sessionID },
            )
        }
        if (settingsHook && !promoted) {
          let subagentStopBlocked = false
          // Hard cap on blocked-SubagentStop continuation: a misbehaving hook that
          // ignores stop_hook_active would otherwise re-prompt forever (burning
          // tokens). Capped here; at the limit we log.warn and stop. Mirrors the
          // main agent Stop path (prompt.ts). Shared constant from SettingsHook.
          let lastStillBlocked = false
          for (let i = 0; i < SettingsHook.MAX_STOP_CONTINUATIONS; i++) {
            const stopResult = yield* settingsHook
              .trigger(yield* stopPayload(subagentStopBlocked), {
                sessionID: ctx.sessionID,
                transcriptPath: yield* transcript(ctx.sessionID),
                ...(yield* hookIdentity()),
              })
              .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
            // Land any hook systemMessages so they're never silently dropped.
            yield* SettingsHook.landSystemMessages(stopResult, { sessionID: ctx.sessionID })
            // `continue:false` ends the subagent loop, so its stopReason cannot be
            // model feedback either; surface it the same way.
            if (
              stopResult.preventContinuation &&
              stopResult.stopReason &&
              !stopResult.systemMessages.includes(stopResult.stopReason)
            )
              yield* SettingsHook.landSystemMessages(
                { additionalContexts: [], systemMessages: [stopResult.stopReason] },
                { sessionID: ctx.sessionID },
              )
            if (
              (!stopResult.blocked && !stopResult.additionalContexts?.some((text) => text.trim())) ||
              stopResult.preventContinuation
            ) {
              lastStillBlocked = false
              break
            }
            lastStillBlocked = true
            subagentStopBlocked = true
            // Continue the subagent: feed the block reason and run another turn.
            // A failure here breaks the loop immediately (don't swallow the error
            // and re-loop forever — the prior Effect.catch did that).
            const toolsBefore = stopToolCount
            const cont = yield* ops
              .prompt(
                {
                  messageID: MessageID.ascending(),
                  sessionID: nextSession.id,
                  model: { modelID: model.modelID, providerID: model.providerID },
                  variant: next.model ? undefined : variant,
                  agent: next.name,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text:
                        [...(stopResult.additionalContexts ?? []), stopResult.blocked?.reason]
                          .filter(Boolean)
                          .join("\n\n") || "Continue.",
                    },
                  ],
                },
                { continueToolBudget: true, internalDelegation: true },
              )
              .pipe(Effect.exit)
            if (Exit.isFailure(cont)) {
              lastStillBlocked = false
              break
            }
            const after = yield* sessions.messages({ sessionID: nextSession.id }).pipe(Effect.orDie)
            // Like the main Stop budget, only consecutive feedback turns without tool work count.
            if (countTools(after) > toolsBefore) i = -1
            // The parent receives the continuation's final answer, not the stale first one.
            output = {
              ...output,
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: cont.value.parts.findLast((item) => item.type === "text")?.text ?? "",
              }),
            }
          }
          if (lastStillBlocked) {
            yield* Effect.logWarning("SubagentStop continuation limit reached; forcing stop", {
              agentID: nextSession.id,
              agentType: next.name,
              limit: SettingsHook.MAX_STOP_CONTINUATIONS,
            })
          }
        }
        return output
      }).pipe(
        Effect.ensuring(releaseSubagent),
        Effect.ensuring(
          Effect.suspend(() =>
            !retainScopedAgent && settingsHook?.unregisterScoped
              ? settingsHook.unregisterScoped(nextSession.id, scopedOrigin)
              : Effect.void,
          ),
        ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      repairArguments: repairBackgroundArgument,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
