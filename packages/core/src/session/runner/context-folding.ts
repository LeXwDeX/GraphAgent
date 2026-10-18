export * as CoreContextFolding from "./context-folding"

import { LLM, type LLMError, type LLMRequest, type Message, type Model, type PreparedRequest } from "@opencode-ai/llm"
import { Effect, Option } from "effect"
import { Token } from "../../util/token"
import {
  fingerprintContextFoldingRequest,
  planContextFolding,
  projectContextFoldingRequest,
  type ContextFoldingProjectionPlan,
  type ContextFoldingProjectionResult,
  type FoldCandidate,
  type FoldPlan,
  type FoldRef,
  type FoldStep,
  type PreparedRequestBudgetInput,
  type ProjectionSkipReason,
  type WireCallMapping,
  type WireProjectionSnapshot,
  type WireResultMapping,
} from "../context-folding"
import { ContextFoldingToolSourceLedger } from "../context-folding/tool-source-ledger"
import { readWirePath, verifyWireValueChanges, type WireValueChange } from "../context-folding/wire-value"
import { SessionMessage } from "../message"
import type { LLMMessageConversion, ToolMessageBinding } from "./to-llm-message"
import { toLLMMessages } from "./to-llm-message"

const MAX_COPY_DEPTH = 64
const MAX_COPY_NODES = 131_072

export type RequestPurpose = "conversation" | "compaction" | "auxiliary" | "unknown"

type PlainCopy<T = unknown> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>

function independentWireCopy<T>(value: T, allowedClasses?: ReadonlySet<string>): PlainCopy<T>
function independentWireCopy(value: unknown, allowedClasses: ReadonlySet<string> = new Set()): PlainCopy {
  let nodes = 0
  const copy = (current: unknown, ancestors: Set<object>, depth: number): PlainCopy => {
    nodes++
    if (nodes > MAX_COPY_NODES || depth > MAX_COPY_DEPTH) return { ok: false }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return { ok: true, value: current }
    }
    if (typeof current === "number") return Number.isFinite(current) ? { ok: true, value: current } : { ok: false }
    if (typeof current !== "object" || ancestors.has(current)) return { ok: false }

    const nextAncestors = new Set(ancestors)
    nextAncestors.add(current)
    try {
      const prototype = Object.getPrototypeOf(current)
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype) return { ok: false }
        const keys = Reflect.ownKeys(current)
        if (keys.length !== current.length + 1 || keys.some((key) => typeof key === "symbol")) return { ok: false }
        const result: unknown[] = []
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (!descriptor || !("value" in descriptor)) return { ok: false }
          const item = copy(descriptor.value, nextAncestors, depth + 1)
          if (!item.ok) return item
          result.push(item.value)
        }
        return { ok: true, value: result }
      }
      if (
        prototype !== Object.prototype &&
        prototype !== null &&
        !allowedClasses.has(String(prototype?.constructor?.name))
      )
        return { ok: false }
      const result: Record<string, unknown> = prototype === null ? Object.create(null) : {}
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") return { ok: false }
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor || !("value" in descriptor)) return { ok: false }
        if (!descriptor.enumerable || descriptor.value === undefined) continue
        const item = copy(descriptor.value, nextAncestors, depth + 1)
        if (!item.ok) return item
        Object.defineProperty(result, key, {
          value: item.value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return { ok: true, value: result }
    } catch {
      return { ok: false }
    }
  }
  return copy(value, new Set(), 0)
}

const refKey = (ref: FoldRef) => JSON.stringify([ref.messageID, ref.partID, ref.callID])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const wireFingerprint = (value: unknown) => {
  const copy = independentWireCopy(value, new Set(["Message", "SystemPart", "ToolDefinition", "GenerationOptions"]))
  if (!copy.ok) return { ok: false as const }
  return fingerprintContextFoldingRequest({
    request: copy.value,
    identity: null,
    budget: {
      contextLimit: 0,
      inputLimit: { kind: "absent" },
      outputReserve: 0,
      system: { kind: "none" },
      messages: [],
      tools: [],
      protocolOverheadTokens: 0,
      media: "none",
    },
  })
}

const sameWireValue = (left: unknown, right: unknown) => {
  const leftFingerprint = wireFingerprint(left)
  const rightFingerprint = wireFingerprint(right)
  return leftFingerprint.ok && rightFingerprint.ok && leftFingerprint.value === rightFingerprint.value
}

const missingSource = (sessionID: string, messageID: string, callID: string, toolName: string) => ({
  sessionID,
  assistantMessageID: messageID,
  callID,
  toolName,
  sourceKind: "unknown" as const,
  registrationID: "missing",
  registrationGeneration: "missing",
})

type ReadTextPage = Readonly<{
  type: "text-page"
  content: string
  mime: string
  offset: number
  truncated: boolean
  next?: number
}>

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

function textPage(value: unknown): ReadTextPage | undefined {
  if (!isRecord(value)) return undefined
  const expected = new Set([
    "type",
    "content",
    "mime",
    "offset",
    "truncated",
    ...(Object.hasOwn(value, "next") ? ["next"] : []),
  ])
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expected.has(key))) return undefined
  if (
    value.type !== "text-page" ||
    typeof value.content !== "string" ||
    typeof value.mime !== "string" ||
    !positiveSafeInteger(value.offset) ||
    typeof value.truncated !== "boolean"
  )
    return undefined
  let next: number | undefined
  if (Object.hasOwn(value, "next")) {
    if (!positiveSafeInteger(value.next)) return undefined
    next = value.next
  }
  return {
    type: value.type,
    content: value.content,
    mime: value.mime,
    offset: value.offset,
    truncated: value.truncated,
    ...(next === undefined ? {} : { next }),
  }
}

