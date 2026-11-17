// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The only source-to-prepared-graph seam for workflow authoring.
 *
 * Callers authorize and read a source; this module owns every interpretation
 * step after that boundary: YAML parsing, file-only legacy normalization,
 * strict action decode, block compilation, profile validation, diagnostics,
 * and content-addressed result caching.
 */
export * as WorkflowAuthoring from "./authoring"

import { Effect, Schema } from "effect"
import type { NodeConfig, NodeDefaults, WorkflowConfig } from "./dag"
import { graphForm, liveGates } from "./blocks"
import type { AcceptanceItem, LiveGate, LiveNode, PriorRound, ReviewGate, WorkflowBlock } from "./blocks"
import { acceptanceFromCriteria, type AdmissionInput } from "./admission"
import { DagCompose } from "./compose"
import type { Config } from "@/config/config"
import { DagTemplateInputs } from "./template-inputs"
import { DagValidation } from "./validation"

type Action = "start" | "extend" | "replan"

type Source = { kind: "inline"; value: unknown; source?: string } | { kind: "yaml"; content: string; source: string }

interface EnvironmentContext {
  directory?: string
  parent?: { id: string; providerID: string }
}

export type PreparedGraph =
  | {
      action: "start"
      nodes: NodeConfig[]
      title: string
      config: Omit<WorkflowConfig, "admission">
      admission?: AdmissionInput
    }
  | { action: "extend"; nodes: NodeConfig[] }
  | { action: "replan"; nodes: NodeConfig[] }

/** A prepared extend fragment, paired with the `extend` control op. */
export type PreparedExtend = Extract<PreparedGraph, { action: "extend" }>
/** A prepared replan fragment, paired with the `replan` control op. */
export type PreparedReplan = Extract<PreparedGraph, { action: "replan" }>
/** The prepared graphs a live control mutation may carry. */
export type PreparedNodes = PreparedExtend | PreparedReplan

interface Result extends DagValidation.ValidationResult {
  /** Strict decoded document. Boundary-owned legacy fields are not exposed. A
   * document that declares template inputs is returned as written, with its
   * declarations and placeholders. */
  document?: unknown
  prepared?: PreparedGraph
  /** Set when the start document declares template inputs: which declared
   * inputs the caller supplied and which fell back to their default. */
  template?: { supplied: string[]; defaulted: string[] }
}

interface PrepareInput {
  action: Action
  source: Source
  profile?: DagValidation.Profile
  environment?: EnvironmentContext
  /** Persisted workflow workspace for extend/replan. Fragments cannot carry
   * workspace; the runtime spawns their nodes in the durable workspace. */
  executionWorkspace?: string
  known_dependencies?: string[]
  node_defaults?: NodeDefaults
  /** Frozen review gate: the caller overrides the authored value at start
   * (session mode on) and passes the workflow's persisted value for mutations. */
  review_gate?: ReviewGate
  /** Acceptance items judged by the completeness lane; mutations pass the
   * workflow's persisted config.acceptance. */
  acceptance?: readonly AcceptanceItem[]
  /** Resolve a review block's prior_round from the referenced workflow's
   * stored outputs. Live callers supply it; portable validation compiles
   * without prior findings. A failure becomes a blocking diagnostic. */
  prior_rounds?: (reference: { workflow_id: string; review_id: string }) => Effect.Effect<PriorRound, string>
  /** Template arguments for a start document that declares `inputs` (#1073).
   * Absent means "no inputs supplied": a document with required inputs is then
   * rejected rather than started from placeholders. */
  template?: DagTemplateInputs.Supply
  /** The live workflow's nodes, for an extend (#1073). A block that depends on
   * a live reporting checkpoint is gated on its verdict as in a start document,
   * and a fragment that leaves a dependent of one ungated is rejected here with
   * its repair instead of at the runtime seam. */
  live_nodes?: readonly LiveNode[]
}

interface Options {
  loadEnvironment?: (context: EnvironmentContext) => Effect.Effect<DagValidation.EnvironmentCatalogs>
  /** Live config layer. Start validation reads the user's global
   * `dag.max_total_nodes` cap from it on every call (Issue #1031 M4); without
   * it the documented default applies. */
  config?: Pick<Config.Interface, "dagGlobal">
}

