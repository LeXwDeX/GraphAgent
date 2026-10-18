import { Hash } from "../../util/hash"
import { Token } from "../../util/token"
import { estimateContextFoldingBudget } from "./budget"
import { ContextFoldingPolicy } from "./policy"
import type {
  ContextFoldingProjectionInput,
  ContextFoldingProjectionPlan,
  ContextFoldingProjectionResult,
  ContextFoldingRequestFingerprintInput,
  FoldRef,
  ProjectionDependencies,
  ProjectionSkipReason,
  SelectedFoldReplacement,
  WirePathSegment,
  WireProjectionSnapshot,
  WireResultMapping,
} from "./types"
import { cloneWireValue, readWirePath, serializeWireValue, verifyWireValueChanges, writeWirePath } from "./wire-value"
import { consumeContainerEntries, consumeString, createWorkBudget, type WorkBudget } from "./work-budget"

const TEXT_PLACEHOLDER_PREFIX = "[Duplicate tool output folded. Identical full output is retained in later tool call "
const ERROR_PLACEHOLDER_PREFIX =
  "[Duplicate tool error output folded. The identical full error is retained in later tool call "
const PLACEHOLDER_PREFIXES = [TEXT_PLACEHOLDER_PREFIX, ERROR_PLACEHOLDER_PREFIX] as const
const PLACEHOLDER_SUFFIX = ".]"

const refKey = (ref: FoldRef) => JSON.stringify([ref.messageID, ref.partID, ref.callID])
const pathKey = (path: readonly WirePathSegment[]) =>
  JSON.stringify(path.map((segment) => [typeof segment === "number" ? "n" : "s", segment]))

const emptyProjectionPlan = (
  skipReason: ProjectionSkipReason,
  budget?: ReturnType<typeof estimateContextFoldingBudget>,
): ContextFoldingProjectionPlan => ({
  replacements: [],
  estimatedBefore: budget?.estimatedInputTokens,
  estimatedAfter: budget?.estimatedInputTokens,
  targetTokens: budget?.targetTokens,
  overBudget: budget?.overBudget,
  skipReason,
})

const unchanged = <Request>(
  request: Request,
  skipReason: ProjectionSkipReason,
  budget?: ReturnType<typeof estimateContextFoldingBudget>,
): ContextFoldingProjectionResult<Request> => ({
  request,
  applied: false,
  plan: emptyProjectionPlan(skipReason, budget),
})

const validRef = (ref: FoldRef) =>
  !!ref &&
  typeof ref.messageID === "string" &&
  ref.messageID.length > 0 &&
  typeof ref.partID === "string" &&
  ref.partID.length > 0 &&
  typeof ref.callID === "string" &&
  ref.callID.length > 0

const utf8BytesAtMost = (value: string, limit: number) => {
  if (value.length > limit) return false
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
    if (bytes > limit) return false
  }
  return true
}

const placeholder = (visibleCallID: string, resultKind: "text" | "error") => {
  if (visibleCallID.length === 0 || !utf8BytesAtMost(visibleCallID, ContextFoldingPolicy.maximumVisibleCallIDBytes)) {
    return undefined
  }
  const prefix = resultKind === "error" ? ERROR_PLACEHOLDER_PREFIX : TEXT_PLACEHOLDER_PREFIX
  return `${prefix}${JSON.stringify(visibleCallID)}${PLACEHOLDER_SUFFIX}`
}

const alreadyProjected = (value: string) => PLACEHOLDER_PREFIXES.some((prefix) => value.startsWith(prefix))

const mappingResultKind = (result: WireResultMapping): "text" | "error" | "unknown" => {
  if (result.resultKind === "error") return "error"
  if (result.resultKind === "text" || result.resultKind === undefined) return "text"
  return "unknown"
}

export const fingerprintContextFoldingRequest = (input: ContextFoldingRequestFingerprintInput) => {
  const request = serializeWireValue(input.request)
  if (!request.ok) return request
  const identity = serializeWireValue(input.identity)
  if (!identity.ok) return identity
  const budget = serializeWireValue(input.budget)
  if (!budget.ok) return budget
  const inputBytes = request.inputBytes + identity.inputBytes + budget.inputBytes
  if (!Number.isSafeInteger(inputBytes)) return { ok: false as const, reason: "work-limit" as const }
  return {
    ok: true as const,
    value: Hash.sha256(
      `request:${Hash.sha256(request.value)};identity:${Hash.sha256(identity.value)};budget:${Hash.sha256(budget.value)}`,
    ),
    inputBytes,
  }
}

type ValidatedReplacement = SelectedFoldReplacement &
  Readonly<{
    sourcePath: readonly WirePathSegment[]
    witnessPath: readonly WirePathSegment[]
    sourceBody: string
    witnessBody: string
    sourceOrdinal: number
    anchor: boolean
  }>

