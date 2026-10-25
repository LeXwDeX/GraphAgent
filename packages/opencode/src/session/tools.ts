import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { hasCaptureSlot, isFinalResponseSession } from "@/dag/runtime/capture"
import { DagStore } from "@opencode-ai/core/dag/store"
import path from "node:path"
import { MemorySearch } from "@/tool/memory-search"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { HookTranscript } from "@/hook/transcript"
import { promptIdentity } from "@/hook/prompt-identity"
import { withHookFeedback, withHookFailure, withPreContext } from "@/hook/trigger-result"
import { builtinToolOutput, mcpToolOutput, toolOutputReplacement } from "@/hook/tool-output"
import { toolInputValidator } from "@/hook/tool-input"
import {
  executeWithPermissionInput,
  confirmPermissionInput,
  HookPermissionInterrupt,
  ToolInputUpdated,
} from "@/permission/hook-control"
import { Logging } from "@opencode-ai/core/observability/logging"
import { applyPreHookDecision, classifyPermissionAsk, withoutUnusableDefer } from "@/hook/pre-hook-decision"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect, Exit, type Schema } from "effect"
import * as Option from "effect/Option"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { TodoReminders } from "./todo-reminders"
import { EffectBridge } from "@/effect/bridge"
import { SessionContext } from "@/effect/session-context"
import { ModelV2 } from "@opencode-ai/core/model"
import { Hash } from "@opencode-ai/core/util/hash"
import { isRecord } from "@/util/record"
import { hookQuestionAnswers } from "@/hook/question-answers"
import {
  ToolSourceLedger,
  type Interface as ToolSourceLedgerInterface,
  type Registration as ToolSourceRegistration,
} from "./tool-source-ledger"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
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
const ROOT_ONLY_TOOLS = new Set([MemorySearch.MemorySearchTool.id, TaskTool.id, "workflow", "goal"])

const canUseAgentMessages = Effect.fn("SessionTools.canUseAgentMessages")(function* (session: Session.Info) {
  const store = yield* Effect.serviceOption(DagStore.Service)
  if (Option.isNone(store)) return false
  const workflows = (yield* store.value.listBySession(session.parentID ?? session.id)).filter(
    (workflow) =>
      workflow.projectId === session.projectID &&
      workflow.directory !== null &&
      path.resolve(workflow.directory) === path.resolve(session.directory),
  )
  if (!session.parentID) return workflows.length > 0
  for (const workflow of workflows) {
    const nodes = yield* store.value.getNodes(workflow.id)
    if (nodes.some((node) => !node.superseded && node.childSessionId === session.id)) return true
  }
  return false
})

const hookAddsInstructions = (result: TriggerResult) =>
  (result.additionalContexts?.length ?? 0) > 0 ||
  (result.systemMessages?.length ?? 0) > 0 ||
  result.blocked !== undefined ||
  result.preventContinuation === true

/** Tool-result metadata marking a hook `continue:false`; the processor ends the turn on it. */
const hookStopMetadata = (result: TriggerResult) => ({
  hookStopped: true,
  stopReason: result.stopReason ?? "Hook requested stop",
})

const outputFingerprint = (value: unknown) => {
  try {
    return Hash.sha256(JSON.stringify(value))
  } catch {
    return undefined
  }
}

export type DirectToolContext = Omit<Tool.Context, "ask"> & {
  ask(input: Parameters<Tool.Context["ask"]>[0]): Effect.Effect<void, unknown>
}

type DirectTool = Omit<Tool.Def, "execute"> & {
  execute(args: any, context: DirectToolContext): Effect.Effect<Tool.ExecuteResult, unknown>
}

type ToolSelection =
  { directTool: DirectTool; model?: Provider.Model } | { directTool?: undefined; model: Provider.Model }