type DecodedAction =
  | { action: "start"; spec: DagValidation.StartSpec }
  | { action: "extend"; spec: DagValidation.ExtendGraph }
  | { action: "replan"; spec: { fragment: DagValidation.StartGraph } }

interface EffectiveReviewConfig {
  review_gate: ReviewGate
  acceptance?: readonly AcceptanceItem[]
}

/** The review gate is fixed at start and never re-derived from the current
 * session mode: a deep start always fixes strict, an explicit caller override
 * (session mode on) wins over the authored value, and mutations pass the
 * workflow's persisted gate through PrepareInput. Deep workflows without
 * config.acceptance derive AC1..ACn from the admission criteria. */
function effectiveReviewConfig(decoded: DecodedAction, input: PrepareInput): EffectiveReviewConfig {
  if (decoded.action !== "start") {
    return {
      review_gate: input.review_gate ?? "standard",
      ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
    }
  }
  const spec = decoded.spec
  let acceptance: readonly AcceptanceItem[] | undefined = spec.config.acceptance ?? input.acceptance
  if (acceptance === undefined && spec.mode === "deep" && spec.admission) {
    acceptance = acceptanceFromCriteria(spec.admission.brief.acceptance_criteria)
  }
  return {
    review_gate: spec.mode === "deep" ? "strict" : (input.review_gate ?? spec.config.review_gate ?? "standard"),
    ...(acceptance !== undefined ? { acceptance } : {}),
  }
}

const VALIDATOR_VERSION = 1
const ModelRef = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })
const decodeModelRef = Schema.decodeUnknownOption(ModelRef, DagValidation.STRICT_PARSE_OPTIONS)

