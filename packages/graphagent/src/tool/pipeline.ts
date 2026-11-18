// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { JSONSchema7 } from "@ai-sdk/provider"
import { type Tool as AITool, jsonSchema, tool, type ToolExecutionOptions } from "ai"
import { Cause, Effect, Exit, type Schema } from "effect"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"
import { addCorrections, correctionsOf } from "@graphagent/core/session/outcome"
import { Logging } from "@graphagent/core/observability/logging"
import type { Agent } from "@/agent/agent"
import type { TaskOrigin } from "@/tool/task"
import type { EffectBridge } from "@/effect/bridge"
import { SessionContext } from "@/effect/session-context"
import { applyPreHookDecision, classifyPermissionAsk, withoutUnusableDefer } from "@/hook/pre-hook-decision"
import { hookQuestionAnswers } from "@/hook/question-answers"
import { SettingsHook, type TriggerResult } from "@/hook"
import { builtinToolOutput, mcpToolOutput, toolOutputReplacement } from "@/hook/tool-output"
import { toolInputValidator } from "@/hook/tool-input"
import { hookBlock, withHookFeedback, withHookFailure, withPreContext } from "@/hook/trigger-result"
import { Permission } from "@/permission"
import { confirmPermissionInput, executeWithPermissionInput, HookPermissionInterrupt } from "@/permission/hook-control"
import type { Provider } from "@/provider/provider"
import type { SessionProcessor } from "@/session/processor"
import { PartID } from "@/session/schema"
import type { Session } from "@/session/session"
import { MCP } from "@/mcp"
import { McpContent } from "@/mcp/content"
import type { Truncate } from "@/tool/truncate"
import { ToolJsonSchema } from "@/tool/json-schema"
import { MemorySearch } from "@/tool/memory-search"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import type { ToolEntry } from "./registry"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"

export type { ToolEntry }

export { MCP_RESOURCE_TOOLS, MCP_RESOURCE_ORDER, type McpResourceOp } from "./mcp-resource"
import type { McpResourceOp } from "./mcp-resource"

const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const { base64Size, formatBytes } = McpContent
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

// Verified ask-before-side-effect built-ins. Third-party definitions are never restarted.
const PERMISSION_RESTART_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "grep",
  "glob",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "lsp",
  "workflow",
])
// Child sessions (a task subagent, a DAG node) never own the human dialog:
// `question` and `plan_exit` are root-only even for an agent profile that
// allows them (the `plan` profile does). A node asks its parent through
// `agent.send`; a task child states what it needs in its final answer.
const ROOT_ONLY_TOOLS = new Set([
  MemorySearch.MemorySearchTool.id,
  TaskTool.id,
  "workflow",
  "goal",
  "watch_pr",
  "question",
  "plan_exit",
])
export { ROOT_ONLY_TOOLS }

/** Tool-result metadata marking a hook `continue:false`; the processor ends the turn on it. */
export const hookStopMetadata = (result: TriggerResult) => ({
  hookStopped: true,
  stopReason: result.stopReason ?? "Hook requested stop",
})

export function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

// Cancel hooks independently so tools that finalize partial output on abort can
// still persist that output through completeToolCall.
export function withHookCancellation(hooks: SettingsHook.Interface | undefined, signal: AbortSignal | undefined) {
  if (!hooks || !signal) return hooks
  const bounded = (effect: Effect.Effect<TriggerResult>): Effect.Effect<TriggerResult> => {
    const empty = Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })
    if (signal.aborted) return empty
    return Effect.raceFirst(
      effect,
      Effect.callback<TriggerResult>((resume) => {
        const abort = () => resume(empty)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        return Effect.sync(() => signal.removeEventListener("abort", abort))
      }),
    )
  }
  return {
    ...hooks,
    trigger: (payload: SettingsHook.HookPayload, ctx: SettingsHook.TriggerContext) =>
      bounded(hooks.trigger(payload, ctx)),
    ...(hooks.hookCall
      ? {
          hookCall: (payload: SettingsHook.HookPayload, ctx: SettingsHook.ToolHookContext) =>
            bounded(hooks.hookCall!(payload, ctx)),
        }
      : {}),
  } satisfies SettingsHook.Interface
}

/**
 * Single entry for tool-lifecycle hooks. Prefer the engine's narrow `hookCall`
 * (session plus tool/MCP identity; transcript and environment stay lazy) and
 * fall back to `trigger` for partial test mocks that only implement it.
 */
export function callHook(
  hooks: SettingsHook.Interface,
  payload: SettingsHook.HookPayload,
  ctx: SettingsHook.ToolHookContext,
): Effect.Effect<TriggerResult> {
  return hooks.hookCall ? hooks.hookCall(payload, ctx) : hooks.trigger(payload, ctx)
}

export type DirectToolContext = Omit<Tool.Context, "ask"> & {
  ask(input: Parameters<Tool.Context["ask"]>[0]): Effect.Effect<void, unknown>
}

export type DirectTool = Omit<Tool.Def, "execute"> & {
  execute(args: any, context: DirectToolContext): Effect.Effect<Tool.ExecuteResult, unknown>
}

export type ToolSelection =
  { directTool: DirectTool; model?: Provider.Model } | { directTool?: undefined; model: Provider.Model }

