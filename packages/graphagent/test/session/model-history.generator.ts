// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { Provider } from "@/provider/provider"
import { freeze } from "../../src/session/history/freeze"
import type { MessageID, SessionID } from "../../src/session/schema"
import { MessageID as MessageIDValue, PartID, SessionID as SessionIDValue } from "../../src/session/schema"
import type { ToModelMessagesOptions } from "../../src/session/message-v2"

/**
 * Deterministic random operation sequences over a conversation view (Issue
 * #1022, PR4). The property test converts the same view through the cache and
 * through the batched oracle and compares the wire messages; this generator
 * only produces valid session shapes, never expected output.
 */

export type Operation =
  | "user-text"
  | "assistant-text"
  | "assistant-reasoning"
  | "assistant-tool"
  | "assistant-media-tool"
  | "compaction"
  | "summary"
  | "user-image"
  | "revert"
  | "model"
  | "options"
  | "rebuild"
  | "noop"

const OPERATIONS: readonly Operation[] = [
  "user-text",
  "user-text",
  "assistant-text",
  "assistant-text",
  "assistant-reasoning",
  "assistant-tool",
  "assistant-media-tool",
  "compaction",
  "summary",
  "user-image",
  "revert",
  "model",
  "options",
  "rebuild",
  "noop",
]

export interface Rng {
  next(): number
  int(maxExclusive: number): number
  pick<T>(items: readonly T[]): T
  chance(probability: number): boolean
}

/** Linear congruential generator so every run and every CI replay is identical. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (probability) => next() < probability,
  }
}

const providerID = ProviderV2.ID.make("test")

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const xaiModel: Provider.Model = {
  ...baseModel,
  id: ModelV2.ID.make("test-xai-model"),
  api: { ...baseModel.api, id: "test-xai-model", npm: "@ai-sdk/xai" },
}

const mediaUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
const pdfUrl = "data:application/pdf;base64,JVBERi0xLjQK"

export interface Scenario {
  readonly sessionID: SessionID
  /** Next random operation; returns the label it applied. */
  step(): Operation
  /** Frozen history of the current draft, as the request path builds it. */
  view(): SessionV1.WithParts[]
  readonly model: Provider.Model
  readonly options: ToModelMessagesOptions
}