type MappingValidation =
  | Readonly<{ ok: true; replacements: readonly ValidatedReplacement[] }>
  | Readonly<{ ok: false; reason: "already-projected" | "invalid-reference" | "mapping-mismatch" | "work-limit" }>

const validOrdinal = (value: number) => Number.isSafeInteger(value) && value >= 0

const validPath = (path: unknown): path is readonly WirePathSegment[] =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.length <= ContextFoldingPolicy.workLimits.maxDepth &&
  path.every(
    (segment: unknown) =>
      (typeof segment === "string" || typeof segment === "number") &&
      (typeof segment !== "number" || (Number.isSafeInteger(segment) && segment >= 0)),
  )

const consumeRef = (ref: FoldRef, budget: WorkBudget) =>
  consumeString(budget, ref.messageID) && consumeString(budget, ref.partID) && consumeString(budget, ref.callID)

const consumePath = (path: readonly WirePathSegment[], budget: WorkBudget) =>
  consumeContainerEntries(budget, path.length) &&
  path.every((segment) => typeof segment !== "string" || consumeString(budget, segment))

const validateMapping = <Request>(
  request: Request,
  snapshot: WireProjectionSnapshot,
  replacements: ContextFoldingProjectionInput<Request>["duplicatePlan"]["replacements"],
): MappingValidation => {
  if (!Array.isArray(snapshot.calls) || !Array.isArray(snapshot.results))
    return { ok: false, reason: "mapping-mismatch" }
  if (
    snapshot.calls.length > ContextFoldingPolicy.maximumCandidates ||
    snapshot.results.length > ContextFoldingPolicy.maximumCandidates ||
    replacements.length > ContextFoldingPolicy.maximumCandidates
  ) {
    return { ok: false, reason: "work-limit" }
  }

  const budget = createWorkBudget(ContextFoldingPolicy.workLimits)
  if (!consumeContainerEntries(budget, snapshot.calls.length + snapshot.results.length + replacements.length)) {
    return { ok: false, reason: "work-limit" }
  }

  const callsByRef = new Map<string, (typeof snapshot.calls)[number]>()
  const callsByID = new Set<string>()
  const callOrdinals = new Set<number>()
  const wirePaths = new Set<string>()
  for (const call of snapshot.calls) {
    if (
      !validRef(call.ref) ||
      typeof call.visibleCallID !== "string" ||
      call.visibleCallID.length === 0 ||
      !validPath(call.visibleCallIDPath) ||
      !validOrdinal(call.ordinal)
    ) {
      return { ok: false, reason: "mapping-mismatch" }
    }
    if (
      !consumeRef(call.ref, budget) ||
      !consumeString(budget, call.visibleCallID) ||
      !consumePath(call.visibleCallIDPath, budget)
    ) {
      return { ok: false, reason: "work-limit" }
    }
    const key = refKey(call.ref)
    const callIDPathKey = pathKey(call.visibleCallIDPath)
    if (
      callsByRef.has(key) ||
      callsByID.has(call.visibleCallID) ||
      callOrdinals.has(call.ordinal) ||
      wirePaths.has(callIDPathKey)
    ) {
      return { ok: false, reason: "mapping-mismatch" }
    }
    const actualCallID = readWirePath(request, call.visibleCallIDPath)
    if (!actualCallID.ok || actualCallID.value !== call.visibleCallID) {
      return { ok: false, reason: "mapping-mismatch" }
    }
    callsByRef.set(key, call)
    callsByID.add(call.visibleCallID)
    callOrdinals.add(call.ordinal)
    wirePaths.add(callIDPathKey)
  }

  const resultsByRef = new Map<string, WireResultMapping>()
  const resultsByID = new Set<string>()
  const resultOrdinals = new Set<number>()
  const paths = new Set<string>()
  for (const result of snapshot.results) {
    if (
      !validRef(result.ref) ||
      typeof result.visibleCallID !== "string" ||
      result.visibleCallID.length === 0 ||
      !validOrdinal(result.ordinal) ||
      (result.complete !== true && result.complete !== false) ||
      !validPath(result.visibleCallIDPath) ||
      !validPath(result.bodyPath)
    ) {
      return { ok: false, reason: "mapping-mismatch" }
    }
    if (
      !consumeRef(result.ref, budget) ||
      !consumeString(budget, result.visibleCallID) ||
      !consumePath(result.visibleCallIDPath, budget) ||
      !consumePath(result.bodyPath, budget)
    ) {
      return { ok: false, reason: "work-limit" }
    }
    const key = refKey(result.ref)
    const resultIDPathKey = pathKey(result.visibleCallIDPath)
    const bodyPathKey = pathKey(result.bodyPath)
    if (
      resultsByRef.has(key) ||
      resultsByID.has(result.visibleCallID) ||
      resultOrdinals.has(result.ordinal) ||
      wirePaths.has(resultIDPathKey) ||
      wirePaths.has(bodyPathKey) ||
      resultIDPathKey === bodyPathKey ||
      paths.has(bodyPathKey)
    ) {
      return { ok: false, reason: "mapping-mismatch" }
    }
    const call = callsByRef.get(key)
    if (!call || call.visibleCallID !== result.visibleCallID) return { ok: false, reason: "mapping-mismatch" }
    const actualResultID = readWirePath(request, result.visibleCallIDPath)
    if (!actualResultID.ok || actualResultID.value !== result.visibleCallID) {
      return { ok: false, reason: "mapping-mismatch" }
    }
    const body = readWirePath(request, result.bodyPath)
    if (!body.ok || typeof body.value !== "string") return { ok: false, reason: "mapping-mismatch" }
    resultsByRef.set(key, result)
    resultsByID.add(result.visibleCallID)
    resultOrdinals.add(result.ordinal)
    wirePaths.add(resultIDPathKey)
    wirePaths.add(bodyPathKey)
    paths.add(bodyPathKey)
  }

  if (callsByRef.size !== resultsByRef.size || callsByID.size !== resultsByID.size) {
    return { ok: false, reason: "mapping-mismatch" }
  }

  const sourceRefs = new Set<string>()
  const witnessRefs = new Set<string>()
  for (const replacement of replacements) {
    const source = refKey(replacement.source)
    const witness = refKey(replacement.witness)
    if (source === witness || sourceRefs.has(source)) return { ok: false, reason: "mapping-mismatch" }
    sourceRefs.add(source)
    witnessRefs.add(witness)
  }
  if ([...witnessRefs].some((witness) => sourceRefs.has(witness))) return { ok: false, reason: "mapping-mismatch" }

  const validated: ValidatedReplacement[] = []
  let previousSourceOrdinal = -1
  let firstFailure: "invalid-reference" | "mapping-mismatch" | undefined
  for (const replacement of replacements) {
    const resultKind = replacement.resultKind === "error" ? "error" : "text"
    const source = resultsByRef.get(refKey(replacement.source))
    const witness = resultsByRef.get(refKey(replacement.witness))
    if (
      !source ||
      !witness ||
      !source.complete ||
      !witness.complete ||
      source.ordinal >= witness.ordinal ||
      mappingResultKind(source) !== resultKind ||
      mappingResultKind(witness) !== resultKind
    ) {
      firstFailure ??= "mapping-mismatch"
      continue
    }
    if (source.ordinal <= previousSourceOrdinal) {
      firstFailure ??= "mapping-mismatch"
      continue
    }

    const sourceBody = readWirePath(request, source.bodyPath)
    const witnessBody = readWirePath(request, witness.bodyPath)
    if (
      !sourceBody.ok ||
      !witnessBody.ok ||
      typeof sourceBody.value !== "string" ||
      typeof witnessBody.value !== "string"
    ) {
      firstFailure ??= "mapping-mismatch"
      continue
    }
    // Re-folding an already projected request is a whole-mapping condition, not a single-pair mismatch.
    if (alreadyProjected(sourceBody.value)) return { ok: false, reason: "already-projected" }
    if (sourceBody.value !== witnessBody.value) {
      firstFailure ??= "mapping-mismatch"
      continue
    }

    const folded = placeholder(witness.visibleCallID, resultKind)
    if (folded === undefined) {
      firstFailure ??= "invalid-reference"
      continue
    }
    const estimatedSavings = Token.estimate(JSON.stringify(sourceBody.value)) - Token.estimate(JSON.stringify(folded))
    previousSourceOrdinal = source.ordinal
    validated.push({
      source: replacement.source,
      witness: replacement.witness,
      placeholder: folded,
      estimatedSavings,
      sourcePath: [...source.bodyPath],
      witnessPath: [...witness.bodyPath],
      sourceBody: sourceBody.value,
      witnessBody: witnessBody.value,
      sourceOrdinal: source.ordinal,
      anchor: replacement.anchor === true,
    })
  }

  if (validated.length === 0 && replacements.length > 0) {
    return { ok: false, reason: firstFailure ?? "mapping-mismatch" }
  }
  return { ok: true, replacements: validated }
}