export type WrapInput = ToolSelection & {
  agent: Agent.Info
  session: Session.Info
  /**
   * The latest user message: its per-message tool switches, and the mode of the turn it starts. A non-interactive
   * turn reaches the task tool as `extra.noninteractive` (#1357).
   */
  user?: Pick<SessionV1.User, "tools" | "hookMode">
  /** Session rules; defaults to `session.permission`. */
  permission?: PermissionV1.Ruleset
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "previewToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  /** Who drives the task calls of this step; only a command-driven subtask sets it (#1057). */
  taskOrigin?: TaskOrigin
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  hooks?: SettingsHook.Interface
  /** Host decides interactive/batch eligibility before any tool executes. */
  canDefer?: (callID: string, signal?: AbortSignal) => boolean | Promise<boolean>
}

export type RawContextFn = (
  args: Record<string, unknown>,
  options: ToolExecutionOptions,
  confirmed?: boolean,
  recorded?: Record<string, unknown>,
  toolName?: string,
  hookAllowed?: boolean,
) => DirectToolContext

export type ContextFn = (...args: Parameters<RawContextFn>) => Tool.Context

export interface Deps {
  input: WrapInput
  run: EffectBridge.Shape
  permission: Permission.Interface
  hooks: SettingsHook.Interface | undefined
  agentService: Agent.Interface | undefined
  questionHookAnswers: WeakMap<ToolExecutionOptions, ReadonlyArray<ReadonlyArray<string>>>
  hookContext: (toolName?: string) => Effect.Effect<Omit<SettingsHook.ToolHookContext, "sessionID">>
  /**
   * A PreToolUse hook denied this tool's call (a deny verdict, exit 2, or a guard that failed closed). Records
   * it on the node's safety evidence when the session is a DAG node; a refused hook confirmation is not one.
   */
  hookDenied: (toolName: string, reason: string) => Effect.Effect<void>
  reportInterrupt: (toolName: string, args: unknown, toolUseID: string) => Effect.Effect<void>
  recordInput: (callID: string, args: Record<string, unknown>) => Effect.Effect<void>
  rawContext: RawContextFn
  context: ContextFn
  configuredPermission: PermissionV1.Ruleset
  /** Resolved entries; each source kind is executed by exactly one helper below. */
  entries: ReadonlyArray<ToolEntry>
  truncate: Truncate.Interface
  resourceHookState: WeakMap<
    ToolExecutionOptions,
    { confirmed: boolean; allowed: boolean; name: string; original: Record<string, unknown> }
  >
}

export type BuiltinEntry = Extract<ToolEntry, { source: { kind: "builtin" } }>
export type DirectShellEntry = Extract<ToolEntry, { source: { kind: "direct-shell" } }>
export type McpEntry = Extract<ToolEntry, { source: { kind: "mcp" } }>
export type McpResourceEntry = Extract<ToolEntry, { source: { kind: "mcp-resource" } }>

export function isBuiltinEntry(entry: ToolEntry): entry is BuiltinEntry {
  return entry.source.kind === "builtin"
}

export function isDirectShellEntry(entry: ToolEntry): entry is DirectShellEntry {
  return entry.source.kind === "direct-shell"
}

export function isMcpEntry(entry: ToolEntry): entry is McpEntry {
  return entry.source.kind === "mcp"
}

/**
 * A PostToolUse hook may replace the metadata of a result, but not the corrections the harness made before
 * the hook ran: they are the harness's own account of the call, kept for the statistics.
 */
function keepCorrections<M extends Record<string, unknown>>(replaced: M, original: unknown) {
  return addCorrections(replaced, ...correctionsOf(original))
}

/**
 * The failure of a tool with its text bounded (#1446). The text of an error is model-visible like an output, and a
 * tool can fail with a text of any size (an MCP server's error body, a command's stderr). Past the output cap it
 * is cut, the whole text is saved, and the model is told where, so the error cannot take the window as an
 * unbounded output could. What the user decided (a refusal) and an interruption are not text for the model and
 * pass through, and so does a text that fits.
 */
export function boundErrorCause(
  truncate: Truncate.Interface,
  agent: Agent.Info,
  cause: Cause.Cause<unknown>,
): Effect.Effect<never, unknown> {
  if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
  const error = Cause.squash(cause)
  if (
    error instanceof PermissionV1.DeniedError ||
    error instanceof PermissionV1.RejectedError ||
    error instanceof PermissionV1.CorrectedError
  )
    return Effect.failCause(cause)
  return truncate.output(errorMessage(error), {}, agent).pipe(
    Effect.flatMap((bounded) => {
      if (!bounded.truncated) return Effect.failCause(cause)
      const failure = new Error(bounded.content, { cause: error })
      return Cause.hasDies(cause) ? Effect.die(failure) : Effect.fail(failure)
    }),
  )
}