type ComparablePart = Readonly<{
  providerExecuted?: unknown
  metadata?: unknown
  providerMetadata?: unknown
  cache?: unknown
}>

type ComparableCall = ComparablePart &
  Readonly<{
    id: string
    name: string
    input: unknown
  }>

type ComparableResult = ComparablePart &
  Readonly<{
    id: string
    name: string
    result?: Readonly<{ type: string; value?: unknown }>
  }>

type CandidateBody =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "text-page"; text: string; outer: Omit<ReadTextPage, "content"> }>
  | Readonly<{ kind: "error"; text: string; outer: unknown }>

/**
 * The foldable error body is always a string field. Canonical errors usually carry
 * `{ error: { type, message }, content, structured }`; only the message is replaced, and the remaining fields travel
 * through comparison metadata unchanged. An unrecognized error shape is never foldable.
 */
const errorBody = (value: unknown): Readonly<{ text: string; outer: unknown; path: readonly string[] }> | undefined => {
  if (typeof value === "string") return { text: value, outer: undefined, path: [] }
  if (!isRecord(value)) return undefined
  if (typeof value.error === "string") {
    const { error: _error, ...outer } = value
    return { text: value.error, outer, path: ["error"] }
  }
  if (isRecord(value.error) && value.error.type === "unknown" && typeof value.error.message === "string") {
    const { message: _message, ...errorOuter } = value.error
    const { error: _nested, ...rest } = value
    return { text: value.error.message, outer: { ...rest, error: errorOuter }, path: ["error", "message"] }
  }
  return undefined
}

const candidateBody = (toolName: string, result: ComparableResult | undefined): CandidateBody | undefined => {
  if (!result?.result) return undefined
  if (result.result.type === "error") {
    const error = errorBody(result.result.value)
    return error ? { kind: "error", text: error.text, outer: error.outer } : undefined
  }
  if ((toolName === "grep" || toolName === "glob") && result.result.type === "text") {
    return typeof result.result.value === "string" ? { kind: "text", text: result.result.value } : undefined
  }
  if (toolName !== "read" || result.result.type !== "json") return undefined
  const page = textPage(result.result.value)
  if (!page) return undefined
  const { content, ...outer } = page
  return { kind: "text-page", text: content, outer }
}

const optionalFields = (part: ComparablePart) => ({
  ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
  ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
  ...(part.providerMetadata === undefined ? {} : { providerMetadata: part.providerMetadata }),
  ...("cache" in part && part.cache !== undefined ? { cache: part.cache } : {}),
})

const comparisonMetadata = (
  message: SessionMessage.Assistant,
  binding: Readonly<{ call: ComparableCall; result?: ComparableResult }> | undefined,
  body: CandidateBody | undefined,
) => ({
  ...(message.metadata === undefined ? {} : { messageMetadata: message.metadata }),
  ...(binding === undefined
    ? {}
    : {
        call: optionalFields(binding.call),
        ...(binding.result === undefined
          ? {}
          : {
              result: {
                type: binding.result.result?.type,
                ...optionalFields(binding.result),
                ...(body?.kind === "text-page" ? { outer: body.outer } : {}),
                ...(body?.kind === "error" ? { errorOuter: body.outer } : {}),
              },
            }),
      }),
})

const hasAttachments = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status === "error") {
    return tool.state.content.some((item) => item.type === "file") ? ("present" as const) : ("none" as const)
  }
  if (tool.state.status !== "completed") return "unknown" as const
  if ((tool.state.attachments?.length ?? 0) > 0 || (tool.state.outputPaths?.length ?? 0) > 0) return "present" as const
  return tool.state.content.some((item) => item.type === "file") ? ("present" as const) : ("none" as const)
}

const status = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status === "completed") return "completed" as const
  if (tool.state.status === "pending") return "pending" as const
  if (tool.state.status === "running") return "running" as const
  if (tool.state.status === "error") return "error" as const
  return "unknown" as const
}

const outerMetadata = (tool: SessionMessage.AssistantTool) => ({
  ...(tool.provider === undefined ? {} : { provider: tool.provider }),
  ...(tool.state.status === "completed" && tool.state.attachments !== undefined
    ? { attachments: tool.state.attachments }
    : {}),
  ...(tool.state.status === "completed" && tool.state.outputPaths !== undefined
    ? { outputPaths: tool.state.outputPaths }
    : {}),
})

const instructionSafety = (
  recorded: ContextFoldingToolSourceLedger.RecordedSource | undefined,
  body: CandidateBody | undefined,
) => {
  if (body?.text.includes("<system-reminder>")) return "dynamic" as const
  return recorded?.instructions ?? ("unknown" as const)
}

export type HistoryReference = Readonly<{
  ref: FoldRef
  toolName: string
  complete: boolean
  bodyKind: CandidateBody["kind"] | "unknown"
  evidence: Readonly<{
    input: unknown
    result: unknown
    comparisonMetadata: unknown
    outerMetadata: unknown
  }>
}>

