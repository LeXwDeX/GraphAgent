// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { ModelsDev } from "@graphagent/core/models-dev"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { ConfigCompaction } from "@graphagent/core/config/compaction"
import { Flag } from "@graphagent/core/flag/flag"
import { NamedError } from "@graphagent/core/util/error"
import type { SessionAdmission } from "@graphagent/core/session/admission"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "../session"
import type { Agent } from "../../agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Permission } from "@/permission"
import { MCP } from "../../mcp"
import type { LSP } from "@/lsp/lsp"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import type { Instruction } from "../instruction"
import type { LLM } from "../llm"
import type { SystemPrompt } from "../system"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess } from "../engine-process"
import { RuntimeSlots } from "../runtime-slots"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@graphagent/core/fs-util"
import type { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SettingsHook } from "@/hook"
import type { HookPayload } from "@/hook"
import { HookModelMetrics } from "@/hook/model-metrics"
import { HookTranscript } from "@/hook/transcript"
import type { Question } from "@/question"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, SessionID } from "../schema"
import { MessageV2 } from "../message-v2"
import { HistoryClaim } from "../history/claim"
import { HistoryView } from "../history/view"
import { SessionTools } from "../tools"
import { SessionReminders } from "../reminders"
import { TodoReminders } from "../todo-reminders"
import { RuntimeContext } from "../runtime-context"
import { MAX_STEPS_PROMPT } from "../max-steps"
import { FINAL_STEP_INSTRUCTION, type FinalPolicy } from "./final-policy"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { decodeDataUrl } from "@/util/data-url"
import { estimateOverhead } from "../overflow"
import type { ToolSourceLedger } from "../tool-source-ledger"
import type { Handle as ProcessorHandle } from "../processor"
import type { ToolBatch as HookToolBatchState } from "@/hook/tool-batch"
import type { Interface, PromptError, PromptInput, SetModelInput } from "../prompt"
import type { AdmissionCommit, ModelBaseline } from "../turns"
import { Cause, DateTime, Effect, Exit, Option, Schema, Stream, Types } from "effect"
import type { Context } from "effect"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { eq } from "drizzle-orm"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { ulid } from "ulid"
import { LLMEvent } from "@graphagent/llm"
import type { Tool } from "@/tool/tool"

export type PromptModelSelection = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
}

/**
 * Explicit callers win, then the model saved on the session, then the agent
 * default. The provider default remains the caller's final fallback.
 */
export function selectPromptModel(input: {
  requested?: PromptModelSelection
  saved?: { providerID: string; id: string; variant?: string }
  agent?: PromptModelSelection
}): PromptModelSelection | undefined {
  if (input.requested) return input.requested
  if (!input.saved) return input.agent
  const providerID = ProviderV2.ID.make(input.saved.providerID)
  const modelID = ModelV2.ID.make(input.saved.id)
  return input.saved.variant === undefined
    ? { providerID, modelID }
    : { providerID, modelID, variant: input.saved.variant }
}

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

export class ModelSwitchBlocked extends Schema.TaggedError<ModelSwitchBlocked>()("ModelSwitchBlocked", {
  message: Schema.String,
}) {}

export class QueuedMessageNotFound extends Schema.TaggedError<QueuedMessageNotFound>()("QueuedMessageNotFound", {
  messageID: MessageID,
}) {}

export class QueuedMessageInvalid extends Schema.TaggedError<QueuedMessageInvalid>()("QueuedMessageInvalid", {
  message: Schema.String,
}) {}

export class QueuedMessageConflict extends Schema.TaggedError<QueuedMessageConflict>()("QueuedMessageConflict", {
  kind: Schema.Literals(["already_consumed", "stale", "not_queued", "history_uncertain"]),
  message: Schema.String,
}) {}

export type QueuedMessageError = QueuedMessageNotFound | QueuedMessageInvalid | QueuedMessageConflict

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

