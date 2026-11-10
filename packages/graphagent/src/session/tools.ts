import { Agent } from "@/agent/agent"
import { subagentRoleDefaultRuleIndices } from "@/agent/subagent-permissions"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ToolPipeline, toRecord } from "@/tool/pipeline"
import type { DirectToolContext, ToolEntry, WrapInput } from "@/tool/pipeline"
import { SettingsHook } from "@/hook"
import { ToolInputUpdated } from "@/permission/hook-control"
import { type Tool as AITool, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import * as Option from "effect/Option"
import { EffectBridge } from "@/effect/bridge"
import { Hash } from "@graphagent/core/util/hash"
import { ToolSourceLedger, type Registration as ToolSourceRegistration } from "./tool-source-ledger"
import { serializedTools, TOOLS_JSON } from "./overflow"
import { EngineProcess } from "./engine-process"

const outputFingerprint = (value: unknown) => {
  try {
    return Hash.sha256(JSON.stringify(value))
  } catch {
    return undefined
  }
}

export type { DirectToolContext }

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: WrapInput) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const permission = yield* Permission.Service
  const agentService = Option.getOrUndefined(yield* Effect.serviceOption(Agent.Service))
  const registry = yield* ToolRegistry.Service
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

  // Definition-stage rewrites (availability, permissions, descriptions, schemas) happen in
  // the registry; this layer only wraps the resulting entries for execution.
  const turnID = input.messages.findLast((message) => message.info.role === "user")?.info.id
  const entries = input.directTool
    ? yield* registry.resolve({
        directTool: input.directTool,
        ...(input.model ? { model: input.model } : {}),
        ...(turnID ? { turnID } : {}),
        agent: input.agent,
        session: input.session,
        user: input.user,
        permission: input.permission ?? input.session.permission,
      })
    : yield* registry.resolve({
        model: input.model,
        ...(turnID ? { turnID } : {}),
        agent: input.agent,
        session: input.session,
        user: input.user,
        permission: input.permission ?? input.session.permission,
      })
  const entriesByID = new Map(entries.map((entry) => [entry.id, entry]))

  // Real MCP identity of each server-provided tool, keyed by its model-facing name. Hook
  // matchers use the official `mcp__server__tool` name derived from this binding, never by
  // splitting the lossy key.
  const hookIdentity = (toolName: string | undefined) => {
    if (toolName === undefined) return undefined
    const source = entriesByID.get(toolName)?.source
    if (source?.kind !== "mcp") return undefined
    return {
      canonicalToolName: source.canonicalName,
      mcpServer: { name: source.server, source: source.source },
    }
  }
  // Server-marked tools (`_meta["anthropic/requiresUserInteraction"] === true`) always need a human.
  const needsForcedAsk = (toolName: string) => {
    const source = entriesByID.get(toolName)?.source
    return source?.kind === "mcp" && source.requiresUserInteraction
  }
  // Tool identity for hook matching. The engine derives transcript,
  // environment and prompt identity lazily from the session, so the pipeline
  // only supplies the executing session and the tool/MCP binding.
  const hookContext = Effect.fn("SessionTools.hookContext")(function* (toolName?: string) {
    const policy = "hookPolicy" in permission ? yield* permission.hookPolicy(input.session.id) : undefined
    const mode = policy?.mode ?? (input.agent.name === "plan" ? "plan" : "default")
    const binding = hookIdentity(toolName)
    // A tool executed under a child session is that subagent's own call: CC
    // names the child session and the executing agent in agent_id / agent_type.
    const subagent = input.session.parentID ? { agentID: input.session.id, agentType: input.agent.name } : undefined
    return { permissionMode: mode === "manual" ? "default" : mode, ...binding, ...subagent }
  })

  // Cancellation has already invalidated the normal hook wrapper. Give failure hooks
  // one short, best-effort finalizer window using the underlying service.
  const reportInterrupt = (toolName: string, args: unknown, toolUseID: string) =>
    Effect.gen(function* () {
      if (!hooks) return
      yield* ToolPipeline.callHook(
        hooks,
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

  const settlement = (entry: ToolEntry): ToolSourceRegistration =>
    entry.source.kind === "builtin"
      ? { sourceKind: "host-builtin", registrationID: entry.source.registrationID }
      : entry.source.kind === "direct-shell"
        ? { sourceKind: "host-builtin", registrationID: "host:explicit-shell" }
        : entry.source.kind === "mcp"
          ? { sourceKind: "mcp", registrationID: `mcp:${entry.id}` }
          : { sourceKind: "mcp", registrationID: entry.source.registrationID }
  const activeRegistrations = [...entries].toSorted((left, right) => left.id.localeCompare(right.id)).map(settlement)
  let registrationGeneration = "inactive"

  const recordSettlement = (entry: ToolEntry, callID: string) =>
    sourceLedger.record({
      sessionID: input.session.id,
      assistantMessageID: input.processor.message.id,
      callID,
      toolName: entry.id,
      ...settlement(entry),
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
    preview: (val) => input.processor.previewToolCall(options.toolCallId, val),
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
            ...(toolName === undefined ? {} : hookIdentity(toolName)),
            // A forced ask is never settled by a hook allow, bypass, acceptEdits, remembered or configured
            // allow; deny rules and dontAsk still apply first.
            ...(toolName !== undefined && needsForcedAsk(toolName) ? { force: true } : {}),
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
    recordSettlement,
    recordInput,
    rawContext,
    context,
    configuredPermission,
    entries,
    truncate,
    resourceHookState,
  }
  yield* ToolPipeline.builtinTools(pipelineDeps, tools)
  yield* ToolPipeline.mcpResourceTools(pipelineDeps, tools)

  yield* ToolPipeline.mcpServerTools(pipelineDeps, tools)

  const serialized = serializedTools(tools)
  const strict = Object.entries(tools)
    .filter(([, item]) => item.strict !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({ name, strict: item.strict }))
  const signature = materializationSignature(input.model, serialized, strict)
  registrationGeneration = yield* sourceLedger.activate(input.session.id, activeRegistrations, signature)

  // Serialize the model-facing fragment once and keep it for the next request
  // that materializes the same tools. The overhead estimate in `prepare` reads
  // the attached string instead of walking every schema again (Issue #1022, PR5).
  try {
    const runtimes = EngineProcess.runtimes
    const cached = runtimes.requestTools.get(input.session.id)
    const json = cached?.key === signature ? cached.json : JSON.stringify(serialized)
    if (cached?.key !== signature) runtimes.rememberToolsJson(input.session.id, signature, json)
    Object.defineProperty(tools, TOOLS_JSON, { value: json })
  } catch {
    // An unserializable tool shape falls back to the legacy estimate path.
  }
  return tools
})

/** The tool fragment `SessionTools.resolve` serialized for this record, if any. */
export function serializedFragment(tools: Record<string, AITool>): string | undefined {
  const value = (tools as Record<PropertyKey, unknown>)[TOOLS_JSON]
  return typeof value === "string" ? value : undefined
}

function materializationSignature(
  model: Provider.Model | undefined,
  tools: ReturnType<typeof serializedTools>,
  strict: ReadonlyArray<{ readonly name: string; readonly strict: AITool["strict"] }>,
) {
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
        tools,
        ...(strict.length === 0 ? {} : { strict }),
      }),
    )
  } catch {
    // An unstable or unserializable tool shape must not reuse prior provenance.
    return `unknown:${crypto.randomUUID()}`
  }
}

export * as SessionTools from "./tools"
