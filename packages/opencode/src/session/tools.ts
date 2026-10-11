import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { setActiveElicitationSession } from "@/mcp/elicitation"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { isFinalResponseSession } from "@/dag/runtime/capture"
import { MemorySearch } from "@/tool/memory-search"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { withHookFeedback, withHookFailure } from "@/hook/trigger-result"
import { toolFileChanges } from "@/hook/file-changes"
import { applyPreHookDecision, classifyPermissionAsk } from "@/hook/pre-hook-decision"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect } from "effect"
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
const ROOT_ONLY_TOOLS = new Set([MemorySearch.MemorySearchTool.id, TaskTool.id, "workflow"])

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

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  hooks?: SettingsHook.Interface
  sourceLedger?: ToolSourceLedgerInterface
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const sourceLedger =
    input.sourceLedger ??
    Option.getOrUndefined(yield* Effect.serviceOption(ToolSourceLedger.Service)) ??
    ToolSourceLedger.unavailable
  const hooks = input.hooks ?? Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))

  const registryContext = {
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  }
  const registryItems = (yield* registry.registrations(registryContext)).filter(
    (registration) => !(registration.definition.id === "submit_result" && isFinalResponseSession(input.session.id)),
  )
  const mcpItems = yield* mcp.tools()
  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
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

  // `confirmed`: the user already approved this exact call in a hook-forced ask, so ask-level rules
  // do not prompt again for it; deny rules still apply. `recorded` is the model's own input, which the
  // tool part keeps (history and doom-loop detection compare model calls, not hook rewrites).
  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    confirmed = false,
    recorded: Record<string, unknown> = args,
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
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
          { toolInput: args, ...(confirmed ? { confirmed: true } : {}) },
        )
        .pipe(Effect.orDie),
  })

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
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        const settingsHook = withHookCancellation(hooks, options.abortSignal)
        return run.promise(
          // Set the active session for server-initiated MCP reverse requests
          // (elicitation) so the handler can route the Question to this session.
          SessionContext.run(context(args, options).sessionID, () =>
            Effect.gen(function* () {
              let ctx = context(args, options)
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                { args },
              )
              // SettingsHook PreToolUse
              let preContexts: string[] = []
              let dynamicInstructions = false
              // Native todo surfacing (#429): once per assistant turn, before
              // any non-todowrite tool result, re-show the uncompleted list.
              const todoReminder = yield* TodoReminders.preToolCall({
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
                tool: item.id,
              })
              if (settingsHook) {
                const preResult = yield* settingsHook
                  .trigger(
                    { event: "PreToolUse", toolName: item.id, toolInput: toRecord(args), toolUseID: ctx.callID },
                    { sessionID: ctx.sessionID, transcriptPath: "" },
                  )
                  .pipe(
                    Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                  )
                yield* SettingsHook.landSystemMessages(preResult, { sessionID: ctx.sessionID })
                const decision = applyPreHookDecision(toRecord(args), preResult)
                if (decision.deniedReason) {
                  return {
                    output: `[Tool denied by hook] ${decision.deniedReason}`,
                    attachments: [],
                    metadata: { hookDenied: true },
                  } as any
                }
                if (decision.stopReason) {
                  return {
                    output: `[Hook stopped] ${decision.stopReason}`,
                    attachments: [],
                    metadata: { hookStopped: true, stopReason: decision.stopReason },
                  } as any
                }
                // permissionDecision:"ask" — invoke the confirmation dialog. We call
                // permission.ask directly (NOT the orDie-piped ctx.ask) and classify the
                // outcome: typed rejections become a denied result, while interrupts
                // (session abort mid-dialog) and defects propagate instead of being
                // masked as a denial.
                let hookConfirmed = false
                if (preResult.permissionDecision === "ask") {
                  const askReason = preResult.permissionDecisionReason
                  // force: a hook "ask" always prompts — earlier "always" approvals cannot
                  // skip it. The ruleset stays empty: this request carries no real pattern,
                  // so pattern-scoped allows (e.g. `edit: {"*":"deny","plans/*.md":"allow"}`)
                  // must not be pre-empted by a wildcard deny. The tool's own ctx.ask with
                  // the real patterns still enforces deny rules afterwards. The user confirms
                  // the input the tool will actually run with, including any updatedInput.
                  const verdict = yield* permission
                    .ask(
                      {
                        permission: item.id,
                        sessionID: ctx.sessionID,
                        patterns: [item.id],
                        always: [],
                        metadata: {
                          hookAsk: true,
                          input: decision.effectiveArgs,
                          ...(askReason ? { reason: askReason } : {}),
                        },
                        tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                        ruleset: [],
                      },
                      { force: true, toolInput: decision.effectiveArgs },
                    )
                    .pipe(Effect.exit)
                  const outcome = classifyPermissionAsk(verdict)
                  if (outcome !== "approved" && outcome !== "denied")
                    return yield* Effect.failCause(outcome.propagate as never)
                  if (outcome === "denied") {
                    const reason = askReason ?? "Denied by user in hook confirmation"
                    return {
                      output: `[Tool denied by hook] ${reason}`,
                      attachments: [],
                      metadata: { hookDenied: true },
                    } as any
                  }
                  hookConfirmed = true
                }
                preContexts = preResult.additionalContexts ?? []
                dynamicInstructions ||= hookAddsInstructions(preResult)
                // The tool's own permission checks see the effective input and the confirmation.
                ctx = context(decision.effectiveArgs, options, hookConfirmed, args)
                // effectiveArgs reflects any PreToolUse updatedInput rewrite (shallow merge).
                args = decision.effectiveArgs
              }
              if (options.abortSignal?.aborted) return yield* Effect.interrupt
              const result = yield* Effect.suspend(() => {
                const cleanup = setActiveElicitationSession(ctx.sessionID)
                return item.execute(args, ctx).pipe(Effect.ensuring(Effect.sync(cleanup)))
              })
              const output = {
                ...result,
                attachments: result.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              // PreToolUse additionalContexts: prepend so the model sees any hook-injected
              // gate/reminder before the tool result (mirrors PostToolUse surfacing below).
              const preLines = [todoReminder, ...preContexts].filter((line): line is string => Boolean(line))
              if (preLines.length) {
                dynamicInstructions = true
                output.output = `${preLines.join("\n\n")}\n\n${output.output ?? ""}`
              }
              const beforePlugin = outputFingerprint(output)
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                output,
              )
              dynamicInstructions ||= beforePlugin === undefined || beforePlugin !== outputFingerprint(output)
              // SettingsHook PostToolUse
              if (settingsHook) {
                const postResult = yield* settingsHook
                  .trigger(
                    {
                      event: "PostToolUse",
                      toolName: item.id,
                      toolInput: toRecord(args),
                      toolResponse: output.output,
                      toolUseID: ctx.callID,
                    },
                    { sessionID: ctx.sessionID, transcriptPath: "" },
                  )
                  .pipe(
                    Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                  )
                yield* SettingsHook.landSystemMessages(postResult, { sessionID: ctx.sessionID })
                dynamicInstructions ||= hookAddsInstructions(postResult)
                output.output = withHookFeedback(output.output ?? "", postResult)
                // continue:false ends the agent turn once this result is recorded (processor → "stop").
                if (postResult.preventContinuation)
                  output.metadata = {
                    ...(isRecord(output.metadata) ? output.metadata : {}),
                    ...hookStopMetadata(postResult),
                  }
              }
              if (settingsHook) {
                for (const change of toolFileChanges(
                  item.id,
                  toRecord(args),
                  result.metadata,
                  input.session.directory,
                )) {
                  const fileResult = yield* settingsHook
                    .trigger({ event: "FileChanged", ...change }, { sessionID: ctx.sessionID, transcriptPath: "" })
                    .pipe(
                      Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                    )
                  yield* SettingsHook.landSystemMessages(fileResult, { sessionID: ctx.sessionID })
                  dynamicInstructions ||= hookAddsInstructions(fileResult)
                  output.output = withHookFeedback(output.output ?? "", fileResult)
                }
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
                  const error = Cause.squash(cause)
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
                        { sessionID: input.session.id, transcriptPath: "" },
                      )
                      .pipe(
                        Effect.catch(() =>
                          Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult),
                        ),
                      )
                    yield* SettingsHook.landSystemMessages(failResult, { sessionID: input.session.id })
                    const failure = withHookFailure(error, failResult)
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
        ProviderTransform.schema(input.model, {
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
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
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
        ProviderTransform.schema(input.model, {
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
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
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
        ProviderTransform.schema(input.model, {
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
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
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

  for (const [key, item] of Object.entries(mcpItems)) {
    if (key === "submit_result" && isFinalResponseSession(input.session.id)) continue
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) => {
      const settingsHook = withHookCancellation(hooks, opts.abortSignal)
      return run.promise(
        Effect.gen(function* () {
          let ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          // SettingsHook PreToolUse
          let preContexts: string[] = []
          // Native todo surfacing (#429): same per-turn contract as native tools.
          const mcpTodoReminder = yield* TodoReminders.preToolCall({
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
            tool: key,
          })
          if (settingsHook) {
            const preResult = yield* settingsHook
              .trigger(
                { event: "PreToolUse", toolName: key, toolInput: toRecord(args), toolUseID: opts.toolCallId },
                { sessionID: ctx.sessionID, transcriptPath: "" },
              )
              .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            yield* SettingsHook.landSystemMessages(preResult, { sessionID: ctx.sessionID })
            const decision = applyPreHookDecision(toRecord(args), preResult)
            if (decision.deniedReason) {
              return { content: [{ type: "text", text: `[Tool denied by hook] ${decision.deniedReason}` }] } as any
            }
            if (decision.stopReason) {
              const text = `[Hook stopped] ${decision.stopReason}`
              return {
                title: "",
                output: text,
                metadata: { hookStopped: true, stopReason: decision.stopReason },
                content: [{ type: "text", text }],
              } as any
            }
            // permissionDecision:"ask" — confirmation dialog (see native path note:
            // typed rejections deny; interrupts/defects propagate).
            let hookConfirmed = false
            if (preResult.permissionDecision === "ask") {
              const askReason = preResult.permissionDecisionReason
              const verdict = yield* permission
                .ask(
                  {
                    permission: key,
                    sessionID: ctx.sessionID,
                    patterns: [key],
                    always: [],
                    metadata: {
                      hookAsk: true,
                      input: decision.effectiveArgs,
                      ...(askReason ? { reason: askReason } : {}),
                    },
                    tool: { messageID: input.processor.message.id, callID: opts.toolCallId },
                    ruleset: [],
                  },
                  { force: true, toolInput: decision.effectiveArgs },
                )
                .pipe(Effect.exit)
              const outcome = classifyPermissionAsk(verdict)
              if (outcome !== "approved" && outcome !== "denied")
                return yield* Effect.failCause(outcome.propagate as never)
              if (outcome === "denied") {
                const reason = askReason ?? "Denied by user in hook confirmation"
                return { content: [{ type: "text", text: `[Tool denied by hook] ${reason}` }] } as any
              }
              hookConfirmed = true
            }
            preContexts = preResult.additionalContexts ?? []
            ctx = context(decision.effectiveArgs, opts, hookConfirmed, args)
            args = decision.effectiveArgs
          }
          if (opts.abortSignal?.aborted) return yield* Effect.interrupt
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.suspend(() => {
              const cleanup = setActiveElicitationSession(ctx.sessionID)
              return Effect.promise(() => execute(args, opts)).pipe(Effect.ensuring(Effect.sync(cleanup)))
            })
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
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

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
          // SettingsHook PostToolUse
          if (settingsHook) {
            const postResult = yield* settingsHook
              .trigger(
                {
                  event: "PostToolUse",
                  toolName: key,
                  toolInput: toRecord(args),
                  toolResponse: output.output,
                  toolUseID: opts.toolCallId,
                },
                { sessionID: ctx.sessionID, transcriptPath: "" },
              )
              .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
            yield* SettingsHook.landSystemMessages(postResult, { sessionID: ctx.sessionID })
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
              const error = Cause.squash(cause)
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
                    { sessionID: input.session.id, transcriptPath: "" },
                  )
                  .pipe(
                    Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
                  )
                yield* SettingsHook.landSystemMessages(failResult, { sessionID: input.session.id })
                const failure = withHookFailure(error, failResult)
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
    activeRegistrations,
    materializationSignature(input.model, tools),
  )
  return tools
})

function materializationSignature(model: Provider.Model, tools: Record<string, AITool>) {
  try {
    return Hash.sha256(
      JSON.stringify({
        model: {
          providerID: model.providerID,
          modelID: model.id,
          apiID: model.api.id,
          npm: model.api.npm,
        },
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
