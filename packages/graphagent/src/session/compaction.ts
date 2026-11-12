import { HookModelMetrics } from "@/hook/model-metrics"
import { HookSessionContext } from "@/hook/session-context"
import { Skill } from "@/skill"
import { Instruction } from "./instruction"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ConfigReasoningDistillation } from "@graphagent/core/config/reasoning-distillation"
import { Flag } from "@graphagent/core/flag/flag"
import { NamedError } from "@graphagent/core/util/error"
import { Hash } from "@graphagent/core/util/hash"
import { DagStore } from "@graphagent/core/dag/store"

import { Effect, Exit, Layer, Context } from "effect"
import * as Option from "effect/Option"
import type { ModelMessage } from "ai"
import { EngineProcess } from "./engine-process"
import { SessionCompactionModel } from "./compaction-model"
import type { LLM } from "./llm"
import type { RequestPrefix } from "./runtime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, measured, triggerLimit, usable } from "./overflow"
import { serviceUse } from "@graphagent/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { buildPrompt } from "@graphagent/core/session/compaction-prompt"
import { SessionCompactionEvent } from "@graphagent/schema/session-compaction-event"
import { SettingsHook, HOOK_REWAKE_SENTINEL, type TriggerResult } from "@/hook"
import { HookStartContext } from "@/hook/start-context"
import { Memory } from "@/memory/memory"
import { SessionStatus } from "./status"
import { Todo } from "./todo"

export const Event = SessionCompactionEvent

const TOOL_OUTPUT_MAX_CHARS = 2_000
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000

// The shared request keeps the main request's system text and tools, so the
// compaction agent prompt cannot carry the role constraints. Repeat them in
// the directive instead: summarize, never answer or call tools, follow the
// template. The directive comes before the generated prompt (Issue #1028, PR5).
const SHARED_DIRECTIVE = `You summarize coding-session context so work can continue.

Summarize only the supplied conversation history. Newest turns may remain verbatim outside the summary. Focus on older context that still matters.

Do not answer the conversation. Do not call tools. Do not mention summarization, compaction, or merging. Use the conversation's language and follow the requested output structure exactly.`

/**
 * Compaction request that reuses the main conversation request's cached
 * prefix (system text and tools). Only the trailing directive is new, and the
 * conversation messages are converted exactly as the main request converted
 * them. Tool execution is refused so a model that ignores the directive falls
 * back to a clean request instead of persisting a summary.
 */
function sharedCompactionInput(input: {
  prefix: RequestPrefix
  user: SessionV1.User
  sessionID: SessionID
  model: Provider.Model
  messages: ModelMessage[]
  prompt: string
  onToolRefused: () => void
}): LLM.StreamInput {
  return {
    // The carrier message keeps the parent identity but not its system text:
    // that text is already part of the recorded prefix below.
    user: { ...input.user, system: undefined },
    agent: input.prefix.agent,
    permission: input.prefix.permission,
    nativePermission: input.prefix.nativePermission,
    sessionID: input.sessionID,
    // `LLMRequestPrep.prepare` appends the per-message system text after the
    // recorded system array; the compaction carrier has none of its own.
    system: [...input.prefix.system, ...(input.prefix.userSystem ? [input.prefix.userSystem] : [])],
    messages: [
      ...input.messages,
      {
        role: "user",
        content: [{ type: "text", text: `${SHARED_DIRECTIVE}\n\n${input.prompt}` }],
      },
    ],
    tools: input.prefix.tools,
    toolChoice: input.prefix.toolChoice,
    model: input.model,
    purpose: "compaction",
    retries: 0,
    toolPolicy: "refuse",
    onToolRefused: input.onToolRefused,
  }
}
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

// Reads the compacted summary's pending-work sections. Only bullets under the exact
// headings count; a heading or a "(none)" placeholder ends the section.
function summaryItems(summary: string | undefined, heading: string) {
  if (!summary) return []
  const lines = summary.split("\n")
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const text = line.trim()
    if (!text) continue
    if (text.startsWith("#")) break
    if (!text.startsWith("- ")) continue
    const item = text.slice(2).trim()
    if (!item || item === "(none)") continue
    items.push(item)
  }
  return items
}