/**
 * Validates a final-wire mapping, selects old duplicate sources by budget, and applies all replacements to a private
 * serializable copy. Every failure returns the exact original request object.
 */
const project = <Request>(
  input: ContextFoldingProjectionInput<Request>,
  dependencies: ProjectionDependencies = {},
): ContextFoldingProjectionResult<Request> => {
  const budget = estimateContextFoldingBudget(input.budget)
  if (budget.skipReason) return unchanged(input.request, budget.skipReason, budget)

  const currentFingerprint = fingerprintContextFoldingRequest({
    request: input.request,
    identity: input.identity,
    budget: input.budget,
  })
  if (!currentFingerprint.ok) return unchanged(input.request, currentFingerprint.reason, budget)
  if (
    !input.expectedRequestFingerprint ||
    currentFingerprint.value !== input.expectedRequestFingerprint ||
    input.mapping.requestFingerprint !== currentFingerprint.value
  ) {
    return unchanged(input.request, "stale-request", budget)
  }

  if (input.duplicatePlan.replacements.length === 0) {
    return unchanged(input.request, input.duplicatePlan.skipReason ?? "no-eligible-duplicates", budget)
  }
  if (input.duplicatePlan.skipReason !== undefined) return unchanged(input.request, "mapping-mismatch", budget)

  const mapping = validateMapping(input.request, input.mapping, input.duplicatePlan.replacements)
  if (!mapping.ok) return unchanged(input.request, mapping.reason, budget)

  const eligible = mapping.replacements.filter(
    (replacement) => replacement.estimatedSavings >= ContextFoldingPolicy.minimumNetSavingsTokens,
  )
  const selected: ValidatedReplacement[] = []
  let estimatedAfter = budget.estimatedInputTokens!
  const select = (replacements: readonly ValidatedReplacement[]) => {
    for (const replacement of replacements) {
      selected.push(replacement)
      estimatedAfter = Math.max(0, estimatedAfter - replacement.estimatedSavings)
      if (estimatedAfter <= budget.targetTokens!) break
    }
  }
  // Compress unrelated tasks first: sources from earlier task epochs are folded before duplicates that belong to
  // the current task. Exact duplicates preserve meaning either way; this ordering preserves the active task's
  // full working set whenever older duplicates alone are enough to reach the soft target.
  select(eligible.filter((replacement) => !replacement.anchor))
  if (estimatedAfter > budget.targetTokens!) select(eligible.filter((replacement) => replacement.anchor))
  selected.sort((left, right) => left.sourceOrdinal - right.sourceOrdinal)
  if (selected.length === 0) return unchanged(input.request, "insufficient-savings", budget)

  const copy = cloneWireValue(input.request)
  if (!copy.ok)
    return unchanged(input.request, copy.reason === "work-limit" ? "work-limit" : "projection-failed", budget)

  try {
    for (const [index, replacement] of selected.entries()) {
      if (!writeWirePath(copy.value, replacement.sourcePath, replacement.placeholder)) {
        return unchanged(input.request, "projection-failed", budget)
      }
      dependencies.afterReplacement?.(index)
    }

    for (const replacement of selected) {
      const projectedSource = readWirePath(copy.value, replacement.sourcePath)
      const projectedWitness = readWirePath(copy.value, replacement.witnessPath)
      const originalSource = readWirePath(input.request, replacement.sourcePath)
      const originalWitness = readWirePath(input.request, replacement.witnessPath)
      if (
        !projectedSource.ok ||
        projectedSource.value !== replacement.placeholder ||
        !projectedWitness.ok ||
        projectedWitness.value !== replacement.witnessBody ||
        !originalSource.ok ||
        originalSource.value !== replacement.sourceBody ||
        !originalWitness.ok ||
        originalWitness.value !== replacement.witnessBody
      ) {
        return unchanged(input.request, "projection-failed", budget)
      }
    }

    const verification = verifyWireValueChanges(
      input.request,
      copy.value,
      selected.map((replacement) => ({
        path: replacement.sourcePath,
        before: replacement.sourceBody,
        after: replacement.placeholder,
      })),
    )
    if (!verification.ok) {
      return unchanged(input.request, verification.reason === "work-limit" ? "work-limit" : "projection-failed", budget)
    }
    if (!verification.value) return unchanged(input.request, "projection-failed", budget)
  } catch {
    return unchanged(input.request, "projection-failed", budget)
  }

  const publicReplacements: SelectedFoldReplacement[] = selected.map(
    ({ source, witness, placeholder, estimatedSavings }) => ({ source, witness, placeholder, estimatedSavings }),
  )
  return {
    request: copy.value,
    applied: true,
    plan: {
      replacements: publicReplacements,
      estimatedBefore: budget.estimatedInputTokens,
      estimatedAfter,
      targetTokens: budget.targetTokens,
      overBudget: estimatedAfter > budget.targetTokens!,
      skipReason: undefined,
    },
  }
}

export const projectContextFoldingRequest = <Request>(
  input: ContextFoldingProjectionInput<Request>,
  dependencies: ProjectionDependencies = {},
): ContextFoldingProjectionResult<Request> => {
  try {
    return project(input, dependencies)
  } catch {
    return unchanged(input.request, "projection-failed")
  }
}
