import { HookModelMetrics } from "@/hook/model-metrics"
import { HookSessionContext } from "@/hook/session-context"
import { Skill } from "@/skill"
import { Instruction } from "./instruction"
import { CompactionExport } from "./compaction-export"
import { CompactionFacts } from "./compaction-facts"
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
import { SessionRole } from "./role"
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
import { Injection } from "@graphagent/core/system-context/injection"
import { SettingsHook, type TriggerResult } from "@/hook"
import { hookBlock } from "@/hook/trigger-result"
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

const ACTIVE_WORKFLOW_STATUSES = new Set(["pending", "running", "paused", "stepping"])

const OVERFLOW_NOTE = "The previous request exceeded the provider's size limit. The conversation was compacted."
// The overflow note for a latest request that carries attachments.
const MEDIA_OVERFLOW_NOTE =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files."

// What opens the continuation text after an overflow: the media note when the latest request carries files. The note
// follows that request whether the text quotes it or the retained tail holds it.
const overflowNote = (latest: CompactionFacts.Request | undefined) =>
  latest?.attachments.length ? MEDIA_OVERFLOW_NOTE : OVERFLOW_NOTE

const requestLines = (label: string, request: CompactionFacts.Request) => [
  label,
  ...(request.text ? [request.text] : []),
  ...request.attachments,
]

// An empty list has no section; an older path the limit cut off is only counted.
const pathLines = (label: string, paths: readonly string[], omitted: number) =>
  paths.length === 0
    ? []
    : [label, ...(omitted > 0 ? [`- (+${omitted} older paths omitted)`] : []), ...paths.map((file) => `- ${file}`)]

// What the model resumes from after an automatic compaction. The requests, the task state and the files are facts the
// harness read; the summary lines after them are narrative and may be stale, so the latest request outranks them. That
// request is quoted only when the summary replaced it: the retained tail already holds it as the user wrote it. The
// last line says where the compacted messages can be read in full.
function continuationText(input: {
  summary: string | undefined
  requests: CompactionFacts.Requests
  todos: readonly Pick<Todo.Info, "content" | "status">[]
  workflows: readonly Pick<DagStore.WorkflowRow, "id" | "title" | "status">[]
  files: CompactionFacts.SessionFiles
  /** Opens the text after a provider overflow. */
  overflowNote?: string
  exportNote?: string
}) {
  const openTodos = input.todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
  const workflows = input.workflows.filter((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status))
  const goal = CompactionFacts.summaryItems(input.summary, "## Goal")[0]
  const progress = CompactionFacts.summaryItems(input.summary, "### In Progress")
  const next = CompactionFacts.summaryItems(input.summary, "## Next Steps")
  const pending = openTodos.length > 0 || workflows.length > 0 || progress.length > 0 || next.length > 0

  const lines = pending
    ? [
        "Continue the pending work only if the latest user request still calls for it.",
        "The latest user request takes precedence over the summary and task state below; do not resume work that it stopped or replaced.",
      ]
    : ["Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."]
  const { first, latest } = input.requests
  if (first) lines.push(...requestLines("Original task prompt:", first))
  if (latest) lines.push(...requestLines("Latest user request:", latest))
  const context: string[] = []
  if (openTodos.length) context.push("Open todos:", ...openTodos.map((todo) => `- ${todo.status}: ${todo.content}`))
  if (workflows.length)
    context.push(
      "Active workflows:",
      ...workflows.map((workflow) => `- ${workflow.status}: ${workflow.id} (${workflow.title})`),
    )
  context.push(...pathLines("Files changed in this session:", input.files.changed, input.files.omittedChanged))
  context.push(...pathLines("Files read in this session:", input.files.read, input.files.omittedRead))
  if (goal) context.push(`Summary goal: ${goal}`)
  if (progress.length) context.push("Summary in progress (may be stale):", ...progress.map((item) => `- ${item}`))
  if (next.length) context.push("Summary next steps (may be stale):", ...next.map((item) => `- ${item}`))
  if (context.length) lines.push("Context:", ...context)
  if (input.exportNote) lines.push(input.exportNote)
  const text = lines.join("\n")
  return input.overflowNote ? `${input.overflowNote}\n\n${text}` : text
}

/**
 * Skills whose bodies `messages` loaded through the skill tool (receipts
 * excluded): once those messages are summarized away the bodies are gone.
 */
