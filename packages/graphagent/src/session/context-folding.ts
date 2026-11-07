import {
  fingerprintContextFoldingRequest,
  planContextFolding,
  projectContextFoldingRequest,
  type ContextFoldingProjectionResult,
  type FoldPlan,
  type FoldCandidate,
  type FoldRef,
  type FoldStep,
  type PreparedRequestBudgetInput,
  type ProjectionSkipReason,
  type WireCallMapping,
  type WireProjectionSnapshot,
  type WireResultMapping,
} from "@opencode-ai/core/session/context-folding"
import { Token } from "@opencode-ai/core/util/token"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Effect } from "effect"
import type { Interface as ToolSourceLedgerInterface } from "./tool-source-ledger"
import { LLMNative } from "./llm/native-request"
import { isReplayableAssistantMessage } from "./message-replay"

const PROTOCOL_OVERHEAD_TOKENS = 64
const MAX_COPY_DEPTH = 64
const MAX_COPY_NODES = 131_072

export type RequestPurpose = "conversation" | "compaction" | "auxiliary" | "unknown"

export type HistoryReference = Readonly<{
  ref: FoldRef
  toolName: string
  complete: boolean
  resultKind: "text" | "error" | "unknown"
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
  resultKind: "text" | "error" | "unknown"
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

type ProjectionInput = Readonly<{
  model: Provider.Model
  purpose: RequestPurpose
  snapshot: Snapshot
  tools: Record<string, Tool>
  toolChoice?: "auto" | "required" | "none"
  maxOutputTokens: number | undefined
  params: unknown
  system: PreparedRequestBudgetInput["system"]
  sourceMessages: ModelMessage[]
  messageTransformOptions: Record<string, unknown>
}>

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
          enumerable: descriptor.enumerable,
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

const missingSource = (sessionID: string, messageID: string, callID: string, toolName: string) => ({
  sessionID,
  assistantMessageID: messageID,
  callID,
  toolName,
  sourceKind: "unknown" as const,
  registrationID: "missing",
  registrationGeneration: "missing",
})

const estimateStep = (parts: readonly SessionV1.Part[]) => {
  try {
    return Token.estimate(JSON.stringify(parts))
  } catch {
    return -1
  }
}

const wireFingerprint = (value: unknown) => {
  const copy = independentWireCopy(value)
  if (!copy.ok) return { ok: false as const, reason: "unknown-content" as const }
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

const evidenceFingerprint = (value: unknown) =>
  wireFingerprint(value === undefined ? { kind: "absent" } : { kind: "present", value })

function instructionSafety(part: SessionV1.ToolPart): "none" | "dynamic" | "unknown" {
  if (part.state.status !== "completed") return "unknown"
  const metadata = part.state.metadata
  if (!isRecord(metadata)) return "unknown"
  const marker = metadata.contextFoldingInstructions
  if (marker !== "none" && marker !== "dynamic") return "unknown"
  if (typeof part.state.output !== "string") return "unknown"
  if (part.state.output.includes("<system-reminder>")) return "dynamic"
  if (part.tool !== "read") return marker
  if (!Object.hasOwn(metadata, "loaded")) return "unknown"
  if (!Array.isArray(metadata.loaded) || !metadata.loaded.every((item) => typeof item === "string")) return "unknown"
  return metadata.loaded.length > 0 ? "dynamic" : marker
}

function errorInstructionSafety(part: SessionV1.ToolPart): "none" | "dynamic" | "unknown" {
  if (part.state.status !== "error") return "unknown"
  if (typeof part.state.error !== "string") return "unknown"
  return part.state.error.includes("<system-reminder>") ? "dynamic" : "none"
}

/**
 * A real user turn opens a new task epoch. Synthetic/system/shell/compaction turns and unrecognized shapes do not,
 * which keeps every candidate in a single conservative epoch when the history is not clearly user-authored.
 */
function isRealUserTurn(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "user" || message.info.summary !== undefined) return false
  let realText = false
  for (const part of message.parts) {
    if (part.type === "compaction") return false
    if (part.type === "text" && part.synthetic !== true && part.ignored !== true && part.text.trim().length > 0) {
      realText = true
    }
  }
  return realText
}

export const history = Effect.fn("ContextFolding.history")(function* (input: {
  messages: readonly SessionV1.WithParts[]
  ledger: ToolSourceLedgerInterface
}) {
  const steps: FoldStep[] = []
  const references: HistoryReference[] = []
  let taskEpoch = 0

  for (const message of input.messages) {
    if (message.info.role === "user") {
      if (isRealUserTurn(message)) taskEpoch++
      continue
    }
    if (message.info.role !== "assistant") continue
    // Keep folding history aligned with the exact assistant messages the provider wire replays.
    if (!isReplayableAssistantMessage(message)) continue
    let stepParts: SessionV1.Part[] = []
    let stepID = `${message.info.id}:0`
    const flush = () =>
      Effect.gen(function* () {
        if (stepParts.length === 0) return
        const parts = stepParts
        const id = stepID
        stepParts = []
        const candidates: FoldCandidate[] = []
        for (const part of parts) {
          if (part.type !== "tool") continue
          const identity =
            (yield* input.ledger.lookup({
              sessionID: part.sessionID,
              assistantMessageID: part.messageID,
              callID: part.callID,
              toolName: part.tool,
            })) ?? missingSource(part.sessionID, part.messageID, part.callID, part.tool)
          const completedState = part.state.status === "completed" ? part.state : undefined
          const errorState = part.state.status === "error" ? part.state : undefined
          // An interrupted error is replayed on the wire as a successful partial output. It is not a complete
          // failure payload, so it never enters the error identity.
          const interruptedError =
            errorState !== undefined &&
            isRecord(errorState.metadata) &&
            errorState.metadata.interrupted === true &&
            typeof errorState.metadata.output === "string"
          const attachments: "none" | "present" =
            completedState && (completedState.attachments?.length ?? 0) > 0 ? "present" : "none"
          // Truncated previews stay foldable because identity compares the complete visible body and metadata:
          // a truncated duplicate loses no unique bytes when the later witness keeps the identical preview.
          // Compacted sentinels and file-backed outputs remain lossy and are never eligible.
          const complete =
            !!completedState &&
            completedState.time.compacted === undefined &&
            typeof completedState.metadata.outputPath !== "string"
          const errorText = errorState && !interruptedError ? errorState.error : undefined
          const completeError = typeof errorText === "string"
          const errorComparisonMetadata = errorState ? { metadata: errorState.metadata } : undefined
          const ref = { messageID: part.messageID, partID: part.id, callID: part.callID }
          references.push({
            ref,
            toolName: part.tool,
            complete: complete || completeError,
            resultKind: completedState ? "text" : completeError ? "error" : "unknown",
            evidence: {
              input: part.state.input,
              result: completedState ? completedState.output : completeError ? errorText : undefined,
              comparisonMetadata: completedState
                ? { title: completedState.title, metadata: completedState.metadata }
                : completeError
                  ? errorComparisonMetadata
                  : undefined,
              outerMetadata: part.metadata,
            },
          })
          candidates.push({
            ref,
            toolName: part.tool,
            source: identity,
            status: part.state.status,
            input: part.state.input,
            result: completedState
              ? {
                  kind: "text" as const,
                  text: completedState.output,
                  complete,
                  comparisonMetadata: { title: completedState.title, metadata: completedState.metadata },
                }
              : completeError
                ? {
                    kind: "error" as const,
                    text: errorText,
                    complete: true,
                    failureClass: "tool-error",
                    comparisonMetadata: errorComparisonMetadata,
                  }
                : { kind: "unknown" as const },
            safety: {
              attachments,
              instructions: completedState ? instructionSafety(part) : errorInstructionSafety(part),
              providerExecuted: part.metadata?.providerExecuted === true,
            },
            taskEpoch,
            ...(part.tool === "read" && typeof part.state.input.filePath === "string"
              ? { targetPath: part.state.input.filePath }
              : {}),
          })
        }
        steps.push({ id, estimatedTokens: estimateStep(parts), candidates })
      })

    for (const part of message.parts) {
      if (part.type === "step-start" && stepParts.length > 0) yield* flush()
      if (part.type === "step-start") stepID = part.id
      stepParts.push(part)
    }
    yield* flush()
  }

  return { duplicatePlan: planContextFolding(steps), references } satisfies HistorySnapshot
})

type ModelLocated = Readonly<{
  id: string
  name: string
  kind: "call" | "result"
  ordinal: number
  input?: unknown
  result?: unknown
  resultKind?: "text" | "error"
}>

function locateModelMessages(messages: readonly ModelMessage[]): ModelLocated[] {
  const located: ModelLocated[] = []
  let callOrdinal = 0
  let resultOrdinal = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const item: unknown = part
      if (!isRecord(item) || typeof item.toolCallId !== "string" || typeof item.toolName !== "string") continue
      if (item.type === "tool-call") {
        located.push({
          id: item.toolCallId,
          name: item.toolName,
          kind: "call",
          ordinal: callOrdinal++,
          input: item.input,
        })
      }
      if (item.type === "tool-result") {
        const output = isRecord(item.output) ? item.output : undefined
        const resultKind = output?.type === "text" ? "text" : output?.type === "error-text" ? "error" : undefined
        const result = resultKind !== undefined && output !== undefined ? output.value : undefined
        located.push({
          id: item.toolCallId,
          name: item.toolName,
          kind: "result",
          ordinal: resultOrdinal++,
          result,
          ...(resultKind ? { resultKind } : {}),
        })
      }
    }
  }
  return located
}

