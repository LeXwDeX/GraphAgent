// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { ModelsDev } from "@graphagent/core/models-dev"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { NamedError } from "@graphagent/core/util/error"
import type { SessionAdmission } from "@graphagent/core/session/admission"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "../session"
import { SessionRole } from "../role"
import type { Agent } from "../../agent/agent"
import type { Command } from "@/command"
import { Provider } from "@/provider/provider"
import { ProviderProfile } from "@/provider/profile"
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
import { ChildSlot } from "../child/slot"
import type { ChildRuns } from "../child/run"
import { DEFAULT_USER_MAX_TOTAL_NODES } from "@/dag/dag"
import { DagMode } from "@/dag/mode"
import type { UnavailableReason } from "@/dag/mode-status"
import { EngineProcess } from "../engine-process"
import { RuntimeSlots } from "../runtime-slots"
import type { AgentScheduler } from "../agent-scheduler"
import type { DagMode as DagModeType } from "@graphagent/schema/dag-mode"
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@graphagent/core/fs-util"
import type { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SettingsHook } from "@/hook"
import type { HookPayload } from "@/hook"
import { HookModelMetrics } from "@/hook/model-metrics"
import { HookTranscript } from "@/hook/transcript"
import { hookBlock, hookToolStop } from "@/hook/trigger-result"
import type { Question } from "@/question"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, SessionID } from "../schema"
import { MessageV2 } from "../message-v2"
import { HistoryClaim } from "../history/claim"
import { HistoryView } from "../history/view"
import { SessionTools } from "../tools"
import { SessionReminders } from "../reminders"
import { RuntimeContext } from "../runtime-context"
import { MAX_STEPS_PROMPT } from "../max-steps"
import { FINAL_STEP_INSTRUCTION, type FinalPolicy } from "./final-policy"
import { SystemSections } from "./system-sections"
import { Overhead } from "./overhead"
import { TaskTool, type TaskOrigin, type TaskPromptOps } from "@/tool/task"
import { decodeDataUrl } from "@/util/data-url"
import { estimateOverhead } from "../overflow"
import { LLMRequestPrep } from "../llm/request"
import type { Handle as ProcessorHandle } from "../processor"
import type { ToolBatch as HookToolBatchState } from "@/hook/tool-batch"
import type { Interface, PromptError, PromptInput, SetModelInput } from "../prompt"
import type { AdmissionCommit, ModelBaseline } from "../turns"
import { classifyToolError, endedMetadata } from "../tool-outcome"
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
 * The admission transaction (message plus ledger key) rolled back. `submit`
 * re-checks its ledger and classifies a concurrent loser as `duplicate`; any
 * other admission caller surfaces the failure instead of a defect.
 */
export class AdmissionPersistFailed extends Schema.TaggedError<AdmissionPersistFailed>()(
  "SessionPromptAdmissionPersistFailed",
  { cause: Schema.String },
) {
  override get message() {
    return `session admission transaction failed: ${this.cause}`
  }
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
  /** Command definitions, for the settings a command-driven subtask carries (#1057). */
  readonly commands: Command.Interface
  /** The parent's delegations travel in the request's runtime context (`ChildSlot`). */
  readonly children: ChildRuns.Interface
  /** The concurrency the DAG announcement states is the scheduler's own DAG layer (#1290). */
  readonly scheduler: Pick<AgentScheduler.Interface, "capacity">
  readonly ops: () => Effect.Effect<TaskPromptOps>
}