export const builtinTools = Effect.fn("ToolPipeline.builtinTools")(function* (
  deps: Deps,
  tools: Record<string, AITool>,
) {
  const {
    input,
    run,
    hooks,
    permission,
    questionHookAnswers,
    context,
    rawContext,
    recordInput,
    reportInterrupt,
    hookContext,
    hookDenied,
    entries,
    truncate,
  } = deps

  for (const entry of entries) {
    if (!isBuiltinEntry(entry) && !isDirectShellEntry(entry)) continue
    const item = entry.definition
    const toolSchema = item.jsonSchema ?? ToolJsonSchema.fromSchema(item.parameters as Schema.Top)
    const validateInput = toolInputValidator(toolSchema)
    tools[entry.id] = tool({
      description: entry.description,
      inputSchema: jsonSchema(entry.jsonSchema),
      execute(args, options) {
        const settingsHook = withHookCancellation(hooks, options.abortSignal)
        // PreToolUse context also rides on a failure of the call it governed.
        let preContexts: string[] = []
        let executionPending = false
        return run.promise(
          // Set the active session for server-initiated MCP reverse requests
          // (elicitation) so the handler can route the Question to this session.
          SessionContext.run(context(args, options).sessionID, () =>
            Effect.gen(function* () {
              const originalArgs = toRecord(args)
              let ctx = context(args, options, false, originalArgs, item.id)
              let hookConfirmed = false
              let hookAllowed = false
              // SettingsHook PreToolUse
              if (settingsHook) {
                let preResult = yield* callHook(
                  settingsHook,
                  { event: "PreToolUse", toolName: item.id, toolInput: toRecord(args), toolUseID: ctx.callID },
                  { ...(yield* hookContext()), sessionID: ctx.sessionID },
                ).pipe(
                  Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                )
                yield* SettingsHook.landSystemMessages(preResult, { sessionID: ctx.sessionID })
                if (
                  preResult.permissionDecision === "defer" &&
                  !preResult.preventContinuation &&
                  !(yield* Effect.promise(() =>
                    Promise.resolve(input.canDefer?.(options.toolCallId, options.abortSignal) ?? false),
                  ))
                ) {
                  yield* Logging.backgroundDebug("hook defer ignored", { reason: "interactive-or-multiple-tool-call" })
                  preResult = withoutUnusableDefer(preResult)
                }
                let decision = applyPreHookDecision(toRecord(args), preResult)
                if (decision.deferred)
                  return {
                    output: "",
                    attachments: [],
                    metadata: {
                      hookDeferred: true,
                      deferredToolUse: { id: options.toolCallId, name: item.id, input: args },
                    },
                  }
                // A refusal settles as a complete tool result, `title` included. The processor would name a
                // title-less result after its tool, but `handleSubtask` writes `execute`'s result as it is (#1350).
                if (decision.deniedReason) {
                  yield* hookDenied(item.id, decision.deniedReason)
                  return {
                    title: item.id,
                    output: withPreContext(
                      `[Tool denied by hook] ${decision.deniedReason}`,
                      preResult.additionalContexts,
                    ),
                    attachments: [],
                    metadata: { hookDenied: true },
                  } satisfies Tool.ExecuteResult
                }
                if (decision.stopReason) {
                  return {
                    title: item.id,
                    output: `[Hook stopped] ${decision.stopReason}`,
                    attachments: [],
                    metadata: { hookStopped: true, stopReason: decision.stopReason },
                  } satisfies Tool.ExecuteResult
                }
                if (
                  item.id === "question" &&
                  preResult.updatedInput !== undefined &&
                  "answers" in decision.effectiveArgs
                ) {
                  // `answers` is hook-only: it never reaches the tool schema, and only an explicit
                  // allow lets it stand in for the user. Anything else keeps the dialog.
                  const { answers, ...rest } = decision.effectiveArgs
                  decision = { ...decision, effectiveArgs: rest }
                  if (preResult.permissionDecision === "allow") {
                    const supplied = yield* Effect.sync(() => hookQuestionAnswers(rest.questions, answers))
                    questionHookAnswers.set(options, supplied)
                  }
                }
                if (preResult.updatedInput !== undefined)
                  yield* Effect.sync(() => validateInput(decision.effectiveArgs))
                // permissionDecision:"ask" — invoke the confirmation dialog. We call
                // permission.ask directly (NOT the orDie-piped ctx.ask) and classify the
                // outcome: typed rejections become a denied result, while interrupts
                // (session abort mid-dialog) and defects propagate instead of being
                // masked as a denial.
                hookAllowed = preResult.permissionDecision === "allow"
                hookConfirmed = false
                if (preResult.permissionDecision === "ask") {
                  const askReason = preResult.permissionDecisionReason
                  // force: a hook "ask" always prompts — earlier "always" approvals cannot
                  // skip it. The ruleset stays empty: this request carries no real pattern,
                  // so pattern-scoped allows (e.g. `edit: {"*":"deny","plans/*.md":"allow"}`)
                  // must not be pre-empted by a wildcard deny. The tool's own ctx.ask with
                  // the real patterns still enforces deny rules afterwards. The user confirms
                  // the input the tool will actually run with, including any updatedInput.
                  const verdict = yield* confirmPermissionInput(
                    decision.effectiveArgs,
                    (effectiveArgs) =>
                      permission.ask(
                        {
                          permission: item.id,
                          sessionID: ctx.sessionID,
                          patterns: [item.id],
                          always: [],
                          metadata: {
                            hookAsk: true,
                            input: effectiveArgs,
                            ...(askReason ? { reason: askReason } : {}),
                          },
                          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                          ruleset: [],
                        },
                        { force: true, toolInput: effectiveArgs },
                      ),
                    validateInput,
                  ).pipe(Effect.exit)
                  const outcome = classifyPermissionAsk(verdict)
                  if (outcome !== "approved" && outcome !== "denied")
                    return yield* Effect.failCause(outcome.propagate as never)
                  if (outcome === "denied") {
                    const reason = askReason ?? "Denied by user in hook confirmation"
                    return {
                      title: item.id,
                      output: withPreContext(`[Tool denied by hook] ${reason}`, preResult.additionalContexts),
                      attachments: [],
                      metadata: { hookDenied: true },
                    } satisfies Tool.ExecuteResult
                  }
                  if (Exit.isSuccess(verdict)) decision = { ...decision, effectiveArgs: verdict.value.input }
                  hookConfirmed = true
                }
                preContexts = preResult.additionalContexts ?? []
                // The tool's own permission checks see the effective input and the confirmation.
                ctx = context(decision.effectiveArgs, options, hookConfirmed, decision.effectiveArgs, item.id)
                // Execute the complete replacement, not a patch of the model input.
                args = decision.effectiveArgs
              }
              if (options.abortSignal?.aborted) return yield* Effect.interrupt
              executionPending = true
              const executed = yield* executeWithPermissionInput(
                toRecord(args),
                (next) => {
                  args = next
                  ctx = context(next, options, hookConfirmed, next, item.id, hookAllowed)
                  return recordInput(options.toolCallId, next).pipe(
                    Effect.andThen(
                      Effect.suspend((): Effect.Effect<Tool.ExecuteResult, unknown> =>
                        isDirectShellEntry(entry)
                          ? entry.definition.execute(
                              next,
                              rawContext(next, options, hookConfirmed, next, item.id, hookAllowed),
                            )
                          : entry.definition.execute(next, ctx),
                      ),
                    ),
                  )
                },
                {
                  canRestart: entry.source.kind === "builtin" && PERMISSION_RESTART_TOOLS.has(item.id),
                  validate: (next) => {
                    validateInput(next)
                  },
                },
              ).pipe(Effect.onInterrupt(() => reportInterrupt(item.id, args, options.toolCallId)))
              executionPending = false
              if (options.abortSignal?.aborted)
                yield* reportInterrupt(item.id, args, options.toolCallId).pipe(Effect.uninterruptible)
              const result = executed.value
              args = executed.input
              const output = {
                ...result,
                attachments: result.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              // The shell tool registers a successful `gh pr create` itself (#1071),
              // before a PostToolUse hook can replace either the command or its
              // result; the generic pipeline carries no feature import for it.
              // PreToolUse feedback is attached after PostToolUse has seen and possibly replaced the
              // native result, so Post hooks never receive earlier hook text and a replacement keeps it.
              const preLines = preContexts.filter((line): line is string => Boolean(line))
              // SettingsHook PostToolUse; a completed failure (nonzero shell
              // exit) fires the reference's PostToolUseFailure instead while
              // keeping the same model-facing result and feedback handling.
              if (settingsHook) {
                const hookFailure = output.hookFailure
                const postResult = yield* callHook(
                  settingsHook,
                  hookFailure === undefined
                    ? {
                        event: "PostToolUse",
                        toolName: item.id,
                        toolInput: toRecord(args),
                        // V2 passes the tool's structured output; the model-facing
                        // text lives in the transcript, not in tool_response.
                        toolResponse: output.metadata,
                        toolOutput: output,
                        toolUseID: ctx.callID,
                      }
                    : {
                        event: "PostToolUseFailure",
                        toolName: item.id,
                        toolInput: toRecord(args),
                        error: hookFailure,
                        toolUseID: ctx.callID,
                      },
                  { ...(yield* hookContext()), sessionID: ctx.sessionID },
                ).pipe(
                  Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                )
                yield* SettingsHook.landSystemMessages(postResult, { sessionID: ctx.sessionID })
                const replacement = toolOutputReplacement(postResult)
                const rewritten = replacement.present ? builtinToolOutput(replacement.value) : undefined
                if (rewritten) {
                  output.title = rewritten.title
                  output.output = rewritten.output
                  output.metadata = keepCorrections(rewritten.metadata, output.metadata) as typeof output.metadata
                  output.attachments = rewritten.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })) as typeof output.attachments
                }
                output.output = withHookFeedback(output.output ?? "", postResult)
                // continue:false ends the agent turn once this result is recorded (processor → "stop").
                if (postResult.preventContinuation)
                  output.metadata = {
                    ...(isRecord(output.metadata) ? output.metadata : {}),
                    ...hookStopMetadata(postResult),
                  }
              }
              if (preLines.length) {
                output.output = `${hookBlock(preLines)}\n\n${output.output ?? ""}`
              }
              if (options.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(options.toolCallId, output)
              }
              return output
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause)
                  if (executionPending && options.abortSignal?.aborted) {
                    yield* reportInterrupt(item.id, args, options.toolCallId).pipe(Effect.uninterruptible)
                    return yield* Effect.failCause(cause)
                  }
                  const error = Cause.squash(cause)
                  if (
                    error instanceof PermissionV1.DeniedError ||
                    error instanceof PermissionV1.RejectedError ||
                    error instanceof PermissionV1.CorrectedError
                  )
                    return yield* Effect.failCause(cause)
                  if (error instanceof HookPermissionInterrupt)
                    return {
                      title: "",
                      output: error.message,
                      attachments: [],
                      metadata: { hookStopped: true, stopReason: error.message },
                    }
                  if (!executionPending) return yield* Effect.failCause(cause)
                  // SettingsHook PostToolUseFailure
                  if (settingsHook) {
                    const failResult = yield* callHook(
                      settingsHook,
                      {
                        event: "PostToolUseFailure",
                        toolName: item.id,
                        toolInput: toRecord(args),
                        error: String(error),
                        toolUseID: options.toolCallId,
                      },
                      { ...(yield* hookContext()), sessionID: input.session.id },
                    ).pipe(
                      Effect.catch(() =>
                        Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult),
                      ),
                    )
                    yield* SettingsHook.landSystemMessages(failResult, { sessionID: input.session.id })
                    const failure = withHookFailure(error, failResult, preContexts)
                    if (failure !== error)
                      return yield* Cause.hasDies(cause) ? Effect.die(failure) : Effect.fail(failure)
                  }
                  return yield* Effect.failCause(cause)
                }),
              ),
              Effect.catchCause((cause) => boundErrorCause(truncate, input.agent, cause)),
            ),
          ),
        )
      },
    })
  }
})

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