function uniqueByVisibleID(located: readonly ModelLocated[], id: string, kind: ModelLocated["kind"]) {
  const matches = located.filter((item) => item.kind === kind && item.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

const refKey = (ref: FoldRef) => JSON.stringify([ref.messageID, ref.partID, ref.callID])

export function bindModelMessages(input: HistorySnapshot, messages: ModelMessage[]): Snapshot | undefined {
  const selected = new Set(selectedReferences(input).map((reference) => refKey(reference.ref)))
  const located = locateModelMessages(messages)
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
      const call = uniqueByVisibleID(located, reference.ref.callID, "call")
      const result = uniqueByVisibleID(located, reference.ref.callID, "result")
      if (
        !call ||
        !result ||
        call.name !== reference.toolName ||
        result.name !== reference.toolName ||
        result.resultKind !== reference.resultKind ||
        !sameWireValue(call.input, reference.evidence.input) ||
        !sameWireValue(result.result, reference.evidence.result)
      )
        continue
      bound.add(key)
    }
    prepared.push({
      ref: reference.ref,
      toolName: reference.toolName,
      complete: reference.complete,
      resultKind: reference.resultKind,
      inputFingerprint: inputFingerprint.value,
      resultFingerprint: resultFingerprint.value,
      comparisonMetadataFingerprint: comparisonMetadataFingerprint.value,
      outerMetadataFingerprint: outerMetadataFingerprint.value,
    })
  }

  // Isolate each selected pair. One unverifiable pair must not disable folding for every other verified pair.
  const replacements = input.duplicatePlan.replacements.filter((replacement) => {
    if (!bound.has(refKey(replacement.source)) || !bound.has(refKey(replacement.witness))) return false
    const source = uniqueByVisibleID(located, replacement.source.callID, "result")
    const witness = uniqueByVisibleID(located, replacement.witness.callID, "result")
    return source !== undefined && witness !== undefined && source.ordinal < witness.ordinal
  })
  const duplicatePlan: FoldPlan =
    replacements.length === 0 && input.duplicatePlan.replacements.length > 0
      ? { ...input.duplicatePlan, replacements: [], skipReason: "mapping-mismatch" }
      : { ...input.duplicatePlan, replacements }

  const historyBindingFingerprint = wireFingerprint({
    duplicatePlan,
    references: prepared,
    sourceMessages: messages,
  })
  if (!historyBindingFingerprint.ok) return undefined
  return {
    duplicatePlan,
    references: prepared,
    historyBindingFingerprint: historyBindingFingerprint.value,
  }
}