export interface PrepareDeps {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly provider: Provider.Interface
  readonly config: Config.Interface
  readonly permission: Permission.Interface
  readonly fsys: FSUtil.Interface
  readonly mcp: MCP.Interface
  readonly lsp: LSP.Interface
  readonly registry: ToolRegistry.Interface
  readonly truncate: Truncate.Interface
  readonly image: Image.Interface
  readonly instruction: Instruction.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly flags: RuntimeFlags.Info
  readonly llm: LLM.Interface
  readonly sys: SystemPrompt.Interface
  readonly database: Database.Interface
  readonly db: Database.Interface["db"]
  readonly promptLocks: KeyedMutex.KeyedMutex<SessionID>
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly toolSources: ToolSourceLedger.Interface
  readonly todoReminders: Option.Option<TodoReminders.Interface>
  readonly agentMessages: DagMessages.Interface | undefined
  readonly reasoningDistillationEnabled: (model: Provider.Model) => Effect.Effect<boolean>
  readonly queueModelSwitch: (
    sessionID: SessionID,
    payload: Extract<HookPayload, { event: "PreModelSwitch" | "PostModelSwitch" }>,
  ) => Effect.Effect<void>
  readonly modelWriteEpoch: (sessionID: SessionID) => number | undefined
  readonly modelWriteBump: (sessionID: SessionID) => void
  readonly modelSwitchContext: (sessionID: SessionID, apiModelID: string) => Effect.Effect<readonly string[]>
  readonly budgetState: (sessionID: SessionID) => Effect.Effect<{
    active?: ToolBudget.Budget
    pending: Map<MessageID, ToolBudget.Budget>
  }>
  readonly dropPendingBudget: (sessionID: SessionID, messageID: MessageID) => Effect.Effect<void>
  readonly hookQuestions: Question.Interface | undefined
  readonly ops: () => Effect.Effect<TaskPromptOps>
}

export type CreateUserMessage = (
  input: PromptInput,
  persistAdmission?: Effect.Effect<void>,
  commitAdmission?: AdmissionCommit,
  modelBaseline?: ModelBaseline,
) => Effect.Effect<
  { readonly info: SessionV1.User; readonly parts: SessionV1.Part[] },
  PromptError | SessionAdmission.Blocked
>