export function make(options: Options = {}) {
  const cache = new Map<string, Result>()

  const prepare = (input: PrepareInput): Effect.Effect<Result> =>
    Effect.gen(function* () {
      const profile = input.profile ?? "portable"
      const sourceName = input.source.kind === "yaml" ? input.source.source : (input.source.source ?? "<inline>")
      // Only a start document owns the node ceiling; fragments inherit the
      // workflow's persisted one and are checked again by Dag.replan.
      const userDag = options.config ? yield* options.config.dagGlobal() : undefined
      const userMaxTotalNodes = input.action === "start" ? userDag?.max_total_nodes : undefined
      const key = cacheKey(input, profile, userMaxTotalNodes)
      // Environment catalogs are live state (models and agents may
      // change during the tool instance), so only portable results are safe
      // to cache by source content. A prior_round compile depends on another
      // workflow's stored outputs, so it is never cached; neither is a fragment
      // read against the live workflow's nodes.
      const cacheable =
        profile === "portable" && input.live_nodes === undefined && !sourceMentionsPriorRound(input.source)
      const cached = cacheable ? cache.get(key) : undefined
      if (cached) return cached

      // A start document that declares template inputs is returned as written
      // (declarations and placeholders intact) with a note of which inputs the
      // call supplied; the instantiated copy only feeds decoding.
      let template: DagTemplateInputs.Outcome | undefined
      let asWritten: unknown
      const finish = (result: Result): Result => {
        const finished: Result = template?.declared
          ? {
              ...result,
              document: asWritten,
              template: { supplied: template.supplied, defaulted: template.defaulted },
            }
          : result
        if (cacheable) cache.set(key, finished)
        return finished
      }

      const parsed = parseSource(input.source, input.action, profile)
      if (!parsed.value) return finish(parsed.result)
      asWritten = parsed.value.value
      let documentValue = parsed.value.value
      if (input.action === "start") {
        template = DagTemplateInputs.instantiate(documentValue, input.template)
        if (template.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
          return finish(invalidResult(sourceName, profile, template.diagnostics))
        documentValue = template.value
      }
      const liveForm = input.live_nodes ? graphForm(input.live_nodes.map((entry) => entry.definition)) : undefined
      const decoded = decodeAction(input.action, documentValue, sourceName, profile, liveForm, template?.origins)
      if (!decoded.value) return finish({ ...decoded.result, document: parsed.value.value })
      if (decoded.value.action === "replan") {
        const fragment = decoded.value.spec.fragment
        const rejected = (["delivery_node", "workspace", "isolation", "acceptance", "review_gate"] as const)
          .filter((field) => fragment[field] !== undefined)
          .map((field) =>
            DagValidation.diagnostic({
              code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
              path: `fragment.${field}`,
              message:
                field === "workspace"
                  ? "workspace only applies to start; set workspace on individual nodes instead"
                  : field === "isolation"
                    ? "isolation only applies to start; a workflow-level worktree cannot be introduced mid-run"
                    : field === "acceptance"
                      ? "acceptance only applies to start; the workflow's acceptance criteria are fixed and judged by its completeness lane"
                      : field === "review_gate"
                        ? "review_gate only applies to start; the gate is fixed at run.start and later mutations validate against the persisted value"
                        : `${field} only applies to start; replans preserve the existing capture and delivery configuration`,
              hint:
                field === "workspace"
                  ? 'Remove "workspace" from the fragment and set it on each node that needs a different checkout.'
                  : field === "isolation"
                    ? 'Remove "isolation" from the fragment; node-level isolation stays available per node.'
                    : field === "acceptance"
                      ? 'Remove "acceptance" from the fragment; it belongs to the start document.'
                      : field === "review_gate"
                        ? 'Remove "review_gate" from the fragment; start a successor workflow to change the gate.'
                        : `Remove "${field}" from the fragment. Delivery selection is maintained by the runtime across replans.`,
            }),
          )
        if (rejected.length > 0)
          return finish({ ...invalidResult(sourceName, profile, rejected), document: decoded.value.spec })
      }
      const prior = yield* resolvePriorRounds(decoded.value, input.prior_rounds)
      if (prior.diagnostics.length > 0)
        return finish({ ...invalidResult(sourceName, profile, prior.diagnostics), document: decoded.value.spec })
      const review = effectiveReviewConfig(decoded.value, input)
      // An extend fragment may depend on checkpoints of the live workflow; they
      // gate their dependents the way an in-document review block does.
      const gates =
        input.action === "extend" && input.live_nodes
          ? liveGates(input.live_nodes, input.node_defaults)
          : undefined
      const compiled = compileAction(decoded.value, input.known_dependencies, review, prior.rounds, gates)
      if (!compiled.nodes)
        return finish({ ...invalidResult(sourceName, profile, compiled.diagnostics), document: decoded.value.spec })
      if (profile === "environment" && !options.loadEnvironment) {
        return finish({
          ...invalidResult(sourceName, profile, [
            DagValidation.diagnostic({
              code: DagValidation.DIAGNOSTIC_CODES.environmentUnavailable,
              path: "$environment",
              message: "environment validation requires a live catalog loader",
              hint: "Provide agents, prompt assets, and model resolution for environment validation",
            }),
          ]),
          document: decoded.value.spec,
        })
      }

      const modeledNodes = applyNodeModels(compiled.nodes, parsed.value.nodes)
      const nodes =
        input.action === "replan" && parsed.value.defaultModel
          ? modeledNodes.map((node) => (node.model ? node : { ...node, model: parsed.value.defaultModel }))
          : modeledNodes
      const baseDefaults = input.action === "start" ? compiled.node_defaults : input.node_defaults
      const nodeDefaults = parsed.value.defaultModel
        ? { ...baseDefaults, model: parsed.value.defaultModel }
        : baseDefaults
      const catalogs =
        profile === "environment" && options.loadEnvironment
          ? yield* options.loadEnvironment(input.environment ?? {})
          : undefined
      // #1158: a compose block, or a node whose worker is a composer, becomes its split node and expansion
      // slot here, where the agent catalog is at hand. The runtime cannot expand a slot yet, so the same
      // step refuses to submit one (DagCompose.gate).
      const composed = DagCompose.compileNodes(nodes, catalogs?.composers, DagCompose.limits(userDag))
      const composeErrors = [...composed.problems, ...DagCompose.gate(composed.nodes)].map((problem) =>
        DagValidation.diagnostic({
          code: DagValidation.DIAGNOSTIC_CODES.dagInvalid,
          path: problem.path,
          message: problem.message,
          hint: problem.hint,
        }),
      )
      const graphNodes = composed.nodes
      const validation = yield* DagValidation.validatePostCompile({
        source: sourceName,
        profile,
        config: {
          ...compiled.config,
          review_gate: review.review_gate,
          ...(userMaxTotalNodes !== undefined ? { user_max_total_nodes: userMaxTotalNodes } : {}),
          ...(nodeDefaults ? { node_defaults: nodeDefaults } : {}),
        },
        nodes: graphNodes,
        blocks: compiled.blocks,
        directory: input.environment?.directory,
        executionWorkspace: input.action === "start" ? undefined : input.executionWorkspace,
        catalogs,
        structural: input.action === "start",
      })
      // Block compilation reports through diagnostics; node-source compilation
      // can also return nodes with blocking diagnostics (the strict writer
      // gate). Merge them with the post-compile result instead of
      // short-circuiting, so the caller sees every error the document has.
      // #1073: the merged-graph checkpoint gate Dag.extend enforces at the
      // runtime seam, run here so the rejection carries its repair.
      const liveGateErrors =
        input.action === "extend" && input.live_nodes
          ? DagValidation.liveCheckpointGateDiagnostics({
              fragment: graphNodes,
              live: input.live_nodes,
              defaults: nodeDefaults,
              form: compiled.blocks === undefined ? "nodes" : "blocks",
            })
          : []
      const errors = DagValidation.sortDiagnostics([
        ...validation.errors,
        ...compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        ...composeErrors,
        ...liveGateErrors,
      ])
      const valid = errors.length === 0
      const prepared = valid ? prepareGraph(decoded.value, graphNodes, nodeDefaults, review) : undefined
      const result = {
        ...validation,
        valid,
        errors,
        warnings: DagValidation.sortDiagnostics([
          ...validation.warnings,
          ...compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
          ...legacyModelWarnings(input.action, parsed.value),
        ]),
        document: decoded.value.spec,
        ...(prepared ? { prepared } : {}),
      } satisfies Result
      return finish({
        ...result,
        warnings: DagValidation.sortDiagnostics([...result.warnings, ...(template?.diagnostics ?? [])]),
      })
    })

  return { prepare }
}

function prepareGraph(
  decoded: DecodedAction,
  nodes: NodeConfig[],
  nodeDefaults: NodeDefaults | undefined,
  review: EffectiveReviewConfig,
): PreparedGraph {
  if (decoded.action !== "start") return { action: decoded.action, nodes }
  const spec = decoded.spec
  const blocks = "blocks" in spec.config ? spec.config.blocks : []
  const syntheses = blocks.filter(
    (block) => block.kind === "synthesize" && !blocks.some((other) => other.depends_on?.includes(block.id)),
  )
  const deliveryNode = spec.config.delivery_node ?? (syntheses.length === 1 ? syntheses[0].id : undefined)
  return {
    action: decoded.action,
    nodes,
    title: spec.title ?? spec.config.name,
    config: {
      name: spec.config.name,
      ...(deliveryNode ? { delivery_node: deliveryNode } : {}),
      mode: spec.mode ?? "standard",
      review_gate: review.review_gate,
      ...(review.acceptance !== undefined ? { acceptance: [...review.acceptance] } : {}),
      ...(spec.config.max_concurrency !== undefined ? { max_concurrency: spec.config.max_concurrency } : {}),
      ...(spec.config.max_node_replan_attempts !== undefined
        ? { max_node_replan_attempts: spec.config.max_node_replan_attempts }
        : {}),
      ...(spec.config.max_total_nodes !== undefined ? { max_total_nodes: spec.config.max_total_nodes } : {}),
      ...(spec.config.workspace !== undefined ? { workspace: spec.config.workspace } : {}),
      ...(spec.config.isolation !== undefined ? { isolation: spec.config.isolation } : {}),
      ...(nodeDefaults ? { node_defaults: nodeDefaults } : {}),
      nodes,
    },
    ...(spec.admission ? { admission: spec.admission } : {}),
  }
}

interface LegacyModels {
  nodes: ReadonlyMap<string, { modelID: string; providerID: string }>
  defaultModel?: { modelID: string; providerID: string }
}

interface ParsedValue extends LegacyModels {
  value: unknown
}

function legacyModelWarnings(action: Action, models: LegacyModels): DagValidation.Diagnostic[] {
  const prefix = action === "start" ? "config." : action === "replan" ? "fragment." : ""
  const paths = [
    ...(models.defaultModel ? [`${prefix}node_defaults.model`] : []),
    ...Array.from(models.nodes.keys(), (nodeID) => `${prefix}nodes[${nodeID}].model`),
  ]
  return paths.map((path) =>
    DagValidation.diagnostic({
      severity: "warning",
      code: DagValidation.DIAGNOSTIC_CODES.modelLegacyPin,
      path,
      message: "Legacy YAML model pin retained for compatibility; it overrides DAG tier model selection.",
      hint: "Do not pin models in new workflow specs. Remove model and configure the DAG tiers in .agents/settings.json instead.",
    }),
  )
}

function parseSource(
  source: Source,
  action: Action,
  profile: DagValidation.Profile,
): { value: ParsedValue; result?: never } | { value?: never; result: Result } {
  if (source.kind === "inline") {
    return { value: { value: source.value, nodes: new Map() } }
  }
  const parsed = DagValidation.parseYaml(source.content)
  if (!parsed.parsed) {
    return { result: invalidResult(source.source, profile, [parsed.diagnostic]) }
  }
  return { value: normalizeLegacyFile(action, parsed.value) }
}

function decodeAction(
  action: Action,
  value: unknown,
  source: string,
  profile: DagValidation.Profile,
  liveForm?: "blocks" | "nodes" | "mixed",
  origins: readonly DagTemplateInputs.Origin[] = [],
) {
  const options = {
    ...DagValidation.STRICT_PARSE_OPTIONS,
    errors: "all",
  } as const
  // A decode failure under a field a template input filled names that input.
  const invalid = (failure: unknown) =>
    invalidResult(
      source,
      profile,
      DagTemplateInputs.explainOrigins(DagValidation.schemaDiagnostics(failure, "", action), origins),
    )
  if (action === "start") {
    // A document that mixes graph sources reports the one mistake with one
    // correction instead of four union errors.
    const mixed = DagValidation.mixedGraphDiagnostic(action, value, liveForm)
    if (mixed) return { result: invalidResult(source, profile, [mixed]) }
    const decoded = Schema.decodeUnknownResult(DagValidation.StartSpec, options)(value)
    if (decoded._tag === "Success") return { value: { action, spec: decoded.success } } as const
    return { result: invalid(decoded.failure) }
  }
  if (action === "extend") {
    const mixed = DagValidation.mixedGraphDiagnostic(action, value, liveForm)
    if (mixed) return { result: invalidResult(source, profile, [mixed]) }
    const decoded = Schema.decodeUnknownResult(DagValidation.ExtendSpec, options)(value)
    if (decoded._tag === "Success") return { value: { action, spec: decoded.success } } as const
    return { result: invalid(decoded.failure) }
  }
  // Replan-only tail (start/extend returned above). Guard the envelope BEFORE
  // the union decode so a missing top-level `fragment` reports the real mistake
  // instead of the misleading "blocks/nodes graph" union error.
  const envelope = DagValidation.replanEnvelopeDiagnostic(value)
  if (envelope) return { result: invalidResult(source, profile, [envelope]) }
  const mixed = DagValidation.mixedGraphDiagnostic(action, value, liveForm)
  if (mixed) return { result: invalidResult(source, profile, [mixed]) }
  const decoded = Schema.decodeUnknownResult(DagValidation.ReplanSpec, options)(value)
  if (decoded._tag === "Success") return { value: { action, spec: decoded.success } } as const
  return { result: invalid(decoded.failure) }
}

function compileAction(
  decoded: DecodedAction,
  knownDependencies: string[] | undefined,
  review: EffectiveReviewConfig,
  priorRounds: Readonly<Record<string, PriorRound>> = {},
  liveGateMap?: ReadonlyMap<string, LiveGate>,
): {
  nodes?: NodeConfig[]
  diagnostics: DagValidation.Diagnostic[]
  blocks?: readonly import("./blocks").DagBlocks.WorkflowBlock[]
  node_defaults?: NodeDefaults
  config: {
    mode?: "standard" | "deep"
    objective?: string
    max_total_nodes?: number
    delivery_node?: string
    workspace?: string
    isolation?: "worktree"
  }
} {
  const options: DagValidation.BlockCompileOptions = {
    known_dependencies: knownDependencies,
    review_gate: review.review_gate,
    ...(review.acceptance !== undefined ? { acceptance: review.acceptance } : {}),
    ...(Object.keys(priorRounds).length > 0 ? { prior_rounds: priorRounds } : {}),
    ...(liveGateMap !== undefined && liveGateMap.size > 0 ? { live_gates: liveGateMap } : {}),
  }
  if (decoded.action === "extend") {
    const extend = decoded.spec
    const compiled = DagValidation.compileBlockSource(extend, options)
    return {
      ...compiled,
      blocks: "blocks" in extend ? extend.blocks : undefined,
      config: "objective" in extend ? { objective: extend.objective } : {},
    }
  }
  const graph = decoded.action === "start" ? decoded.spec.config : decoded.spec.fragment
  const compiled = DagValidation.compileGraphSource(graph, options)
  return {
    ...compiled,
    blocks: "blocks" in graph ? graph.blocks : undefined,
    node_defaults: graph.node_defaults,
    config: decoded.action === "start" ? { ...graph, mode: decoded.spec.mode } : graph,
  }
}

function decodedBlocks(decoded: DecodedAction): readonly WorkflowBlock[] {
  if (decoded.action === "start")
    return "blocks" in decoded.spec.config ? decoded.spec.config.blocks : []
  if (decoded.action === "extend") return "blocks" in decoded.spec ? decoded.spec.blocks : []
  return "blocks" in decoded.spec.fragment ? decoded.spec.fragment.blocks : []
}

function priorRoundPath(decoded: DecodedAction): string {
  return decoded.action === "start" ? "config.blocks" : decoded.action === "extend" ? "blocks" : "fragment.blocks"
}

/** Resolve every declared prior_round through the caller's live loader. The
 * authoring agent never supplies prior findings itself; a missing or unknown
 * reference is a blocking diagnostic, never a silent empty round. */
function resolvePriorRounds(
  decoded: DecodedAction,
  loader: PrepareInput["prior_rounds"],
): Effect.Effect<{ rounds: Record<string, PriorRound>; diagnostics: DagValidation.Diagnostic[] }> {
  return Effect.gen(function* () {
    const references = new Map<string, { workflow_id: string; review_id: string }>()
    for (const block of decodedBlocks(decoded)) {
      const reference = block.prior_round
      if (block.kind !== "review" || reference === undefined) continue
      // Shape errors (empty ids, non-review blocks) belong to block compile.
      if (reference.workflow_id.trim() === "" || reference.review_id.trim() === "") continue
      references.set(`${reference.workflow_id}/${reference.review_id}`, reference)
    }
    if (loader === undefined || references.size === 0) return { rounds: {}, diagnostics: [] }
    const rounds: Record<string, PriorRound> = {}
    const diagnostics: DagValidation.Diagnostic[] = []
    for (const [key, reference] of references) {
      const loaded = yield* loader(reference).pipe(Effect.result)
      if (loaded._tag === "Failure") {
        diagnostics.push(
          DagValidation.diagnostic({
            code: DagValidation.DIAGNOSTIC_CODES.dagInvalid,
            path: priorRoundPath(decoded),
            message: `prior_round ${key} could not be resolved: ${loaded.failure}`,
            hint: "Reference the review decision of a completed or live workflow owned by this session; prior findings are read from its stored outputs",
          }),
        )
      } else {
        rounds[key] = loaded.success
      }
    }
    return { rounds, diagnostics }
  })
}

function sourceMentionsPriorRound(source: Source) {
  if (source.kind === "yaml") return source.content.includes("prior_round")
  return (JSON.stringify(source.value) ?? "").includes("prior_round")
}

function invalidResult(
  source: string,
  profile: DagValidation.Profile,
  diagnostics: DagValidation.Diagnostic[],
): Result {
  const errors = DagValidation.sortDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "error"))
  return {
    source,
    profile,
    valid: errors.length === 0,
    errors,
    warnings: DagValidation.sortDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning")),
    nodes: [],
  }
}