export type CreateUserMessage = (
  input: PromptInput,
  persistAdmission?: Effect.Effect<void, unknown>,
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

/** A part before `assign` gives it an id. */
type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never

/** Expand one MCP resource attachment into the text and file parts the model receives. */
function resolveMcpResource(input: {
  readonly mcp: MCP.Interface
  readonly messageID: MessageID
  readonly sessionID: SessionID
  readonly clientName: string
  readonly uri: string
  readonly part: { readonly mime: string; readonly filename?: string | undefined }
}) {
  const { mcp, messageID, sessionID, clientName, uri, part } = input
  return Effect.gen(function* () {
    yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
    const pieces: Draft<SessionV1.Part>[] = [
      {
        messageID,
        sessionID,
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
            messageID,
            sessionID,
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
              messageID,
              sessionID,
              type: "text",
              synthetic: true,
              text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
            })
            continue
          }
          if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
            pieces.push({
              messageID,
              sessionID,
              type: "text",
              synthetic: true,
              text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
            })
            continue
          }
          pieces.push({
            messageID,
            sessionID,
            type: "text",
            synthetic: true,
            text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
          })
          pieces.push({
            messageID,
            sessionID,
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
        messageID,
        sessionID,
        type: "text",
        synthetic: true,
        text: `Failed to read MCP resource ${part.filename}: ${message}`,
      })
    }
    return pieces
  })
}

/**
 * A hook `continue:false` stops the call in one of two shapes: the settled tool result is marked `hookStopped`
 * (PreToolUse, PostToolUse), or the failure is a `HookToolStop` (PostToolUseFailure). The processor ends a model turn
 * on either; a subtask ends its turn on them too, with no summary round, so a command's turn stops where a model's
 * would (#1351).
 */
function hookStopped(part: SessionV1.ToolPart, failure: unknown) {
  return (
    (part.state.status === "completed" && part.state.metadata.hookStopped === true) ||
    hookToolStop(failure) !== undefined
  )
}

/** After a command-driven subtask, ask the parent to summarize the tool output and continue. */
function appendTaskSummaryPrompt(input: {
  readonly sessions: Session.Interface
  readonly sessionID: SessionID
  readonly lastUser: SessionV1.User
}) {
  const { sessions, sessionID, lastUser } = input
  return Effect.gen(function* () {
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
}

/** Tail of the request for the last step of a turn; see `FinalPolicy`. */
function finalStepMessages(
  input: Pick<TurnRequestInput, "finalPolicy" | "toolLimitReached" | "budget">,
): LLM.StreamInput["messages"] {
  if (input.finalPolicy === "structuredTerminal") {
    return [
      {
        role: "assistant",
        content: input.toolLimitReached ? ToolBudget.renderExhaustedPrompt(input.budget.max) : MAX_STEPS_PROMPT,
      },
    ]
  }
  if (input.finalPolicy === "terminal" || input.finalPolicy === "closing") {
    return [
      {
        role: "assistant",
        // The instruction belongs to this request only; keep it out
        // of the cached prefix so the breakpoint stays on the last
        // persisted message.
        providerOptions: { graphagent: { cache: "none" } },
        content: FINAL_STEP_INSTRUCTION,
      },
    ]
  }
  return []
}

/**
 * Agent input frozen for this request must still be in the model input, and
 * the mailbox must accept tying it to this request.
 */
function associateAgentSnapshot(input: {
  readonly agentMessages: DagMessages.Interface
  readonly identity: DagMessages.Caller
  readonly agentSnapshot: DagMessages.Snapshot
  readonly msgs: readonly SessionV1.WithParts[]
}) {
  const { agentMessages, identity, agentSnapshot, msgs } = input
  return Effect.gen(function* () {
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
  })
}

/**
 * Compaction may reuse exactly this system text and tool set so provider
 * prefix caching serves most of its request (Issue #1028, PR5). Structured
 * turns and the closing policy reshape the request, so they record nothing.
 */
function rememberRequestPrefix(
  input: Pick<TurnRequestInput, "sessionID" | "session" | "agent" | "model" | "user" | "finalPolicy">,
  prepared: {
    readonly directory: string
    readonly processInput: LLM.StreamInput
    readonly toolsJson: string | undefined
  },
) {
  const { sessionID, session, agent, model, user: lastUser, finalPolicy } = input
  const { directory, processInput, toolsJson } = prepared
  if ((finalPolicy === "normal" || finalPolicy === "terminal") && lastUser.format?.type !== "json_schema") {
    const prefixSystem = [...processInput.system]
    EngineProcess.runtimes.rememberRequestPrefix(sessionID, {
      directory,
      agent,
      model: { providerID: model.providerID, id: model.id },
      system: prefixSystem,
      userSystem: lastUser.system,
      tools: processInput.tools,
      toolsJson,
      toolChoice: processInput.toolChoice,
      permission: session.permission,
      nativePermission: processInput.nativePermission,
      prefixTokens: estimateOverhead({
        system: LLMRequestPrep.requestSystem(processInput),
        tools: processInput.tools,
        toolsJson,
      }),
      recordedAt: Date.now(),
    })
  }
}

/**
 * Reconcile the model-facing DAG facts from the durable row (#1031 M1/M2). The
 * turn loop's session snapshot predates the loop, and a local `/dag-mode`
 * command may run inside the active turn, so the row is the source of truth for
 * the mode and the session budget. A row deleted mid-turn falls back to the
 * snapshot instead of failing the request.
 */
const reconcileDagMode = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  fallback: Pick<Session.Info, "dagMode" | "dagBudgetTokens" | "dagBudgetUnlimited">,
) {
  const live = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const info = live ?? fallback
  return {
    mode: DagMode.get(info),
    budgetTokens: info.dagBudgetTokens,
    budgetUnlimited: info.dagBudgetUnlimited,
  }
})