type McpAttachment = Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">

/**
 * One embedded resource of an MCP result: its text goes to `text`, its blob becomes a file when the type and the size
 * allow it. Returns whether the blob was left out, in which case a line in `text` says so.
 */
function mcpEmbeddedResource(resource: Record<string, unknown>, text: string[], attachments: McpAttachment[]) {
  if (typeof resource.text === "string" && resource.text) text.push(resource.text)
  if (typeof resource.blob !== "string" || !resource.blob) return false
  const uri = typeof resource.uri === "string" ? resource.uri : ""
  const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream"
  const size = base64Size(resource.blob)
  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
    text.push(
      `[Binary MCP resource omitted: ${uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
    )
    return true
  }
  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
    text.push(
      `[Binary MCP resource omitted: ${uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
    )
    return true
  }
  attachments.push({ type: "file", mime, url: `data:${mime};base64,${resource.blob}`, filename: uri })
  return false
}

/**
 * Splits the content of an MCP result into the text the model reads and the files it receives. What cannot be passed
 * on is replaced by a line that says so (#1447); `droppedContent` and `droppedAttachment` report that it happened,
 * for the result's `metadata.corrections`.
 */
function mcpContentParts(content: unknown, server: string) {
  const text: string[] = []
  const attachments: McpAttachment[] = []
  let droppedContent = false
  let droppedAttachment = false
  for (const item of Array.isArray(content) ? content : []) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      text.push(item.text)
    } else if (
      isRecord(item) &&
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      typeof item.data === "string"
    ) {
      attachments.push({ type: "file", mime: item.mimeType, url: `data:${item.mimeType};base64,${item.data}` })
    } else if (isRecord(item) && item.type === "resource" && isRecord(item.resource)) {
      if (mcpEmbeddedResource(item.resource, text, attachments)) droppedAttachment = true
    } else {
      text.push(McpContent.omitted(item, server))
      droppedContent = true
    }
  }
  return { text, attachments, droppedContent, droppedAttachment }
}