function normalizeLegacyFile(action: Action, value: unknown): ParsedValue {
  const stripped = action === "start" ? stripPersistedWorkflowFields(value) : value
  if (!isRecord(stripped)) return { value: stripped, nodes: new Map() }
  const graphKey = action === "start" ? "config" : action === "replan" ? "fragment" : undefined
  const graph = graphKey ? stripped[graphKey] : stripped
  const normalized = normalizeLegacyGraph(graph)
  return {
    value: graphKey ? { ...stripped, [graphKey]: normalized.graph } : normalized.graph,
    nodes: normalized.nodes,
    ...(normalized.defaultModel ? { defaultModel: normalized.defaultModel } : {}),
  }
}

function normalizeLegacyGraph(value: unknown): {
  graph: unknown
  nodes: Map<string, { modelID: string; providerID: string }>
  defaultModel?: { modelID: string; providerID: string }
} {
  if (!isRecord(value)) return { graph: value, nodes: new Map() }
  const nodeModels = new Map<string, { modelID: string; providerID: string }>()
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.map((node) => {
        if (!isRecord(node)) return node
        const model = decodeModelRef(node.model)
        if (model._tag === "None" || typeof node.id !== "string") return node
        nodeModels.set(node.id, model.value)
        const normalized = { ...node }
        delete normalized.model
        return normalized
      })
    : value.nodes
  const defaults = isRecord(value.node_defaults) ? { ...value.node_defaults } : value.node_defaults
  const defaultModel = isRecord(defaults) ? decodeModelRef(defaults.model) : undefined
  if (isRecord(defaults) && defaultModel?._tag === "Some") delete defaults.model
  return {
    graph: {
      ...value,
      ...(nodes ? { nodes } : {}),
      ...(defaults ? { node_defaults: defaults } : {}),
    },
    nodes: nodeModels,
    ...(defaultModel?._tag === "Some" ? { defaultModel: defaultModel.value } : {}),
  }
}