export function copyModelMessages(messages: ModelMessage[]): ModelMessage[] | undefined {
  const copy = independentWireCopy(messages)
  return copy.ok ? copy.value : undefined
}

function selectedReferences(snapshot: HistorySnapshot): readonly HistoryReference[]
function selectedReferences(snapshot: Snapshot): readonly PreparedReference[]
function selectedReferences(snapshot: HistorySnapshot | Snapshot): readonly (HistoryReference | PreparedReference)[] {
  const selected = new Set<string>()
  for (const replacement of snapshot.duplicatePlan.replacements) {
    selected.add(JSON.stringify(replacement.source))
    selected.add(JSON.stringify(replacement.witness))
  }
  return snapshot.references.filter((reference) => selected.has(JSON.stringify(reference.ref)))
}

function toolWire(tools: Record<string, Tool>) {
  return Object.entries(tools)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({
      name,
      description: item.description ?? "",
      inputSchema: asSchema(item.inputSchema).jsonSchema,
      ...(item.strict === undefined ? {} : { strict: item.strict }),
    }))
}

function hasMedia(messages: unknown) {
  if (!Array.isArray(messages)) return true
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (["file", "image", "media"].includes(String(part.type))) return true
      if (!isRecord(part.output) || part.output.type !== "content" || !Array.isArray(part.output.value)) continue
      if (part.output.value.some((item) => isRecord(item) && item.type !== "text")) return true
    }
  }
  return false
}

