import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@graphagent/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@graphagent/core/dag/store"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission, subagentDefaultDeniedTools } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import * as Option from "effect/Option"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@graphagent/core/database/database"
import { AgentScheduler } from "@/session/agent-scheduler"
import { SettingsHook, type TriggerResult } from "@/hook"
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
const CANCEL_DESCRIPTION = [
  'Cancellation: call with action="cancel" and the background task_id to stop one of this session\'s background tasks.',
  "Only background tasks can be cancelled this way; a foreground task is cancelled from the parent session, and a task from another session is refused.",
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
const TRUNCATION_CONTINUATION =
  "Your previous turn hit the output token limit. Do not redo the work; write the final answer now."

function finalText(result: SessionV1.WithParts) {
  return result.parts.findLast((part) => part.type === "text")?.text ?? ""
}

// A continuation answers the same task. Keep the earlier partial when the
// continuation adds nothing, but do not duplicate an answer it already contains.
function mergePartial(prior: string, text: string) {
  if (!prior || prior === text) return text || prior
  if (!text) return prior
  return text.includes(prior) ? text : `${prior}\n${text}`
}

// A child has no human to type "continue" after the output cap cuts its turn.
// Never let that truncation read as a completed task with an empty result.
function settle(result: SessionV1.WithParts, prior = ""): { text: string; error?: Error } {
  const text = finalText(result)
  const partial = mergePartial(prior, text)
  const info = result.info.role === "assistant" ? result.info : undefined
  // Keep the child session reachable: the parent can resume it by passing this
  // id back as task_id instead of redoing the whole task from scratch.
  const resume = info
    ? `. Continue: task task_id="${info.sessionID}" prompt="Continue the task and write the final answer now."`
    : ""
  if (info?.finish === "length") {
    const { output, reasoning } = info.tokens
    const detail = `${output + reasoning}; reasoning ${reasoning}, text ${output}`
    return {
      text,
      error: new Error(
        `Subagent output truncated at the output token cap (${detail})` +
          (partial ? `. Partial output:\n${partial}` : "") +
          resume,
      ),
    }
  }
  if (!text.trim())
    return {
      text,
      error: new Error(
        "Subagent returned an empty final answer" + (partial ? `. Partial output:\n${partial}` : "") + resume,
      ),
    }
  return { text }
}

function providerFailure(result: SessionV1.WithParts, prior = ""): Error | undefined {
  const error = result.info.role === "assistant" ? result.info.error : undefined
  if (!error || error.name === "MessageAbortedError") return undefined
  const detail = "message" in error.data && typeof error.data.message === "string" ? error.data.message : ""
  const reason = detail ? `${error.name}: ${detail}` : error.name
  const partial = mergePartial(prior, finalText(result))
  return new Error(partial ? `Subagent failed (${reason}). Partial output:\n${partial}` : `Subagent failed (${reason})`)
}

function continuationFailure(cause: Cause.Cause<unknown>, prior: string): Effect.Effect<never, unknown> {
  if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
  const defect = Cause.squash(cause)
  const detail = defect instanceof Error ? defect.message : String(defect)
  return Effect.die(
    new Error(`Subagent continuation failed (${detail})` + (prior ? `. Partial output:\n${prior}` : ""), {
      cause: defect,
    }),
  )
}

const TaskParameterFields = {
  action: Schema.optional(Schema.Literal("cancel")).annotate({
    description:
      'Set to "cancel" together with task_id to cancel one of this session\'s background tasks. Omit for a normal task run. Only background tasks can be cancelled here; a foreground task is cancelled from the parent session.',
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "A short (3-5 words) description of the task; required unless action is cancel",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "The task for the agent to perform; required unless action is cancel",
  }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "The type of specialized agent to use for this task; required unless action is cancel",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      'With action "cancel": the background task to cancel. Otherwise set only to resume a previous task (pass a prior task_id and the task continues the same subagent session instead of creating a fresh one)',
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

type TaskShape = Schema.Schema.Type<Schema.Struct<typeof TaskParameterFields>>

// The tool accepts two shapes on one object root: a start/resume call and
// `{ action: "cancel", task_id }`. A root-level union is outside the OpenAI
// tools contract (see Tool.assertObjectRootedParameters), so both shapes share
// one optional-field struct and are distinguished here at decode time.
const requireTaskShape = Schema.makeFilter<TaskShape>((value) => {
  if (value.action === "cancel") {
    return value.task_id ? undefined : 'task_id is required when action is "cancel"'
  }
  return value.description && value.prompt && value.subagent_type
    ? undefined
    : "description, prompt and subagent_type are required unless action is cancel"
})

const BaseParameters = Schema.Struct(TaskParameterFields).check(requireTaskShape)

export const Parameters = Schema.Struct({
  ...TaskParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
}).check(requireTaskShape)

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
    // Child runs share the process-level child pool (#1021). Optional so a
    // standalone harness without the app layer runs unconstrained.
    const scheduler = Option.getOrUndefined(yield* Effect.serviceOption(AgentScheduler.Service))
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
      if (params.action === "cancel") {
        // Registered by C2 for H3 (#1026). The child-run cancellation service
        // does not exist yet, so fail closed instead of starting a task.
        return yield* Effect.fail(
          new Error(
            "Task cancellation is not implemented in this build; stop the parent session to cancel a foreground task.",
          ),
        )
      }
      if (params.description === undefined || params.prompt === undefined || params.subagent_type === undefined) {
        return yield* Effect.fail(
          new Error("description, prompt and subagent_type are required unless action is cancel"),
        )
      }
      const description: string = params.description
      const prompt: string = params.prompt
      const subagentType: string = params.subagent_type
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require GRAPHAGENT_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [subagentType],
          always: ["*"],
          metadata: {
            description,
            subagent_type: subagentType,
          },
        })
      }

      const next = yield* agent.get(subagentType)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${subagentType} is not a valid agent type`))
      }

      const session = params.task_id !== undefined ? yield* sessions.get(SessionID.make(params.task_id)) : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...subagentDefaultDeniedTools(next).map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })),
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
          title: description + ` (@${next.name} subagent)`,
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

      let stopToolCursor: string | undefined
      const stopPayload = Effect.fn("TaskTool.subagentStopPayload")(function* (active: boolean) {
        const recent = yield* sessions.messages({ sessionID: nextSession.id, limit: 1 }).pipe(Effect.orDie)
        const latest = recent.at(-1)
        stopToolCursor = latest
          ? MessageV2.cursor.encode({ id: latest.info.id, time: latest.info.time.created })
          : undefined
        const last =
          latest?.info.role === "assistant"
            ? latest
            : Option.getOrUndefined(
                yield* sessions
                  .findMessage(nextSession.id, (message) => message.info.role === "assistant")
                  .pipe(Effect.orDie),
              )
        return {
          event: "SubagentStop" as const,
          stopHookActive: active,
          agentID: nextSession.id,
          agentType: next.name,
          lastAssistantMessage: last?.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          backgroundTasks: yield* HookTurnContext.backgroundTasks(ctx.sessionID, { jobs: background, workflows }),
          sessionCrons: [],
        }
      })
      // Scans forward from the stop-payload cursor for tool work started by a
      // blocked-continuation turn instead of re-reading the whole session.
      const newToolWorkSince = (after: string | undefined) =>
        Effect.gen(function* () {
          let cursor = after
          while (true) {
            const page = yield* MessageV2.after({ sessionID: nextSession.id, limit: 50, after: cursor }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.orDie,
            )
            if (page.items.some((message) => message.parts.some((part) => part.type === "tool"))) return true
            if (!page.more || !page.cursor) return false
            cursor = page.cursor
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
        title: description,
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
              { sessionID: ctx.sessionID },
            )
            .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
          yield* SettingsHook.landSystemMessages(result, { sessionID: nextSession.id })
          startContexts = result.additionalContexts
        }
        const parts = yield* ops.resolvePromptParts(prompt)
        // Queue immediately before ops.prompt (after parts resolved) so a failed resolve leaves no
        // stale queued context; admission of the child's first message drains it.
        if (startCtx) {
          for (const text of startContexts) {
            if (text) yield* startCtx.append(nextSession.id, text)
          }
        }
        let result = yield* ops.prompt(
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
        // A child that ended on a provider or output error must not read as a
        // completed task carrying an empty or partial answer. Cancellation keeps
        // its existing interrupt path.
        const failure = providerFailure(result)
        if (failure) return yield* Effect.fail(failure)
        let prior = ""
        // One bounded continuation in the same child session: the cap cut the
        // child's turn, and it has no human to ask for the rest.
        if (result.info.role === "assistant" && result.info.finish === "length") {
          prior = finalText(result)
          const continued = yield* ops
            .prompt(
              {
                messageID: MessageID.ascending(),
                sessionID: nextSession.id,
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                variant: next.model ? undefined : variant,
                agent: next.name,
                parts: [{ type: "text", synthetic: true, text: TRUNCATION_CONTINUATION }],
              },
              { continueToolBudget: true, internalDelegation: true },
            )
            .pipe(Effect.exit)
          if (Exit.isFailure(continued)) return yield* continuationFailure(continued.cause, prior)
          result = continued.value
          const continuedFailure = providerFailure(result, prior)
          if (continuedFailure) return yield* Effect.fail(continuedFailure)
        }
        const settled = settle(result, prior)
        if (settled.error) return yield* Effect.fail(settled.error)
        return settled.text
      })

      // The child-run slot covers the whole subagent run, and task runs only
      // draw the slots left after the DAG workflow reservation; DAG runs never
      // enter the per-parent task bucket (#1021).
      const runWithSlot = Effect.fn("TaskTool.runWithSlot")(function* () {
        if (!scheduler) return yield* runTask()
        const limits = yield* scheduler.limits()
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* scheduler.childSlot({ kind: "task", parentSessionID: ctx.sessionID }, limits.childGlobal)
            return yield* runTask()
          }),
        )
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
                        ? `Background task completed: ${description}`
                        : `Background task failed: ${description}`,
                    text,
                  }),
                },
              ],
            },
            { continueToolBudget: true },
          )
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      // A goal waiting on this background task registers its task id. Wake
      // only that wait; see watch_pr for the evaluate semantics.
      const wakeGoal = (jobID: string, payload: string, evaluate: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          const { GoalLoop } = yield* Effect.promise(() => import("@/goal/loop"))
          const loops = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoop.Service))
          if (!loops) return
          yield* loops.wake(ctx.sessionID, { source: "background_job", ids: [jobID] }, payload, { evaluate })
        }).pipe(Effect.ignore)

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result.info?.status !== "completed" && result.info?.status !== "error") {
                // No result prompt follows (cancelled or vanished job): end the
                // wait now so the goal does not sleep until its deadline.
                yield* wakeGoal(
                  jobID,
                  `Background task ${description} ended without a result (${result.info?.status ?? "missing"})`,
                  true,
                )
                return undefined
              }
              yield* wakeGoal(
                jobID,
                result.info.status === "completed"
                  ? `Background task completed: ${description}`
                  : `Background task failed: ${description}`,
                false,
              )
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

      if (yield* background.extend({ id: nextSession.id, run: runWithSlot() })) {
        return {
          title: description,
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
          title: description,
          metadata,
          onPromote: Effect.all([
            ctx.metadata({
              title: description,
              metadata: { ...metadata, background: true, jobId: nextSession.id },
            }),
            notify(nextSession.id),
            // From here the child is a background task and fires its own Stop.
            releaseSubagent,
          ]),
          run: runWithSlot().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
        })
        .pipe(Effect.onError(() => releaseSubagent))

      function backgroundResult() {
        return {
          title: description,
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
                title: description,
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
            .trigger(yield* stopPayload(false), { sessionID: ctx.sessionID })
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
          // main agent Stop path (prompt.ts); both read the same env override.
          let lastStillBlocked = false
          const stopHookContinuationCap = SettingsHook.stopHookBlockCap()
          for (let i = 0; i < stopHookContinuationCap; i++) {
            const stopResult = yield* settingsHook
              .trigger(yield* stopPayload(subagentStopBlocked), { sessionID: ctx.sessionID })
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
            if (!stopResult.blocked || stopResult.preventContinuation) {
              if (stopResult.additionalContexts?.some((text) => text.trim()))
                yield* Effect.logDebug("ignoring non-blocking SubagentStop context")
              lastStillBlocked = false
              break
            }
            lastStillBlocked = true
            subagentStopBlocked = true
            // Continue the subagent: feed the block reason and run another turn.
            // A failure here breaks the loop immediately (don't swallow the error
            // and re-loop forever — the prior Effect.catch did that).
            const toolCursor = stopToolCursor
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
            // A failed continuation is not a clean stop: propagate its
            // interruption, defect, or failure instead of returning stale output.
            if (Exit.isFailure(cont)) return yield* Effect.failCause(cont.cause)
            // Like the main Stop budget, only consecutive feedback turns without tool work count.
            if (yield* newToolWorkSince(toolCursor)) i = -1
            const failure = providerFailure(cont.value)
            if (failure) {
              lastStillBlocked = false
              output = {
                ...output,
                output: renderOutput({ sessionID: nextSession.id, state: "error", text: failure.message }),
              }
              break
            }
            // The parent receives the continuation's final answer, not the stale first one.
            const settled = settle(cont.value)
            if (settled.error) {
              lastStillBlocked = false
              output = {
                ...output,
                output: renderOutput({ sessionID: nextSession.id, state: "error", text: settled.error.message }),
              }
              break
            }
            output = {
              ...output,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: settled.text }),
            }
          }
          if (lastStillBlocked) {
            yield* Effect.logWarning("SubagentStop continuation limit reached; forcing stop", {
              agentID: nextSession.id,
              agentType: next.name,
              limit: stopHookContinuationCap,
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
      description: [
        DESCRIPTION,
        ...(flags.experimentalBackgroundSubagents ? [BACKGROUND_DESCRIPTION] : []),
        CANCEL_DESCRIPTION,
      ].join("\n\n"),
      effects: "unknown",
      parameters: Parameters,
      repairArguments: repairBackgroundArgument,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