export function loadedSkillNames(messages: readonly SessionV1.WithParts[]) {
  const names = new Set<string>()
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "skill" || part.state.status !== "completed") continue
      const { name, alreadyLoaded } = part.state.metadata
      if (typeof name === "string" && alreadyLoaded !== true) names.add(name)
    }
  return [...names].toSorted((a, b) => a.localeCompare(b))
}

export function skillContinuationNote(names: readonly string[]) {
  if (names.length === 0) return undefined
  return `Skills loaded earlier in this conversation are no longer in context: ${names.join(", ")}. Call the skill tool with the name to load one again when needed.`
}

function withSkillNote(text: string, head: readonly SessionV1.WithParts[]) {
  const note = skillContinuationNote(loadedSkillNames(head))
  return note === undefined ? text : `${text}\n\n${note}`
}

// Saves the messages the summary replaces and returns the note that tells the model where they are. An export that
// fails costs only the note: a path the model could not open is not worth giving, and the compaction still stands.
const exportHead = Effect.fnUntraced(function* (input: {
  sessionID: SessionID
  compactionID: MessageID
  messages: readonly SessionV1.WithParts[]
}) {
  // Nothing was replaced, so there is nothing to read back.
  if (input.messages.length === 0) return undefined
  const saved = yield* CompactionExport.write(input).pipe(Effect.exit)
  if (Exit.isSuccess(saved)) return CompactionExport.retrievalNote({ path: saved.value, sessionID: input.sessionID })
  yield* Effect.logWarning("compaction export failed", {
    sessionID: input.sessionID,
    compactionID: input.compactionID,
    cause: saved.cause,
  })
  return undefined
})

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

type UserTurn = {
  readonly info: SessionV1.User
  readonly parts: SessionV1.Part[]
  readonly index: number
}

type Replay = Pick<UserTurn, "info" | "parts">

// The latest real user turn before the marker. The marker is a user message too, but no turn.
function priorUserTurn(messages: readonly SessionV1.WithParts[], parentID: MessageID): UserTurn | undefined {
  for (let i = messages.findIndex((m) => m.info.id === parentID) - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"))
      return { info: msg.info, parts: msg.parts, index: i }
  }
  return undefined
}

// A provider overflow replays the prompt of the turn it hit, so that turn stays out of the summary input. Without
// an earlier turn there is nothing to summarize and nothing is replayed. A turn that already finished steps is not
// replayed either: its prompt would run them again, and the summary would never hear of them.
function overflowReplay(
  messages: SessionV1.WithParts[],
  parentID: MessageID,
): { replay: Replay | undefined; messages: SessionV1.WithParts[] } {
  const none = { replay: undefined, messages }
  const prior = priorUserTurn(messages, parentID)
  if (!prior) return none
  const marker = messages.findIndex((m) => m.info.id === parentID)
  if (messages.slice(prior.index + 1, marker).some((m) => m.info.role === "assistant" && m.info.finish)) return none
  const earlier = messages.slice(0, prior.index)
  if (!earlier.some((m) => m.info.role === "user" && !m.parts.some((part) => part.type === "compaction"))) return none
  return { replay: { info: prior.info, parts: prior.parts }, messages: earlier }
}