export function makeScenario(seed: number, sessionID: SessionID): Scenario {
  const rng = makeRng(seed)
  const draft: SessionV1.WithParts[] = []
  let clock = 0
  let messageSeq = 0
  let partSeq = 0
  let model: Provider.Model = baseModel
  const options: ToModelMessagesOptions = {}

  const nextMessageID = () => MessageIDValue.make(`msg_gen_${seed}_${++messageSeq}`)
  const nextPartID = () => PartID.make(`prt_gen_${seed}_${++partSeq}`)
  const time = () => ++clock

  const partBase = (messageID: MessageID) => ({
    id: nextPartID(),
    sessionID,
    messageID,
  })

  const textPart = (id: MessageID, text: string) =>
    ({ ...partBase(id), type: "text", text }) as unknown as SessionV1.Part
  const stepStartPart = (id: MessageID) => ({ ...partBase(id), type: "step-start" }) as unknown as SessionV1.Part
  const reasoningPart = (id: MessageID, text: string, signature?: string) =>
    ({
      ...partBase(id),
      type: "reasoning",
      text,
      ...(signature ? { metadata: { anthropic: { signature } } } : {}),
    }) as unknown as SessionV1.Part
  const compactionPart = (id: MessageID) => ({ ...partBase(id), type: "compaction" }) as unknown as SessionV1.Part
  const filePart = (id: MessageID, mime: string, url: string, filename: string) =>
    ({ ...partBase(id), type: "file", mime, url, filename }) as unknown as SessionV1.Part
  const toolPart = (id: MessageID, tool: string, callID: string, output: string, attachment?: SessionV1.Part) =>
    ({
      ...partBase(id),
      type: "tool",
      callID,
      tool,
      state: {
        status: "completed",
        input: { cmd: `${tool} ${callID}` },
        output,
        title: tool,
        metadata: {},
        time: rng.chance(0.2) ? { start: 0, end: 1, compacted: true } : { start: 0, end: 1 },
        attachments: attachment ? [attachment] : undefined,
      },
    }) as unknown as SessionV1.Part

  const userMessage = (id: MessageID, parts: SessionV1.Part[]): SessionV1.WithParts =>
    ({
      info: {
        id,
        sessionID,
        role: "user",
        time: { created: time() },
        agent: rng.chance(0.15) ? "plan" : "user",
        model: { providerID: model.providerID, modelID: model.api.id },
        tools: {},
        mode: "",
      },
      parts,
    }) as unknown as SessionV1.WithParts

  const assistantMessage = (
    id: MessageID,
    parentID: MessageID | undefined,
    parts: SessionV1.Part[],
    flags: { summary?: boolean } = {},
  ): SessionV1.WithParts =>
    ({
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created: time() },
        parentID,
        modelID: model.api.id,
        providerID: model.providerID,
        mode: "",
        agent: "agent",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        ...(flags.summary ? { summary: true } : {}),
      },
      parts,
    }) as unknown as SessionV1.WithParts

  const lastUser = () => {
    for (let index = draft.length - 1; index >= 0; index--) {
      const candidate = draft[index]!
      if (candidate.info.role === "user") return candidate.info.id
    }
    return undefined
  }

  const ensureUser = () => {
    if (lastUser() === undefined) addUserText()
  }

  const addUserText = () => {
    const id = nextMessageID()
    draft.push(userMessage(id, [textPart(id, `request ${messageSeq}`)]))
  }

  const addAssistantText = () => {
    ensureUser()
    const id = nextMessageID()
    const parts: SessionV1.Part[] = [stepStartPart(id), textPart(id, `answer ${messageSeq}`)]
    if (rng.chance(0.3)) parts.splice(1, 0, stepStartPart(id))
    draft.push(assistantMessage(id, lastUser(), parts))
  }

  const addAssistantReasoning = () => {
    ensureUser()
    const id = nextMessageID()
    const signed = rng.chance(0.7)
    const parts: SessionV1.Part[] = []
    if (rng.chance(0.3)) parts.push(stepStartPart(id))
    parts.push(
      reasoningPart(id, rng.chance(0.2) ? "" : `thinking ${messageSeq}`, signed ? `sig-${messageSeq}` : undefined),
    )
    parts.push(textPart(id, `answer ${messageSeq}`))
    draft.push(assistantMessage(id, lastUser(), parts))
  }

  const addAssistantTool = (media: boolean) => {
    ensureUser()
    const id = nextMessageID()
    const callID = `call_${seed}_${messageSeq}`
    const attachment = media
      ? filePart(id, rng.chance(0.5) ? "image/png" : "application/pdf", rng.chance(0.5) ? mediaUrl : pdfUrl, "tool.pdf")
      : undefined
    draft.push(
      assistantMessage(id, lastUser(), [
        stepStartPart(id),
        textPart(id, `running ${callID}`),
        toolPart(id, rng.chance(0.5) ? "bash" : "read", callID, `output of ${callID}`, attachment),
      ]),
    )
  }

  const addCompaction = () => {
    ensureUser()
    const id = nextMessageID()
    draft.push(userMessage(id, [compactionPart(id)]))
  }

  const addSummary = () => {
    // Summaries only count as compaction evidence when a marker precedes them.
    addCompaction()
    const marker = lastUser()!
    const id = nextMessageID()
    draft.push(assistantMessage(id, marker, [textPart(id, `summary ${messageSeq}`)], { summary: true }))
  }

  const addUserImage = () => {
    const id = nextMessageID()
    draft.push(
      userMessage(id, [textPart(id, `look at ${messageSeq}`), filePart(id, "image/png", mediaUrl, "image.png")]),
    )
  }

  const revert = () => {
    if (draft.length <= 1) return
    draft.length = rng.int(draft.length - 1) + 1
  }

  const rebuild = () => {
    if (draft.length === 0) return
    const index = rng.int(draft.length)
    draft[index] = structuredClone(draft[index]!)
  }

  const operations: Record<Operation, () => void> = {
    "user-text": addUserText,
    "assistant-text": addAssistantText,
    "assistant-reasoning": addAssistantReasoning,
    "assistant-tool": () => addAssistantTool(false),
    "assistant-media-tool": () => addAssistantTool(true),
    compaction: addCompaction,
    summary: addSummary,
    "user-image": addUserImage,
    revert,
    model: () => {
      model = model.id === baseModel.id ? xaiModel : baseModel
    },
    options: () => {
      if (rng.chance(0.5)) options.stripMedia = !options.stripMedia
      if (rng.chance(0.5)) options.toolOutputMaxChars = options.toolOutputMaxChars ? undefined : 20
      if (rng.chance(0.5)) options.reasoningDistillationEnabled = !options.reasoningDistillationEnabled
    },
    rebuild,
    noop: () => {},
  }

  return {
    sessionID,
    step() {
      const operation = rng.pick(OPERATIONS)
      operations[operation]()
      return operation
    },
    view() {
      return freeze([...draft])
    },
    get model() {
      return model
    },
    get options() {
      return options
    },
  }
}

/** True when the current draft carries inline base64 media somewhere on the wire. */
export function hasInlineMedia(view: SessionV1.WithParts[]) {
  for (const message of view) {
    for (const part of message.parts) {
      if (part.type === "file" && part.url.startsWith("data:")) return true
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      if (part.state.attachments?.some((attachment) => attachment.url.startsWith("data:"))) return true
    }
  }
  return false
}

export function makeSessionID(seed: number) {
  return SessionIDValue.make(`ses_gen_${seed}`)
}
