import { Agent } from "@/agent/agent"
import { subagentRoleDefaultRuleIndices } from "@/agent/subagent-permissions"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { ToolRegistry } from "@/tool/registry"
import { hasCaptureSlot, isFinalResponseSession } from "@/dag/runtime/capture"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Truncate } from "@/tool/truncate"
import {
  MAX_MCP_RESOURCE_BLOB_BYTES,
  MCP_RESOURCE_TOOLS,
  SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES,
  ToolPipeline,
  base64Size,
  formatBytes,
  hookStopMetadata,
  toRecord,
  withHookCancellation,
} from "@/tool/pipeline"
import type { DirectToolContext, ResolveInput } from "@/tool/pipeline"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { HookTranscript } from "@/hook/transcript"
import { promptIdentity } from "@/hook/prompt-identity"
import { withHookFeedback, withHookFailure, withPreContext } from "@/hook/trigger-result"
import { mcpToolOutput, toolOutputReplacement } from "@/hook/tool-output"
import { toolInputValidator } from "@/hook/tool-input"
import {
  executeWithPermissionInput,
  confirmPermissionInput,
  HookPermissionInterrupt,
  ToolInputUpdated,
} from "@/permission/hook-control"
import { Logging } from "@graphagent/core/observability/logging"
import { applyPreHookDecision, classifyPermissionAsk, withoutUnusableDefer } from "@/hook/pre-hook-decision"
import { type Tool as AITool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect, Exit } from "effect"
import * as Option from "effect/Option"
import { Session } from "./session"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { SessionContext } from "@/effect/session-context"
import { ModelV2 } from "@graphagent/core/model"
import { Hash } from "@graphagent/core/util/hash"
import { ToolSourceLedger, type Registration as ToolSourceRegistration } from "./tool-source-ledger"

const canUseAgentMessages = Effect.fn("SessionTools.canUseAgentMessages")(function* (session: Session.Info) {
  const store = yield* Effect.serviceOption(DagStore.Service)
  const messages = yield* Effect.serviceOption(DagMessages.Service)
  if (Option.isNone(store) || Option.isNone(messages)) return false
  const workflows = yield* store.value.listBySession(session.parentID ?? session.id)
  const caller = { projectID: session.projectID, directory: session.directory, sessionID: session.id }
  if (!session.parentID) {
    for (const workflow of workflows) {
      const endpoint = yield* messages.value.resolve(caller, workflow.id)
      if (endpoint.ok && endpoint.value.kind === "main") return true
    }
    return false
  }
  const endpoint = yield* messages.value.revisions(caller)
  if (!endpoint.ok || endpoint.value.endpoint.kind !== "node") return false
  for (const workflow of workflows) {
    if (endpoint.value.endpoint.workflowID !== workflow.id) continue
    const nodes = yield* store.value.getNodes(workflow.id)
    if (
      nodes.some(
        (node) =>
          node.status === "running" &&
          !node.superseded &&
          node.childSessionId === session.id &&
          node.id === endpoint.value.endpoint.nodeID &&
          DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts) === endpoint.value.endpoint.attemptID,
      )
    )
      return true
  }
  return false
})

const outputFingerprint = (value: unknown) => {
  try {
    return Hash.sha256(JSON.stringify(value))
  } catch {
    return undefined
  }
}

export type { DirectToolContext }

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: ResolveInput) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
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
            ...(input.session.parentID
              ? {
                  role: input.agent.name,
                  roleDefaultIndices: subagentRoleDefaultRuleIndices(input.session.permission ?? [], input.agent),
                  sessionRuleCount: input.session.permission?.length ?? 0,
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

  const configuredPermission = Permission.merge(input.agent.permission, input.session.permission ?? [])
  const pipelineDeps = {
    input,
    run,
    permission,
    hooks,
    agentService,
    questionHookAnswers,
    hookContext,
    reportInterrupt,
    transformSchema,
    recordSettlement,
    recordInput,
    rawContext,
    context,
    configuredPermission,
    registryItems,
    mcp,
    truncate,
    resourceHookState,
    hasMcpResourceServer,
  }
  yield* ToolPipeline.builtinTools(pipelineDeps, tools)
  yield* ToolPipeline.mcpResourceTools(pipelineDeps, tools)

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
          // SettingsHook PreToolUse
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
          const preLines = preContexts.filter((line): line is string => Boolean(line))
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

export * as SessionTools from "./tools"
