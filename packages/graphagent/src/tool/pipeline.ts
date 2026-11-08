import type { JSONSchema7 } from "@ai-sdk/provider"
import { type Tool as AITool, jsonSchema, tool, type ToolExecutionOptions } from "ai"
import { Cause, Effect, Exit, type Schema } from "effect"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Logging } from "@graphagent/core/observability/logging"
import type { Agent } from "@/agent/agent"
import type { EffectBridge } from "@/effect/bridge"
import { SessionContext } from "@/effect/session-context"
import { applyPreHookDecision, classifyPermissionAsk, withoutUnusableDefer } from "@/hook/pre-hook-decision"
import { hookQuestionAnswers } from "@/hook/question-answers"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { builtinToolOutput, toolOutputReplacement } from "@/hook/tool-output"
import { toolInputValidator } from "@/hook/tool-input"
import { withHookFeedback, withHookFailure, withPreContext } from "@/hook/trigger-result"
import { Permission } from "@/permission"
import { confirmPermissionInput, executeWithPermissionInput, HookPermissionInterrupt } from "@/permission/hook-control"
import type { Provider } from "@/provider/provider"
import type { SessionProcessor } from "@/session/processor"
import { PartID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { Registration as ToolSourceRegistration, ToolSourceLedger } from "@/session/tool-source-ledger"
import { ToolJsonSchema } from "@/tool/json-schema"
import { MemorySearch } from "@/tool/memory-search"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { isRecord } from "@/util/record"

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
const ROOT_ONLY_TOOLS = new Set([MemorySearch.MemorySearchTool.id, TaskTool.id, "workflow", "goal", "watch_pr"])

export const hookAddsInstructions = (result: TriggerResult) =>
  (result.additionalContexts?.length ?? 0) > 0 ||
  (result.systemMessages?.length ?? 0) > 0 ||
  result.blocked !== undefined ||
  result.preventContinuation === true

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
  return {
    ...hooks,
    trigger: (payload: SettingsHook.HookPayload, ctx: SettingsHook.TriggerContext) => {
      const empty = Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })
      if (signal.aborted) return empty
      return Effect.raceFirst(
        hooks.trigger(payload, ctx),
        Effect.callback<TriggerResult>((resume) => {
          const abort = () => resume(empty)
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          return Effect.sync(() => signal.removeEventListener("abort", abort))
        }),
      )
    },
  } satisfies SettingsHook.Interface
}

export type DirectToolContext = Omit<Tool.Context, "ask"> & {
  ask(input: Parameters<Tool.Context["ask"]>[0]): Effect.Effect<void, unknown>
}

export type DirectTool = Omit<Tool.Def, "execute"> & {
  execute(args: any, context: DirectToolContext): Effect.Effect<Tool.ExecuteResult, unknown>
}

export type ToolSelection =
  { directTool: DirectTool; model?: Provider.Model } | { directTool?: undefined; model: Provider.Model }