export interface TurnRequestInput {
  readonly sessionID: SessionID
  readonly session: Session.Info
  readonly messages: SessionV1.WithParts[]
  readonly budget: ToolBudget.Budget
  readonly model: Provider.Model
  readonly toolBatch: HookToolBatchState
  /** Request shape for this model step; see `FinalPolicy`. */
  readonly finalPolicy: FinalPolicy
  /** Forwarded to `LLM.StreamInput.onToolRefused` for the terminal step. */
  readonly onToolRefused?: () => void
  readonly user: SessionV1.User
  readonly agent: Agent.Info
  readonly handle: ProcessorHandle
  readonly toolLimitReached: boolean
  readonly identity: DagMessages.Caller
  readonly agentSnapshot: DagMessages.Snapshot | undefined
  readonly onStructured: (output: unknown) => void
  readonly prepareStage: <A, E, R>(
    stage: "memory" | "reasoning" | "tools",
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly requestOverheads: Map<SessionID, number>
  readonly runtimeContexts: Map<SessionID, readonly RuntimeContext.Entry[]>
}

export function makePrepare(deps: PrepareDeps) {
  const {
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
    ops,
  } = deps

  const claimSnapshot = HistoryClaim.makeClaim({
    database,
    sessions,
    promptLocks,
    budgetState,
    maxToolCalls: config.get().pipe(Effect.map((info) => info.maxToolCalls)),
  })

  const queuedMessage = Effect.fn("SessionPrompt.queuedMessage")(function* (input: QueuedMessageDeleteInput) {
    const messages = yield* sessions
      .messages({ sessionID: input.sessionID })
      .pipe(Effect.catch(() => Effect.fail(new QueuedMessageNotFound({ messageID: input.messageID }))))
    const message = messages.find((item) => item.info.id === input.messageID)
    if (!message) return yield* new QueuedMessageNotFound({ messageID: input.messageID })
    if (!HistoryView.isOrdinaryUser(message)) {
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
            Effect.tap(() => dropPendingBudget(input.sessionID, input.messageID)),
            Effect.catchTag("SqlError", Effect.die),
          ),
      ),
  )

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
      .setTitle({ sessionID: input.session.id, title: t, source: "generated" })
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
    const parentAgent = yield* agents.get(lastUser.agent)
    if (!parentAgent) throw new Error(`Agent not found: "${lastUser.agent}"`)
    const tools = yield* SessionTools.resolve({
      agent: parentAgent,
      session,
      model: taskModel,
      user: lastUser,
      messages: msgs,
      promptOps,
      bypassAgentCheck: true,
      hooks: settingsHook,
      sourceLedger: toolSources,
      processor: {
        message: assistantMessage,
        updateToolCall: (_id, update) =>
          Effect.gen(function* () {
            part = yield* sessions.updatePart(update(part))
            return part
          }),
        previewToolCall: () => Effect.void,
        completeToolCall: (_id, result) =>
          Effect.gen(function* () {
            if (part.state.status !== "running") return
            part = yield* sessions.updatePart({
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                ...result,
                time: { ...part.state.time, end: Date.now() },
              },
            })
          }),
      },
    }).pipe(
      Effect.provideService(Permission.Service, permission),
      Effect.provideService(ToolRegistry.Service, registry),
      Effect.provideService(MCP.Service, mcp),
      Effect.provideService(Truncate.Service, truncate),
    )
    const callable = tools[TaskTool.id]
    if (!callable?.execute) throw new Error("Task tool unavailable")
    let error: Error | undefined
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        Promise.resolve(
          callable.execute!(taskArgs, {
            toolCallId: part.callID,
            messages: [],
            abortSignal: signal,
          }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasDies(cause)) return Effect.die(Cause.squash(cause))
        if (Cause.hasInterrupts(cause)) return Effect.interrupt
        const failure = Cause.squash(cause)
        error = failure instanceof Error ? failure : new Error(String(failure))
        return Effect.succeed(undefined)
      }),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          assistantMessage.finish = "tool-calls"
          assistantMessage.time.completed = Date.now()
          yield* sessions.updateMessage(assistantMessage)
          if (part.state.status === "running")
            yield* sessions.updatePart({
              ...part,
              state: {
                status: "error",
                error: "Cancelled",
                input: part.state.input,
                metadata: part.state.metadata,
                time: { start: part.state.time.start, end: Date.now() },
              },
            })
        }),
      ),
    )
    const attachments = result?.attachments

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

  const prepareModelSwitch = Effect.fn("SessionPrompt.prepareModelSwitch")(function* (
    input: Omit<SetModelInput, "source"> & { source?: "command" | "picker" | "sdk" | "auto" | "resume" },
  ) {
    const previous = yield* currentModel(input.sessionID)
    const selected = input.model ?? (yield* provider.defaultModel().pipe(Effect.orDie))
    const target = yield* getModel(selected.providerID, selected.modelID, input.sessionID)
    const current = yield* db
      .select({ model: SessionTable.model, agent: SessionTable.agent })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    const changed = previous.providerID !== selected.providerID || previous.modelID !== selected.modelID
    const variantChanged =
      input.variant === "default"
        ? current?.model?.variant !== "default"
        : ("variant" in previous ? previous.variant : undefined) !== input.variant
    const source = input.source ?? "sdk"
    const history =
      (changed || source === "resume") && settingsHook
        ? yield* HookTranscript.history(
            input.sessionID,
            yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie),
          )
        : []
    const agentName = history.findLast((message) => message.info.role === "user")?.info.agent ?? current?.agent
    const activeAgent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
    const configuration = yield* config.get()
    const priorModel = Option.getOrUndefined(
      yield* provider.getModel(previous.providerID, previous.modelID).pipe(Effect.option),
    )
    const targetProvider = yield* provider.getProvider(target.providerID)
    const priorProvider = priorModel ? yield* provider.getProvider(priorModel.providerID) : undefined
    const catalogService = Option.getOrUndefined(yield* Effect.serviceOption(ModelsDev.Service))
    const catalog = catalogService ? yield* catalogService.get() : undefined
    const metrics = yield* HookModelMetrics.snapshot({
      sessionID: input.sessionID,
      target,
      previous: priorModel,
      history,
      providerOptions: targetProvider?.options,
      previousProviderOptions: priorProvider?.options,
      agentOptions: activeAgent?.options,
      previousAgentOptions: activeAgent?.options,
      variant: input.variant,
      previousVariant: "variant" in previous && typeof previous.variant === "string" ? previous.variant : undefined,
      configuredCost: configuration.provider?.[target.providerID]?.models?.[target.id]?.cost,
      catalogCost:
        catalog?.[target.providerID]?.models[target.id]?.cost ??
        catalog?.[target.providerID]?.models[target.api.id]?.cost,
    })
    const payload: Extract<HookPayload, { event: "PreModelSwitch" | "PostModelSwitch" }> = {
      event: "PreModelSwitch",
      fromModel: priorModel?.api.id ?? previous.modelID,
      toModel: target.api.id,
      requestedModel: source === "auto" ? null : (input.model?.modelID ?? null),
      source,
      ...metrics,
    }
    // Restoring a saved model is a runtime lifecycle event. It must not
    // rewrite durable state or rerun PreModelSwitch for an already saved choice.
    const result = { providerID: selected.providerID, modelID: selected.modelID }
    if (source === "resume") {
      return {
        result,
        persist: queueModelSwitch(input.sessionID, { ...payload, event: "PostModelSwitch" }),
      }
    }
    if (changed && current?.model && settingsHook && source !== "auto") {
      const result = yield* settingsHook.trigger(payload, { sessionID: input.sessionID })
      yield* SettingsHook.landSystemMessages(result, { sessionID: input.sessionID })
      const reason =
        result.modelSwitchDecisionReason ??
        result.blocked?.reason ??
        result.stopReason ??
        "Model switch blocked by hook"
      if (result.blocked || result.preventContinuation || result.modelSwitchDecision === "deny")
        return yield* Effect.fail(new ModelSwitchBlocked({ message: reason }))
      if (result.modelSwitchDecision === "ask") {
        if (source !== "command" || input.hookMode !== "interactive")
          return yield* Effect.fail(new ModelSwitchBlocked({ message: reason }))
        const questions = hookQuestions
        if (!questions) return yield* Effect.fail(new ModelSwitchBlocked({ message: reason }))
        const answer = yield* questions
          .ask({
            sessionID: input.sessionID,
            questions: [
              {
                question: reason,
                header: "Switch model",
                custom: false,
                options: [
                  { label: "Switch", description: `Use ${target.name}` },
                  { label: "Keep current", description: "Keep the current model" },
                ],
              },
            ],
          })
          .pipe(Effect.option)
        if (Option.isNone(answer) || answer.value[0]?.[0] !== "Switch")
          return yield* Effect.fail(new ModelSwitchBlocked({ message: reason }))
      }
    }
    // The caller decides where ModelSwitched lands: a plain prompt applies it
    // immediately, while a cancellable command commits it under admission.
    const persist = Effect.suspend(() => {
      if (current?.model && !changed && !variantChanged) return Effect.void
      return Effect.uninterruptible(
        Effect.gen(function* () {
          yield* sessions.setModelSelection({
            sessionID: input.sessionID,
            timestamp: DateTime.toEpochMillis(yield* DateTime.now),
            model: {
              id: selected.modelID,
              providerID: selected.providerID,
              variant: ModelV2.VariantID.make(input.variant ?? "default"),
            },
          })
          // The durable write completed; bump before any interruption can
          // separate the write from the epoch observation.
          modelWriteBump(input.sessionID)
          if (changed && current?.model)
            yield* queueModelSwitch(input.sessionID, { ...payload, event: "PostModelSwitch" })
        }),
      )
    })
    return { result, persist }
  })
  /** Raw persisted model selection, used to detect a later user setModel. */
  const modelSelection = Effect.fnUntraced(function* (sessionID: SessionID) {
    const row = yield* db
      .select({ model: SessionTable.model })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    return {
      providerID: row?.model?.providerID,
      modelID: row?.model?.id,
      variant: row?.model?.variant,
    } as const
  })
  const applyModelSwitch = Effect.fn("SessionPrompt.applyModelSwitch")(function* (
    input: Omit<SetModelInput, "source"> & { source?: "command" | "picker" | "sdk" | "auto" | "resume" },
    options?: { readonly bump?: boolean },
  ) {
    const prepared = yield* prepareModelSwitch(input)
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* prepared.persist
        // An explicit successful model write advances the causal version even
        // when the durable value did not change (no-op) or returned to an
        // earlier value (ABA).
        if (options?.bump) modelWriteBump(input.sessionID)
      }),
    )
    return prepared.result
  })
  const restoreModelContext: Interface["restoreModelContext"] = Effect.fn("SessionPrompt.restoreModelContext")(
    function* (sessionID) {
      if (!settingsHook) return
      const saved = yield* currentModel(sessionID)
      // A removed historical model was not initialized in this process.
      // Skip its restore notification; an explicit next selection is still
      // validated through the normal model-switch path.
      const available = yield* provider
        .getModel(saved.providerID, saved.modelID)
        .pipe(Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)))
      if (!available) return
      yield* applyModelSwitch({
        sessionID,
        model: saved,
        source: "resume",
        ...("variant" in saved && typeof saved.variant === "string" ? { variant: saved.variant } : {}),
      }).pipe(Effect.orDie)
    },
  )
  const setModel: Interface["setModel"] = Effect.fn("SessionPrompt.setModel")((input) =>
    promptLocks.withLock(input.sessionID)(applyModelSwitch(input, { bump: true })),
  )

  const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void>,
    commitAdmission?: AdmissionCommit,
    modelBaseline?: ModelBaseline,
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
    const model =
      selectPromptModel({ requested: input.model, saved: current?.model ?? undefined, agent: ag.model }) ??
      (yield* currentModel(input.sessionID))
    const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
    const savedVariant =
      current?.model?.providerID === model.providerID && current.model.id === model.modelID
        ? current.model.variant
        : undefined
    const full =
      input.variant === undefined && savedVariant === undefined && ag.variant && same
        ? yield* provider
            .getModel(model.providerID, model.modelID)
            .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
        : undefined
    const variant =
      input.variant ?? savedVariant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

    const info: SessionV1.User = {
      id: input.messageID ?? MessageID.ascending(),
      role: "user",
      hookMode: input.hookMode,
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

    // Model/agent switch events belong to the same transaction as the message:
    // admission checks the owner inside the commit, so a cancelled command
    // cannot publish a model switch or persist its message afterwards.
    const modelSwitch = yield* prepareModelSwitch({
      sessionID: input.sessionID,
      model: info.model,
      variant,
      hookMode: input.hookMode,
      source: "sdk",
    })

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

    const parsed = decodeMessageInfo(info, { errors: "all" })
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
      const p = decodeMessagePart(part, { errors: "all" })
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
      // A command's model selection was captured before expansion. If the
      // user changed the session model while the command was still pending,
      // the old command must not publish its ModelSwitched (or run its post
      // switch hook) after the newer write. The message itself keeps the
      // command's original variant for compatibility.
      const unchanged = modelBaseline
        ? yield* Effect.gen(function* () {
            const live = yield* modelSelection(input.sessionID)
            return (
              live.providerID === modelBaseline.providerID &&
              live.modelID === modelBaseline.modelID &&
              live.variant === modelBaseline.variant &&
              modelWriteEpoch(input.sessionID) === modelBaseline.epoch
            )
          })
        : true
      if (unchanged) yield* modelSwitch.persist
      if (current?.agent !== info.agent) {
        yield* sessions.setAgent({
          sessionID: input.sessionID,
          timestamp: info.time.created,
          agent: info.agent,
        })
      }
      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)
      if (persistAdmission) yield* persistAdmission
    })
    // Preparation and hook callbacks stay outside the write reservation.
    // Internal wakes commit their transcript receipt and reporting mark together.
    const reserved = () =>
      persistAdmission || modelBaseline
        ? db.transaction(() => persist, { behavior: "immediate" }).pipe(Effect.orDie)
        : persist
    yield* commitAdmission ? commitAdmission(reserved()) : reserved()
    return { info, parts }
  }, Effect.scoped)

  const buildTurnRequest = Effect.fn("SessionPrompt.buildTurnRequest")(function* (input: TurnRequestInput) {
    const {
      sessionID,
      session,
      budget,
      model,
      toolBatch,
      finalPolicy,
      onToolRefused,
      user: lastUser,
      agent,
      handle,
      toolLimitReached,
      identity,
      agentSnapshot,
      prepareStage,
      requestOverheads: requestOverheadBySession,
      runtimeContexts: runtimeContextBySession,
      onStructured,
    } = input
    let msgs = input.messages
    const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
    const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
    const promptOps = yield* ops()

    // `closing` and `structuredTerminal` use an empty tool set and
    // `tool_choice: "none"`; `terminal` keeps the normal tool set and refuses
    // execution in the LLM layer instead. `terminal`/`closing` append the
    // fixed final-step instruction; only the structured terminal keeps the
    // legacy max-steps text.
    const closing = finalPolicy === "closing"
    const legacyToolsDisabled = closing || finalPolicy === "structuredTerminal"
    // Only a normal step may advertise the structured-output tool; the
    // structured terminal keeps the legacy empty-tool shape.
    const structuredFormat = finalPolicy === "normal" ? lastUser.format : undefined
    const refuseTools = finalPolicy === "terminal" || closing

    const tools = legacyToolsDisabled
      ? {}
      : yield* prepareStage(
          "tools",
          SessionTools.resolve({
            agent,
            session,
            model,
            user: lastUser,
            processor: handle,
            bypassAgentCheck,
            messages: msgs,
            promptOps,
            hooks: settingsHook,
            canDefer:
              !session.parentID && lastUser.hookMode !== "interactive"
                ? (id, signal) => toolBatch.isSingle(id, signal)
                : undefined,
            sourceLedger: toolSources,
          }).pipe(
            Effect.provideService(Permission.Service, permission),
            Effect.provideService(ToolRegistry.Service, registry),
            Effect.provideService(MCP.Service, mcp),
            Effect.provideService(Truncate.Service, truncate),
          ),
        )

    // Permission.ask evaluates native rules before configured rules. Use
    // that same split for the system prompts and the stream input.
    const nativePermission = (yield* agents.permissionPolicy(agent.name)).native
    // Resolution already applied native and configured permission rules plus the
    // per-message tool switches, so the advertised set is exactly the resolved keys.
    const enabledTools = Object.keys(tools)
    msgs = yield* SessionReminders.derive({
      messages: msgs,
      agent,
      session,
      tools: enabledTools,
    }).pipe(
      Effect.provideService(RuntimeFlags.Service, flags),
      Effect.provideService(FSUtil.Service, fsys),
      Effect.provideService(Session.Service, sessions),
    )
    if (structuredFormat?.type === "json_schema") {
      tools["StructuredOutput"] = createStructuredOutputTool({
        schema: structuredFormat.schema,
        onSuccess(output) {
          onStructured(output)
        },
      })
    }

    // Reminder text is computed after the persisted user content and appended by
    // the provider adapter after the persisted user content. It never
    // reaches stored messages and only the current turn carries one.
    const todoReminder = yield* Option.match(todoReminders, {
      onNone: () => Effect.succeed(undefined),
      onSome: (reminders) =>
        reminders.forRequest({
          sessionID,
          messages: msgs,
          enabled: enabledTools.includes("todowrite"),
        }),
    })

    // Building the folding history walks every message; only do it when
    // built-in dynamic folding is enabled for this request.
    const configured = yield* config.get()
    const foldingConfig = configured.compaction
    const folding = ConfigCompaction.resolveDynamic({
      disabledByEnvironment: Flag.GRAPHAGENT_DISABLE_PRUNE,
      dynamic: foldingConfig?.dynamic,
      prune: foldingConfig?.prune,
    })

    // Permission.ask evaluates native rules before configured rules. Use
    // that same split for everything advertised to the model.
    const [
      skills,
      env,
      languageDocs,
      instructions,
      mcpInstructions,
      goalDocs,
      hooksDocs,
      memoryDocs,
      modelMsgs,
      contextFoldingHistory,
    ] = yield* Effect.all(
      [
        sys.skills(agent, session.permission, nativePermission),
        sys.environment(model),
        sys.language(configured.language),
        instruction.system({ sessionID }).pipe(Effect.orDie),
        sys.mcp(agent, session.permission, nativePermission),
        sys.goal(sessionID),
        sys.hooks(),
        prepareStage("memory", sys.memory({ sessionID, messages: msgs, main: !session.parentID })),
        MessageV2.toModelMessagesEffect(msgs, model, {
          reasoningDistillationEnabled: yield* reasoningDistillationEnabled(model),
        }),
        folding.enabled
          ? MessageV2.contextFoldingHistory({ messages: msgs, ledger: toolSources })
          : Effect.succeed(undefined),
      ],
      { concurrency: "unbounded" },
    )
    const system = [
      ...env,
      ...languageDocs,
      ...instructions,
      ...(mcpInstructions ? [mcpInstructions] : []),
      ...(skills ? [skills] : []),
      ...goalDocs.system,
      ...hooksDocs,
      RuntimeContext.SYSTEM_NOTE,
    ]
    // Goal, memory, the environment and the date are state, not system text:
    // the cached prefix must not change when the directory or the day changes.
    // Owner-contributed slots (for example DAG mode) follow them.
    const ctx = yield* InstanceState.context
    const runtimeState = RuntimeSlots.state({
      goal: goalDocs.context,
      memory: memoryDocs,
      environment: { directory: ctx.directory, root: ctx.root, git: ctx.project.vcs === "git" },
      now: yield* DateTime.nowAsDate,
      custom: EngineProcess.runtimes.runtimeSlots.list(input.sessionID),
    })
    const runtimeEvents: string[] = []
    if (structuredFormat?.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
    const processInput: LLM.StreamInput = {
      user: lastUser,
      agent,
      permission: session.permission,
      nativePermission,
      sessionID,
      parentSessionID: session.parentID,
      system,
      messages: [
        ...modelMsgs,
        ...(finalPolicy === "structuredTerminal"
          ? [
              {
                role: "assistant" as const,
                content: toolLimitReached ? ToolBudget.renderExhaustedPrompt(budget.max) : MAX_STEPS_PROMPT,
              },
            ]
          : refuseTools
            ? [{ role: "assistant" as const, content: FINAL_STEP_INSTRUCTION }]
            : []),
      ],
      tools,
      toolBudget: budget,
      toolBatch,
      model,
      toolChoice: legacyToolsDisabled
        ? "none"
        : structuredFormat?.type === "json_schema" && Provider.supportsForcedToolChoice(model)
          ? "required"
          : undefined,
      toolPolicy: refuseTools ? "refuse" : undefined,
      onToolRefused,
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
    }
    runtimeEvents.push(...(yield* modelSwitchContext(sessionID, model.api.id)))
    // Async hooks contribute at the next model boundary without manufacturing a user turn.
    if (settingsHook?.drainAsync) {
      const queued = yield* settingsHook.drainAsync(sessionID)
      runtimeEvents.push(...queued.additionalContexts)
    }
    // Runtime context goes into the history, before any assistant prefill, so the system prefix stays
    // constant and each request extends the previous one.
    const runtime = RuntimeContext.place({
      ledger: runtimeContextBySession.get(sessionID) ?? [],
      messages: modelMsgs,
      state: runtimeState,
      events: runtimeEvents,
      afterTool: !ProviderTransform.mistralFamily(model),
    })
    if (runtime.ledger.length > 0) runtimeContextBySession.set(sessionID, runtime.ledger)
    else runtimeContextBySession.delete(sessionID)
    processInput.messages.splice(0, modelMsgs.length, ...TodoReminders.append(runtime.messages, todoReminder))
    processInput.system.push(...runtime.unplaced)
    // Record what this request carries besides its messages. The next limit check runs before the
    // next request is prepared, when system text and tool schemas are not available yet.
    requestOverheadBySession.set(
      sessionID,
      estimateOverhead({
        system: [...processInput.system, ...runtime.ledger.map((entry) => entry.content)],
        tools: processInput.tools,
        // The cached fragment is only valid for the resolved tool set; the
        // structured-output tool is added afterwards, so that request
        // re-serializes instead of reusing a stale fragment (Issue #1022, PR5).
        toolsJson:
          legacyToolsDisabled || lastUser.format?.type === "json_schema"
            ? undefined
            : SessionTools.serializedFragment(processInput.tools),
      }),
    )
    return { processInput }
  })

  return {
    claimSnapshot,
    resolvePromptParts,
    ensureTitle: title,
    handleSubtask,
    getModel,
    currentModel,
    prepareModelSwitch,
    modelSelection,
    applyModelSwitch,
    restoreModelContext,
    setModel,
    createUserMessage,
    editQueuedMessage,
    deleteQueuedMessage,
    buildTurnRequest,
  }
}

export type PrepareApi = ReturnType<typeof makePrepare>

export * as Prepare from "./prepare"
