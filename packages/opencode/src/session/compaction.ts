import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ConfigReasoningDistillation } from "@opencode-ai/core/config/reasoning-distillation"
import { Flag } from "@opencode-ai/core/flag/flag"

import { Effect, Layer, Context } from "effect"
import * as Option from "effect/Option"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, measured, triggerLimit, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { Memory } from "@/memory/memory"
import { SessionStatus } from "./status"

export const Event = SessionCompactionEvent

const TOOL_OUTPUT_MAX_CHARS = 2_000
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
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
    threshold?: "auto" | "model"
  }) => Effect.Effect<boolean>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const status = yield* SessionStatus.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const reasoningDistillationEnabled = (cfg: ConfigV1.Info, model: Provider.Model) =>
      ConfigReasoningDistillation.resolveEnabled({
        disabledByEnvironment: Flag.OPENCODE_DISABLE_REASONING_DISTILLATION,
        enabled: cfg.reasoningDistillation?.enabled,
        modelEnabled: cfg.provider?.[model.providerID]?.models?.[model.id]?.reasoningDistillation?.enabled,
        modelID: model.id,
        apiModelID: model.api.id,
      }).enabled

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
      estimatedInputTokens?: number
      threshold?: "auto" | "model"
    }) {
      const cfg = yield* config.get()
      const request = {
        cfg,
        tokens: input.tokens,
        model: input.model,
        estimatedInputTokens: input.estimatedInputTokens,
        threshold: input.threshold,
        outputTokenMax: flags.outputTokenMax,
      }
      const triggered = overflow(request)
      if (triggered) {
        yield* Effect.logInfo("automatic compaction threshold reached", {
          modelUsableTokens: usable(request),
          triggerTokens: triggerLimit(request),
          measuredTokens: measured(input.tokens),
          estimatedInputTokens: input.estimatedInputTokens,
          thresholdMode: input.threshold ?? "auto",
        })
      }
      return triggered
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model, {
        reasoningDistillationEnabled: reasoningDistillationEnabled(yield* config.get(), input.model),
      })
      return Token.estimate(JSON.stringify(msgs))
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

      // PreCompact hook. processCompaction has no custom-instruction channel, so
      // custom_instructions defaults to "" (CC behavior) in the envelope builder.
      if (settingsHook) {
        const preResult = yield* settingsHook
          .trigger(
            { event: "PreCompact", trigger: input.auto ? "auto" : "manual" },
            { sessionID: input.sessionID, transcriptPath: "" },
          )
          .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] } as TriggerResult)))
        yield* SettingsHook.landSystemMessages(preResult, { sessionID: input.sessionID })
        if (preResult.blocked) return "stop"
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
      const conversationModel = yield* provider
        .getModel(userMessage.model.providerID, userMessage.model.modelID)
        .pipe(Effect.orDie)
      const smallModel = yield* provider.getSmallModel(conversationModel.providerID)
      const agentModel = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : undefined
      const models = [smallModel, agentModel, conversationModel].filter(
        (candidate, index, all): candidate is Provider.Model =>
          candidate !== undefined &&
          all.findIndex((item) => item?.id === candidate.id && item.providerID === candidate.providerID) === index,
      )
      const model = models[0]
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const filteredHistory = history.filter((_, index) => !hidden.has(index))
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: memoryContext, prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const ctx = yield* InstanceState.context
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
      let recent = ""
      let selected: { head: SessionV1.WithParts[]; tail_start_id: MessageID | undefined }
      while (true) {
        const candidate = models[attempt]
        selected = yield* select({ messages: filteredHistory, cfg, model: candidate, conversationModel })
        const msgs = structuredClone(selected.head)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const tailIndex = selected.tail_start_id
          ? history.findIndex((message) => message.info.id === selected.tail_start_id)
          : -1
        msg = {
          ...template,
          id: MessageID.ascending(),
          modelID: candidate.id,
          providerID: candidate.providerID,
          time: { created: Date.now() },
        }
        yield* session.updateMessage(msg)
        processor = yield* processors.create({ assistantMessage: msg, sessionID: input.sessionID, model: candidate })
        const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, candidate, {
          stripMedia: true,
          toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
          reasoningDistillationEnabled: reasoningDistillationEnabled(cfg, candidate),
        })
        recent =
          tailIndex < 0
            ? ""
            : JSON.stringify(
                yield* MessageV2.toModelMessagesEffect(history.slice(tailIndex), candidate, {
                  stripMedia: true,
                  toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
                  reasoningDistillationEnabled: reasoningDistillationEnabled(cfg, candidate),
                }),
              )
        result = yield* processor.process({
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
        })
        if (result !== "timeout" && result !== "compact") break
        if (attempt + 1 >= models.length) {
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
        yield* status.set(input.sessionID, {
          type: "retry",
          attempt,
          message: `Compaction ${result === "timeout" ? "timed out" : "exceeded context"}; switching to ${models[attempt].providerID}/${models[attempt].id}`,
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
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
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
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        if (flags.experimentalEventSystem) {
          if (summary)
            yield* events.publish(SessionEvent.Compaction.Ended, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.make(input.parentID),
              timestamp: DateTime.makeUnsafe(Date.now()),
              reason: input.auto ? "auto" : "manual",
              text: summary ?? "",
              recent,
            })
        }
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
        // PostCompact hook
        if (settingsHook) {
          const pcResult = yield* settingsHook
            .trigger(
              {
                event: "PostCompact",
                trigger: input.auto ? "auto" : "manual",
                compactSummary: summary ?? "compaction completed",
              } as any,
              { sessionID: input.sessionID, transcriptPath: "" },
            )
            .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
          yield* SettingsHook.landSystemMessages(pcResult, { sessionID: input.sessionID })
        }
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
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.make(msg.id),
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
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
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Session.node,
  Agent.node,
  Plugin.node,
  SessionProcessor.node,
  Provider.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Memory.node,
  SettingsHook.node,
  SessionStatus.node,
])

export * as SessionCompaction from "./compaction"