function budget(
  input: ProjectionInput,
  messages: unknown,
  tools: unknown,
  mediaMessages: unknown = messages,
): PreparedRequestBudgetInput {
  return {
    contextLimit: input.model.limit.context,
    inputLimit:
      input.model.limit.input === undefined ? { kind: "absent" } : { kind: "value", value: input.model.limit.input },
    outputReserve: input.maxOutputTokens,
    system: input.system,
    messages,
    tools,
    protocolOverheadTokens: PROTOCOL_OVERHEAD_TOKENS,
    media: hasMedia(mediaMessages) ? "unknown" : "none",
  }
}

function identity(input: ProjectionInput, runtime: "ai-sdk" | "native") {
  return {
    adapter: "opencode-context-folding-v1",
    runtime,
    purpose: input.purpose,
    providerID: input.model.providerID,
    modelID: input.model.id,
    apiID: input.model.api.id,
    npm: input.model.api.npm,
    ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
    params: input.params,
  }
}

type Located = Readonly<{
  path: readonly (string | number)[]
  bodyPath?: readonly (string | number)[]
  id: string
  name: string
  kind: "call" | "result"
  ordinal: number
  resultKind?: "text" | "error" | "unknown"
}>

function locateAISDK(request: unknown): Located[] {
  if (!isRecord(request) || !Array.isArray(request.messages)) return []
  const located: Located[] = []
  let callOrdinal = 0
  let resultOrdinal = 0
  request.messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      if (!isRecord(part) || typeof part.toolCallId !== "string" || typeof part.toolName !== "string") return
      const base = ["messages", messageIndex, "content", partIndex] as const
      if (part.type === "tool-call") {
        located.push({
          path: [...base, "toolCallId"],
          id: part.toolCallId,
          name: part.toolName,
          kind: "call",
          ordinal: callOrdinal++,
        })
      }
      if (
        part.type === "tool-result" &&
        isRecord(part.output) &&
        (part.output.type === "text" || part.output.type === "error-text") &&
        typeof part.output.value === "string"
      ) {
        located.push({
          path: [...base, "toolCallId"],
          bodyPath: [...base, "output", "value"],
          id: part.toolCallId,
          name: part.toolName,
          kind: "result",
          ordinal: resultOrdinal++,
          resultKind: part.output.type === "error-text" ? "error" : "text",
        })
      }
    })
  })
  return located
}

function locateNative(request: unknown): Located[] {
  if (!isRecord(request) || !Array.isArray(request.messages)) return []
  const located: Located[] = []
  let callOrdinal = 0
  let resultOrdinal = 0
  request.messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      if (!isRecord(part) || typeof part.id !== "string" || typeof part.name !== "string") return
      const base = ["messages", messageIndex, "content", partIndex] as const
      if (part.type === "tool-call") {
        located.push({
          path: [...base, "id"],
          id: part.id,
          name: part.name,
          kind: "call",
          ordinal: callOrdinal++,
        })
      }
      if (part.type !== "tool-result") return
      const nativeResultKind =
        isRecord(part.result) && part.result.type === "error"
          ? "error"
          : isRecord(part.result) && part.result.type === "text"
            ? "text"
            : "unknown"
      if (typeof part.result === "string") {
        located.push({
          path: [...base, "id"],
          bodyPath: [...base, "result"],
          id: part.id,
          name: part.name,
          kind: "result",
          ordinal: resultOrdinal++,
          resultKind: "unknown",
        })
      } else if (isRecord(part.result) && typeof part.result.value === "string") {
        located.push({
          path: [...base, "id"],
          bodyPath: [...base, "result", "value"],
          id: part.id,
          name: part.name,
          kind: "result",
          ordinal: resultOrdinal++,
          resultKind: nativeResultKind,
        })
      }
    })
  })
  return located
}

function mapping(
  requestFingerprint: string,
  input: ProjectionInput,
  located: readonly Located[],
): WireProjectionSnapshot {
  const calls: WireCallMapping[] = []
  const results: WireResultMapping[] = []
  for (const reference of selectedReferences(input.snapshot)) {
    const expectedID = ProviderTransform.toolCallID(reference.ref.callID, input.model)
    const call = located.filter((item) => item.kind === "call" && item.id === expectedID)
    const result = located.filter((item) => item.kind === "result" && item.id === expectedID)
    if (
      call.length !== 1 ||
      result.length !== 1 ||
      call[0].name !== reference.toolName ||
      result[0].name !== reference.toolName ||
      !result[0].bodyPath
    )
      continue
    calls.push({
      ref: reference.ref,
      visibleCallID: call[0].id,
      visibleCallIDPath: call[0].path,
      ordinal: call[0].ordinal,
    })
    results.push({
      ref: reference.ref,
      visibleCallID: result[0].id,
      visibleCallIDPath: result[0].path,
      bodyPath: result[0].bodyPath,
      ordinal: result[0].ordinal,
      resultKind: reference.resultKind,
      complete: reference.complete,
    })
  }
  return { requestFingerprint, calls, results }
}