export type HistorySnapshot = Readonly<{
  duplicatePlan: FoldPlan
  references: readonly HistoryReference[]
}>

export type PreparedReference = Readonly<{
  ref: FoldRef
  toolName: string
  complete: boolean
  bodyKind: CandidateBody["kind"] | "unknown"
  inputFingerprint: string
  resultFingerprint: string
  comparisonMetadataFingerprint: string
  outerMetadataFingerprint: string
}>

export type Snapshot = Readonly<{
  duplicatePlan: FoldPlan
  references: readonly PreparedReference[]
  historyBindingFingerprint: string
}>

const evidenceFingerprint = (value: unknown) =>
  wireFingerprint(value === undefined ? { kind: "absent" } : { kind: "present", value })

const estimatedStepTokens = (message: SessionMessage.Assistant, model: Model) => {
  try {
    return Token.estimate(JSON.stringify(toLLMMessages([message], model)))
  } catch {
    return -1
  }
}

// Task epochs segment the conversation into user turns. An unrecognized message shape makes the segmentation
// untrustworthy, so every candidate then shares epoch 0 instead of inventing task boundaries.
const knownMessageTypes = new Set([
  "agent-switched",
  "model-switched",
  "user",
  "synthetic",
  "system",
  "shell",
  "assistant",
  "compaction",
])

export const history = Effect.fn("CoreContextFolding.history")(function* (input: {
  sessionID: string
  messages: readonly SessionMessage.Message[]
  conversion: LLMMessageConversion
  model: Model
  ledger: ContextFoldingToolSourceLedger.Interface
}) {
  const bindings = new Map<string, ToolMessageBinding[]>()
  for (const binding of input.conversion.toolBindings) {
    const key = refKey(binding.ref)
    bindings.set(key, [...(bindings.get(key) ?? []), binding])
  }

  const steps: FoldStep[] = []
  const references: HistoryReference[] = []
  const reliableEpochs = input.messages.every((message) => knownMessageTypes.has(message.type))
  let taskEpoch = 0
  for (const message of input.messages) {
    if (message.type === "user") {
      if (typeof message.text === "string" && message.text.trim().length > 0) taskEpoch++
      continue
    }
    if (message.type !== "assistant") continue
    const candidates: FoldCandidate[] = []
    for (const tool of message.content) {
      if (tool.type !== "tool") continue
      const ref = { messageID: message.id, partID: tool.id, callID: tool.id }
      const matches = bindings.get(refKey(ref)) ?? []
      const binding = matches.length === 1 ? matches[0] : undefined
      const recorded = yield* input.ledger.lookup({
        sessionID: input.sessionID,
        assistantMessageID: message.id,
        callID: tool.id,
        toolName: tool.name,
      })
      const body = candidateBody(tool.name, binding?.result)
      const attachments = hasAttachments(tool)
      // A truncated preview stays foldable: the comparison metadata carries the page outer fields, so two
      // truncated results only match when their complete visible bytes and truncation hints are identical.
      const complete =
        (tool.state.status === "completed" || tool.state.status === "error") &&
        attachments === "none" &&
        body !== undefined
      const metadata = comparisonMetadata(message, binding, body)
      references.push({
        ref,
        toolName: tool.name,
        complete,
        bodyKind: body?.kind ?? "unknown",
        evidence: {
          input: binding?.call.input,
          result: binding?.result?.result,
          comparisonMetadata: metadata,
          outerMetadata: outerMetadata(tool),
        },
      })
      candidates.push({
        ref,
        toolName: tool.name,
        source: recorded?.identity ?? missingSource(input.sessionID, message.id, tool.id, tool.name),
        status: status(tool),
        input: binding?.call.input,
        result:
          body === undefined
            ? { kind: "unknown" }
            : body.kind === "error"
              ? {
                  kind: "error" as const,
                  text: body.text,
                  complete,
                  // The adapter proves a complete error payload but not the underlying failure taxonomy, so the
                  // coarse class stays fixed. Only identical error bytes inside one class share an identity.
                  failureClass: "tool-error",
                  comparisonMetadata: metadata,
                }
              : { kind: "text" as const, text: body.text, complete, comparisonMetadata: metadata },
        safety: {
          attachments,
          instructions: instructionSafety(recorded, body),
          providerExecuted: tool.provider?.executed === true,
        },
        taskEpoch: reliableEpochs ? taskEpoch : 0,
        ...(tool.name === "read" && isRecord(binding?.call.input) && typeof binding?.call.input.path === "string"
          ? { targetPath: binding.call.input.path }
          : {}),
      })
    }
    steps.push({ id: message.id, estimatedTokens: estimatedStepTokens(message, input.model), candidates })
  }
  return { duplicatePlan: planContextFolding(steps), references } satisfies HistorySnapshot
})

type CanonicalLocated = Readonly<{
  path: readonly (string | number)[]
  bodyPath?: readonly (string | number)[]
  id: string
  name: string
  kind: "call" | "result"
  ordinal: number
  input?: unknown
  result?: unknown
  bodyKind?: CandidateBody["kind"]
  part?: ComparableCall | ComparableResult
}>

const comparableFields = (part: Record<string, unknown>) => ({
  ...(Object.hasOwn(part, "providerExecuted") ? { providerExecuted: part.providerExecuted } : {}),
  ...(Object.hasOwn(part, "metadata") ? { metadata: part.metadata } : {}),
  ...(Object.hasOwn(part, "providerMetadata") ? { providerMetadata: part.providerMetadata } : {}),
  ...(Object.hasOwn(part, "cache") ? { cache: part.cache } : {}),
})