// Why a compaction attempt gives way to the next one, as the retry status names it.
function attemptFailure(input: { incomplete: boolean; refused: boolean; result: SessionProcessor.Result }) {
  if (input.incomplete) return "returned an incomplete summary"
  if (input.refused) return "attempted a tool call"
  return input.result === "timeout" ? "timed out" : "exceeded context"
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

    // The model `agent.compaction` names, when the catalog knows it. One it does not know leaves that stage out of the
    // ladder: the ladder skips stages without a model, and a model that cannot be resolved is such a stage.
    const resolveAgentModel = Effect.fnUntraced(function* (agent: Agent.Info) {
      if (!agent.model) return undefined
      const resolved = yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.exit)
      if (Exit.isSuccess(resolved)) return resolved.value
      yield* Effect.logWarning("compaction agent model unavailable", {
        providerID: agent.model.providerID,
        modelID: agent.model.modelID,
        cause: resolved.cause,
      })
      return undefined
    })

    // Settle the pending marker through the persisted message path. A leftover compaction part is
    // unfinished work for every later prompt, which would then run the compaction again and never finish it.
    const dropMarker = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      parentID: MessageID
      parent: SessionV1.WithParts
    }) {
      if (input.parent.parts.every((part) => part.type === "compaction"))
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: input.parentID })
      else
        for (const part of input.parent.parts)
          if (part.type === "compaction")
            yield* session.removePart({ sessionID: input.sessionID, messageID: input.parentID, partID: part.id })
    })

    // A PreCompact veto settles the pending marker; each branch below says who is told.
    const settleVetoedCompaction = Effect.fnUntraced(function* (
      input: ProcessInput & { parent: SessionV1.WithParts; blocked: NonNullable<TriggerResult["blocked"]> },
    ) {
      yield* dropMarker(input)
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
      if (current && SessionRole.isRoot(current)) {
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
          // The model sees the context in its hook block; an earlier turn may hold it as written before blocks existed.
          const block = hookBlock([text])
          const keys = [Hash.sha256(text), Hash.sha256(block)]
          if (keys.some((key) => seen.has(key))) continue
          // A long context copied verbatim into the summary is already model-visible.
          if (compacted && text.length >= 80 && compacted.includes(text)) continue
          for (const key of keys) seen.add(key)
          if (input.followUpID) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: input.followUpID,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: block,
              time: { start: Date.now(), end: Date.now() },
            })
          } else if (startContext) {
            // The queue holds the context as the hook wrote it; admission puts it in its block.
            yield* startContext.append(input.sessionID, text)
          }
        }
      }
    })

    // The text the summarizer stored in its assistant message; undefined when it stored none.
    const readSummary = Effect.fnUntraced(function* (sessionID: SessionID, msg: SessionV1.Assistant) {
      const stored = Option.getOrUndefined(
        yield* session.findMessage(sessionID, (item) => item.info.id === msg.id).pipe(Effect.orDie),
      )
      return summaryText(stored ?? { info: msg, parts: [] })
    })

    // Whether the finished summary is committed. A summary of the template's shape is. An incomplete one with text is
    // kept and logged, since the one retry is spent and the narrative still has its use. An empty one is never
    // committed: its message and the marker go, so the next prompt is not blocked by unfinished work, and the failure
    // is reported.
    const settleSummary = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      parentID: MessageID
      parent: SessionV1.WithParts
      msg: SessionV1.Assistant
      summary: string | undefined
    }) {
      if (CompactionFacts.validateSummary(input.summary)) return "ok" as const
      if (input.summary) {
        yield* Effect.logWarning("compaction summary incomplete", {
          sessionID: input.sessionID,
          model: `${input.msg.providerID}/${input.msg.modelID}`,
          length: input.summary.length,
        })
        return "ok" as const
      }
      yield* session.removeMessage({ sessionID: input.sessionID, messageID: input.msg.id })
      yield* dropMarker(input)
      yield* events.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: new NamedError.Unknown({ message: "Compaction produced an empty summary" }).toObject(),
      })
      yield* status.set(input.sessionID, { type: "idle" })
      return "stop" as const
    })

    // The follow-up user message of an automatic compaction: the replay of the prompt an overflow cut off or, without
    // one, the continuation text. Returns the new message's id.
    const appendFollowUp = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      parentID: MessageID
      messages: SessionV1.WithParts[]
      userMessage: SessionV1.User
      replay: Replay | undefined
      overflow: boolean
      summary: string | undefined
      head: readonly SessionV1.WithParts[]
      /** Tokens the quoted requests may take: what the retained tail may take. */
      budget: number
    }) {
      if (input.replay) {
        const original = input.replay.info
        const replayMsg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          hookMode: original.hookMode,
          format: original.format,
          tools: original.tools,
          system: original.system,
        })
        for (const part of input.replay.parts) {
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
        return replayMsg.id
      }

      // The facts come from the stored history as a whole: neither the summary nor the retained tail limits them.
      const todo = Option.getOrUndefined(yield* Effect.serviceOption(Todo.Service))
      const todos = todo ? yield* todo.get(input.sessionID) : []
      const dag = Option.getOrUndefined(yield* Effect.serviceOption(DagStore.Service))
      const workflows = dag ? yield* dag.listBySession(input.sessionID) : []
      const history = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      // A session that cannot be read counts as a root.
      const info = yield* session.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const ctx = yield* InstanceState.context
      // The retained tail stays in context; what the summary replaces is saved word for word, and the continuation
      // names the file, so a request cut short above or a detail the summary dropped can be read back.
      const exportNote = yield* exportHead({
        sessionID: input.sessionID,
        compactionID: input.parentID,
        messages: input.head,
      })
      const requests = CompactionFacts.requestsOf({
        messages: history,
        child: info !== undefined && SessionRole.isChild(info),
      })
      const body = continuationText({
        summary: input.summary,
        // A latest request the retained tail holds is in context as it was written: quoting it again would show the
        // model two copies, and the second one would take room from the budget.
        requests: CompactionFacts.fitRequests(CompactionFacts.quotedRequests(requests, input.head), input.budget),
        todos,
        workflows,
        files: CompactionFacts.sessionFiles({ messages: history, directory: ctx.directory }),
        overflowNote: input.overflow ? overflowNote(requests.latest) : undefined,
        exportNote,
      })
      const text = Injection.wrap("compaction", withSkillNote(body, input.head))
      // The turn's mode and request settings are read from its last user message, so the message that continues the
      // turn carries them, as the user messages a Stop hook or a DAG message appends do. They come from the turn's own
      // last user message: the marker holds only an agent and a model.
      const prior = priorUserTurn(input.messages, input.parentID)?.info
      const continueMsg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: input.userMessage.agent,
        model: input.userMessage.model,
        hookMode: prior?.hookMode,
        format: prior?.format,
        system: prior?.system,
        tools: prior?.tools,
      })
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
      return continueMsg.id
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
        memory && SessionRole.isRoot({ parentID: sessionInfo?.parentID })
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

      const { replay, messages } = input.overflow
        ? overflowReplay(input.messages, input.parentID)
        : { replay: undefined, messages: input.messages }

      const agent = yield* agents.get("compaction")
      if (!agent) return yield* Effect.die(new Error("Compaction agent is unavailable"))
      const conversationModel = yield* provider
        .getModel(userMessage.model.providerID, userMessage.model.modelID)
        .pipe(Effect.orDie)
      const smallModel = yield* provider.getSmallModel(conversationModel.providerID)
      const agentModel = yield* resolveAgentModel(agent)
      const cfg = yield* config.get()
      const mode = cfg.compaction?.mode ?? "small"
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const filteredHistory = history.filter((_, index) => !hidden.has(index))
      const nextPrompt = buildPrompt({ previousSummary, context: memoryContext })
      const ctx = yield* InstanceState.context
      // Without a configured mode the ladder starts with the agent and conversation models; a configured mode keeps
      // the legacy order, small model first. A duplicated model is tried once, under its earliest role.
      const clean = SessionCompactionModel.cleanCandidates({
        configured: cfg.compaction?.mode,
        small: smallModel,
        agent: agentModel,
        conversation: conversationModel,
      })
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
      let retried = false
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
        // A finished summary of the wrong shape is asked for once more, on the same model, before the stage's
        // result stands. The retry takes the next slot of the plan and does not use up the ladder behind it.
        const incomplete =
          result === "continue" &&
          !refused &&
          !retried &&
          !CompactionFacts.validateSummary(yield* readSummary(input.sessionID, msg))
        if (!failed && !incomplete) break
        if (incomplete) {
          retried = true
          plan.splice(attempt + 1, 0, entry)
        }
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
        const reason = attemptFailure({ incomplete, refused, result })
        yield* status.set(input.sessionID, {
          type: "retry",
          attempt,
          message: `Compaction ${reason}; ${incomplete ? "retrying with" : "switching to"} ${plan[attempt].model.providerID}/${plan[attempt].model.id}`,
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

      const summary = yield* readSummary(input.sessionID, msg)
      if (
        result === "continue" &&
        (yield* settleSummary({ sessionID: input.sessionID, parentID: input.parentID, parent, msg, summary })) ===
          "stop"
      )
        return "stop"

      if (result === "continue" && compactionPart && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      // Auto-compaction may append a follow-up user message (overflow replay or the synthetic "continue" prompt).
      // SessionStart(compact) contexts attach to it so they sit after the summary in model input; without one they
      // are queued.
      const followUpID =
        result === "continue" && input.auto
          ? yield* appendFollowUp({
              sessionID: input.sessionID,
              parentID: input.parentID,
              messages: input.messages,
              userMessage,
              replay,
              overflow: input.overflow === true,
              summary,
              head: selected.head,
              budget: preserveRecentBudget({ cfg, model: conversationModel }),
            })
          : undefined

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