function project<Request>(
  request: Request,
  input: ProjectionInput,
  runtime: "ai-sdk" | "native",
  preparedBudget: PreparedRequestBudgetInput,
  locate: (request: Request) => Located[],
  expectedMessages: unknown,
  allowedClasses: ReadonlySet<string> = new Set(),
): ContextFoldingProjectionResult<Request> {
  const unchanged = (skipReason: ProjectionSkipReason) =>
    ({
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
    }) satisfies ContextFoldingProjectionResult<Request>
  if (input.purpose !== "conversation") return unchanged("no-eligible-duplicates")
  const copy = independentWireCopy(request, allowedClasses)
  if (!copy.ok) return unchanged("invalid-structure")
  const copiedBudget = independentWireCopy(preparedBudget, allowedClasses)
  if (!copiedBudget.ok) return unchanged("unknown-content")
  const tree = copy.value
  const expectedCopy = independentWireCopy(expectedMessages, allowedClasses)
  if (!expectedCopy.ok || !sameWireValue(expectedCopy.value, isRecord(tree) ? tree.messages : undefined)) {
    return unchanged("mapping-mismatch")
  }
  const finalBudget = copiedBudget.value
  const copiedIdentity = independentWireCopy(identity(input, runtime), allowedClasses)
  if (!copiedIdentity.ok) return unchanged("unknown-content")
  const requestIdentity = copiedIdentity.value
  const fingerprint = fingerprintContextFoldingRequest({
    request: tree,
    identity: requestIdentity,
    budget: finalBudget,
  })
  if (!fingerprint.ok) return unchanged(fingerprint.reason)
  const wireMapping = mapping(fingerprint.value, input, locate(tree))
  return projectContextFoldingRequest({
    request: tree,
    identity: requestIdentity,
    expectedRequestFingerprint: fingerprint.value,
    duplicatePlan: input.snapshot.duplicatePlan,
    budget: finalBudget,
    mapping: wireMapping,
  })
}

function expectedTransformedMessages(input: ProjectionInput) {
  const historyBindingFingerprint = wireFingerprint({
    duplicatePlan: input.snapshot.duplicatePlan,
    references: input.snapshot.references,
    sourceMessages: input.sourceMessages,
  })
  if (!historyBindingFingerprint.ok || historyBindingFingerprint.value !== input.snapshot.historyBindingFingerprint)
    return undefined
  const copy = copyModelMessages(input.sourceMessages)
  if (!copy) return undefined
  try {
    return ProviderTransform.message(copy, input.model, input.messageTransformOptions)
  } catch {
    return undefined
  }
}

export function projectAISDK(input: ProjectionInput & { messages: ModelMessage[] }) {
  const expected = expectedTransformedMessages(input)
  if (!expected) {
    return project(
      { messages: input.messages },
      input,
      "ai-sdk",
      budget(input, input.messages, toolWire(input.tools)),
      locateAISDK,
      [],
    )
  }
  const request = { messages: input.messages }
  return project(request, input, "ai-sdk", budget(input, input.messages, toolWire(input.tools)), locateAISDK, expected)
}

export function projectNative(
  input: ProjectionInput & {
    request: { readonly system: unknown; readonly messages: unknown; readonly tools: unknown }
    transformedMessages: ModelMessage[]
  },
) {
  const expected = expectedTransformedMessages(input)
  const request = { messages: input.request.messages }
  const transmitted = { system: input.request.system, messages: input.request.messages }
  const expectedNative = expected ? LLMNative.convertMessages(expected).messages : []
  if (!expected || !sameWireValue(expected, input.transformedMessages)) {
    return project(
      request,
      input,
      "native",
      budget(input, transmitted, input.request.tools, input.request.messages),
      locateNative,
      [],
      new Set(["Message", "SystemPart", "ToolDefinition"]),
    )
  }
  return project(
    request,
    input,
    "native",
    budget(input, transmitted, input.request.tools, input.request.messages),
    locateNative,
    expectedNative,
    new Set(["Message", "SystemPart", "ToolDefinition"]),
  )
}

export * as ContextFolding from "./context-folding"