function locateCanonical(messages: unknown): CanonicalLocated[] {
  if (!Array.isArray(messages)) return []
  const located: CanonicalLocated[] = []
  let ordinal = 0
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      const currentOrdinal = ordinal++
      if (!isRecord(part) || typeof part.id !== "string" || typeof part.name !== "string") return
      const base = ["messages", messageIndex, "content", partIndex] as const
      if (part.type === "tool-call") {
        const comparable: ComparableCall = {
          id: part.id,
          name: part.name,
          input: part.input,
          ...comparableFields(part),
        }
        located.push({
          path: [...base, "id"],
          id: part.id,
          name: part.name,
          kind: "call",
          ordinal: currentOrdinal,
          input: part.input,
          part: comparable,
        })
        return
      }
      if (part.type !== "tool-result" || !isRecord(part.result)) return
      if (typeof part.result.type !== "string") return
      const comparable: ComparableResult = {
        id: part.id,
        name: part.name,
        result: {
          type: part.result.type,
          ...(Object.hasOwn(part.result, "value") ? { value: part.result.value } : {}),
        },
        ...comparableFields(part),
      }
      if (part.result.type === "error") {
        // Only the string payload of a recognized error shape is replaceable; the surrounding error fields ride
        // through the comparison metadata. An unrecognized shape stays unmapped instead of guessing a path.
        const error = errorBody(part.result.value)
        located.push({
          path: [...base, "id"],
          ...(error ? { bodyPath: [...base, "result", "value", ...error.path], bodyKind: "error" as const } : {}),
          id: part.id,
          name: part.name,
          kind: "result",
          ordinal: currentOrdinal,
          result: part.result,
          part: comparable,
        })
        return
      }
      if (
        (part.name === "grep" || part.name === "glob") &&
        part.result.type === "text" &&
        typeof part.result.value === "string"
      ) {
        located.push({
          path: [...base, "id"],
          bodyPath: [...base, "result", "value"],
          id: part.id,
          name: part.name,
          kind: "result",
          ordinal: currentOrdinal,
          result: part.result,
          bodyKind: "text",
          part: comparable,
        })
        return
      }
      if (part.name === "read" && part.result.type === "json") {
        const page = textPage(part.result.value)
        if (page)
          located.push({
            path: [...base, "id"],
            bodyPath: [...base, "result", "value", "content"],
            id: part.id,
            name: part.name,
            kind: "result",
            ordinal: currentOrdinal,
            result: part.result,
            bodyKind: "text-page",
            part: comparable,
          })
        else
          located.push({
            path: [...base, "id"],
            id: part.id,
            name: part.name,
            kind: "result",
            ordinal: currentOrdinal,
            result: part.result,
            part: comparable,
          })
        return
      }
      located.push({
        path: [...base, "id"],
        id: part.id,
        name: part.name,
        kind: "result",
        ordinal: currentOrdinal,
        result: part.result,
        part: comparable,
      })
    })
  })
  return located
}