function stripPersistedWorkflowFields(value: unknown) {
  if (!isRecord(value) || !isRecord(value.admission)) return value
  const admission = { ...value.admission }
  delete admission.protocol_version
  delete admission.state
  delete admission.fingerprint
  return { ...value, admission }
}

function applyNodeModels(nodes: NodeConfig[], models: LegacyModels["nodes"]) {
  return nodes.map((node) => {
    const model = models.get(node.id)
    return model ? { ...node, model } : node
  })
}

function cacheKey(input: PrepareInput, profile: DagValidation.Profile, userMaxTotalNodes?: number) {
  const content =
    input.source.kind === "yaml" ? input.source.content : (JSON.stringify(input.source.value) ?? "undefined")
  const context = JSON.stringify({
    version: VALIDATOR_VERSION,
    action: input.action,
    profile,
    source: input.source.kind === "yaml" ? input.source.source : (input.source.source ?? "<inline>"),
    directory: input.environment?.directory,
    parent: input.environment?.parent,
    execution_workspace: input.executionWorkspace,
    known_dependencies: input.known_dependencies,
    node_defaults: input.node_defaults,
    review_gate: input.review_gate,
    acceptance: input.acceptance,
    user_max_total_nodes: userMaxTotalNodes,
    template: input.template,
  })
  return new Bun.CryptoHasher("sha256").update(`${context}\0${content}`).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
