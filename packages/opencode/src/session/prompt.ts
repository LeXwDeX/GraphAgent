import { Flag } from "@opencode-ai/core/flag/flag"
import {
  assessCanonicalReasoning,
  makeRewriteBudget,
  makeRewriteScheduler,
  rewriteLogFields,
  runReasoningRewrite,
} from "@opencode-ai/core/session/reasoning-distillation"
import { ConfigReasoningDistillation } from "@opencode-ai/core/config/reasoning-distillation"
import { adoptReasoning } from "./reasoning-adoption"
import { withHookFeedback } from "@/hook/trigger-result"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { measured } from "./overflow"
import { SessionRevert } from "./revert"

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
import { SHELL_ABORT_NOTE } from "../tool/shell"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Deferred, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AgentAttachment, FileAttachment, Prompt, Source } from "@opencode-ai/core/session/prompt"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { Todo } from "./todo"
import { TodoReminders } from "./todo-reminders"
import { SessionTools } from "./tools"
import { ToolSourceLedger } from "./tool-source-ledger"
import { LLMEvent } from "@opencode-ai/llm"
import { SettingsHook, HOOK_REWAKE_SENTINEL, type TriggerResult } from "@/hook/settings"
import { TaskSubagents } from "@/hook/task-subagents"
import { applyPreHookDecision } from "@/hook/pre-hook-decision"
import { dispatchTrust } from "@/hook/workspace-trust"
import { HookStartContext } from "@/hook/start-context"
import { HookRewake } from "@/hook/rewake"
import { Goal } from "@/goal/goal"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { Memory } from "@/memory/memory"
import { SessionAutomationLease } from "./automation-lease"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { setCaptureSnapshot } from "@/dag/runtime/capture"
import { ToolBudget } from "@opencode-ai/core/session/tool-budget"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface AdmissionOptions {
  /** Internal follow-ups retain the current input's tool budget. */
  readonly continueToolBudget?: boolean
  /**
   * Opaque SettingsHook stop-chain token riding on an async Stop-hook rewake.
   * When set, admission re-validates the chain before commit and the run path
   * re-validates before runLoop, refusing callbacks whose chain was
   * invalidated by a session cancel after their completion check. Only the
   * hook rewake paths set this; plain user prompts never do.
   */
  readonly stopChainToken?: unknown
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput, options?: AdmissionOptions) => Effect.Effect<SessionV1.WithParts, Image.Error>
  /** Run a short commit while idle, serialized with prompt admission. Never start or await a turn here. */
  readonly withIdle: <A, E, R>(
    sessionID: SessionID,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>
  readonly prepareIfIdle: (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void>,
    options?: AdmissionOptions,
  ) => Effect.Effect<Option.Option<IdleAdmission>, Image.Error>
  readonly promptIfIdle: (
    input: PromptInput,
    options?: AdmissionOptions,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  readonly editQueuedMessage: (input: QueuedMessageEditInput) => Effect.Effect<SessionV1.WithParts, QueuedMessageError>
  readonly deleteQueuedMessage: (input: QueuedMessageDeleteInput) => Effect.Effect<boolean, QueuedMessageError>
}

export const QueuedMessageExpected = Schema.Struct({
  partID: PartID,
  expectedText: Schema.String,
  expectedPartIDs: Schema.Array(PartID),
})

export const QueuedMessageEditInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  ...QueuedMessageExpected.fields,
  text: Schema.String,
})
export type QueuedMessageEditInput = typeof QueuedMessageEditInput.Type

export const QueuedMessageDeleteInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  ...QueuedMessageExpected.fields,
})
export type QueuedMessageDeleteInput = typeof QueuedMessageDeleteInput.Type

export class QueuedMessageNotFound extends Schema.TaggedErrorClass<QueuedMessageNotFound>()("QueuedMessageNotFound", {
  messageID: MessageID,
}) {}

export class QueuedMessageInvalid extends Schema.TaggedErrorClass<QueuedMessageInvalid>()("QueuedMessageInvalid", {
  message: Schema.String,
}) {}

export class QueuedMessageConflict extends Schema.TaggedErrorClass<QueuedMessageConflict>()("QueuedMessageConflict", {
  kind: Schema.Literals(["already_consumed", "stale", "not_queued", "history_uncertain"]),
  message: Schema.String,
}) {}

export type QueuedMessageError = QueuedMessageNotFound | QueuedMessageInvalid | QueuedMessageConflict