const unique = (located: readonly CanonicalLocated[], id: string, kind: CanonicalLocated["kind"]) => {
  const matches = located.filter((item) => item.kind === kind && item.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

const uniqueRequestIDs = (located: readonly CanonicalLocated[]) => {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const item of located) {
    const target = item.kind === "call" ? calls : results
    if (target.has(item.id)) return false
    target.add(item.id)
  }
  return true
}

const selectedReferences = <T extends HistoryReference | PreparedReference>(snapshot: {
  duplicatePlan: FoldPlan
  references: readonly T[]
}) => {
  const selected = new Set<string>()
  for (const replacement of snapshot.duplicatePlan.replacements) {
    selected.add(refKey(replacement.source))
    selected.add(refKey(replacement.witness))
  }
  return snapshot.references.filter((reference) => selected.has(refKey(reference.ref)))
}

export function bindHistory(
  input: HistorySnapshot,
  expectedMessages: readonly Message[],
  sourceMessages?: readonly SessionMessage.Message[],
): Snapshot | undefined {
  const copied = independentWireCopy(expectedMessages, new Set(["Message"]))
  if (!copied.ok) return undefined
  const request = { messages: copied.value }
  const located = locateCanonical(copied.value)
  if (!uniqueRequestIDs(located)) return undefined

  const selected = new Set(selectedReferences(input).map((reference) => refKey(reference.ref)))
  const prepared: PreparedReference[] = []
  const bound = new Set<string>()
  for (const reference of input.references) {
    const key = refKey(reference.ref)
    const isSelected = selected.has(key)
    const inputFingerprint = evidenceFingerprint(reference.evidence.input)
    const resultFingerprint = evidenceFingerprint(reference.evidence.result)
    const comparisonMetadataFingerprint = evidenceFingerprint(reference.evidence.comparisonMetadata)
    const outerMetadataFingerprint = evidenceFingerprint(reference.evidence.outerMetadata)
    if (
      !inputFingerprint.ok ||
      !resultFingerprint.ok ||
      !comparisonMetadataFingerprint.ok ||
      !outerMetadataFingerprint.ok
    ) {
      // Unselected references still bind the whole history fingerprint. A selected reference that cannot be
      // fingerprinted only invalidates its own duplicate pair.
      if (!isSelected) return undefined
      continue
    }
    if (isSelected) {
      const call = unique(located, reference.ref.callID, "call")
      const result = unique(located, reference.ref.callID, "result")
      if (
        !call ||
        !result ||
        call.name !== reference.toolName ||
        result.name !== reference.toolName ||
        result.bodyKind !== reference.bodyKind ||
        !sameWireValue(call.input, reference.evidence.input) ||
        !sameWireValue(result.result, reference.evidence.result)
      )
        continue
      if (sourceMessages) {
        const sourceMatches = sourceMessages.flatMap((message) =>
          message.type === "assistant" && message.id === reference.ref.messageID
            ? message.content
                .filter(
                  (part): part is SessionMessage.AssistantTool =>
                    part.type === "tool" && part.id === reference.ref.partID && part.name === reference.toolName,
                )
                .map((tool) => ({ message, tool }))
            : [],
        )
        if (sourceMatches.length !== 1 || !call.part || !result.part) continue
        const source = sourceMatches[0]
        if (!("result" in result.part) || !("input" in call.part) || !result.part.result) continue
        const body = candidateBody(reference.toolName, result.part)
        const currentComparison = comparisonMetadata(
          source.message,
          {
            call: call.part,
            result: result.part,
          },
          body,
        )
        if (
          !sameWireValue(currentComparison, reference.evidence.comparisonMetadata) ||
          !sameWireValue(outerMetadata(source.tool), reference.evidence.outerMetadata)
        )
          continue
      }
      bound.add(key)
    }
    prepared.push({
      ref: reference.ref,
      toolName: reference.toolName,
      complete: reference.complete,
      bodyKind: reference.bodyKind,
      inputFingerprint: inputFingerprint.value,
      resultFingerprint: resultFingerprint.value,
      comparisonMetadataFingerprint: comparisonMetadataFingerprint.value,
      outerMetadataFingerprint: outerMetadataFingerprint.value,
    })
  }

  // Isolate each selected pair. One unverifiable pair must not disable folding for every other verified pair.
  const replacements = input.duplicatePlan.replacements.filter((replacement) => {
    if (!bound.has(refKey(replacement.source)) || !bound.has(refKey(replacement.witness))) return false
    const source = unique(located, replacement.source.callID, "result")
    const witness = unique(located, replacement.witness.callID, "result")
    return source !== undefined && witness !== undefined && source.ordinal < witness.ordinal
  })
  const duplicatePlan: FoldPlan =
    replacements.length === 0 && input.duplicatePlan.replacements.length > 0
      ? { ...input.duplicatePlan, replacements: [], skipReason: "mapping-mismatch" }
      : { ...input.duplicatePlan, replacements }

  const historyBindingFingerprint = wireFingerprint({
    duplicatePlan,
    references: prepared,
    request,
  })
  if (!historyBindingFingerprint.ok) return undefined
  return {
    duplicatePlan,
    references: prepared,
    historyBindingFingerprint: historyBindingFingerprint.value,
  }
}

const hasMedia = (messages: readonly Message[]) =>
  messages.some((message) =>
    message.content.some(
      (part) => part.type === "media" || (part.type === "tool-result" && part.result.type === "content"),
    ),
  )

const outputReserve = (request: LLMRequest) =>
  request.generation?.maxTokens ??
  request.model.defaults?.generation?.maxTokens ??
  request.model.route.defaults.generation?.maxTokens ??
  request.model.defaults?.limits?.output ??
  request.model.route.defaults.limits?.output

const budget = (request: LLMRequest, preparedBody: unknown): PreparedRequestBudgetInput => ({
  contextLimit: request.model.defaults?.limits?.context ?? request.model.route.defaults.limits?.context,
  inputLimit: { kind: "absent" },
  outputReserve: outputReserve(request),
  system: { kind: "none" },
  // The prepared provider body already contains system, messages, tools and protocol fields exactly once.
  messages: preparedBody,
  tools: [],
  protocolOverheadTokens: 0,
  media: hasMedia(request.messages) ? "unknown" : "none",
})

const identity = (request: LLMRequest, purpose: RequestPurpose, prepared: PreparedRequest) => ({
  adapter: "core-context-folding-v1",
  purpose,
  providerID: request.model.provider,
  modelID: request.model.id,
  routeID: prepared.route,
  protocol: prepared.protocol,
  ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
  ...(request.generation === undefined ? {} : { generation: request.generation }),
  ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
})

function mapping(
  requestFingerprint: string,
  snapshot: Snapshot,
  located: readonly CanonicalLocated[],
): WireProjectionSnapshot {
  const calls: WireCallMapping[] = []
  const results: WireResultMapping[] = []
  for (const reference of selectedReferences(snapshot)) {
    const call = unique(located, reference.ref.callID, "call")
    const result = unique(located, reference.ref.callID, "result")
    if (
      !call ||
      !result ||
      call.name !== reference.toolName ||
      result.name !== reference.toolName ||
      result.bodyKind !== reference.bodyKind ||
      !result.bodyPath
    )
      continue
    calls.push({
      ref: reference.ref,
      visibleCallID: call.id,
      visibleCallIDPath: call.path,
      ordinal: call.ordinal,
    })
    results.push({
      ref: reference.ref,
      visibleCallID: result.id,
      visibleCallIDPath: result.path,
      bodyPath: result.bodyPath,
      ordinal: result.ordinal,
      complete: reference.complete,
      resultKind: result.bodyKind === "error" ? "error" : "text",
    })
  }
  return { requestFingerprint, calls, results }
}

type PreparedLocated = Readonly<{
  id: string
  name?: string
  kind: "call" | "result"
  ordinal: number
  input?: unknown
  textPath?: readonly (string | number)[]
  text?: string
}>

function locateOpenAIChat(body: unknown): PreparedLocated[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined
  const located: PreparedLocated[] = []
  let ordinal = 0
  body.messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call) => {
        const position = ordinal++
        if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function)) return
        if (typeof call.function.name !== "string" || typeof call.function.arguments !== "string") return
        try {
          located.push({
            id: call.id,
            name: call.function.name,
            kind: "call",
            ordinal: position,
            input: JSON.parse(call.function.arguments),
          })
        } catch {
          return
        }
      })
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string" && typeof message.content === "string") {
      located.push({
        id: message.tool_call_id,
        kind: "result",
        ordinal: ordinal++,
        text: message.content,
        textPath: ["messages", messageIndex, "content"],
      })
    }
  })
  return located
}