/** A local command exchange is presentation state, not a model request (#1031 M1). */
const isModelSourceMessage = (message: SessionV1.WithParts) =>
  message.info.role === "user" && !!message.info.model && !MessageV2.isLocalCommand(message)

interface DagRequestFacts {
  readonly advertised: boolean
  readonly unavailable?: UnavailableReason
  readonly mode: DagModeType
  readonly budget: number | null
  readonly concurrency: number
  readonly maxTotalNodes: number
  /** `dag.permission` as configured now (#1324); L2 states it unless it is the default. */
  readonly permission?: ConfigV1.DagPermission
}

/**
 * The DAG facts one request derives (#1031 M2). Availability comes from the
 * request inputs, never from the per-step tool set: a closing or
 * structured-terminal step advertises no tools yet still belongs to a turn
 * whose workflow tool is published. The budget follows the live row so a
 * mid-turn `/dag-mode budget` reaches the next placeable request.
 */
const dagRequestFacts = Effect.fnUntraced(function* (input: {
  sessions: Session.Interface
  config: Config.Interface
  scheduler: Pick<AgentScheduler.Interface, "capacity">
  session: Session.Info
  agent: Agent.Info
  user: SessionV1.User
  model: Provider.Model
  nativePermission: PermissionV1.Ruleset
  configured: ConfigV1.Info
}): Effect.fn.Return<DagRequestFacts> {
  const permission = Permission.merge(input.agent.permission, input.session.permission ?? [])
  const disabled = input.configured.tools?.workflow === false
  const denied = Permission.disabledByPolicy(["workflow"], input.nativePermission, permission).has("workflow")
  const switchedOff = input.user.tools?.workflow === false
  const advertised = SessionRole.isRoot(input.session) && !disabled && !denied && !switchedOff
  // The status degradation order: tool switch, deny rule, then model
  // capabilities. `no_worker` needs the agent catalog and stays with the
  // `/dag-mode status` snapshot.
  const unavailable: UnavailableReason | undefined = SessionRole.isChild(input.session)
    ? undefined
    : !advertised
      ? disabled
        ? "workflow_tool_disabled"
        : "start_denied"
      : !input.model.capabilities.toolcall
        ? "model_no_tool_calling"
        : undefined
  const live = yield* reconcileDagMode(input.sessions, input.session.id, input.session)
  const dag = yield* input.config.dagGlobal()
  // #1290: the cap the model plans against is the one the scheduler enforces
  // (the DAG layer: `dag.concurrency` or its default, cut to the child pool),
  // the same read the status endpoint makes.
  const capacity = yield* input.scheduler.capacity()
  return {
    advertised,
    unavailable,
    mode: live.mode,
    budget: live.budgetUnlimited ? null : (live.budgetTokens ?? dag.budget?.tokens ?? null),
    concurrency: capacity.children.dagCap,
    maxTotalNodes: dag.max_total_nodes ?? DEFAULT_USER_MAX_TOTAL_NODES,
    ...(dag.permission ? { permission: dag.permission } : {}),
  }
})