export const resolve = Effect.fn("SessionTools.resolve")(function* (
  input: ToolSelection & {
    agent: Agent.Info
    session: Session.Info
    processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
    bypassAgentCheck: boolean
    messages: SessionV1.WithParts[]
    promptOps: TaskPromptOps
    hooks?: SettingsHook.Interface
    sourceLedger?: ToolSourceLedgerInterface
    /** Host decides interactive/batch eligibility before any tool executes. */
    canDefer?: (callID: string, signal?: AbortSignal) => boolean | Promise<boolean>
  },
) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const agentService = Option.getOrUndefined(yield* Effect.serviceOption(Agent.Service))
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const sourceLedger =
    input.sourceLedger ??
    Option.getOrUndefined(yield* Effect.serviceOption(ToolSourceLedger.Service)) ??
    ToolSourceLedger.unavailable
  // Answers a PreToolUse hook supplied for the question tool; never taken from model input.
  const questionHookAnswers = new WeakMap<ToolExecutionOptions, ReadonlyArray<ReadonlyArray<string>>>()
  const resourceHookState = new WeakMap<
    ToolExecutionOptions,
    { confirmed: boolean; allowed: boolean; name: string; original: Record<string, unknown> }
  >()
  const hooks = input.hooks ?? Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))

  // Real MCP identity of each server-provided tool, keyed by its model-facing name. Hook
  // matchers use the official `mcp__server__tool` name derived from this binding, never by
  // splitting the lossy key.
  const mcpHookIdentity = new Map<string, { canonicalToolName: string; mcpServer: { name: string; source: string } }>()
  // Server-marked tools (`_meta["anthropic/requiresUserInteraction"] === true`) always need a human.
  const mcpRequiresInteraction = new Map<string, { server: string; tool: string }>()
  // The prompt runtime injects a wrapped settings service that materializes the transcript before
  // each configured event and overrides this context. Callers that reach `resolve` directly have
  // no such wrapper, so they would send `transcript_path: ""`; give them a real snapshot instead.
  const hookContext = Effect.fn("SessionTools.hookContext")(function* (toolName?: string) {
    const policy = "hookPolicy" in permission ? yield* permission.hookPolicy(input.session.id) : undefined
    const mode = policy?.mode ?? (input.agent.name === "plan" ? "plan" : "default")
    const binding = toolName === undefined ? undefined : mcpHookIdentity.get(toolName)
    // Tool events fire inside a prompt, so name that prompt and its effort in the
    // envelope. When the prompt runtime injected its wrapper the same values are
    // recomputed there; an explicitly supplied value always wins.
    const prompt = promptIdentity(input.messages as readonly HookTranscript.Message[])
    const transcriptPath = input.hooks
      ? ""
      : yield* HookTranscript.materialize({
          sessionID: input.session.id,
          directory: input.session.directory,
          messages: input.messages as readonly HookTranscript.Message[],
        }).pipe(Effect.orDie)
    // A tool executed under a child session is that subagent's own call: CC
    // names the child session and the executing agent in agent_id / agent_type.
    const subagent = input.session.parentID ? { agentID: input.session.id, agentType: input.agent.name } : undefined
    return { permissionMode: mode === "manual" ? "default" : mode, ...prompt, ...binding, ...subagent, transcriptPath }
  })

  // Cancellation has already invalidated the normal hook wrapper. Give failure hooks
  // one short, best-effort finalizer window using the underlying service.
  const reportInterrupt = (toolName: string, args: unknown, toolUseID: string) =>
    Effect.gen(function* () {
      if (!hooks) return
      yield* hooks.trigger(
        {
          event: "PostToolUseFailure",
          toolName,
          toolInput: toRecord(args),
          toolUseID,
          error: "Tool execution interrupted",
          isInterrupt: true,
        },
        { ...(yield* hookContext(toolName)), sessionID: input.session.id },
      )
    }).pipe(Effect.interruptible, Effect.timeoutOption("250 millis"), Effect.ignoreCause)

  const transformSchema = (schema: Parameters<typeof ProviderTransform.schema>[1]) =>
    input.model ? ProviderTransform.schema(input.model, schema) : schema
  const registrations = input.directTool
    ? [{ definition: input.directTool, sourceKind: "host-builtin" as const, registrationID: "host:explicit-shell" }]
    : yield* registry.registrations({
        modelID: ModelV2.ID.make(input.model.api.id),
        providerID: input.model.providerID,
        agent: input.agent,
      })
  const agentMessagesAvailable =
    registrations.some((item) => item.sourceKind === "host-builtin" && item.definition.id === "agent") &&
    (yield* canUseAgentMessages(input.session))
  const registryItems = registrations.filter((registration) => {
    if (registration.sourceKind !== "host-builtin") return true
    if (registration.definition.id === "submit_result")
      return !!input.session.parentID && hasCaptureSlot(input.session.id) && !isFinalResponseSession(input.session.id)
    if (registration.definition.id === "agent") return agentMessagesAvailable
    return true
  })
  const mcpItems = input.directTool ? {} : yield* mcp.tools()
  for (const [key, item] of Object.entries(mcpItems)) {
    const binding = McpCatalog.toolBinding(item)
    if (binding?.requiresUserInteraction === true)
      mcpRequiresInteraction.set(key, { server: binding.server, tool: binding.tool })
    if (binding)
      mcpHookIdentity.set(key, {
        canonicalToolName: McpCatalog.canonicalToolName(binding),
        mcpServer: { name: binding.server, source: binding.source },
      })
  }
  const hasMcpResourceServer =
    !input.directTool &&
    Object.values(yield* mcp.clients()).some((client) => !!client.getServerCapabilities()?.resources)
  const effectiveSources = new Map<string, ToolSourceRegistration>()
  for (const item of registryItems) {
    effectiveSources.set(item.definition.id, {
      sourceKind: item.sourceKind,
      registrationID: item.registrationID,
    })
  }
  if (hasMcpResourceServer) {
    effectiveSources.set(MCP_RESOURCE_TOOLS.list, {
      sourceKind: "mcp",
      registrationID: `mcp-resource:${MCP_RESOURCE_TOOLS.list}`,
    })
    effectiveSources.set(MCP_RESOURCE_TOOLS.listTemplates, {
      sourceKind: "mcp",
      registrationID: `mcp-resource:${MCP_RESOURCE_TOOLS.listTemplates}`,
    })
    effectiveSources.set(MCP_RESOURCE_TOOLS.read, {
      sourceKind: "mcp",
      registrationID: `mcp-resource:${MCP_RESOURCE_TOOLS.read}`,
    })
  }
  for (const key of Object.keys(mcpItems).toSorted()) {
    if (key === "submit_result" && isFinalResponseSession(input.session.id)) continue
    effectiveSources.set(key, { sourceKind: "mcp", registrationID: `mcp:${key}` })
  }
  const activeRegistrations = [...effectiveSources.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => source)
  let registrationGeneration = "inactive"

  const recordSettlement = (toolName: string, callID: string, source: ToolSourceRegistration) =>
    sourceLedger.record({
      sessionID: input.session.id,
      assistantMessageID: input.processor.message.id,
      callID,
      toolName,
      sourceKind: source.sourceKind,
      registrationID: source.registrationID,
      registrationGeneration,
    })

  // The pending tool part follows the validated input that will execute. A
  // deferred call returns before this boundary and retains its original input.
  const recordInput = (callID: string, args: Record<string, unknown>) =>
    input.processor
      .updateToolCall(callID, (part) => {
        if (part.state.status !== "running" && part.state.status !== "pending") return part
        return { ...part, state: { ...part.state, input: args } }
      })
      .pipe(Effect.asVoid)

  const rawContext = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    confirmed = resourceHookState.get(options)?.confirmed ?? false,
    recorded: Record<string, unknown> = args,
    toolName = resourceHookState.get(options)?.name,
    hookAllowed = resourceHookState.get(options)?.allowed ?? false,
  ): DirectToolContext => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(questionHookAnswers.has(options) ? { hookAnswers: questionHookAnswers.get(options) } : {}),
    },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: recorded,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask(
          {
            ...req,
            sessionID: input.session.id,
            tool: { messageID: input.processor.message.id, callID: options.toolCallId },
            ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
          },
          {
            toolInput: args,
            toolName,
            ...(toolName === undefined ? {} : mcpHookIdentity.get(toolName)),
            // A forced ask is never settled by a hook allow, bypass, acceptEdits, remembered or configured
            // allow; deny rules and dontAsk still apply first.
            ...(toolName !== undefined && mcpRequiresInteraction.has(toolName) ? { force: true } : {}),
            hookAllowed,
            ...(agentService
              ? {
                  resolveRuleset: (mode?: "plan") =>
                    agentService.permissionPolicy(mode === "plan" ? "plan" : input.agent.name).pipe(
                      Effect.map((policy) => ({
                        ...policy,
                        rules: Permission.merge(policy.rules, input.session.permission ?? []),
                      })),
                    ),
                }
              : {}),
            ...(confirmed ? { confirmed: true } : {}),
          },
        )
        .pipe(
          Effect.flatMap((result) =>
            result?.updatedInput
              ? Effect.die(new ToolInputUpdated(result.updatedInput))
              : recordInput(options.toolCallId, args),
          ),
        ),
  })

  const context = (...args: Parameters<typeof rawContext>): Tool.Context => {
    const value = rawContext(...args)
    return { ...value, ask: (request) => value.ask(request).pipe(Effect.orDie) }
  }

  for (const registration of registryItems) {
    const item = registration.definition
    if (input.session.parentID && ROOT_ONLY_TOOLS.has(item.id)) continue
    if (
      item.id === MemorySearch.MemorySearchTool.id &&
      Permission.disabled(
        [MemorySearch.MemorySearchTool.id],
        Permission.merge(input.agent.permission, input.session.permission ?? []),
      ).has(MemorySearch.MemorySearchTool.id)
    )
      continue
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
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                { args },
              )
              // SettingsHook PreToolUse
              let dynamicInstructions = false
              // Native todo surfacing (#429): once per assistant turn, before
              // any non-todowrite tool result, re-show the uncompleted list.
              const todoReminder = yield* TodoReminders.preToolCall({
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
                tool: item.id,
              })
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
              const preLines = [todoReminder, ...preContexts].filter((line): line is string => Boolean(line))
              const beforePlugin = outputFingerprint(output)
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                output,
              )
              dynamicInstructions ||= beforePlugin === undefined || beforePlugin !== outputFingerprint(output)
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

  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        transformSchema({
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
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
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            yield* recordSettlement(MCP_RESOURCE_TOOLS.list, opts.toolCallId, {
              sourceKind: "mcp",
              registrationID: `mcp-resource:${MCP_RESOURCE_TOOLS.list}`,
            })
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        transformSchema({
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
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
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            yield* recordSettlement(MCP_RESOURCE_TOOLS.listTemplates, opts.toolCallId, {
              sourceKind: "mcp",
              registrationID: `mcp-resource:${MCP_RESOURCE_TOOLS.listTemplates}`,
            })
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        transformSchema({
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
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
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            yield* recordSettlement(MCP_RESOURCE_TOOLS.read, opts.toolCallId, {
              sourceKind: "mcp",
              registrationID: `mcp-resource:${MCP_RESOURCE_TOOLS.read}`,
            })
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  // Resource helpers are OpenCode-owned tools too: the same settings hooks
  // must govern them, not only server-provided MCP callTool definitions.
  for (const name of Object.values(MCP_RESOURCE_TOOLS)) {
    const item = tools[name]
    const execute = item?.execute
    if (!item || !execute) continue
    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const validateInput = toolInputValidator(schema)
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
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: name, sessionID: input.session.id, callID: opts.toolCallId },
            { args },
          )
          if (settingsHook) {
            pre = yield* settingsHook
              .trigger(
                { event: "PreToolUse", toolName: name, toolInput: args, toolUseID: opts.toolCallId },
                {
                  ...(yield* hookContext()),
                  sessionID: input.session.id,
                },
              )
              .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
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
            if (decision.deniedReason)
              return {
                title: "",
                output: withPreContext(`[Tool denied by hook] ${decision.deniedReason}`, pre.additionalContexts),
                metadata: { hookDenied: true },
              }
            if (decision.stopReason)
              return {
                title: "",
                output: decision.stopReason,
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
              // Plugin-before runs once above, outside the permission restart boundary.
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
            const post = yield* settingsHook
              .trigger(
                {
                  event: "PostToolUse",
                  toolName: name,
                  toolInput: args,
                  toolUseID: opts.toolCallId,
                  toolResponse: output.metadata,
                  toolOutput: output,
                },
                { ...(yield* hookContext()), sessionID: input.session.id },
              )
              .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
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
          if (preLines.length) output.output = `${preLines.join("\n\n")}\n\n${output.output}`
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
                const failure = yield* settingsHook
                  .trigger(
                    {
                      event: "PostToolUseFailure",
                      toolName: name,
                      toolInput: args,
                      toolUseID: options.toolCallId,
                      error: String(error),
                    },
                    { ...(yield* hookContext()), sessionID: input.session.id },
                  )
                  .pipe(
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
        ),
      )
    }
  }

  for (const [key, item] of Object.entries(mcpItems)) {
    if (key === "submit_result" && isFinalResponseSession(input.session.id)) continue
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const validateInput = toolInputValidator(schema)
    const transformed = transformSchema({ ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
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
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          // SettingsHook PreToolUse
          // Native todo surfacing (#429): same per-turn contract as native tools.
          const mcpTodoReminder = yield* TodoReminders.preToolCall({
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
            tool: key,
          })
          if (settingsHook) {
            let preResult = yield* settingsHook
              .trigger(
                { event: "PreToolUse", toolName: key, toolInput: toRecord(args), toolUseID: opts.toolCallId },
                { ...(yield* hookContext(key)), sessionID: ctx.sessionID },
              )
              .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
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
              return {
                content: [
                  {
                    type: "text",
                    text: withPreContext(
                      `[Tool denied by hook] ${decision.deniedReason}`,
                      preResult.additionalContexts,
                    ),
                  },
                ],
              }
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
                return {
                  content: [
                    {
                      type: "text",
                      text: withPreContext(`[Tool denied by hook] ${reason}`, preResult.additionalContexts),
                    },
                  ],
                }
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
                const interaction = mcpRequiresInteraction.get(key)
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
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          let postResult: TriggerResult | undefined
          if (settingsHook) {
            postResult = yield* settingsHook
              .trigger(
                {
                  event: "PostToolUse",
                  toolName: key,
                  toolInput: toRecord(args),
                  toolResponse: result,
                  toolUseID: opts.toolCallId,
                },
                { ...(yield* hookContext(key)), sessionID: ctx.sessionID },
              )
              .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            yield* SettingsHook.landSystemMessages(postResult, { sessionID: ctx.sessionID })
            const replacement = toolOutputReplacement(postResult, true)
            if (replacement.present) result = mcpToolOutput(replacement.value)
          }

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          // PreToolUse additionalContexts: prepend so the model sees any hook-injected
          // gate/reminder before the tool result (mirrors PostToolUse surfacing below).
          const preLines = [mcpTodoReminder, ...preContexts].filter((line): line is string => Boolean(line))
          if (preLines.length) {
            output.output = `${preLines.join("\n\n")}\n\n${output.output ?? ""}`
          }
          if (postResult) {
            output.output = withHookFeedback(output.output ?? "", postResult)
            if (postResult.preventContinuation)
              output.metadata = { ...output.metadata, ...hookStopMetadata(postResult) }
          }
          yield* recordSettlement(key, opts.toolCallId, {
            sourceKind: "mcp",
            registrationID: `mcp:${key}`,
          })
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
                const failResult = yield* settingsHook
                  .trigger(
                    {
                      event: "PostToolUseFailure",
                      toolName: key,
                      toolInput: toRecord(args),
                      error: String(error),
                      toolUseID: opts.toolCallId,
                    },
                    { ...(yield* hookContext(key)), sessionID: input.session.id },
                  )
                  .pipe(
                    Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                  )
                yield* SettingsHook.landSystemMessages(failResult, { sessionID: input.session.id })
                const failure = withHookFailure(error, failResult, preContexts)
                if (failure !== error) return yield* Cause.hasDies(cause) ? Effect.die(failure) : Effect.fail(failure)
              }
              return yield* Effect.failCause(cause)
            }),
          ),
        ),
      )
    }
    tools[key] = item
  }

  registrationGeneration = yield* sourceLedger.activate(
    input.session.id,
    activeRegistrations,
    materializationSignature(input.model, tools),
  )
  return tools
})

function materializationSignature(model: Provider.Model | undefined, tools: Record<string, AITool>) {
  try {
    return Hash.sha256(
      JSON.stringify({
        model: model
          ? {
              providerID: model.providerID,
              modelID: model.id,
              apiID: model.api.id,
              npm: model.api.npm,
            }
          : undefined,
        tools: Object.entries(tools)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([name, item]) => ({
            name,
            description: item.description ?? "",
            inputSchema: asSchema(item.inputSchema).jsonSchema,
            ...(item.strict === undefined ? {} : { strict: item.strict }),
          })),
      }),
    )
  } catch {
    // An unstable or unserializable tool shape must not reuse prior provenance.
    return `unknown:${crypto.randomUUID()}`
  }
}

// Cancel hooks independently so tools that finalize partial output on abort can
// still persist that output through completeToolCall.
function withHookCancellation(hooks: SettingsHook.Interface | undefined, signal: AbortSignal | undefined) {
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

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

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

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