function locateOpenAIResponses(body: unknown): PreparedLocated[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.input)) return undefined
  const located: PreparedLocated[] = []
  let ordinal = 0
  body.input.forEach((item, index) => {
    const position = ordinal++
    if (!isRecord(item)) return
    if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string" &&
      typeof item.arguments === "string"
    ) {
      try {
        located.push({
          id: item.call_id,
          name: item.name,
          kind: "call",
          ordinal: position,
          input: JSON.parse(item.arguments),
        })
      } catch {
        return
      }
    }
    if (item.type === "function_call_output" && typeof item.call_id === "string" && typeof item.output === "string") {
      located.push({
        id: item.call_id,
        kind: "result",
        ordinal: position,
        text: item.output,
        textPath: ["input", index, "output"],
      })
    }
  })
  return located
}

function locateAnthropic(body: unknown): PreparedLocated[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined
  const located: PreparedLocated[] = []
  let ordinal = 0
  body.messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      const position = ordinal++
      if (!isRecord(part)) return
      if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
        located.push({ id: part.id, name: part.name, kind: "call", ordinal: position, input: part.input })
      }
      if (part.type === "tool_result" && typeof part.tool_use_id === "string" && typeof part.content === "string") {
        located.push({
          id: part.tool_use_id,
          kind: "result",
          ordinal: position,
          text: part.content,
          textPath: ["messages", messageIndex, "content", partIndex, "content"],
        })
      }
    })
  })
  return located
}

function locatePrepared(protocol: string, body: unknown) {
  if (protocol === "openai-chat" || protocol === "openai-compatible-chat") return locateOpenAIChat(body)
  if (protocol === "openai-responses") return locateOpenAIResponses(body)
  if (protocol === "anthropic-messages") return locateAnthropic(body)
  return undefined
}