const ACTIVE_WORKFLOW_STATUSES = new Set(["pending", "running", "paused", "stepping"])
// The latest request is quoted verbatim and labeled authoritative. Above this explicit
// budget the continuation is omitted instead of quoting a prefix as if it were the request.
const AUTHORITATIVE_REQUEST_MAX_CHARS = 2_000

// Returns the newest real user turn's request, null when that turn cannot be
// represented as text (attachments, mixed or non-text parts), or undefined when no
// real user turn exists. Internal rewake prompts are not user turns.
function latestUserRequest(messages: readonly SessionV1.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    if (message.parts.some((part) => part.type === "compaction" || part.type === "subtask")) continue

    const textParts = message.parts.flatMap((part) =>
      part.type === "text" && !part.synthetic && !part.ignored ? [part] : [],
    )
    // Attachments, tool output and mixed parts are a real turn we cannot represent;
    // never inspect their data for the rewake sentinel.
    if (message.parts.some((part) => part.type !== "text")) return null
    // Synthetic-only or ignored-only turns are internal (auto-continue, injected
    // context), not user requests.
    if (!textParts.length) continue
    // The internal rewake convention prefixes the assembled original text.
    if (
      textParts
        .map((part) => part.text)
        .join("\n")
        .startsWith(HOOK_REWAKE_SENTINEL)
    )
      continue
    const text = textParts
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    return text || null
  }
  return undefined
}

function pendingContinuation(input: {
  summary: string | undefined
  request: string | null | undefined
  todos: readonly Pick<Todo.Info, "content" | "status">[]
  workflows: readonly Pick<DagStore.WorkflowRow, "id" | "title" | "status">[]
}) {
  // The newest user turn could not be represented safely (attachments or mixed parts).
  if (input.request === null) return undefined
  // A prefix of the request can drop later restrictions. Do not reconstruct it.
  if (input.request && input.request.length > AUTHORITATIVE_REQUEST_MAX_CHARS) return undefined

  const openTodos = input.todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
  const workflows = input.workflows.filter((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status))
  const goal = summaryItems(input.summary, "## Goal")[0]
  const progress = summaryItems(input.summary, "### In Progress")
  const next = summaryItems(input.summary, "## Next Steps")
  if (!openTodos.length && !workflows.length && !progress.length && !next.length) return undefined

  const lines = [
    "Continue the pending work only if the latest user request still calls for it.",
    "The latest user request takes precedence over the summary and task state below; do not resume work that it stopped or replaced.",
  ]
  if (input.request) lines.push("Latest user request:", input.request)
  const context: string[] = []
  if (openTodos.length) context.push("Open todos:", ...openTodos.map((todo) => `- ${todo.status}: ${todo.content}`))
  if (workflows.length)
    context.push(
      "Active workflows:",
      ...workflows.map((workflow) => `- ${workflow.status}: ${workflow.id} (${workflow.title})`),
    )
  if (goal) context.push(`Summary goal: ${goal}`)
  if (progress.length) context.push("Summary in progress (may be stale):", ...progress.map((item) => `- ${item}`))
  if (next.length) context.push("Summary next steps (may be stale):", ...next.map((item) => `- ${item}`))
  if (context.length) lines.push("Context:", ...context)
  return lines.join("\n")
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start].info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
    estimatedInputTokens?: number
  }) => Effect.Effect<boolean>
  /** "declined": a PreCompact hook vetoed an automatic compaction; the caller continues uncompacted. */
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop" | "declined">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionCompaction") {}

export const use = serviceUse(Service)

