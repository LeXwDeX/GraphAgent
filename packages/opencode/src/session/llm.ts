import type { ToolBatch } from "@/hook/tool-batch"
import { randomUUID } from "node:crypto"
import { Logging } from "@opencode-ai/core/observability/logging"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/layer-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { InvalidToolInputError, streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import { type LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { ThinkingReplay } from "./thinking-replay"
import {
  ContextFolding,
  type HistorySnapshot as ContextFoldingHistorySnapshot,
  type RequestPurpose,
} from "./context-folding"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Flag } from "@opencode-ai/core/flag/flag"
import { contextFoldingDiagnostic, type ContextFoldingProjectionPlan } from "@opencode-ai/core/session/context-folding"
import {
  engineOrganizerCall,
  ReasoningDistillationPolicy,
  type OrganizeCall,
} from "@opencode-ai/core/session/reasoning-distillation"
import { ToolBudget } from "@opencode-ai/core/session/tool-budget"

/** Provider-SDK organizer transport; the timeout measures response start and idle gaps. */
export const sdkOrganizerCall =
  (input: {
    model: Parameters<typeof wrapLanguageModel>[0]["model"]
    maxOutputTokens: number
    effort: "none" | "low"
    timeoutMs: number
    signal: AbortSignal
    onResponseStarted?: () => void
  }): OrganizeCall =>
  async ({ prompt }) => {
    const idle = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let started = false
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(
        () => idle.abort(new DOMException("Organizer response timed out", "TimeoutError")),
        input.timeoutMs,
      )
    }
    reset()
    try {
      const result = streamText({
        model: wrapLanguageModel({
          model: input.model,
          middleware: {
            specificationVersion: "v3",
            wrapStream: async ({ doStream }) => {
              const result = await doStream()
              return {
                ...result,
                stream: result.stream.pipeThrough(
                  new TransformStream({
                    transform(chunk, controller) {
                      // Providers can synthesize starts/metadata from headers. Raw frames or response content
                      // prove the upstream stream has started; synthetic chunks cannot extend its deadline.
                      if (
                        chunk.type === "raw" ||
                        chunk.type === "text-delta" ||
                        chunk.type === "reasoning-delta" ||
                        chunk.type === "source" ||
                        chunk.type === "file" ||
                        chunk.type === "tool-input-delta" ||
                        chunk.type === "tool-call" ||
                        chunk.type === "tool-result"
                      ) {
                        reset()
                        if (!started) {
                          started = true
                          input.onResponseStarted?.()
                        }
                      }
                      controller.enqueue(chunk)
                    },
                  }),
                ),
              }
            },
          },
        }),
        prompt,
        temperature: 0,
        maxOutputTokens: input.maxOutputTokens,
        maxRetries: 0,
        includeRawChunks: true,
        // Errors are returned to the rewrite caller through fullStream below.
        onError: () => {},
        providerOptions: { openaiCompatible: { reasoningEffort: input.effort } },
        abortSignal: AbortSignal.any([input.signal, idle.signal]),
      })
      for await (const chunk of result.fullStream) {
        if (chunk.type === "error") throw chunk.error
        if (chunk.type === "abort") throw input.signal.reason ?? idle.signal.reason ?? new Error("Organizer aborted")
      }
      const [text, totalUsage, finishReason] = await Promise.all([result.text, result.totalUsage, result.finishReason])
      return {
        text,
        usageTokens: typeof totalUsage?.totalTokens === "number" ? totalUsage.totalTokens : undefined,
        finishReason,
      }
    } finally {
      clearTimeout(timer!)
    }
  }