export type ResolveInput = ToolSelection & {
  agent: Agent.Info
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  hooks?: SettingsHook.Interface
  sourceLedger?: ToolSourceLedger.Interface
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

export type RegistryItem = Readonly<{
  definition: Tool.Def | DirectTool
  sourceKind: ToolSourceRegistration["sourceKind"]
  registrationID: string
}>

export interface Deps {
  input: ResolveInput
  run: EffectBridge.Shape
  permission: Permission.Interface
  hooks: SettingsHook.Interface | undefined
  agentService: Agent.Interface | undefined
  questionHookAnswers: WeakMap<ToolExecutionOptions, ReadonlyArray<ReadonlyArray<string>>>
  hookContext: (toolName?: string) => Effect.Effect<Omit<SettingsHook.TriggerContext, "sessionID">>
  reportInterrupt: (toolName: string, args: unknown, toolUseID: string) => Effect.Effect<void>
  transformSchema: (schema: JSONSchema7) => JSONSchema7
  recordSettlement: (toolName: string, callID: string, source: ToolSourceRegistration) => Effect.Effect<void>
  recordInput: (callID: string, args: Record<string, unknown>) => Effect.Effect<void>
  rawContext: RawContextFn
  context: ContextFn
  configuredPermission: PermissionV1.Ruleset
  registryItems: ReadonlyArray<RegistryItem>
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
    recordSettlement,
    reportInterrupt,
    hookContext,
    transformSchema,
    configuredPermission,
    agentService,
    registryItems,
  } = deps

  for (const registration of registryItems) {
    const item = registration.definition
    if (input.session.parentID && ROOT_ONLY_TOOLS.has(item.id)) continue
    if (item.id === MemorySearch.MemorySearchTool.id) {
      const nativePermission = agentService ? (yield* agentService.permissionPolicy(input.agent.name)).native : []
      if (Permission.disabledByPolicy([item.id], nativePermission, configuredPermission).has(item.id)) continue
    }
    const toolSchema = item.jsonSchema ?? ToolJsonSchema.fromSchema(item.parameters as Schema.Top)
    const schema = transformSchema(toolSchema)
    const validateInput = toolInputValidator(toolSchema)
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
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
              let dynamicInstructions = false
              if (settingsHook) {
                let preResult = yield* settingsHook
                  .trigger(
                    { event: "PreToolUse", toolName: item.id, toolInput: toRecord(args), toolUseID: ctx.callID },
                    { ...(yield* hookContext()), sessionID: ctx.sessionID },
                  )
                  .pipe(
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
                if (decision.deniedReason) {
                  return {
                    output: withPreContext(
                      `[Tool denied by hook] ${decision.deniedReason}`,
                      preResult.additionalContexts,
                    ),
                    attachments: [],
                    metadata: { hookDenied: true },
                  }
                }
                if (decision.stopReason) {
                  return {
                    output: `[Hook stopped] ${decision.stopReason}`,
                    attachments: [],
                    metadata: { hookStopped: true, stopReason: decision.stopReason },
                  }
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
                      output: withPreContext(`[Tool denied by hook] ${reason}`, preResult.additionalContexts),
                      attachments: [],
                      metadata: { hookDenied: true },
                    }
                  }
                  if (Exit.isSuccess(verdict)) decision = { ...decision, effectiveArgs: verdict.value.input }
                  hookConfirmed = true
                }
                preContexts = preResult.additionalContexts ?? []
                dynamicInstructions ||= hookAddsInstructions(preResult)
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
                      Effect.suspend(() => {
                        return input.directTool
                          ? input.directTool.execute(
                              next,
                              rawContext(next, options, hookConfirmed, next, item.id, hookAllowed),
                            )
                          : item.execute(next, ctx)
                      }),
                    ),
                  )
                },
                {
                  canRestart: registration.sourceKind === "host-builtin" && PERMISSION_RESTART_TOOLS.has(item.id),
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
              // PreToolUse feedback is attached after PostToolUse has seen and possibly replaced the
              // native result, so Post hooks never receive earlier hook text and a replacement keeps it.
              const preLines = preContexts.filter((line): line is string => Boolean(line))
              // SettingsHook PostToolUse; a completed failure (nonzero shell
              // exit) fires the reference's PostToolUseFailure instead while
              // keeping the same model-facing result and feedback handling.
              if (settingsHook) {
                const hookFailure = output.hookFailure
                const postResult = yield* settingsHook
                  .trigger(
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
                  )
                  .pipe(
                    Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                  )
                yield* SettingsHook.landSystemMessages(postResult, { sessionID: ctx.sessionID })
                dynamicInstructions ||= hookAddsInstructions(postResult)
                const replacement = toolOutputReplacement(postResult)
                const rewritten = replacement.present ? builtinToolOutput(replacement.value) : undefined
                if (rewritten) {
                  output.title = rewritten.title
                  output.output = rewritten.output
                  output.metadata = rewritten.metadata as typeof output.metadata
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
                dynamicInstructions = true
                output.output = `${preLines.join("\n\n")}\n\n${output.output ?? ""}`
              }
              dynamicInstructions ||=
                output.output?.includes("<system-reminder>") ||
                (isRecord(output.metadata) &&
                  Array.isArray(output.metadata.loaded) &&
                  output.metadata.loaded.length > 0)
              output.metadata = {
                ...(isRecord(output.metadata) ? output.metadata : {}),
                contextFoldingInstructions: dynamicInstructions ? "dynamic" : "none",
              }
              yield* recordSettlement(item.id, options.toolCallId, registration)
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
                    const failResult = yield* settingsHook
                      .trigger(
                        {
                          event: "PostToolUseFailure",
                          toolName: item.id,
                          toolInput: toRecord(args),
                          error: String(error),
                          toolUseID: options.toolCallId,
                        },
                        { ...(yield* hookContext()), sessionID: input.session.id },
                      )
                      .pipe(
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
            ),
          ),
        )
      },
    })
  }
})

export * as ToolPipeline from "./pipeline"