type ProcessInput = Parameters<Interface["process"]>[0]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const status = yield* SessionStatus.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const instruction = Option.getOrUndefined(yield* Effect.serviceOption(Instruction.Service))
    const startContext = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    const reasoningDistillationEnabled = (cfg: ConfigV1.Info, model: Provider.Model) =>
      ConfigReasoningDistillation.resolveEnabled({
        disabledByEnvironment: Flag.GRAPHAGENT_DISABLE_REASONING_DISTILLATION,
        enabled: cfg.reasoningDistillation?.enabled,
        modelEnabled: cfg.provider?.[model.providerID]?.models?.[model.id]?.reasoningDistillation?.enabled,
      }).enabled

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
      estimatedInputTokens?: number
    }) {
      const cfg = yield* config.get()
      const request = {
        cfg,
        tokens: input.tokens,
        model: input.model,
        estimatedInputTokens: input.estimatedInputTokens,
        outputTokenMax: flags.outputTokenMax,
      }
      const triggered = overflow(request)
      if (triggered) {
        yield* Effect.logInfo("automatic compaction threshold reached", {
          modelUsableTokens: usable(request),
          triggerTokens: triggerLimit(request),
          measuredTokens: measured(input.tokens),
          estimatedInputTokens: input.estimatedInputTokens,
        })
      }
      return triggered
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      // The retained tail outlives the compaction request: media and other parts stay in the session and
      // are sent again by later requests, so size the tail as it is persisted. Only the estimator's
      // calibration is shared with the request gate: it must not undercount CJK text.
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model, {
        reasoningDistillationEnabled: reasoningDistillationEnabled(yield* config.get(), input.model),
      })
      return Token.estimateReserve(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
      conversationModel: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const models = input.model === input.conversationModel ? [input.model] : [input.model, input.conversationModel]
      const budget = Math.min(...models.map((model) => preserveRecentBudget({ cfg: input.cfg, model })))
      const estimateTail = (part: { messages: SessionV1.WithParts[] }) =>
        Effect.forEach(models, (model) => estimate({ messages: part.messages, model }), { concurrency: 1 }).pipe(
          Effect.map((sizes) => Math.max(...sizes)),
        )
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimateTail({
            messages: input.messages.slice(turn.start, turn.end),
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate: estimateTail,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // The shared prefix is usable only while all four guards hold: a snapshot
    // exists, it belongs to this instance directory, the triggering turn used
    // the recorded agent, and the recorded model still resolves. Otherwise the
    // compaction skips the shared request entirely and uses a clean one.
    const resolveSharedPrefix = Effect.fn("SessionCompaction.sharedPrefix")(function* (input: {
      sessionID: SessionID
      directory: string
      agent: string
    }) {
      const prefix = EngineProcess.runtimes.requestPrefixes.get(input.sessionID)
      if (!prefix) return undefined
      if (prefix.directory !== input.directory) return undefined
      if (prefix.agent.name !== input.agent) return undefined
      const resolved = yield* provider.getModel(prefix.model.providerID, prefix.model.id).pipe(Effect.exit)
      if (Exit.isFailure(resolved)) return undefined
      if (resolved.value.providerID !== prefix.model.providerID || resolved.value.id !== prefix.model.id)
        return undefined
      return { prefix, model: resolved.value }
    })

    // A PreCompact veto settles the pending marker; each branch below says who is told.
    const settleVetoedCompaction = Effect.fnUntraced(function* (
      input: ProcessInput & { parent: SessionV1.WithParts; blocked: NonNullable<TriggerResult["blocked"]> },
    ) {
      // Settle the pending marker through the persisted message path. A leftover compaction part is
      // unfinished work for every later prompt, which would then be vetoed again and never answered.
      if (input.parent.parts.every((part) => part.type === "compaction"))
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: input.parentID })
      else
        for (const part of input.parent.parts)
          if (part.type === "compaction")
            yield* session.removePart({ sessionID: input.sessionID, messageID: input.parentID, partID: part.id })
      const reason = input.blocked.reason.trim() || "PreCompact hook blocked compaction"
      if (!input.auto) {
        // Manual /compact shows the hook's reason to the user.
        yield* events.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Compaction blocked by hook: ${reason}` }).toObject(),
        })
      } else if (input.overflow) {
        // Recovery from an API context-limit error: the failure stands. The provider error was already
        // published; persist the terminal state on the request that overflowed.
        const failed = input.messages.findLast(
          (item) => item.info.role === "assistant" && !item.info.finish && !item.info.summary,
        )
        if (failed && failed.info.role === "assistant")
          yield* session.updateMessage({
            ...failed.info,
            error: new SessionV1.ContextOverflowError({
              message: `Context limit exceeded and compaction was blocked by hook: ${reason}`,
            }).toObject(),
            finish: "error",
          })
      }
      if (input.auto && !input.overflow) return "declined" as const
      yield* status.set(input.sessionID, { type: "idle" })
      return "stop" as const
    })

    // PostCompact sees the committed compacted conversation, not the pre-compaction snapshot.
    const runPostCompactHooks = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      auto: boolean
      summary: string | undefined
      conversationModel: Provider.Model
      followUpID: MessageID | undefined
    }) {
      if (!settingsHook) return
      const postMessages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const pcResult = yield* settingsHook
        .trigger(
          {
            event: "PostCompact",
            trigger: input.auto ? "auto" : "manual",
            compactSummary: input.summary ?? "",
          } as any,
          { sessionID: input.sessionID },
        )
        .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
      yield* SettingsHook.landSystemMessages(pcResult, { sessionID: input.sessionID })

      // SessionStart(compact): Claude Code re-fires SessionStart after compaction so
      // hooks can re-inject context the summary dropped. Top-level sessions only
      // (subagents never fire SessionStart). A hook failure must not fail compaction.
      // A session that cannot be read (e.g. deleted meanwhile) skips the hook instead of failing.
      const current = yield* session.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (current && !current.parentID) {
        const ssResult = yield* settingsHook
          .trigger(
            {
              event: "SessionStart",
              source: "compact",
              // Top-level only (checked above): report the DAG mode read-only.
              ...(current.dagMode !== undefined ? { dagMode: current.dagMode } : {}),
              ...(yield* HookModelMetrics.forSession({
                source: "compact",
                sessionID: current.id,
                title: current.title,
                titleSource: current.metadata?.hookTitleSource,
                model: current.model ?? {
                  providerID: input.conversationModel.providerID,
                  id: input.conversationModel.id,
                },
                agent: current.agent,
                history: postMessages,
              })),
            },
            { sessionID: input.sessionID },
          )
          .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
        yield* SettingsHook.landSystemMessages(ssResult, { sessionID: input.sessionID })
        const skills = Option.getOrUndefined(yield* Effect.serviceOption(Skill.Service))
        yield* HookSessionContext.applyStart({
          session: current,
          sessions: session,
          settings: settingsHook,
          result: ssResult,
          reloadSkills: skills?.reload(),
        })
        const seen = new Set<string>()
        for (const message of MessageV2.filterCompacted([...postMessages].reverse()))
          for (const part of message.parts)
            if (part.type === "text" && part.synthetic) seen.add(Hash.sha256(part.text.trim()))
        const compacted = input.summary?.trim()
        for (const ctx of ssResult.additionalContexts ?? []) {
          const text = ctx.trim()
          if (!text) continue
          const key = Hash.sha256(text)
          if (seen.has(key)) continue
          // A long context copied verbatim into the summary is already model-visible.
          if (compacted && text.length >= 80 && compacted.includes(text)) continue
          seen.add(key)
          if (input.followUpID) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: input.followUpID,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text,
              time: { start: Date.now(), end: Date.now() },
            })
          } else if (startContext) {
            yield* startContext.append(input.sessionID, text)
          }
        }
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
      const sessionInfo = memory ? yield* session.get(input.sessionID).pipe(Effect.orDie) : undefined
      const memoryContext =
        memory && !sessionInfo?.parentID
          ? yield* memory.checkpoint({
              sessionID: input.sessionID,
              messages: input.messages,
            })
          : []

      // Current compaction entry points supply no custom instructions; the wire value is null.
      if (settingsHook) {
        const preResult = yield* settingsHook
          .trigger(
            { event: "PreCompact", trigger: input.auto ? "auto" : "manual", customInstructions: null },
            { sessionID: input.sessionID },
          )
          .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
        yield* SettingsHook.landSystemMessages(preResult, { sessionID: input.sessionID })
        if (preResult.blocked) return yield* settleVetoedCompaction({ ...input, parent, blocked: preResult.blocked })
      }

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      if (!agent) return yield* Effect.die(new Error("Compaction agent is unavailable"))
      const conversationModel = yield* provider
        .getModel(userMessage.model.providerID, userMessage.model.modelID)
        .pipe(Effect.orDie)
      const smallModel = yield* provider.getSmallModel(conversationModel.providerID)
      const agentModel = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : undefined
      const cfg = yield* config.get()
      const mode = cfg.compaction?.mode ?? "small"
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const filteredHistory = history.filter((_, index) => !hidden.has(index))
      const nextPrompt = buildPrompt({ previousSummary, context: memoryContext })
      const ctx = yield* InstanceState.context
      // Clean candidates keep the legacy preference order. A duplicated model
      // is tried once, under its earliest role.
      const clean: SessionCompactionModel.CleanCandidate<Provider.Model>[] = []
      for (const [kind, candidate] of [
        ["small", smallModel],
        ["agent", agentModel],
        ["conversation", conversationModel],
      ] as const) {
        if (!candidate) continue
        if (clean.some((entry) => entry.model.providerID === candidate.providerID && entry.model.id === candidate.id))
          continue
        clean.push({ model: candidate, kind })
      }
      const model = clean[0].model
      const shared =
        mode === "small"
          ? undefined
          : yield* resolveSharedPrefix({
              sessionID: input.sessionID,
              directory: ctx.directory,
              agent: userMessage.agent,
            })
      const promptTokens =
        mode === "small" ? 0 : yield* estimate({ messages: filteredHistory, model: conversationModel })
      // `small` never enters the cost selector; it keeps the pre-PR ladder
      // exactly. `shared` puts the shared attempt first; `auto` prices both.
      const plan: SessionCompactionModel.PlanEntry<Provider.Model>[] =
        mode === "small"
          ? clean.map((entry) => ({ ...entry, shared: false, estimatedCost: 0 }))
          : SessionCompactionModel.chooseCompactionModel({
              mode,
              clean,
              shared: shared && { model: shared.model, prefixTokens: shared.prefix.prefixTokens },
              promptTokens,
              warm: !input.overflow,
            })
      const template = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      } satisfies SessionV1.Assistant
      let attempt = 0
      let msg: SessionV1.Assistant = template
      let processor: SessionProcessor.Handle
      let result: SessionProcessor.Result
      let selected: { head: SessionV1.WithParts[]; tail_start_id: MessageID | undefined }
      while (true) {
        const entry = plan[attempt]
        const candidate = entry.model
        selected = yield* select({ messages: filteredHistory, cfg, model: candidate, conversationModel })
        const msgs = structuredClone(selected.head)
        msg = {
          ...template,
          id: MessageID.ascending(),
          modelID: candidate.id,
          providerID: candidate.providerID,
          time: { created: Date.now() },
        }
        yield* session.updateMessage(msg)
        processor = yield* processors.create({ assistantMessage: msg, sessionID: input.sessionID, model: candidate })
        // The shared request must convert history exactly like the main
        // request so the provider sees the same prefix. A clean request keeps
        // its size-reducing options.
        const modelMessages = yield* MessageV2.toModelMessagesEffect(
          msgs,
          candidate,
          entry.shared
            ? { reasoningDistillationEnabled: reasoningDistillationEnabled(cfg, candidate) }
            : {
                stripMedia: true,
                toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
                reasoningDistillationEnabled: reasoningDistillationEnabled(cfg, candidate),
                stripOpaqueReasoning: true,
              },
        )
        let refused = false
        result = yield* processor.process(
          entry.shared && shared
            ? sharedCompactionInput({
                prefix: shared.prefix,
                user: userMessage,
                sessionID: input.sessionID,
                model: candidate,
                messages: modelMessages,
                prompt: nextPrompt,
                onToolRefused: () => {
                  refused = true
                },
              })
            : {
                user: userMessage,
                agent,
                sessionID: input.sessionID,
                tools: {},
                system: [],
                messages: [
                  ...modelMessages,
                  {
                    role: "user",
                    content: [{ type: "text", text: nextPrompt }],
                  },
                ],
                model: candidate,
                purpose: "compaction",
                retries: 0,
              },
        )
        // A refused tool call invalidates the shared attempt even when the
        // stream finished normally: its summary must never be persisted.
        const failed = result === "timeout" || result === "compact" || refused
        if (!failed) break
        if (attempt + 1 >= plan.length) {
          if (refused) {
            yield* session.removeMessage({ sessionID: input.sessionID, messageID: msg.id })
            yield* events.publish(Session.Event.Error, {
              sessionID: input.sessionID,
              error: new NamedError.Unknown({
                message: "Compaction shared request attempted a tool call",
              }).toObject(),
            })
            yield* status.set(input.sessionID, { type: "idle" })
            return "stop"
          }
          if (result === "timeout") {
            if (processor.message.error)
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: processor.message.error })
            yield* status.set(input.sessionID, { type: "idle" })
            return "stop"
          }
          break
        }
        // Failed/partial summaries must never become future compaction input.
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: msg.id })
        attempt++
        const reason = refused ? "attempted a tool call" : result === "timeout" ? "timed out" : "exceeded context"
        yield* status.set(input.sessionID, {
          type: "retry",
          attempt,
          message: `Compaction ${reason}; switching to ${plan[attempt].model.providerID}/${plan[attempt].model.id}`,
          next: Date.now(),
        })
      }

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        yield* status.set(input.sessionID, { type: "idle" })
        return "stop"
      }

      if (result === "continue" && compactionPart && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      const storedSummary = Option.getOrUndefined(
        yield* session.findMessage(input.sessionID, (item) => item.info.id === msg.id).pipe(Effect.orDie),
      )
      const summary = summaryText(storedSummary ?? { info: msg, parts: [] })
      const requestMessage = Option.getOrUndefined(
        yield* session
          .findMessage(input.sessionID, (item) => latestUserRequest([item]) !== undefined)
          .pipe(Effect.orDie),
      )
      const request = requestMessage ? latestUserRequest([requestMessage]) : undefined
      const todo = Option.getOrUndefined(yield* Effect.serviceOption(Todo.Service))
      const todos = todo ? yield* todo.get(input.sessionID) : []
      const dag = Option.getOrUndefined(yield* Effect.serviceOption(DagStore.Service))
      const workflows = dag ? yield* dag.listBySession(input.sessionID) : []

      // Auto-compaction may append a follow-up user message (overflow replay or the
      // synthetic "continue" prompt). SessionStart(compact) contexts attach to it so
      // they sit after the summary in model input; without one they are queued.
      let followUpID: MessageID | undefined
      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          followUpID = replayMsg.id
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const continueMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: userMessage.agent,
            model: userMessage.model,
          })
          followUpID = continueMsg.id
          const text =
            (input.overflow
              ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
              : "") +
            (pendingContinuation({
              summary,
              request,
              todos,
              workflows,
            }) ??
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.")
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: continueMsg.id,
            sessionID: input.sessionID,
            type: "text",
            // Internal marker for auto-compaction followups.
            metadata: { compaction_continue: true },
            synthetic: true,
            text,
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          })
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        // The committed summary replaces the context the prefix was recorded
        // for; the next conversation request records a fresh one.
        EngineProcess.runtimes.forgetRequestPrefix(input.sessionID)
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
        // The committed summary drops earlier context; the next system prompt reloads instruction files.
        if (instruction) yield* instruction.markCompacted(input.sessionID)
        yield* runPostCompactHooks({
          sessionID: input.sessionID,
          auto: input.auto,
          summary,
          conversationModel,
          followUpID,
        })
      }
      return result === "continue" ? "continue" : "stop"
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(HookStartContext.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Session.node,
  Agent.node,
  SessionProcessor.node,
  Provider.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Memory.node,
  SettingsHook.node,
  HookStartContext.node,
  SessionStatus.node,
  Instruction.node,
])

export * as SessionCompaction from "./compaction"