export function strictJSON(text: string): unknown {
  // Models sometimes wrap JSON in a markdown fence despite "output JSON only"
  // instructions; strip the fence before parsing (defensive, mechanical only).
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*```\s*$/, "")
    : trimmed
  return JSON.parse(unfenced)
}

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  /** Shared across every provider request for the current user input. */
  toolBudget?: ToolBudget.Budget
  toolBatch?: ToolBatch
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  purpose?: RequestPurpose
  contextFolding?: ContextFoldingHistorySnapshot
  /** In-process safety signal for activity that can precede or outlive stream events. */
  onAttemptActivity?: (activity: "tool-executed" | "suppressed" | "observational") => void
  /** Persist local replay tombstones before a request can leave this process. */
  onThinkingInvalidated?: (blocks: readonly string[]) => Effect.Effect<void>
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Organizer = Readonly<{
  transport: "engine" | "ai-sdk"
  model: string
  call: (signal: AbortSignal, onResponseStarted?: () => void) => OrganizeCall
}>

export interface Interface {
  /** The configured small model as a reasoning organizer; undefined when none is available (never the main model). */
  readonly organizer: (input: { model: Provider.Model }) => Effect.Effect<Organizer | undefined>
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const toolBudget = input.toolBudget ?? ToolBudget.create(cfg.maxToolCalls)
      const toolChoice = toolBudget.exhausted ? "none" : input.toolChoice
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        tools: toolChoice === "none" ? {} : input.tools,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })
      const admissions = new Map<string, { allowed: boolean; executed: boolean }>()
      const admitToolCall = (id: string) => {
        const prior = admissions.get(id)
        if (prior) return prior
        const admission = { allowed: toolBudget.tryReserve(), executed: false }
        admissions.set(id, admission)
        return admission
      }
      const observeToolCall = (event: LLMEvent) =>
        Effect.sync(() => {
          // Invalid arguments may fail before the executor. Completed local
          // calls still consume budget, without charging execution a second time.
          if (event.type === "tool-call" && !event.providerExecuted && toolChoice !== "none") admitToolCall(event.id)
        })
      if (toolChoice === "none") {
        // Copilot requires a placeholder definition when history contains tool
        // calls. Preserve that wire compatibility while refusing all execution.
        const noop = prepared.tools._noop
        prepared.tools = noop
          ? {
              _noop: {
                ...noop,
                execute: () => {
                  throw new Error("Tools are disabled for this request")
                },
              },
            }
          : {}
      } else {
        // Gate the final tool set so registry, MCP, structured-output and native
        // execution all reserve from the same budget before any tool side effect.
        prepared.tools = Object.fromEntries(
          Object.entries(prepared.tools).map(([name, item]) => {
            const execute = item.execute
            if (!execute) return [name, item]
            return [
              name,
              {
                ...item,
                execute: (...args) => {
                  // A failed stream closes its request scope. Refuse any SDK
                  // callback that arrives after that scope has been aborted.
                  if (input.abort.aborted) throw new DOMException("Aborted", "AbortError")
                  const admission = admitToolCall(args[1].toolCallId)
                  if (!admission.allowed) throw new Error(ToolBudget.exhaustedMessage(toolBudget.max))
                  if (admission.executed) throw new Error(`Duplicate tool call: ${args[1].toolCallId}`)
                  admission.executed = true
                  input.onAttemptActivity?.("tool-executed")
                  return execute(...args)
                },
              } satisfies Tool,
            ]
          }),
        )
      }
      const compatibility = yield* plugin.contextFoldingCompatibility()
      const dynamicFolding = ConfigCompaction.resolveDynamic({
        disabledByEnvironment: Flag.OPENCODE_DISABLE_PRUNE,
        dynamic: cfg.compaction?.dynamic,
        prune: cfg.compaction?.prune,
        knownExternalDcp: compatibility.knownExternalDcp,
      })
      const folding = {
        enabled: dynamicFolding.enabled,
        purpose: input.purpose ?? ("unknown" as const),
        history: input.contextFolding,
        system:
          prepared.params.options.instructions === undefined
            ? ({ kind: "messages" } as const)
            : ({ kind: "instructions", value: prepared.params.options.instructions } as const),
      }
      const bridge = yield* EffectBridge.make()

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = yield* LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          contextFolding: folding,
          onThinkingInvalidated: input.onThinkingInvalidated,
          sessionID: input.sessionID,
          toolBatch: input.toolBatch,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo(
            "context folding",
            contextFoldingDiagnostic({
              runtime: "opencode-native",
              requestPurpose: folding.purpose,
              resolution: dynamicFolding,
              duplicatePlan: folding.history?.duplicatePlan,
              projectionPlan: native.contextFoldingPlan,
            }),
          )
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
            observeToolCall,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // One stream may contain multiple projections/tool rounds; errors never guess a projection or HTTP attempt.
      const diagnostic = {
        clientOperationID: randomUUID(),
        scope: "llm-stream",
        runtime: "ai-sdk",
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        apiModelID: input.model.api.id,
        sdk: input.model.api.npm,
        upstreamIdentity: "unobservable",
      }
      let projectionSeq = 0
      let thinking: ReturnType<typeof ThinkingReplay.project> | undefined
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        observeToolCall,
        bindThinking: (event: LLMEvent) => thinking?.bind(event) ?? event,
        result: streamText({
          // System messages are deliberately assembled by LLMRequestPrep.
          allowSystemInMessages: true,
          onError(error) {
            bridge.fork(
              Logging.backgroundDebug("thinking replay error", {
                ...diagnostic,
                errorChannel: "sdk-onError",
                ...ThinkingReplay.errorDiagnostic(error.error),
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            // Invalid tool *input* (a known tool whose arguments failed to
            // parse) is not repairable by renaming: returning null keeps the
            // original tool and error so the SDK emits an unexecuted invalid
            // tool-call. The lowercase-name repair below stays for unknown
            // tool names only.
            if (InvalidToolInputError.isInstance(failed.error)) {
              return null
            }
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async wrapStream({ doStream }) {
                  const response = await doStream()
                  if (!input.toolBatch) return response
                  const batch = input.toolBatch
                  const reader = response.stream.getReader()
                  let complete = false
                  return {
                    ...response,
                    stream: new ReadableStream({
                      async pull(controller) {
                        try {
                          const next = await reader.read()
                          if (next.done) {
                            if (!complete) batch.finish(false)
                            controller.close()
                            return
                          }
                          const part = next.value
                          if (part.type === "tool-call" && !part.providerExecuted) batch.add(part.toolCallId)
                          if (part.type === "finish") {
                            complete = true
                            batch.finish()
                          }
                          controller.enqueue(part)
                        } catch (error) {
                          batch.finish(false)
                          controller.error(error)
                        }
                      },
                      async cancel(reason) {
                        batch.finish(false)
                        await reader.cancel(reason)
                      },
                    }),
                  }
                },
                async transformParams(args) {
                  if (args.type === "stream") {
                    const sourceOrigins = ThinkingReplay.replayOrigins(args.params.prompt)
                    const sourceMessages = ContextFolding.copyModelMessages(args.params.prompt)
                    const transformed = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                    let outbound = transformed
                    let projectionPlan: ContextFoldingProjectionPlan | undefined
                    const snapshot =
                      folding.enabled && folding.history && folding.purpose === "conversation" && sourceMessages
                        ? ContextFolding.bindModelMessages(folding.history, sourceMessages)
                        : undefined
                    if (snapshot) {
                      const projected = ContextFolding.projectAISDK({
                        model: input.model,
                        purpose: folding.purpose,
                        snapshot,
                        messages: transformed,
                        sourceMessages: sourceMessages ?? [],
                        messageTransformOptions: prepared.messageTransformOptions,
                        tools: prepared.tools,
                        toolChoice,
                        maxOutputTokens: prepared.params.maxOutputTokens,
                        params: prepared.params,
                        system: folding.system,
                      })
                      projectionPlan = projected.plan
                      if (projected.applied) outbound = projected.request.messages
                    }
                    await bridge.promise(
                      Effect.logInfo(
                        "context folding",
                        contextFoldingDiagnostic({
                          runtime: "opencode-ai-sdk",
                          requestPurpose: folding.purpose,
                          resolution: dynamicFolding,
                          duplicatePlan: folding.history?.duplicatePlan,
                          projectionPlan,
                        }),
                      ),
                    )
                    {
                      const replay = ThinkingReplay.project({
                        messages: outbound,
                        sourceOrigins,
                        tools: args.params.tools,
                        context: {
                          provider: input.model.providerID,
                          model: input.model.api.id,
                          sdk: input.model.api.npm,
                        },
                      })
                      thinking = replay
                      if (replay.invalidated.length) {
                        if (!input.onThinkingInvalidated)
                          throw new Error("Thinking replay invalidation requires durable settlement")
                        await bridge.promise(input.onThinkingInvalidated(replay.invalidated))
                      }
                      await bridge.promise(
                        Logging.backgroundDebug("thinking replay projection", {
                          ...diagnostic,
                          projectionSeq: ++projectionSeq,
                          ...replay.diagnostic,
                        }),
                      )
                      outbound = replay.messages
                    }
                    // @ts-expect-error
                    args.params.prompt = outbound
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream.pipe(Stream.tap(result.observeToolCall))

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event, input.onAttemptActivity)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.map(result.bindThinking),
              Stream.tap(result.observeToolCall),
            )
          }),
        ),
      )

    const resolveOrganizer = Effect.fn("LLM.organizer")(function* (input: { model: Provider.Model }) {
      const selected = yield* provider.getSmallModel(input.model.providerID)
      if (!selected) return undefined
      // A declared no-reasoning variant keeps the organizer fast; otherwise it requests low effort.
      const effort = selected.variants?.none?.reasoningEffort === "none" ? "none" : "low"
      const timeoutMs = Flag.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS
      const [item, info] = yield* Effect.all(
        [provider.getProvider(selected.providerID), auth.get(selected.providerID)],
        {
          concurrency: "unbounded",
        },
      )
      const engine = LLMNativeRuntime.organizerClient({ model: selected, provider: item, auth: info, llmClient })
      if (engine.type === "supported")
        return {
          transport: "engine" as const,
          model: `${selected.providerID}/${selected.id}`,
          call: (signal: AbortSignal, onResponseStarted?: () => void) =>
            engineOrganizerCall({ llm: engine.llm, model: engine.model, effort, timeoutMs, signal, onResponseStarted }),
        }
      // Packages the engine does not route keep a provider-SDK fallback, isolated to this one call.
      const language = yield* provider.getLanguage(selected)
      return {
        transport: "ai-sdk" as const,
        model: `${selected.providerID}/${selected.id}`,
        call: (signal: AbortSignal, onResponseStarted?: () => void): OrganizeCall =>
          sdkOrganizerCall({
            model: language,
            maxOutputTokens: selected.limit.output || ReasoningDistillationPolicy.tokens.maxOutputTokens,
            effort,
            timeoutMs,
            signal,
            onResponseStarted,
          }),
      }
    })
    // An unavailable provider or credential skips the rewrite; it never falls back to the main model.
    const organizer: Interface["organizer"] = (input) =>
      resolveOrganizer(input).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return Service.of({ stream, organizer })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make(layer, [
  Auth.node,
  Config.node,
  Provider.node,
  Plugin.node,
  Permission.node,
  EventV2Bridge.node,
  llmClient,
  RuntimeFlags.node,
])

export * as LLM from "./llm"