const uniquePrepared = (located: readonly PreparedLocated[], id: string, kind: PreparedLocated["kind"]) => {
  const matches = located.filter((item) => item.kind === kind && item.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

function completePreparedMapping(located: readonly PreparedLocated[]) {
  const calls = new Map<string, PreparedLocated>()
  const results = new Map<string, PreparedLocated>()
  for (const item of located) {
    const target = item.kind === "call" ? calls : results
    if (target.has(item.id)) return false
    target.set(item.id, item)
  }
  if (calls.size !== results.size) return false
  for (const [id, call] of calls) {
    const result = results.get(id)
    if (!result || call.ordinal >= result.ordinal) return false
  }
  return true
}

function sameReadOuter(before: string, after: string, expectedBefore: string, expectedAfter: string) {
  try {
    const left = textPage(JSON.parse(before))
    const right = textPage(JSON.parse(after))
    if (!left || !right || left.content !== expectedBefore || right.content !== expectedAfter) return false
    const { content: _leftContent, ...leftOuter } = left
    const { content: _rightContent, ...rightOuter } = right
    return sameWireValue(leftOuter, rightOuter)
  } catch {
    return false
  }
}

/**
 * Structured error results are lowered to provider text as a JSON document, so the provider wire still carries the
 * complete error payload around the replaced message. A raw string error is lowered verbatim.
 */
function sameErrorText(
  structured: boolean,
  before: string,
  after: string,
  expectedBefore: string,
  expectedAfter: string,
) {
  if (!structured) return before === expectedBefore && after === expectedAfter
  try {
    const left = errorBody(JSON.parse(before))
    const right = errorBody(JSON.parse(after))
    return (
      left !== undefined &&
      right !== undefined &&
      left.text === expectedBefore &&
      right.text === expectedAfter &&
      left.path.join("\u0000") === right.path.join("\u0000") &&
      sameWireValue(left.outer, right.outer)
    )
  } catch {
    return false
  }
}

const structuredErrorValue = (located: CanonicalLocated | undefined) =>
  isRecord(located?.result) && located.result.type === "error" && isRecord(located.result.value)

function verifyPreparedProjection(input: {
  before: PreparedRequest
  after: PreparedRequest
  originalRequest: unknown
  projectedRequest: unknown
  snapshot: Snapshot
  plan: ContextFoldingProjectionPlan
}) {
  if (input.before.protocol !== input.after.protocol || input.before.route !== input.after.route) return false
  const beforeBody = independentWireCopy(input.before.body)
  const afterBody = independentWireCopy(input.after.body)
  if (!beforeBody.ok || !afterBody.ok) return false
  const before = locatePrepared(input.before.protocol, beforeBody.value)
  const after = locatePrepared(input.after.protocol, afterBody.value)
  if (!before || !after || !completePreparedMapping(before) || !completePreparedMapping(after)) return false
  const canonicalBefore = locateCanonical(isRecord(input.originalRequest) ? input.originalRequest.messages : undefined)
  const canonicalAfter = locateCanonical(isRecord(input.projectedRequest) ? input.projectedRequest.messages : undefined)
  if (!uniqueRequestIDs(canonicalBefore) || !uniqueRequestIDs(canonicalAfter)) return false

  const references = new Map(input.snapshot.references.map((reference) => [refKey(reference.ref), reference]))
  const changes: WireValueChange[] = []
  for (const replacement of input.plan.replacements) {
    const reference = references.get(refKey(replacement.source))
    const witnessReference = references.get(refKey(replacement.witness))
    if (!reference || !witnessReference) return false
    const beforeCall = uniquePrepared(before, replacement.source.callID, "call")
    const beforeResult = uniquePrepared(before, replacement.source.callID, "result")
    const afterCall = uniquePrepared(after, replacement.source.callID, "call")
    const afterResult = uniquePrepared(after, replacement.source.callID, "result")
    const beforeWitnessCall = uniquePrepared(before, replacement.witness.callID, "call")
    const beforeWitness = uniquePrepared(before, replacement.witness.callID, "result")
    const afterWitnessCall = uniquePrepared(after, replacement.witness.callID, "call")
    const afterWitness = uniquePrepared(after, replacement.witness.callID, "result")
    const beforeCanonicalCall = unique(canonicalBefore, replacement.source.callID, "call")
    const afterCanonicalCall = unique(canonicalAfter, replacement.source.callID, "call")
    const beforeCanonicalWitnessCall = unique(canonicalBefore, replacement.witness.callID, "call")
    const afterCanonicalWitnessCall = unique(canonicalAfter, replacement.witness.callID, "call")
    const beforeCanonicalWitnessResult = unique(canonicalBefore, replacement.witness.callID, "result")
    const afterCanonicalWitnessResult = unique(canonicalAfter, replacement.witness.callID, "result")
    if (
      !beforeCall ||
      !beforeResult?.textPath ||
      typeof beforeResult.text !== "string" ||
      !afterCall ||
      !afterResult?.textPath ||
      typeof afterResult.text !== "string" ||
      !beforeWitnessCall ||
      !beforeWitness?.textPath ||
      typeof beforeWitness.text !== "string" ||
      !afterWitnessCall ||
      !afterWitness?.textPath ||
      typeof afterWitness.text !== "string" ||
      !beforeCanonicalCall ||
      !afterCanonicalCall ||
      !beforeCanonicalWitnessCall ||
      !afterCanonicalWitnessCall ||
      !beforeCanonicalWitnessResult?.bodyPath ||
      !afterCanonicalWitnessResult?.bodyPath ||
      beforeCall.name !== reference.toolName ||
      afterCall.name !== reference.toolName ||
      beforeWitnessCall.name !== witnessReference.toolName ||
      afterWitnessCall.name !== witnessReference.toolName ||
      !sameWireValue(beforeCall.input, afterCall.input) ||
      !sameWireValue(beforeCall.input, beforeCanonicalCall.input) ||
      !sameWireValue(afterCall.input, afterCanonicalCall.input) ||
      !sameWireValue(beforeWitnessCall.input, afterWitnessCall.input) ||
      !sameWireValue(beforeWitnessCall.input, beforeCanonicalWitnessCall.input) ||
      !sameWireValue(afterWitnessCall.input, afterCanonicalWitnessCall.input) ||
      beforeResult.ordinal >= beforeWitness.ordinal ||
      afterResult.ordinal >= afterWitness.ordinal ||
      !sameWireValue(beforeResult.textPath, afterResult.textPath) ||
      beforeWitness.text !== afterWitness.text
    )
      return false

    const beforeCanonicalResult = unique(canonicalBefore, replacement.source.callID, "result")
    const afterCanonicalResult = unique(canonicalAfter, replacement.source.callID, "result")
    if (!beforeCanonicalResult?.bodyPath || !afterCanonicalResult?.bodyPath) return false
    const beforeBodyValue = readWirePath(input.originalRequest, beforeCanonicalResult.bodyPath)
    const afterBodyValue = readWirePath(input.projectedRequest, afterCanonicalResult.bodyPath)
    if (
      !beforeBodyValue.ok ||
      !afterBodyValue.ok ||
      typeof beforeBodyValue.value !== "string" ||
      afterBodyValue.value !== replacement.placeholder
    )
      return false
    const beforeWitnessBody = readWirePath(input.originalRequest, beforeCanonicalWitnessResult.bodyPath)
    const afterWitnessBody = readWirePath(input.projectedRequest, afterCanonicalWitnessResult.bodyPath)
    if (
      !beforeWitnessBody.ok ||
      !afterWitnessBody.ok ||
      typeof beforeWitnessBody.value !== "string" ||
      beforeWitnessBody.value !== afterWitnessBody.value ||
      (witnessReference.bodyKind === "text-page"
        ? !sameReadOuter(beforeWitness.text, afterWitness.text, beforeWitnessBody.value, afterWitnessBody.value)
        : witnessReference.bodyKind === "error"
          ? !sameErrorText(
              structuredErrorValue(beforeCanonicalWitnessResult),
              beforeWitness.text,
              afterWitness.text,
              beforeWitnessBody.value,
              afterWitnessBody.value,
            )
          : beforeWitness.text !== beforeWitnessBody.value || afterWitness.text !== afterWitnessBody.value)
    )
      return false
    if (
      reference.bodyKind === "text-page"
        ? !sameReadOuter(beforeResult.text, afterResult.text, beforeBodyValue.value, replacement.placeholder)
        : reference.bodyKind === "error"
          ? !sameErrorText(
              structuredErrorValue(beforeCanonicalResult),
              beforeResult.text,
              afterResult.text,
              beforeBodyValue.value,
              replacement.placeholder,
            )
          : beforeResult.text !== beforeBodyValue.value || afterResult.text !== replacement.placeholder
    )
      return false
    changes.push({ path: beforeResult.textPath, before: beforeResult.text, after: afterResult.text })
  }
  const verified = verifyWireValueChanges(beforeBody.value, afterBody.value, changes)
  return verified.ok && verified.value
}

const unchanged = (
  request: LLMRequest,
  skipReason: ProjectionSkipReason,
): ContextFoldingProjectionResult<LLMRequest> => ({
  request,
  applied: false,
  plan: {
    replacements: [],
    estimatedBefore: undefined,
    estimatedAfter: undefined,
    targetTokens: undefined,
    overBudget: undefined,
    skipReason,
  },
})

export const project = Effect.fn("CoreContextFolding.project")(function* (input: {
  enabled: boolean
  purpose: RequestPurpose
  sessionID: string
  sourceMessages: readonly SessionMessage.Message[]
  conversion: LLMMessageConversion
  expectedMessages: readonly Message[]
  model: Model
  request: LLMRequest
  ledger: ContextFoldingToolSourceLedger.Interface
  prepare: (request: LLMRequest) => Effect.Effect<PreparedRequest, LLMError>
}) {
  if (!input.enabled || input.purpose !== "conversation") return unchanged(input.request, "no-eligible-duplicates")
  const planned = yield* history({
    sessionID: input.sessionID,
    messages: input.sourceMessages,
    conversion: input.conversion,
    model: input.model,
    ledger: input.ledger,
  })
  if (planned.duplicatePlan.replacements.length === 0)
    return unchanged(input.request, planned.duplicatePlan.skipReason ?? "no-eligible-duplicates")
  const snapshot = bindHistory(planned, input.expectedMessages, input.sourceMessages)
  if (!snapshot) return unchanged(input.request, "mapping-mismatch")

  const beforePrepared = Option.getOrUndefined(yield* input.prepare(input.request).pipe(Effect.option))
  if (!beforePrepared) return unchanged(input.request, "mapping-mismatch")
  const beforeBody = independentWireCopy(beforePrepared.body)
  const requestMessages = independentWireCopy(input.request.messages, new Set(["Message"]))
  const requestIdentity = independentWireCopy(
    identity(input.request, input.purpose, beforePrepared),
    new Set(["ToolChoice", "GenerationOptions"]),
  )
  if (!beforeBody.ok || !requestMessages.ok || !requestIdentity.ok) return unchanged(input.request, "unknown-content")

  const requestTree = { messages: requestMessages.value }
  const currentBinding = wireFingerprint({
    duplicatePlan: snapshot.duplicatePlan,
    references: snapshot.references,
    request: requestTree,
  })
  if (!currentBinding.ok || currentBinding.value !== snapshot.historyBindingFingerprint)
    return unchanged(input.request, "mapping-mismatch")
  const preparedBudget = budget(input.request, beforeBody.value)
  const fingerprint = fingerprintContextFoldingRequest({
    request: requestTree,
    identity: requestIdentity.value,
    budget: preparedBudget,
  })
  if (!fingerprint.ok) return unchanged(input.request, fingerprint.reason)
  const located = locateCanonical(requestMessages.value)
  if (!uniqueRequestIDs(located)) return unchanged(input.request, "mapping-mismatch")

  const projected = projectContextFoldingRequest({
    request: requestTree,
    identity: requestIdentity.value,
    expectedRequestFingerprint: fingerprint.value,
    duplicatePlan: snapshot.duplicatePlan,
    budget: preparedBudget,
    mapping: mapping(fingerprint.value, snapshot, located),
  })
  if (!projected.applied) return { ...projected, request: input.request }
  const projectedRequest = LLM.updateRequest(input.request, { messages: projected.request.messages })
  const afterPrepared = Option.getOrUndefined(yield* input.prepare(projectedRequest).pipe(Effect.option))
  if (!afterPrepared) return unchanged(input.request, "mapping-mismatch")
  if (
    !verifyPreparedProjection({
      before: beforePrepared,
      after: afterPrepared,
      originalRequest: requestTree,
      projectedRequest: projected.request,
      snapshot,
      plan: projected.plan,
    })
  )
    return unchanged(input.request, "mapping-mismatch")
  return { ...projected, request: projectedRequest }
})