/** Publish L2 for a main session; a child session owns no workflow budget. */
function publishDagMode(input: {
  sessionID: SessionID
  session: Session.Info
  agent: Agent.Info
  user: SessionV1.User
  facts: DagRequestFacts
}) {
  if (SessionRole.isChild(input.session)) return
  DagMode.set(input.sessionID, {
    mode: input.facts.mode,
    budget: input.facts.budget,
    concurrency: input.facts.concurrency,
    maxTotalNodes: input.facts.maxTotalNodes,
    ...(input.facts.unavailable ? { unavailable: input.facts.unavailable } : {}),
    ...(input.agent.name === "plan" ? { plan: true } : {}),
    ...(input.user.hookMode === "noninteractive" ? { noninteractive: true } : {}),
    ...(input.facts.permission ? { permission: input.facts.permission } : {}),
  })
}

/** The DAG turn state one request needs: L1 visibility, L2 publication and whether the L3 note applies. */
const dagTurnState = Effect.fnUntraced(function* (input: {
  deps: PrepareDeps
  sessionID: SessionID
  session: Session.Info
  agent: Agent.Info
  user: SessionV1.User
  model: Provider.Model
  nativePermission: PermissionV1.Ruleset
  configured: ConfigV1.Info
}) {
  const facts = yield* dagRequestFacts({
    sessions: input.deps.sessions,
    config: input.deps.config,
    scheduler: input.deps.scheduler,
    session: input.session,
    agent: input.agent,
    user: input.user,
    model: input.model,
    nativePermission: input.nativePermission,
    configured: input.configured,
  })
  publishDagMode({
    sessionID: input.sessionID,
    session: input.session,
    agent: input.agent,
    user: input.user,
    facts,
  })
  const eligible = facts.advertised && facts.unavailable === undefined && facts.mode === "on"
  return { advertised: facts.advertised, eligible }
})

/**
 * The tool set this step advertises. Native and configured permission rules and
 * the per-message tool switches are applied during resolution.
 */
function resolveTurnTools(
  deps: PrepareDeps,
  input: TurnRequestInput,
  extra: { readonly bypassAgentCheck: boolean; readonly promptOps: TaskPromptOps },
) {
  const { session, toolBatch } = input
  return SessionTools.resolve({
    agent: input.agent,
    session,
    model: input.model,
    user: input.user,
    processor: input.handle,
    bypassAgentCheck: extra.bypassAgentCheck,
    messages: input.messages,
    promptOps: extra.promptOps,
    hooks: deps.settingsHook,
    canDefer:
      SessionRole.isRoot(session) && input.user.hookMode !== "interactive"
        ? (id, signal) => toolBatch.isSingle(id, signal)
        : undefined,
  }).pipe(
    Effect.provideService(Permission.Service, deps.permission),
    Effect.provideService(ToolRegistry.Service, deps.registry),
    Effect.provideService(MCP.Service, deps.mcp),
    Effect.provideService(Truncate.Service, deps.truncate),
  )
}

/**
 * The task call one command-driven subtask makes (#1057, #1357). The call carries no `background` argument: nobody
 * wrote one. What the command declares (`execution`) travels with the call's origin as the command layer of the task
 * tool's resolution, below an argument the caller passes and above what the agent declares. A headless turn or a
 * hook followup is not told apart here: `SessionTools` hands the task tool the turn's mode, and a non-interactive
 * turn runs every task call in the foreground, so the command is delivered inline whatever it or its agent declares.
 */