/**
 * The metadata of an MCP result: the server's own, whether the text was cut and where the whole of it is saved, and
 * what was left out of the result (#1447).
 */
function mcpResultMetadata(
  base: Record<string, unknown> | undefined,
  truncated: Truncate.Result,
  parts: { droppedContent: boolean; droppedAttachment: boolean },
): Record<string, unknown> {
  return addCorrections(
    {
      ...base,
      truncated: truncated.truncated,
      ...(truncated.truncated && truncated.outputPath !== undefined && { outputPath: truncated.outputPath }),
    },
    ...(parts.droppedContent ? ["mcp_content_dropped"] : []),
    ...(parts.droppedAttachment ? ["attachment_dropped"] : []),
  )
}

export const mcpResourceTools = Effect.fn("ToolPipeline.mcpResourceTools")(function* (
  deps: Deps,
  tools: Record<string, AITool>,
) {
  const {
    input,
    run,
    hooks,
    permission,
    context,
    truncate,
    reportInterrupt,
    hookContext,
    hookDenied,
    resourceHookState,
    entries,
  } = deps
  const mcp = yield* MCP.Service

  const resourceEntries = entries.filter(
    (entry): entry is Extract<ToolEntry, { source: { kind: "mcp-resource" } }> => entry.source.kind === "mcp-resource",
  )
  const resourceEntry = (op: McpResourceOp) =>
    resourceEntries.find((entry) => entry.source.kind === "mcp-resource" && entry.source.op === op)

  const listEntry = resourceEntry("list")
  if (listEntry) {
    tools[listEntry.id] = tool({
      description: listEntry.description,
      inputSchema: jsonSchema(listEntry.jsonSchema),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const listTemplatesEntry = resourceEntry("listTemplates")
  if (listTemplatesEntry) {
    tools[listTemplatesEntry.id] = tool({
      description: listTemplatesEntry.description,
      inputSchema: jsonSchema(listTemplatesEntry.jsonSchema),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const readEntry = resourceEntry("read")
  if (readEntry) {
    tools[readEntry.id] = tool({
      description: readEntry.description,
      inputSchema: jsonSchema(readEntry.jsonSchema),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  // Resource helpers are GraphAgent-owned tools too: the same settings hooks
  // must govern them, not only server-provided MCP callTool definitions.
  for (const entry of resourceEntries) {
    const name = entry.id
    const item = tools[name]
    const execute = item?.execute
    if (!item || !execute) continue
    const validateInput = toolInputValidator(entry.jsonSchema)
    item.execute = (original, options) => {
      let failureContexts: string[] = []
      let executionPending = false
      let args = toRecord(original)
      return run.promise(
        Effect.gen(function* () {
          const opts = { ...options }
          const settingsHook = withHookCancellation(hooks, opts.abortSignal)
          let confirmed = false
          let allowed = false
          let pre: TriggerResult = { additionalContexts: [], systemMessages: [] }
          if (settingsHook) {
            pre = yield* callHook(
              settingsHook,
              { event: "PreToolUse", toolName: name, toolInput: args, toolUseID: opts.toolCallId },
              {
                ...(yield* hookContext()),
                sessionID: input.session.id,
              },
            ).pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            if (
              pre.permissionDecision === "defer" &&
              !pre.preventContinuation &&
              !(yield* Effect.promise(() =>
                Promise.resolve(input.canDefer?.(opts.toolCallId, opts.abortSignal) ?? false),
              ))
            )
              pre = withoutUnusableDefer(pre)
            yield* SettingsHook.landSystemMessages(pre, { sessionID: input.session.id })
            let decision = applyPreHookDecision(args, pre)
            if (decision.deferred)
              return {
                title: "",
                output: "",
                metadata: {
                  hookDeferred: true,
                  deferredToolUse: { id: opts.toolCallId, name, input: original },
                },
              }
            if (decision.deniedReason) {
              yield* hookDenied(name, decision.deniedReason)
              return {
                title: "",
                output: withPreContext(`[Tool denied by hook] ${decision.deniedReason}`, pre.additionalContexts),
                metadata: { hookDenied: true },
              }
            }
            if (decision.stopReason)
              return {
                title: "",
                output: `[Hook stopped] ${decision.stopReason}`,
                metadata: { hookStopped: true, stopReason: decision.stopReason },
              }
            args = decision.effectiveArgs
            if (pre.updatedInput !== undefined) yield* Effect.sync(() => validateInput(args))
            allowed = pre.permissionDecision === "allow"
            if (pre.permissionDecision === "ask") {
              const ask = yield* confirmPermissionInput(
                args,
                (effectiveArgs) =>
                  permission.ask(
                    {
                      sessionID: input.session.id,
                      permission: name,
                      patterns: ["*"],
                      always: [],
                      metadata: {
                        toolInput: effectiveArgs,
                        ...(pre.permissionDecisionReason ? { reason: pre.permissionDecisionReason } : {}),
                      },
                      ruleset: [],
                      tool: { messageID: input.processor.message.id, callID: opts.toolCallId },
                    },
                    {
                      force: true,
                      toolInput: effectiveArgs,
                      toolName: name,
                    },
                  ),
                validateInput,
              ).pipe(Effect.exit)
              const outcome = classifyPermissionAsk(ask)
              if (typeof outcome === "object") return yield* Effect.failCause(outcome.propagate)
              if (outcome === "denied")
                return {
                  title: "",
                  output: withPreContext("[Tool denied by hook] User denied permission", pre.additionalContexts),
                  metadata: { hookDenied: true },
                }
              if (Exit.isSuccess(ask)) args = ask.value.input
              confirmed = true
            }
            failureContexts = pre.additionalContexts
          }
          executionPending = true
          const result = yield* executeWithPermissionInput(
            args,
            (next) => {
              args = next
              resourceHookState.set(opts, { confirmed, allowed, name, original: toRecord(original) })
              // The three resource executors ask read permission before any MCP request.
              // The PreToolUse hook runs once above, outside the permission restart boundary.
              return Effect.promise(() => Promise.resolve(execute(next, opts)))
            },
            {
              canRestart: true,
              validate: (next) => {
                validateInput(next)
              },
            },
          ).pipe(Effect.onInterrupt(() => reportInterrupt(name, args, opts.toolCallId)))
          executionPending = false
          if (opts.abortSignal?.aborted)
            yield* reportInterrupt(name, args, opts.toolCallId).pipe(Effect.uninterruptible)
          const output = builtinToolOutput(result.value)
          if (!output) return yield* Effect.die(new Error("Invalid built-in MCP resource output"))
          args = result.input
          const preLines = pre.additionalContexts
          if (settingsHook) {
            const post = yield* callHook(
              settingsHook,
              {
                event: "PostToolUse",
                toolName: name,
                toolInput: args,
                toolUseID: opts.toolCallId,
                toolResponse: output.metadata,
                toolOutput: output,
              },
              { ...(yield* hookContext()), sessionID: input.session.id },
            ).pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            yield* SettingsHook.landSystemMessages(post, { sessionID: input.session.id })
            const replacement = toolOutputReplacement(post)
            const rewritten = replacement.present ? builtinToolOutput(replacement.value) : undefined
            if (rewritten) {
              output.title = rewritten.title
              output.output = rewritten.output
              output.metadata = rewritten.metadata
              output.attachments = rewritten.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: input.session.id,
                messageID: input.processor.message.id,
              }))
            }
            output.output = withHookFeedback(output.output, post)
            if (post.preventContinuation) output.metadata = { ...output.metadata, ...hookStopMetadata(post) }
          }
          if (preLines.length) output.output = `${hookBlock(preLines)}\n\n${output.output}`
          return output
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause)
              if (executionPending && options.abortSignal?.aborted) {
                yield* reportInterrupt(name, args, options.toolCallId).pipe(Effect.uninterruptible)
                return yield* Effect.failCause(cause)
              }
              const error = Cause.squash(cause)
              if (
                error instanceof PermissionV1.DeniedError ||
                error instanceof PermissionV1.RejectedError ||
                error instanceof PermissionV1.CorrectedError
              )
                return yield* Effect.failCause(cause)
              if (error instanceof HookPermissionInterrupt)
                return { title: "", output: error.message, metadata: { hookStopped: true, stopReason: error.message } }
              if (!executionPending) return yield* Effect.failCause(cause)
              const settingsHook = withHookCancellation(hooks, options.abortSignal)
              if (settingsHook) {
                const failure = yield* callHook(
                  settingsHook,
                  {
                    event: "PostToolUseFailure",
                    toolName: name,
                    toolInput: args,
                    toolUseID: options.toolCallId,
                    error: String(error),
                  },
                  { ...(yield* hookContext()), sessionID: input.session.id },
                ).pipe(
                  Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                )
                yield* SettingsHook.landSystemMessages(failure, { sessionID: input.session.id })
                const withFeedback = withHookFailure(error, failure, failureContexts)
                if (withFeedback !== error)
                  return yield* Cause.hasDies(cause) ? Effect.die(withFeedback) : Effect.fail(withFeedback)
              }
              return yield* Effect.failCause(cause)
            }),
          ),
          Effect.catchCause((cause) => boundErrorCause(truncate, input.agent, cause)),
        ),
      )
    }
  }
})

/**
 * An MCP server tool refused by a PreToolUse hook (#1473). It has the shape
 * of a native refusal, a text `output` and `metadata.hookDenied`, plus the `content`
 * an MCP result carries, so the stored result is the plain text the model reads
 * and `tool_outcome` books the call as denied.
 */
const mcpHookDenied = (text: string) => ({
  title: "",
  output: text,
  metadata: { hookDenied: true },
  content: [{ type: "text" as const, text }],
})

export const mcpServerTools = Effect.fn("ToolPipeline.mcpServerTools")(function* (
  deps: Deps,
  tools: Record<string, AITool>,
) {
  const { input, run, hooks, permission, context, truncate, reportInterrupt, hookContext, hookDenied, entries } = deps

  for (const entry of entries) {
    if (!isMcpEntry(entry)) continue
    const key = entry.id
    const item = entry.tool
    const execute = item.execute
    if (!execute) continue

    const validateInput = toolInputValidator(entry.jsonSchema)
    item.inputSchema = jsonSchema(entry.jsonSchema)
    item.execute = (args, opts) => {
      const settingsHook = withHookCancellation(hooks, opts.abortSignal)
      let preContexts: string[] = []
      let executionPending = false
      return run.promise(
        Effect.gen(function* () {
          const originalArgs = toRecord(args)
          let hookConfirmed = false
          let hookAllowed = false
          let ctx = context(args, opts, false, originalArgs, key)
          // SettingsHook PreToolUse
          if (settingsHook) {
            let preResult = yield* callHook(
              settingsHook,
              { event: "PreToolUse", toolName: key, toolInput: toRecord(args), toolUseID: opts.toolCallId },
              { ...(yield* hookContext(key)), sessionID: ctx.sessionID },
            ).pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            yield* SettingsHook.landSystemMessages(preResult, { sessionID: ctx.sessionID })
            if (
              preResult.permissionDecision === "defer" &&
              !preResult.preventContinuation &&
              !(yield* Effect.promise(() =>
                Promise.resolve(input.canDefer?.(opts.toolCallId, opts.abortSignal) ?? false),
              ))
            ) {
              yield* Logging.backgroundDebug("hook defer ignored", { reason: "interactive-or-multiple-tool-call" })
              preResult = withoutUnusableDefer(preResult)
            }
            let decision = applyPreHookDecision(toRecord(args), preResult)
            if (decision.deferred)
              return {
                output: "",
                attachments: [],
                content: [],
                metadata: { hookDeferred: true, deferredToolUse: { id: opts.toolCallId, name: key, input: args } },
              }
            if (decision.deniedReason) {
              yield* hookDenied(key, decision.deniedReason)
              return mcpHookDenied(
                withPreContext(`[Tool denied by hook] ${decision.deniedReason}`, preResult.additionalContexts),
              )
            }
            if (decision.stopReason) {
              const text = `[Hook stopped] ${decision.stopReason}`
              return {
                title: "",
                output: text,
                metadata: { hookStopped: true, stopReason: decision.stopReason },
                content: [{ type: "text", text }],
              }
            }
            if (preResult.updatedInput !== undefined) yield* Effect.sync(() => validateInput(decision.effectiveArgs))
            // permissionDecision:"ask" — confirmation dialog (see native path note:
            // typed rejections deny; interrupts/defects propagate).
            hookAllowed = preResult.permissionDecision === "allow"
            hookConfirmed = false
            if (preResult.permissionDecision === "ask") {
              const askReason = preResult.permissionDecisionReason
              const verdict = yield* confirmPermissionInput(
                decision.effectiveArgs,
                (effectiveArgs) =>
                  permission.ask(
                    {
                      permission: key,
                      sessionID: ctx.sessionID,
                      patterns: [key],
                      always: [],
                      metadata: {
                        hookAsk: true,
                        input: effectiveArgs,
                        ...(askReason ? { reason: askReason } : {}),
                      },
                      tool: { messageID: input.processor.message.id, callID: opts.toolCallId },
                      ruleset: [],
                    },
                    { force: true, toolInput: effectiveArgs },
                  ),
                validateInput,
              ).pipe(Effect.exit)
              const outcome = classifyPermissionAsk(verdict)
              if (outcome !== "approved" && outcome !== "denied")
                return yield* Effect.failCause(outcome.propagate as never)
              if (outcome === "denied") {
                const reason = askReason ?? "Denied by user in hook confirmation"
                return mcpHookDenied(withPreContext(`[Tool denied by hook] ${reason}`, preResult.additionalContexts))
              }
              if (Exit.isSuccess(verdict)) decision = { ...decision, effectiveArgs: verdict.value.input }
              hookConfirmed = true
            }
            preContexts = preResult.additionalContexts ?? []
            ctx = context(decision.effectiveArgs, opts, hookConfirmed, decision.effectiveArgs, key)
            args = decision.effectiveArgs
          }
          if (opts.abortSignal?.aborted) return yield* Effect.interrupt
          let result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            const authorized = yield* executeWithPermissionInput(
              toRecord(args),
              (next) => {
                ctx = context(next, opts, hookConfirmed, next, key, hookAllowed)
                const interaction = entry.source.requiresUserInteraction
                  ? { server: entry.source.server, tool: entry.source.tool }
                  : undefined
                return ctx.ask(
                  interaction
                    ? {
                        permission: key,
                        metadata: {
                          requiresUserInteraction: true,
                          mcpServer: interaction.server,
                          mcpTool: interaction.tool,
                        },
                        patterns: ["*"],
                        always: [],
                      }
                    : { permission: key, metadata: {}, patterns: ["*"], always: ["*"] },
                )
              },
              {
                canRestart: true,
                validate: (next) => {
                  validateInput(next)
                },
              },
            )
            args = authorized.input
            executionPending = true
            return yield* Effect.suspend(() => {
              return Effect.promise(() => SessionContext.run(ctx.sessionID, () => execute(args, opts)))
            }).pipe(Effect.onInterrupt(() => reportInterrupt(key, args, opts.toolCallId)))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          executionPending = false
          if (opts.abortSignal?.aborted) yield* reportInterrupt(key, args, opts.toolCallId).pipe(Effect.uninterruptible)
          let postResult: TriggerResult | undefined
          if (settingsHook) {
            postResult = yield* callHook(
              settingsHook,
              {
                event: "PostToolUse",
                toolName: key,
                toolInput: toRecord(args),
                toolResponse: result,
                toolUseID: opts.toolCallId,
              },
              { ...(yield* hookContext(key)), sessionID: ctx.sessionID },
            ).pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            yield* SettingsHook.landSystemMessages(postResult, { sessionID: ctx.sessionID })
            const replacement = toolOutputReplacement(postResult, true)
            if (replacement.present) result = mcpToolOutput(replacement.value)
          }

          const parts = mcpContentParts(result.content, entry.source.server)
          const truncated = yield* truncate.output(parts.text.join("\n\n"), {}, input.agent)
          const metadata = mcpResultMetadata(result.metadata, truncated, parts)

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: parts.attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          // PreToolUse additionalContexts: prepend so the model sees any hook-injected
          // gate/reminder before the tool result (mirrors PostToolUse surfacing below).
          const preLines = preContexts.filter((line): line is string => Boolean(line))
          if (preLines.length) {
            output.output = `${hookBlock(preLines)}\n\n${output.output ?? ""}`
          }
          if (postResult) {
            output.output = withHookFeedback(output.output ?? "", postResult)
            if (postResult.preventContinuation)
              output.metadata = { ...output.metadata, ...hookStopMetadata(postResult) }
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause)
              if (executionPending && opts.abortSignal?.aborted) {
                yield* reportInterrupt(key, args, opts.toolCallId).pipe(Effect.uninterruptible)
                return yield* Effect.failCause(cause)
              }
              const error = Cause.squash(cause)
              if (
                error instanceof PermissionV1.DeniedError ||
                error instanceof PermissionV1.RejectedError ||
                error instanceof PermissionV1.CorrectedError
              )
                return yield* Effect.failCause(cause)
              if (error instanceof HookPermissionInterrupt)
                return {
                  title: "",
                  output: error.message,
                  attachments: [],
                  content: [],
                  metadata: { hookStopped: true, stopReason: error.message },
                }
              if (!executionPending) return yield* Effect.failCause(cause)
              if (settingsHook) {
                const failResult = yield* callHook(
                  settingsHook,
                  {
                    event: "PostToolUseFailure",
                    toolName: key,
                    toolInput: toRecord(args),
                    error: String(error),
                    toolUseID: opts.toolCallId,
                  },
                  { ...(yield* hookContext(key)), sessionID: input.session.id },
                ).pipe(
                  Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                )
                yield* SettingsHook.landSystemMessages(failResult, { sessionID: input.session.id })
                const failure = withHookFailure(error, failResult, preContexts)
                if (failure !== error) return yield* Cause.hasDies(cause) ? Effect.die(failure) : Effect.fail(failure)
              }
              return yield* Effect.failCause(cause)
            }),
          ),
          Effect.catchCause((cause) => boundErrorCause(truncate, input.agent, cause)),
        ),
      )
    }
    tools[key] = item
  }
})

export * as ToolPipeline from "./pipeline"