export interface IdleAdmission {
  readonly activate: Effect.Effect<void>
  readonly result: Effect.Effect<SessionV1.WithParts>
  readonly abort: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
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
    const todoSvc = yield* Todo.Service
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
    // Rewrite jobs and budgets belong to the directory: disposing the instance closes this scope, which interrupts
    // pending organizer calls before they can spend tokens or touch the disposed instance's sessions. Deleting a
    // session cancels its own jobs the same way.
    const rewriteState = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const instanceScope = yield* Scope.Scope
        const scheduler = makeRewriteScheduler<{ messageID: MessageID; partID: PartID }>(instanceScope, {
          settleMs: () => Flag.OPENCODE_REASONING_DISTILLATION_SETTLE_MS,
        })
        const budget = makeRewriteBudget()
        yield* Effect.acquireRelease(
          events.listen((event) => {
            if (event.type !== Session.Event.Deleted.type) return Effect.void
            const data = event.data
            if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
            if (typeof data.sessionID !== "string") return Effect.void
            budget.forget(data.sessionID)
            return scheduler.cancel(data.sessionID)
          }),
          (unsubscribe) => unsubscribe,
        )
        return { scheduler, budget }
      }),
    )
    const reasoningDistillationEnabled = (model: Provider.Model) =>
      config.get().pipe(
        Effect.map(
          (cfg) =>
            ConfigReasoningDistillation.resolveEnabled({
              disabledByEnvironment: Flag.OPENCODE_DISABLE_REASONING_DISTILLATION,
              enabled: cfg.reasoningDistillation?.enabled,
              modelEnabled: cfg.provider?.[model.providerID]?.models?.[model.id]?.reasoningDistillation?.enabled,
              modelID: model.id,
              apiModelID: model.api.id,
            }).enabled,
        ),
      )
    const database = yield* Database.Service
    // Start rewriting a reasoning part as soon as it ends, overlapping the rest of the step and its tools. The next
    // provider request of the session settles these jobs first (see the loop below).
    const submitReasoningRewrite = (input: {
      sessionID: SessionID
      part: SessionV1.ReasoningPart
      model: Provider.Model
    }) =>
      InstanceState.useEffect(rewriteState, ({ scheduler, budget }) =>
        scheduler.submit({
          sessionID: input.sessionID,
          key: input.part.id,
          inputCharacters: input.part.text.length,
          enabled: reasoningDistillationEnabled(input.model),
          run: (canAdopt, onResponseStarted) =>
            Effect.gen(function* () {
              // Organize the persisted part: adoption compares against exactly what is stored.
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
              if (!editability.editable) {
                yield* Effect.logDebug("reasoning distillation skipped", {
                  "reasoning_distillation.runtime": "opencode",
                  "reasoning_distillation.reason": editability.reason,
                })
                return undefined
              }
              const cfg = yield* config.get()
              const organizer = yield* llm.organizer({ model: input.model })
              const outcome = yield* runReasoningRewrite({
                onResponseStarted,
                budget,
                sessionID: input.sessionID,
                slot: { messageID: part.messageID, partID: part.id, text: part.text },
                language: ConfigReasoningDistillation.resolveLanguage(cfg.reasoningDistillation),
                call: organizer?.call,
                adopt: (replacement) =>
                  adoptReasoning({ sessionID: input.sessionID, part, replacement, canAdopt }).pipe(
                    Effect.provideService(Database.Service, database),
                    Effect.provideService(Session.Service, sessions),
                    Effect.provideService(EventV2Bridge.Service, events),
                  ),
              })
              yield* Effect.logInfo(
                "reasoning distillation",
                rewriteLogFields(outcome, {
                  runtime: "opencode",
                  "session.id": input.sessionID,
                  ...(organizer ? { model: organizer.model, transport: organizer.transport } : {}),
                }),
              )
              return outcome.adopted && { messageID: outcome.adopted.messageID, partID: outcome.adopted.id }
            }),
        }),
      )
    // Replace reasoning parts in history already held in memory with their stored versions.
    const withStoredReasoning = Effect.fnUntraced(function* (
      sessionID: SessionID,
      msgs: SessionV1.WithParts[],
      refs: ReadonlyArray<{ messageID: MessageID; partID: PartID }>,
    ) {
      if (refs.length === 0) return msgs
      const stored = yield* Effect.forEach(refs, (ref) => sessions.getPart({ sessionID, ...ref }))
      const byID = new Map<string, SessionV1.Part>(
        stored.flatMap((part) => (part?.type === "reasoning" ? [[part.id, part] as const] : [])),
      )
      if (byID.size === 0) return msgs
      return msgs.map((message) =>
        message.parts.some((part) => byID.has(part.id))
          ? { ...message, parts: message.parts.map((part) => byID.get(part.id) ?? part) }
          : message,
      )
    })
    const agentMessages = Option.getOrUndefined(yield* Effect.serviceOption(DagMessages.Service))
    const { db } = database
    const rawSettingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const rewake = Context.make(
      HookRewake.Service,
      HookRewake.bind(({ sessionID, text, stopChain }) =>
        prompt({ sessionID, parts: [{ type: "text", text }] }, { continueToolBudget: true, stopChainToken: stopChain }),
      ),
    )
    const settingsHook: SettingsHook.Interface | undefined = rawSettingsHook && {
      ...rawSettingsHook,
      trigger: (payload, context) =>
        rawSettingsHook
          .trigger(payload, context)
          .pipe(Effect.updateContext((current: Context.Context<never>) => Context.merge(rewake, current))),
    }
    const startContext = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    const goal = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))
    const promptLocks = KeyedMutex.makeUnsafe<SessionID>()
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

    const ordinaryUser = (message: SessionV1.WithParts): message is SessionV1.WithParts & { info: SessionV1.User } =>
      message.info.role === "user" &&
      !MessageV2.isIgnoredUser(message) &&
      !message.parts.some((part) => part.type === "compaction" || part.type === "subtask")

    const claimSnapshot = Effect.fn("SessionPrompt.claimSnapshot")(function* (sessionID: SessionID) {
      return yield* promptLocks.withLock(sessionID)(
        Effect.gen(function* () {
          const messages = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.map((items) => items.filter((message) => !MessageV2.isIgnoredUser(message))),
            Effect.provideService(Database.Service, database),
          )
          const state = yield* budgetState(sessionID)
          let latestPending: { message: SessionV1.WithParts; budget: ToolBudget.Budget } | undefined
          for (const message of messages) {
            const budget = state.pending.get(message.info.id)
            if (budget && (!latestPending || MessageV2.before(latestPending.message.info, message.info))) {
              latestPending = { message, budget }
            }
          }
          const consumed = Date.now()
          for (const message of messages) {
            if (!ordinaryUser(message) || message.info.time.consumed !== undefined) continue
            message.info.time.consumed = consumed
            // Persisted JSON loses Schema.Class prototypes. Rehydrate the output
            // format before encoding the consumed user-message event.
            if (message.info.format)
              message.info.format = Schema.decodeUnknownSync(SessionV1.Format)(message.info.format)
            yield* sessions.updateMessage(message.info)
          }
          // Activate only inputs included in this snapshot. Capture the budget
          // under the same lock so later admissions cannot replace its owner.
          const budget = latestPending?.budget ?? state.active ?? ToolBudget.create((yield* config.get()).maxToolCalls)
          state.active = budget
          for (const message of messages) state.pending.delete(message.info.id)
          return { messages, budget }
        }),
      )
    })

    const queuedMessage = Effect.fn("SessionPrompt.queuedMessage")(function* (input: QueuedMessageDeleteInput) {
      const messages = yield* sessions
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catch(() => Effect.fail(new QueuedMessageNotFound({ messageID: input.messageID }))))
      const message = messages.find((item) => item.info.id === input.messageID)
      if (!message) return yield* new QueuedMessageNotFound({ messageID: input.messageID })
      if (!ordinaryUser(message)) {
        return yield* new QueuedMessageInvalid({ message: "Only ordinary user prompts can be changed while queued" })
      }

      const userByID = new Map(
        messages
          .filter((item): item is SessionV1.WithParts & { info: SessionV1.User } => item.info.role === "user")
          .map((item) => [item.info.id, item.info]),
      )
      for (const item of messages) {
        if (item.info.role !== "assistant") continue
        const parent = userByID.get(item.info.parentID)
        if (!parent) {
          return yield* new QueuedMessageConflict({
            kind: "history_uncertain",
            message: "The session history cannot prove that this prompt is still queued",
          })
        }
        if (message.info.time.consumed === undefined && !MessageV2.before(parent, message.info)) {
          return yield* new QueuedMessageConflict({
            kind: "already_consumed",
            message: "This prompt has already been included in a model request",
          })
        }
      }
      if (message.info.time.consumed !== undefined) {
        return yield* new QueuedMessageConflict({
          kind: "already_consumed",
          message: "This prompt has already been included in a model request",
        })
      }

      let completed: SessionV1.Assistant | undefined
      for (const item of messages) {
        if (item.info.role !== "assistant" || item.info.time.completed === undefined) continue
        if (!completed || MessageV2.before(completed, item.info)) completed = item.info
      }
      let pending: SessionV1.Assistant | undefined
      for (const item of messages) {
        if (item.info.role !== "assistant" || item.info.time.completed !== undefined) continue
        if (completed && MessageV2.before(item.info, completed)) continue
        if (!pending || MessageV2.before(pending, item.info)) pending = item.info
      }
      if (!pending || !MessageV2.before(pending, message.info)) {
        return yield* new QueuedMessageConflict({
          kind: "not_queued",
          message: "This prompt is no longer queued",
        })
      }

      const editable = message.parts.filter(
        (part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic && !part.ignored,
      )
      if (editable.length !== 1 || editable[0].id !== input.partID) {
        return yield* new QueuedMessageInvalid({ message: "Queued prompts must have one editable text part" })
      }
      if (
        editable[0].text !== input.expectedText ||
        message.parts.length !== input.expectedPartIDs.length ||
        message.parts.some((part, index) => part.id !== input.expectedPartIDs[index])
      ) {
        return yield* new QueuedMessageConflict({
          kind: "stale",
          message: "The queued prompt changed before this request was applied",
        })
      }
      return { message, part: editable[0] }
    })

    const editQueuedMessage: Interface["editQueuedMessage"] = Effect.fn("SessionPrompt.editQueuedMessage")((input) =>
      promptLocks.withLock(input.sessionID)(
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const current = yield* queuedMessage(input)
                yield* sessions.updatePart({ ...current.part, text: input.text })
                return yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
                  Effect.provideService(Database.Service, database),
                  Effect.catch(() => Effect.fail(new QueuedMessageNotFound({ messageID: input.messageID }))),
                )
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      ),
    )

    const deleteQueuedMessage: Interface["deleteQueuedMessage"] = Effect.fn("SessionPrompt.deleteQueuedMessage")(
      (input) =>
        promptLocks.withLock(input.sessionID)(
          db
            .transaction(
              () =>
                Effect.gen(function* () {
                  yield* queuedMessage(input)
                  yield* sessions.removeMessage({ sessionID: input.sessionID, messageID: input.messageID })
                  return true
                }),
              { behavior: "immediate" },
            )
            .pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  const budgets = yield* InstanceState.get(toolBudgets)
                  budgets.get(input.sessionID)?.pending.delete(input.messageID)
                }),
              ),
              Effect.catchTag("SqlError", Effect.die),
            ),
        ),
    )

    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput, options?: AdmissionOptions) =>
          prompt(input, options).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      // A user abort invalidates any pending async Stop-hook rewake chain;
      // otherwise a callback completing afterwards would silently restart the
      // cancelled session. Lock-free on purpose: admission can block for a
      // long time inside the prompt lock (hook gates), so cancel must always
      // make progress. Stale rewakes are fenced in admitPrompt (pre-commit
      // and post-commit) and again on the run path before runLoop.
      // Invalidation failure must never block the cancel itself.
      if (settingsHook?.invalidateStopRewakeChain) {
        yield* settingsHook.invalidateStopRewakeChain(sessionID).pipe(Effect.ignore)
      }
      // GOAL-TURN-SCOPE (ESC semantics): ESC on a goal-driven turn means "stop
      // working on the goal", not just "stop this turn". Without this, the idle
      // event after cancel re-enters afterIdle, shouldPreempt returns false (the
      // last user message is the /goal command itself, necessarily older than
      // this turn's assistant output), and the judge auto-resurrects the goal
      // with a continuation the user just tried to abort. Pause instead.
      if (goal && (yield* goal.isTurnDriven(sessionID))) {
        yield* goal.pauseForUserCancel(sessionID, "用户中断（ESC）— /goal resume 继续").pipe(Effect.ignore)
      }
      if (agentMessages) {
        const context = yield* InstanceState.context
        const identity = { projectID: context.project.id, directory: context.directory, sessionID }
        const input = yield* agentMessages.revisions(identity)
        if (input.ok && input.value.snapshotID)
          yield* agentMessages.markStopped(identity, input.value.snapshotID, "cancelled")
        yield* agentMessages.discardPending(identity, "cancelled")
      }
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl, {
            reasoningDistillationEnabled: yield* reasoningDistillationEnabled(mdl),
          })
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
          purpose: "auxiliary",
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      // SettingsHook: PreToolUse for task tool
      if (settingsHook) {
        const preResult = yield* settingsHook
          .trigger({ event: "PreToolUse", toolName: TaskTool.id, toolInput: taskArgs, toolUseID: part.callID } as any, {
            sessionID,
            transcriptPath: "",
          })
          .pipe(
            Effect.catch(() =>
              Effect.succeed({
                blocked: undefined,
                permissionDecision: undefined as "allow" | "deny" | "ask" | undefined,
                permissionDecisionReason: undefined as string | undefined,
              } as any),
            ),
          )
        yield* SettingsHook.landSystemMessages(preResult as TriggerResult, { sessionID })
        const decision = applyPreHookDecision(taskArgs, preResult)
        // deny / blocked → error part
        if (decision.deniedReason) {
          if (part.state.status === "running") {
            part = yield* sessions.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: decision.deniedReason,
                time: { ...part.state.time, end: Date.now() },
              },
            } satisfies SessionV1.ToolPart)
          }
          return { info: assistantMessage, parts: [part] }
        }
        // preventContinuation → stop; reflect the stop message as the part output so the agent sees it
        if (decision.stopReason) {
          if (part.state.status === "running") {
            part = yield* sessions.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: `[Hook stopped] ${decision.stopReason}`,
                time: { ...part.state.time, end: Date.now() },
              },
            } satisfies SessionV1.ToolPart)
          }
          return { info: assistantMessage, parts: [part] }
        }
        // permissionDecision:"ask" — task-tool dispatch has no permission dialog; degrade to deny.
        if (preResult.permissionDecision === "ask") {
          const reason = "Hook requested confirmation but no dialog available"
          yield* Effect.logWarning("PreToolUse hook asked for confirmation on task-tool path; degrading to deny", {
            agent: task.agent,
            reason,
            hookReason: preResult.permissionDecisionReason,
          })
          if (part.state.status === "running") {
            part = yield* sessions.updatePart({
              ...part,
              state: { ...part.state, status: "error", error: reason, time: { ...part.state.time, end: Date.now() } },
            } satisfies SessionV1.ToolPart)
          }
          return { info: assistantMessage, parts: [part] }
        }
        // updatedInput → shallow-merge into taskArgs before dispatch
        if (decision.effectiveArgs !== taskArgs) {
          Object.assign(taskArgs, decision.effectiveArgs)
        }
      }

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      // SettingsHook: PostToolUse for task tool
      if (settingsHook) {
        const postResult: any = yield* settingsHook
          .trigger(
            {
              event: "PostToolUse",
              toolName: TaskTool.id,
              toolInput: taskArgs,
              toolResponse: result?.output ?? "",
              toolUseID: part.callID,
            } as any,
            { sessionID, transcriptPath: "" },
          )
          .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
        yield* SettingsHook.landSystemMessages(postResult as TriggerResult, { sessionID })
        if (result) result.output = withHookFeedback(result.output ?? "", postResult)
      }

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
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
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
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
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: DateTime.makeUnsafe(started),
                callID: part.callID,
                command: input.command,
              })
            }
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
          let shellHookDenied = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", SHELL_ABORT_NOTE, "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Shell.Ended, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(completed),
                  callID: mutablePart.callID,
                  output,
                })
              }
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
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(mutablePart)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: mutablePart.callID },
                { env: {} },
              )
              // SettingsHook: PreToolUse for shell — can deny/block/stop execution or rewrite the command
              if (settingsHook) {
                const preResult = yield* settingsHook
                  .trigger(
                    {
                      event: "PreToolUse",
                      toolName: "bash",
                      toolInput: { command: input.command },
                      toolUseID: mutablePart.callID,
                    } as any,
                    { sessionID: input.sessionID, transcriptPath: "" },
                  )
                  .pipe(
                    Effect.catch(() =>
                      Effect.succeed({
                        blocked: undefined,
                        permissionDecision: undefined as "allow" | "deny" | "ask" | undefined,
                        permissionDecisionReason: undefined as string | undefined,
                      } as any),
                    ),
                  )
                yield* SettingsHook.landSystemMessages(preResult as TriggerResult, { sessionID: input.sessionID })
                const decision = applyPreHookDecision({ command: input.command }, preResult)
                // deny / blocked / stop / ask-degrade all skip execution; each surfaces its own message.
                let skipReason: string | undefined
                if (decision.deniedReason) {
                  shellHookDenied = true
                  skipReason = decision.deniedReason
                } else if (decision.stopReason) {
                  shellHookDenied = true
                  skipReason = `[Hook stopped] ${decision.stopReason}`
                } else if (preResult.permissionDecision === "ask") {
                  // Shell dispatch has no permission dialog — degrade ask to deny (design D3).
                  shellHookDenied = true
                  skipReason = "Hook requested confirmation but no dialog available"
                  yield* Effect.logWarning("PreToolUse hook asked for confirmation on shell path; degrading to deny", {
                    reason: skipReason,
                    hookReason: preResult.permissionDecisionReason,
                  })
                }
                if (skipReason !== undefined) {
                  const errorState = {
                    status: "error" as const,
                    error: skipReason,
                    time: { start: (mutablePart.state as any).time?.start ?? Date.now(), end: Date.now() },
                    input: mutablePart.state.input,
                  }
                  mutablePart = yield* sessions.updatePart({
                    ...mutablePart,
                    state: errorState as any,
                  } satisfies SessionV1.ToolPart)
                } else if (
                  decision.effectiveArgs.command !== undefined &&
                  decision.effectiveArgs.command !== input.command
                ) {
                  // updatedInput rewrote the command — sync execution (args), TUI display (part.state.input),
                  // and PostToolUse toolInput (which reads effectiveCommand below). `!== undefined` (not
                  // truthiness) so a hook that clears the command to "" is honored rather than ignored.
                  effectiveCommand = decision.effectiveArgs.command as string
                  args = Shell.args(sh, effectiveCommand, cwd)
                  mutablePart.state.input = { ...mutablePart.state.input, command: effectiveCommand }
                  yield* sessions.updatePart(mutablePart)
                }
              }
              if (!shellHookDenied) {
                const cmd = ChildProcess.make(sh, args, {
                  cwd,
                  extendEnv: true,
                  env: { ...shellEnv.env, TERM: "dumb" },
                  stdin: "ignore",
                  forceKillAfter: "3 seconds",
                })
                const handle = yield* spawner.spawn(cmd)
                yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                  Effect.gen(function* () {
                    output += chunk
                    if (mutablePart.state.status === "running") {
                      mutablePart.state.metadata = { output }
                      yield* sessions.updatePart(mutablePart)
                    }
                  }),
                )
                yield* handle.exitCode
              } // end if (!shellHookDenied)
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          // SettingsHook: PostToolUse for shell command (skip if hook denied)
          if (settingsHook && !shellHookDenied) {
            const postResult: any = yield* settingsHook
              .trigger(
                {
                  event: "PostToolUse",
                  toolName: "bash",
                  toolInput: { command: effectiveCommand },
                  toolResponse: output,
                  toolUseID: mutablePart.callID,
                } as any,
                { sessionID: input.sessionID, transcriptPath: "" },
              )
              .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
            yield* SettingsHook.landSystemMessages(postResult as TriggerResult, { sessionID: input.sessionID })
            const annotated = withHookFeedback(output, postResult)
            if (annotated !== output) {
              output = annotated
              if (mutablePart.state.status === "completed") {
                mutablePart.state = { ...mutablePart.state, output, metadata: { output } }
                yield* sessions.updatePart(mutablePart)
              }
            }
          }

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [mutablePart] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      const exit = yield* provider.defaultModel().pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.NoProvidersError.isInstance(err) || Provider.NoModelsError.isInstance(err)) {
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({ message: err.message }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (
      input: PromptInput,
      persistAdmission?: Effect.Effect<void>,
    ) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const current = yield* db
        .select({ agent: SessionTable.agent, model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      if (current?.agent !== info.agent) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
        })
      }
      if (
        current?.model?.providerID !== info.model.providerID ||
        current.model.id !== info.model.modelID ||
        (current.model.variant === "default" ? undefined : current.model.variant) !== info.model.variant
      ) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: ModelV2.ID.make(info.model.modelID),
            providerID: ProviderV2.ID.make(info.model.providerID),
            variant: ModelV2.VariantID.make(info.model.variant ?? "default"),
          },
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      const persist = Effect.gen(function* () {
        yield* sessions.updateMessage(info)
        for (const part of parts) yield* sessions.updatePart(part)
        const nextPrompt = parts.reduce(
          (result, part) => {
            if (part.type === "text") {
              if (part.synthetic) result.synthetic.push(part.text)
              else result.text.push(part.text)
            }
            if (part.type === "file") {
              result.files.push(
                FileAttachment.make({
                  uri: part.url,
                  mime: part.mime,
                  name: part.filename,
                  source: part.source
                    ? Source.make({
                        start: part.source.text.start,
                        end: part.source.text.end,
                        text: part.source.text.value,
                      })
                    : undefined,
                }),
              )
            }
            if (part.type === "agent") {
              result.agents.push(
                AgentAttachment.make({
                  name: part.name,
                  source: part.source
                    ? Source.make({
                        start: part.source.start,
                        end: part.source.end,
                        text: part.source.value,
                      })
                    : undefined,
                }),
              )
            }
            return result
          },
          {
            text: [] as string[],
            files: [] as FileAttachment[],
            agents: [] as AgentAttachment[],
            synthetic: [] as string[],
          },
        )
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(info.time.created),
            delivery: "steer",
            prompt: Prompt.make({
              text: nextPrompt.text.join("\n"),
              files: nextPrompt.files,
              agents: nextPrompt.agents,
            }),
          })
        }
        for (const text of nextPrompt.synthetic) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          if (flags.experimentalEventSystem) {
            yield* events.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: DateTime.makeUnsafe(info.time.created),
              text,
            })
          }
        }

        if (persistAdmission) yield* persistAdmission
      })
      // Preparation, plugin callbacks and hooks stay outside the write reservation.
      // Internal wakes commit their transcript receipt and reporting mark together.
      yield* persistAdmission ? db.transaction(() => persist, { behavior: "immediate" }).pipe(Effect.orDie) : persist
      return { info, parts }
    }, Effect.scoped)

    // Re-validates the stop-chain token carried by an async Stop-hook rewake.
    // Returns false when the chain was invalidated (session cancel, newer user
    // prompt, SessionEnd) after the callback's own completion check; the
    // committed message parts are then marked ignored so nothing stale stays
    // model-visible, and the caller must not run the turn. No-op for plain
    // prompts and non-Stop async rewakes (no token).
    const fenceStopRewake = Effect.fn("SessionPrompt.fenceStopRewake")(function* (
      sessionID: SessionID,
      options: AdmissionOptions | undefined,
      message: SessionV1.WithParts,
    ) {
      if (!settingsHook?.validateStopRewakeChain || options?.stopChainToken === undefined) return true
      if (yield* settingsHook.validateStopRewakeChain(sessionID, options.stopChainToken)) return true
      yield* Effect.logWarning("stop-chain rewake discarded after commit", { "session.id": sessionID })
      for (const part of message.parts) {
        if (part.type === "text" && !part.ignored) {
          yield* sessions.updatePart({ ...part, ignored: true } satisfies SessionV1.TextPart)
        }
      }
      yield* sessions.touch(sessionID)
      return false
    })

    const admitPrompt = Effect.fn("SessionPrompt.admitPrompt")(function* (
      input: PromptInput,
      persistAdmission?: Effect.Effect<void>,
      options?: AdmissionOptions,
    ) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)

      // SettingsHook: UserPromptSubmit — gives hooks a chance to block or modify the turn.
      // Runs BEFORE the prompt is persisted: a blocked prompt (e.g. a secret scanner)
      // must never be stored as model-visible history (Claude Code erases it from
      // context). Loop guard (hook-async-rewake): skip hooks for rewake prompts (those
      // whose text starts with HOOK_REWAKE_SENTINEL) to prevent hook → rewake → hook loops.
      let hookAdditionalContexts: string[] = []
      let hookResult: TriggerResult | undefined
      const promptText = input.parts.map((p: any) => (p.type === "text" ? p.text : "")).join("\n")
      const isRewake = promptText.startsWith(HOOK_REWAKE_SENTINEL)
      // Refuse a stale stop-chain rewake before anything is committed. Cancel
      // stays lock-free; the post-commit fence below covers cancels that land
      // while admission is suspended inside plugin callbacks.
      if (settingsHook?.validateStopRewakeChain && isRewake && options?.stopChainToken !== undefined) {
        const chainValid = yield* settingsHook.validateStopRewakeChain(input.sessionID, options.stopChainToken)
        if (!chainValid) {
          yield* Effect.logWarning("stop-chain rewake discarded before admission", { "session.id": input.sessionID })
          // Record the discard in the transcript (`ignored` keeps it out of
          // model input) so the refusal is observable, then stop without work.
          const message = yield* createUserMessage(
            {
              ...input,
              parts: [
                {
                  type: "text",
                  text: "[Hook stopped] async hook result discarded (session cancelled or superseded)",
                  ignored: true,
                },
              ],
            },
            persistAdmission,
          )
          yield* sessions.touch(input.sessionID)
          return { message, run: false as const }
        }
      }
      if (settingsHook && !isRewake) {
        hookResult = yield* settingsHook
          .trigger(
            { event: "UserPromptSubmit", prompt: promptText },
            { sessionID: input.sessionID, transcriptPath: "" },
          )
          .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
        hookAdditionalContexts = hookResult.additionalContexts ?? []
      }

      if (hookResult && (hookResult.blocked || hookResult.preventContinuation)) {
        const reason = hookResult.stopReason ?? hookResult.blocked?.reason ?? "Hook requested stop"
        // The submitted parts are replaced by one user-visible notice. `ignored`
        // keeps it out of model input (and makes the message no model work
        // boundary); it is not synthetic so clients render it in the transcript.
        const message = yield* createUserMessage(
          { ...input, parts: [{ type: "text", text: `[Hook stopped] ${reason}`, ignored: true }] },
          persistAdmission,
        )
        yield* sessions.touch(input.sessionID)
        // systemMessages are logged only: nothing about a blocked prompt reaches the model.
        yield* SettingsHook.landSystemMessages(hookResult, { sessionID: input.sessionID })
        if (agentMessages) {
          const ctx = yield* InstanceState.context
          yield* agentMessages.discardPending(
            { projectID: ctx.project.id, directory: ctx.directory, sessionID: input.sessionID },
            "hook_blocked",
          )
        }
        return { message, run: false as const }
      }

      const message = yield* createUserMessage(input, persistAdmission)
      yield* sessions.touch(input.sessionID)

      // The chain was validated before admission, but cancel can land while
      // the plugin callbacks above suspend. A committed stale rewake is
      // stripped from model input (parts ignored) and never starts a run.
      if (isRewake && options?.stopChainToken !== undefined) {
        if (!(yield* fenceStopRewake(input.sessionID, options, message))) {
          return { message, run: false as const }
        }
      }

      if (hookResult) {
        // Land UserPromptSubmit systemMessages (logged always; injected as synthetic
        // parts so the model sees them — no silent drop).
        yield* SettingsHook.landSystemMessages(hookResult, {
          sessionID: input.sessionID,
          inject: (text) =>
            sessions.updatePart({
              id: PartID.ascending(),
              messageID: message.info.id,
              sessionID: input.sessionID,
              type: "text",
              text,
              synthetic: true,
            } satisfies SessionV1.TextPart),
        })
      }

      // SettingsHook: drain HookStartContext queued by SessionStart hooks (only if not blocked)
      let startContextTexts: string[] = []
      if (startContext) {
        startContextTexts = [...(yield* startContext.consume(input.sessionID))]
      }

      for (const ctx of [...startContextTexts, ...hookAdditionalContexts]) {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.info.id,
          sessionID: input.sessionID,
          type: "text",
          text: ctx,
          synthetic: true,
        } satisfies SessionV1.TextPart)
      }

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (!options?.continueToolBudget) {
        const state = yield* budgetState(input.sessionID)
        state.pending.set(message.info.id, ToolBudget.create((yield* config.get()).maxToolCalls))
      }

      return { message, run: input.noReply !== true }
    })

    const prompt: Interface["prompt"] = Effect.fn("SessionPrompt.prompt")(function* (
      input: PromptInput,
      options?: AdmissionOptions,
    ) {
      const wait = yield* promptLocks.withLock(input.sessionID)(
        Effect.gen(function* () {
          if (goal && input.noReply !== true) yield* goal.clearTurnDriven(input.sessionID)
          const admitted = yield* admitPrompt(input, undefined, options)
          if (!admitted.run) return Effect.succeed(admitted.message)
          // The runner registers before this fence runs: a cancel landing
          // after a passing fence interrupts the registered runner instead of
          // racing a finished check, so a stale rewake can never start a turn.
          return yield* state.ensureRunningHandle(
            input.sessionID,
            lastAssistant(input.sessionID),
            Effect.gen(function* () {
              if (!(yield* fenceStopRewake(input.sessionID, options, admitted.message))) {
                return admitted.message
              }
              return yield* runLoop(input.sessionID)
            }),
          )
        }),
      )
      return yield* wait
    })

    const withIdle: Interface["withIdle"] = Effect.fn("SessionPrompt.withIdle")(
      <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
        promptLocks.withLock(sessionID)(
          Effect.gen(function* () {
            if ((yield* status.get(sessionID)).type !== "idle") return Option.none()
            return Option.some(yield* work)
          }),
        ),
    )

    const prepareIfIdle: Interface["prepareIfIdle"] = Effect.fn("SessionPrompt.prepareIfIdle")(function* (
      input: PromptInput,
      persistAdmission?: Effect.Effect<void>,
      options?: AdmissionOptions,
    ) {
      return yield* promptLocks.withLock(input.sessionID)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const activation = yield* Deferred.make<void>()
            const admission =
              yield* Deferred.make<
                Exit.Exit<{ readonly message: SessionV1.WithParts; readonly run: boolean }, Image.Error>
              >()
            const wait = yield* state.startIfIdle(
              input.sessionID,
              lastAssistant(input.sessionID),
              Effect.gen(function* () {
                yield* Deferred.await(activation)
                const admitted = yield* Deferred.await(admission)
                if (Exit.isFailure(admitted)) return yield* Effect.failCause(admitted.cause)
                if (!admitted.value.run) return admitted.value.message
                // Same runner-first ordering as prompt(): a cancel landing
                // after a passing fence interrupts the registered runner.
                if (!(yield* fenceStopRewake(input.sessionID, options, admitted.value.message))) {
                  return admitted.value.message
                }
                return yield* runLoop(input.sessionID)
              }).pipe(Effect.orDie),
            )
            if (Option.isNone(wait)) return Option.none<IdleAdmission>()

            const admitted = yield* restore(admitPrompt(input, persistAdmission, options)).pipe(Effect.exit)
            yield* Deferred.succeed(admission, admitted)
            if (Exit.isFailure(admitted)) {
              yield* Deferred.succeed(activation, undefined)
              return yield* Effect.failCause(admitted.cause)
            }
            return Option.some({
              activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
              result: wait.value,
              abort: state.cancel(input.sessionID),
            })
          }),
        ),
      )
    })

    const promptIfIdle: Interface["promptIfIdle"] = Effect.fn("SessionPrompt.promptIfIdle")(
      (input: PromptInput, options?: AdmissionOptions) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prepared = yield* restore(prepareIfIdle(input, undefined, options))
            if (Option.isNone(prepared)) return Option.none()
            yield* prepared.value.activate.pipe(Effect.onError(() => prepared.value.abort))
            return Option.some(yield* restore(prepared.value.result))
          }),
        ),
    )

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoopImpl: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
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
        let nextAutoCompactionMinimum: number | undefined
        let autoCompactionPending = false
        let awaitingPostCompactionUsage = false
        let consecutiveAutoCompactions = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        // Capture the lastAssistant helper before the loop's destructured `lastAssistant`
        // (the latest assistant info) shadows it inside the step body.
        const getLastAssistant = lastAssistant

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
                  outcome: Exit.isSuccess(exit)
                    ? "completed"
                    : Cause.hasInterrupts(exit.cause)
                      ? "cancelled"
                      : "failed",
                }),
              ),
            )
            yield* status.set(sessionID, { type: "busy" })
            return value
          })

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          const modelMessageID = MessageID.ascending()
          const identity = { projectID: ctx.project.id, directory: ctx.directory, sessionID }
          let agentSnapshot: DagMessages.Snapshot | undefined
          let snapshot = yield* claimSnapshot(sessionID)
          let msgs = snapshot.messages
          let budget = snapshot.budget
          const previous = MessageV2.latest(msgs)
          const previousParts = msgs.findLast((message) => message.info.id === previous.assistant?.id)?.parts
          const needsStop =
            turnStopped ||
            (previous.assistant?.finish &&
              previous.assistant.finish !== "tool-calls" &&
              !previousParts?.some(
                (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
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
                snapshot = yield* claimSnapshot(sessionID)
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
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            turnStopped ||
            (lastAssistant?.finish &&
              !["tool-calls"].includes(lastAssistant.finish) &&
              !hasToolCalls &&
              MessageV2.before(lastUser, lastAssistant))
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant?.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            // Stop-hook continuation: when forceContinue is set (a prior Stop hook
            // blocked), skip the Stop exit for one iteration so another model turn
            // runs; reset the flag so that turn can finish and Stop normally.
            if (forceContinue && !agentInputBlocked) {
              forceContinue = false
              turnStopped = false
            } else {
              yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
              let agentContinuationPrevented = false
              // Main-agent Stop does not fire for a foreground task-tool subagent's
              // clean exit: task.ts fires SubagentStop (and drives its continuation)
              // for it. task.ts fails a child that ended in error or was cancelled
              // without SubagentStop, so StopFailure still fires for those. Only
              // positively registered sessions are skipped; any other child
              // (SDK-created, DAG node, background task) still fires Stop.
              const taskSubagentCleanExit = !turnError && TaskSubagents.delegateStop(sessionID)
              // SettingsHook: Stop on clean turn exit, StopFailure when it ended in error.
              if (settingsHook && !taskSubagentCleanExit) {
                const lastAssistantMessage =
                  lastAssistantMsg?.parts
                    .filter((part): part is SessionV1.TextPart => part.type === "text")
                    .map((part) => part.text)
                    .join("") || undefined
                const turnErrorMessage = (turnError as { data?: { message?: unknown } } | undefined)?.data?.message
                const stopPayload = turnError
                  ? ({
                      event: "StopFailure",
                      stopHookActive: stopHookBlocked,
                      error: typeof turnErrorMessage === "string" ? turnErrorMessage : JSON.stringify(turnError),
                      lastAssistantMessage,
                    } as const)
                  : ({ event: "Stop", stopHookActive: stopHookBlocked, lastAssistantMessage } as const)
                const stopResult = yield* settingsHook
                  .trigger(stopPayload, { sessionID, transcriptPath: "" })
                  .pipe(
                    Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)),
                  )
                agentContinuationPrevented = stopResult.preventContinuation === true
                if (agentContinuationPrevented && agentMessages) {
                  const input = lastAssistant && (yield* agentMessages.snapshotForTurn(identity, lastAssistant.id))
                  if (input?.ok && input.value)
                    yield* agentMessages.markStopped(identity, input.value.id, "hook_blocked")
                  yield* agentMessages.discardPending(identity, "hook_blocked")
                }
                // Stop-hook block → drive another model turn. The next Stop then carries
                // stop_hook_active=true so a well-behaved hook stops blocking (anti-loop).
                // Capped by MAX_STOP_CONTINUATIONS so a hook that ignores the signal
                // can't loop forever; at the limit we log.warn and force a normal exit.
                const continuing =
                  !agentInputBlocked &&
                  !turnError &&
                  stopResult.blocked !== undefined &&
                  !stopResult.preventContinuation &&
                  stopContinuationCount < SettingsHook.MAX_STOP_CONTINUATIONS
                // Consume Stop-hook outputs so nothing is silently dropped. On a
                // continuation they go into a new synthetic user message AFTER the
                // assistant reply (block reason last, so the request ends with the
                // instruction to continue — mirrors task.ts SubagentStop). On exit they
                // are recorded on the turn's user message (model-visible next prompt).
                const feedback: string[] = [...(stopResult.additionalContexts ?? [])]
                yield* SettingsHook.landSystemMessages(stopResult, {
                  sessionID,
                  inject: (message) => Effect.sync(() => feedback.push(message)),
                })
                if (continuing) feedback.push(stopResult.blocked?.reason || "Continue.")
                const target = continuing ? MessageID.ascending() : lastUser.id
                if (target !== lastUser.id) {
                  yield* sessions.updateMessage({
                    id: target,
                    sessionID,
                    role: "user",
                    agent: lastUser.agent,
                    model: lastUser.model,
                    format: lastUser.format,
                    system: lastUser.system,
                    tools: lastUser.tools,
                    time: { created: Date.now() },
                  })
                }
                for (const text of feedback) {
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: target,
                    sessionID,
                    type: "text",
                    text,
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                }
                if (!agentInputBlocked && !turnError && stopResult.blocked && !stopResult.preventContinuation) {
                  if (continuing) {
                    stopContinuationCount++
                    stopHookBlocked = true
                    forceContinue = true
                    continue
                  }
                  yield* Effect.logWarning("Stop hook continuation limit reached; forcing exit", {
                    "session.id": sessionID,
                    limit: SettingsHook.MAX_STOP_CONTINUATIONS,
                  })
                }
              }
              if (!agentInputBlocked && !agentContinuationPrevented && !turnError && agentMessages) {
                const incoming = yield* agentMessages.revisions(identity)
                if (incoming.ok && incoming.value.queued > 0) {
                  agentBoundaryApproved = true
                  turnStopped = false
                  continue
                }
              }
              return yield* getLastAssistant(sessionID)
            }
          }

          forceContinue = false
          step++
          // Send barrier: adopt finished reasoning rewrites before this step builds its request; seal the rest so a
          // part is rewritten before its first resend or never.
          const adoptedRefs = yield* prepare(
            "reasoning",
            InstanceState.useEffect(rewriteState, ({ scheduler }) =>
              scheduler.settle(sessionID).pipe(Effect.onInterrupt(() => scheduler.cancel(sessionID))),
            ),
          )
          msgs = yield* withStoredReasoning(sessionID, msgs, adoptedRefs)
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
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
            const observedTokens = lastFinished.summary === true || switchedModel ? 0 : measured(lastFinished.tokens)
            const lastFinishedIndex = msgs.findIndex((message) => message.info.id === lastFinished.id)
            const newUsers =
              lastFinishedIndex < 0
                ? []
                : msgs.slice(lastFinishedIndex + 1).filter((message) => message.info.role === "user")
            // Same-model usage reflects the prior prepared request, including folding. Add new user text and
            // pending tool results below. On a model switch, estimate the active projected history.
            // Media is stripped before either estimate and never logged.
            const estimateMessages = switchedModel || lastFinished.summary === true ? msgs : newUsers
            const estimatedTextTokens = estimateMessages.length
              ? Token.estimate(
                  JSON.stringify(
                    yield* MessageV2.toModelMessagesEffect(estimateMessages, model, {
                      stripMedia: true,
                      reasoningDistillationEnabled: yield* reasoningDistillationEnabled(model),
                    }),
                  ),
                )
              : 0
            // Provider usage covers the request that produced lastFinished, but not tool results that completed
            // afterward. Each result is still present until a projection actually folds it; text equality alone
            // does not authorize a budget deduction (e.g. bash results are protected from folding).
            const pendingToolOutputTokens =
              switchedModel || lastFinished.summary === true
                ? 0
                : estimatePendingToolOutputTokens(msgs, lastFinishedIndex)
            const estimatedInputTokens =
              switchedModel || lastFinished.summary === true
                ? estimatedTextTokens
                : observedTokens + estimatedTextTokens + pendingToolOutputTokens
            if (lastFinished.summary === true && autoCompactionPending) {
              autoCompactionPending = false
              awaitingPostCompactionUsage = true
            }
            const effectiveTokens = Math.max(observedTokens, estimatedInputTokens)
            const afterCompaction = lastFinished.summary !== true && awaitingPostCompactionUsage
            if (afterCompaction) {
              nextAutoCompactionMinimum = effectiveTokens + 25_000
              awaitingPostCompactionUsage = false
            }
            const enoughNewContext =
              nextAutoCompactionMinimum === undefined || effectiveTokens >= nextAutoCompactionMinimum
            const tokens =
              lastFinished.summary === true || switchedModel
                ? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
                : lastFinished.tokens
            const hardOverflow = yield* compaction.isOverflow({
              tokens,
              model,
              estimatedInputTokens,
              threshold: "model",
            })
            if (afterCompaction && !hardOverflow) consecutiveAutoCompactions = 0
            const proactiveOverflow =
              !hardOverflow &&
              lastFinished.summary !== true &&
              enoughNewContext &&
              (yield* compaction.isOverflow({ tokens, model, estimatedInputTokens, threshold: "auto" }))
            if (hardOverflow || proactiveOverflow) {
              if (consecutiveAutoCompactions >= 3) {
                const error = new SessionV1.ContextOverflowError({
                  message: "Context still exceeds the model limit after repeated automatic compaction",
                })
                yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
                throw error
              }
              consecutiveAutoCompactions++
              autoCompactionPending = true
              yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
              continue
            }
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
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )
          // Issue #389: re-surface uncompleted todos once per model step
          // (in-memory synthetic part, skipped when all settled or when the
          // turn just updated the list via todowrite).
          msgs = yield* TodoReminders.apply({ messages: msgs, sessionID }).pipe(
            Effect.provideService(Todo.Service, todoSvc),
          )

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
          // Cross-process send fence: this persisted attempt is the claim. Adoption rejects every earlier part once it
          // exists, and only the previous assistant message could still adopt before it, so re-reading that message's
          // settled reasoning picks up a rewrite another process committed after this loop read its history.
          msgs = yield* withStoredReasoning(
            sessionID,
            msgs,
            (msgs.findLast((message) => message.info.role === "assistant")?.parts ?? []).flatMap((part) =>
              part.type === "reasoning" && part.time.end !== undefined && !part.distillation
                ? [{ messageID: part.messageID, partID: part.id }]
                : [],
            ),
          )

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const finalizeFailedAssistant = Effect.fnUntraced(function* (cause: Cause.Cause<never>) {
            if (Cause.hasInterrupts(cause)) return yield* finalizeInterruptedAssistant
            msg.error ??= MessageV2.fromError(Cause.squash(cause), { providerID: msg.providerID })
            msg.time.completed ??= Date.now()
            yield* sessions.updateMessage(msg)
            if (!agentMessages || !agentSnapshot) return
            const input = yield* agentMessages.snapshotForTurn(identity, modelMessageID)
            // Preparation failures retain unassociated input for a later admitted
            // turn. An already associated request has a permanent failed outcome.
            if (input.ok && input.value?.associated) {
              yield* agentMessages.markStopped(identity, input.value.id, "model_error")
              yield* agentMessages.discardPending(identity, "model_error")
            }
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
              onReasoningSettled: (part) => submitReasoningRewrite({ sessionID, part, model }),
            })
            .pipe(
              Effect.onError(finalizeFailedAssistant),
              Effect.onInterrupt(() => finalizeInterruptedAssistant),
            )

          // A later input must produce its own structured response.
          structured = undefined

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()

            const tools = toolsDisabled
              ? {}
              : yield* prepare(
                  "tools",
                  SessionTools.resolve({
                    agent,
                    session,
                    model,
                    processor: handle,
                    bypassAgentCheck,
                    messages: msgs,
                    promptOps,
                    hooks: settingsHook,
                    sourceLedger: toolSources,
                  }).pipe(
                    Effect.provideService(Plugin.Service, plugin),
                    Effect.provideService(Permission.Service, permission),
                    Effect.provideService(ToolRegistry.Service, registry),
                    Effect.provideService(MCP.Service, mcp),
                    Effect.provideService(Truncate.Service, truncate),
                  ),
                )

            if (!toolsDisabled && lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const [
              skills,
              env,
              instructions,
              mcpInstructions,
              goalDocs,
              hooksDocs,
              memoryDocs,
              modelMsgs,
              contextFoldingHistory,
            ] = yield* Effect.all(
              [
                sys.skills(agent),
                sys.environment(model),
                instruction.system().pipe(Effect.orDie),
                sys.mcp(agent, session.permission),
                sys.goal(sessionID),
                sys.hooks(),
                prepare("memory", sys.memory({ sessionID, messages: msgs, main: !session.parentID })),
                MessageV2.toModelMessagesEffect(msgs, model, {
                  reasoningDistillationEnabled: yield* reasoningDistillationEnabled(model),
                }),
                MessageV2.contextFoldingHistory({ messages: msgs, ledger: toolSources }),
              ],
              { concurrency: "unbounded" },
            )
            const system = [
              ...env,
              ...instructions,
              ...(mcpInstructions ? [mcpInstructions] : []),
              ...(skills ? [skills] : []),
              ...goalDocs,
              ...hooksDocs,
              ...memoryDocs,
            ]
            const format = lastUser.format ?? { type: "text" as const }
            if (!toolsDisabled && format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const processInput: LLM.StreamInput = {
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [
                ...modelMsgs,
                ...(toolsDisabled
                  ? [
                      {
                        role: "assistant" as const,
                        content: toolLimitReached ? ToolBudget.renderExhaustedPrompt(budget.max) : MAX_STEPS_PROMPT,
                      },
                    ]
                  : []),
              ],
              tools,
              toolBudget: budget,
              model,
              toolChoice: toolsDisabled ? "none" : format.type === "json_schema" ? "required" : undefined,
              purpose: "conversation",
              contextFolding: contextFoldingHistory,
            }
            if (agentMessages && agentSnapshot) {
              for (const message of agentSnapshot.messages) {
                if (
                  !msgs.some(
                    (item) =>
                      item.info.id === message.transcriptID &&
                      item.parts.some(
                        (part) =>
                          part.id === message.partID &&
                          part.type === "text" &&
                          !part.ignored &&
                          part.text === DagMessages.renderMessage(message),
                      ),
                  )
                )
                  throw new Error("Agent message was removed from the model input")
              }
              const associated = yield* agentMessages.associate(identity, agentSnapshot.id)
              if (!associated.ok) throw new Error(`Agent input association rejected: ${associated.reason}`)
              const endpoint = yield* agentMessages.revisions(identity)
              if (endpoint.ok && endpoint.value.endpoint.kind === "node")
                setCaptureSnapshot(sessionID, agentSnapshot.id)
            }
            const modelStarted = performance.now()
            const result = yield* handle.process(processInput).pipe(
              Effect.onExit((exit) =>
                Effect.logDebug("session model request", {
                  "session.id": sessionID,
                  durationMs: performance.now() - modelStarted,
                  outcome: Exit.isSuccess(exit)
                    ? "completed"
                    : Cause.hasInterrupts(exit.cause)
                      ? "cancelled"
                      : "failed",
                }),
              ),
            )
            if (result === "stop" || handle.message.error) {
              agentInputBlocked = true
              const reason = handle.message.error ? "model_error" : "turn_blocked"
              if (agentMessages) {
                if (agentSnapshot) yield* agentMessages.markStopped(identity, agentSnapshot.id, reason)
                yield* agentMessages.discardPending(identity, reason)
                if (result === "stop" && !handle.message.error) {
                  const endpoint = yield* agentMessages.revisions(identity)
                  if (endpoint.ok && endpoint.value.endpoint.kind === "node") {
                    handle.message.error = new NamedError.Unknown({
                      message: "DAG child turn blocked; continuation requires user action",
                    }).toObject()
                    yield* sessions.updateMessage(handle.message)
                  }
                }
              }
            }

            if (handle.message.finish === "content-filter" && !handle.message.error) {
              handle.message.error = new SessionV1.ContentFilterError({
                message: "The response was blocked by the provider's content filter",
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
              return "break" as const
            }

            if (structured !== undefined && !handle.message.error) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
            }

            if (format.type === "json_schema" && !handle.message.error && (finished || toolsDisabled)) {
              handle.message.error = new SessionV1.StructuredOutputError({
                message: toolLimitReached
                  ? "Maximum tool calls reached before producing structured output"
                  : isLastStep
                    ? "Maximum agent steps reached before producing structured output"
                    : "Model did not produce structured output",
                retries: 0,
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              if (toolsDisabled) yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
              return "break" as const
            }

            if (toolsDisabled || result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onError(finalizeFailedAssistant),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
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
          // The turn finished (outcome "break") or is ongoing (tool calls). Either way
          // loop back: the finished-check at the top of the next iteration fires the
          // Stop hook and returns once the agent is truly done. turnStopped covers
          // blocked turns (permission rejected) whose finish is still "tool-calls".
          turnStopped = outcome === "break"
          if (outcome === "break") turnError = handle.message.error
          continue
        }
        // Unreachable: the step loop above only exits via `return` inside the
        // finished-check. Kept so TS infers a definite return type for runLoop.
        return yield* getLastAssistant(sessionID)
      },
    )

    const runLoop = (sessionID: SessionID): Effect.Effect<SessionV1.WithParts> =>
      runLoopImpl(sessionID).pipe(
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

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      const result = yield* promptLocks.withLock(input.sessionID)(
        state.ensureRunningHandle(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID)),
      )
      return yield* result
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      const result = yield* promptLocks.withLock(input.sessionID)(
        state.startShellHandle(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready),
      )
      return yield* result
    })

    // #409: early-return command dispatches (/memory, /trust, /goal non-kick)
    // must still drive the busy→idle status transition — the run CLI exits its
    // event loop on the idle event, which only the runner's onIdle publishes.
    // startIfIdle keeps today's inline semantics while another turn is running
    // (no queueing, no second idle); the in-flight turn re-emits idle itself.
    const commandTurn = Effect.fnUntraced(function* (sessionID: SessionID, work: Effect.Effect<SessionV1.WithParts>) {
      return yield* promptLocks.withLock(sessionID)(
        Effect.gen(function* () {
          const handle = yield* state.startIfIdle(sessionID, lastAssistant(sessionID), work)
          return yield* Option.getOrElse(handle, () => work)
        }),
      )
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
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
            const model = yield* currentModel(input.sessionID)
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
      // /trust command dispatch — early return BEFORE command registry lookup.
      // Trust writes are security-sensitive and MUST NOT be delegated to the
      // LLM-driven command template path; mirror /goal's early-return dispatch
      // (prompt.ts only wires + renders; the domain logic lives in workspace-trust.ts).
      if (input.command === "trust") {
        return yield* commandTurn(
          input.sessionID,
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const result = dispatchTrust(ctx.directory, input.arguments, ctx.worktree)
            const m = yield* currentModel(input.sessionID)
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
            const cmdText: SessionV1.TextPart = {
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              type: "text",
              text: `/trust ${input.arguments}`.trim(),
              metadata: { command: "trust" },
            }
            yield* sessions.updatePart(cmdText)
            const now = Date.now()
            // time.end set so run-mode consumers print the response (run CLI
            // only renders text parts once ended).
            const responsePart: SessionV1.TextPart = {
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              type: "text",
              text: result.text,
              time: { start: now, end: now },
            }
            yield* sessions.updatePart(responsePart)
            yield* sessions.touch(input.sessionID)
            return { info: userMsg, parts: [cmdText, responsePart] }
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
          const m = yield* currentModel(input.sessionID)
          const agentName = input.agent ?? (yield* agents.defaultAgent())
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
                const contexts = yield* startContext.consume(input.sessionID)
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
            const m = yield* currentModel(input.sessionID)
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
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
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

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      withIdle,
      prepareIfIdle,
      promptIfIdle,
      loop,
      shell,
      command,
      resolvePromptParts,
      editQueuedMessage,
      deleteQueuedMessage,
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
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Agent.defaultLayer,
        Database.defaultLayer,
        DagMessages.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.defaultLayer,
        EventV2Bridge.defaultLayer,
        HookStartContext.defaultLayer,
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

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
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

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
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

export const node = LayerNode.make(layer, [
  SessionStatus.node,
  Session.node,
  Agent.node,
  Provider.node,
  SessionProcessor.node,
  SessionCompaction.node,
  Plugin.node,
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
  Memory.node,
  Todo.node,
  HookStartContext.node,
  SettingsHook.node,
  Goal.node,
  ToolSourceLedger.node,
])

export function admitIfIdle(
  service: Interface,
  automation: SessionAutomationLease.Interface,
  token: SessionAutomationLease.Token,
  input: PromptInput,
  options?: AdmissionOptions,
): Effect.Effect<Option.Option<Effect.Effect<SessionV1.WithParts>>, Image.Error> {
  return automation.handoff(token, service.prepareIfIdle(input, undefined, options))
}

export * as SessionPrompt from "./prompt"