const resolveSubtaskRun = Effect.fnUntraced(function* (
  commands: Command.Interface,
  task: SessionV1.SubtaskPart,
  lastUser: SessionV1.User,
) {
  const command = task.command === undefined ? undefined : yield* commands.get(task.command)
  const initiator: TaskOrigin["initiator"] = lastUser.hookMode === "noninteractive" ? "agent" : "user"
  return {
    taskInput: {
      prompt: task.prompt,
      description: task.description,
      subagent_type: task.agent,
      command: task.command,
    },
    taskOrigin: {
      initiator,
      ...(initiator === "user" && task.command !== undefined ? { command: task.command } : {}),
      ...(command?.execution === undefined ? {} : { commandExecution: command.execution }),
    } satisfies TaskOrigin,
  }
})

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
    agentMessages,
    reasoningDistillationEnabled,
    queueModelSwitch,
    modelWriteEpoch,
    modelWriteBump,
    modelSwitchContext,
    budgetState,
    dropPendingBudget,
    hookQuestions,
    commands,
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
    if (SessionRole.isChild(input.session)) return
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
    const { taskInput, taskOrigin } = yield* resolveSubtaskRun(commands, task, lastUser)
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
        input: taskInput,
        time: { start: Date.now() },
      },
    })
    const taskArgs = taskInput
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
      taskOrigin,
      hooks: settingsHook,
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
                metadata: endedMetadata(part.state, "aborted"),
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
      part = yield* sessions.updatePart({
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
          metadata: endedMetadata(part.state, classifyToolError(error)),
          input: part.state.input,
        },
      } satisfies SessionV1.ToolPart)
    }

    const stopped = hookStopped(part, error)
    if (task.command && !stopped) yield* appendTaskSummaryPrompt({ sessions, sessionID, lastUser })
    return { stopped }
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
      .findMessage(sessionID, isModelSourceMessage)
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
    const agentName = MessageV2.latestUser(history)?.info.agent ?? current?.agent
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
    persistAdmission?: Effect.Effect<void, unknown>,
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

    const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
      ...part,
      id: part.id ? PartID.make(part.id) : PartID.ascending(),
    })

    const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
      "SessionPrompt.resolveUserPart",
    )(function* (part) {
      if (part.type === "file") {
        if (part.source?.type === "resource") {
          return yield* resolveMcpResource({
            mcp,
            messageID: info.id,
            sessionID: input.sessionID,
            clientName: part.source.clientName,
            uri: part.source.uri,
            part,
          })
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

    const persistMessages = Effect.gen(function* () {
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
    })
    // Preparation and hook callbacks stay outside the write reservation.
    // Internal wakes commit their transcript receipt and reporting mark together.
    // A fallible ledger commit keeps its failure typed so `SessionInbox.submit`
    // can re-read the ledger and classify a concurrent duplicate; the
    // model-baseline-only reservation keeps its historical defect-on-failure.
    const reserved = (): Effect.Effect<void, AdmissionPersistFailed> =>
      persistAdmission
        ? db.transaction(() => persistMessages.pipe(Effect.andThen(persistAdmission)), { behavior: "immediate" }).pipe(
            Effect.mapError((cause) => new AdmissionPersistFailed({ cause: String(cause) })),
          )
        : modelBaseline
          ? db.transaction(() => persistMessages, { behavior: "immediate" }).pipe(Effect.orDie)
          : persistMessages
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
      identity,
      agentSnapshot,
      prepareStage,
      runtimeContexts: runtimeContextBySession,
      onStructured,
    } = input
    let msgs = input.messages
    const lastUserMsg = MessageV2.latestUser(msgs)
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
      : yield* prepareStage("tools", resolveTurnTools(deps, input, { bypassAgentCheck, promptOps }))

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

    const configured = yield* config.get()
    const dagTurn = yield* dagTurnState({
      deps, sessionID, session, agent, user: lastUser, model, nativePermission, configured,
    })
    // The todo, plan and DAG notes join the user message that opens a turn, once per change of their state (#1456).
    msgs = yield* SessionReminders.settle({
      messages: msgs, lastUser, agent, tools: enabledTools, dagEligible: dagTurn.eligible,
    }).pipe(Effect.provideService(RuntimeFlags.Service, flags), Effect.provideService(Session.Service, sessions))

    // Permission.ask evaluates native rules before configured rules. Use
    // that same split for everything advertised to the model.
    const [skills, env, languageDocs, instructions, mcpInstructions, goalDocs, hooksDocs, memoryDocs, modelMsgs] =
      yield* Effect.all(
        [
          sys.skills(agent, session.permission, nativePermission),
          sys.environment(model),
          sys.language(configured.language),
          instruction.system({ sessionID, turn: lastUser.id }).pipe(Effect.orDie),
          sys.mcp(agent, session.permission, nativePermission),
          sys.goal(sessionID),
          sys.hooks(),
          prepareStage(
            "memory",
            sys.memory({
              sessionID,
              messages: msgs,
              main: SessionRole.isRoot(session),
              lane: SessionRole.isChild(session) ? "child" : "interactive",
            }),
          ),
          MessageV2.toModelMessagesEffect(msgs, model, {
            reasoningDistillationEnabled: yield* reasoningDistillationEnabled(model),
          }),
        ],
        { concurrency: "unbounded" },
      )
    const sections = SystemSections.assemble({
      env, languageDocs, instructions, mcpInstructions, skills,
      goal: goalDocs.system, hooksDocs, dag: dagTurn.advertised,
    })
    // Goal, memory, the environment and the date are state, not system text:
    // the cached prefix must not change when the directory or the day changes.
    // Owner-contributed slots (for example DAG mode, published by `dagTurnState`)
    // follow them.
    const ctx = yield* InstanceState.context
    const runtimeState = RuntimeSlots.state({
      goal: goalDocs.context,
      memory: memoryDocs,
      environment: { directory: ctx.directory, root: ctx.root, git: ctx.project.vcs === "git" },
      now: yield* DateTime.nowAsDate,
      custom: yield* ChildSlot.custom(deps.children, input.sessionID),
    })
    const runtimeEvents: string[] = []
    if (structuredFormat?.type === "json_schema")
      SystemSections.append(sections, "structured_output", STRUCTURED_OUTPUT_SYSTEM_PROMPT)
    const processInput: LLM.StreamInput = {
      user: lastUser,
      agent,
      permission: session.permission,
      nativePermission,
      sessionID,
      parentSessionID: session.parentID,
      system: sections.system,
      systemLabels: sections.labels,
      messages: [...modelMsgs, ...finalStepMessages(input)],
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
    }
    if (agentMessages && agentSnapshot) yield* associateAgentSnapshot({ agentMessages, identity, agentSnapshot, msgs })
    runtimeEvents.push(...(yield* modelSwitchContext(sessionID, model.api.id)).map((text) => hookBlock([text])))
    // Async hooks contribute at the next model boundary without manufacturing a user turn.
    if (settingsHook?.drainAsync) {
      const queued = yield* settingsHook.drainAsync(sessionID)
      runtimeEvents.push(...queued.additionalContexts.map((text) => hookBlock([text])))
    }
    // Runtime context goes into the history, before any assistant prefill, so the system prefix stays
    // constant and each request extends the previous one.
    const runtime = RuntimeContext.place({
      ledger: runtimeContextBySession.get(sessionID) ?? [],
      messages: modelMsgs,
      state: runtimeState,
      events: runtimeEvents,
      afterTool: ProviderProfile.profileOf(model).userAfterToolResult === "allow",
    })
    if (runtime.ledger.length > 0) runtimeContextBySession.set(sessionID, runtime.ledger)
    else runtimeContextBySession.delete(sessionID)
    processInput.messages.splice(0, modelMsgs.length, ...runtime.messages)
    SystemSections.append(sections, "one_shot_event", ...runtime.unplaced)
    // The cached fragment is only valid for the resolved tool set; the
    // structured-output tool is added afterwards, so that request
    // re-serializes instead of reusing a stale fragment (Issue #1022, PR5).
    const toolsJson =
      legacyToolsDisabled || lastUser.format?.type === "json_schema"
        ? undefined
        : SessionTools.serializedFragment(processInput.tools)
    yield* Overhead.record(input, { processInput, toolsJson, ledger: runtime.ledger })
    rememberRequestPrefix(input, { directory: ctx.directory, processInput, toolsJson })
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
