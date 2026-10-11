// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import type { AdmissionInput } from "./admission"
import { DagValidation } from "./validation"

type Action = "start" | "extend" | "replan"

type Source = { kind: "inline"; value: unknown; source?: string } | { kind: "yaml"; content: string; source: string }

interface EnvironmentContext {
  directory?: string
  parent?: { id: string; providerID: string }
}

type PreparedGraph =
  | {
      action: "start"
      nodes: NodeConfig[]
      title: string
      config: Omit<WorkflowConfig, "admission">
      admission?: AdmissionInput
    }
  | { action: "extend"; nodes: NodeConfig[] }
  | { action: "replan"; nodes: NodeConfig[] }

interface Result extends DagValidation.ValidationResult {
  /** Strict decoded document. Boundary-owned legacy fields are not exposed. */
  document?: unknown
  prepared?: PreparedGraph
}

interface PrepareInput {
  action: Action
  source: Source
  profile?: DagValidation.Profile
  environment?: EnvironmentContext
  known_dependencies?: string[]
  node_defaults?: NodeDefaults
}

interface Options {
  loadEnvironment?: (context: EnvironmentContext) => Effect.Effect<DagValidation.EnvironmentCatalogs>
}

type DecodedAction =
  | { action: "start"; spec: DagValidation.StartSpec }
  | { action: "extend"; spec: DagValidation.ExtendGraph }
  | { action: "replan"; spec: { fragment: DagValidation.StartGraph } }

const VALIDATOR_VERSION = 1
const ModelRef = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })
const decodeModelRef = Schema.decodeUnknownOption(ModelRef, DagValidation.STRICT_PARSE_OPTIONS)

export function make(options: Options = {}) {
  const cache = new Map<string, Result>()

  const prepare = (input: PrepareInput): Effect.Effect<Result> =>
    Effect.gen(function* () {
      const profile = input.profile ?? "portable"
      const sourceName = input.source.kind === "yaml" ? input.source.source : (input.source.source ?? "<inline>")
      const key = cacheKey(input, profile)
      // Environment catalogs are live state (models and agents may
      // change during the tool instance), so only portable results are safe
      // to cache by source content.
      const cached = profile === "portable" ? cache.get(key) : undefined
      if (cached) return cached

      const parsed = parseSource(input.source, input.action, profile)
      if (!parsed.value) {
        if (profile === "portable") cache.set(key, parsed.result)
        return parsed.result
      }
      const decoded = decodeAction(input.action, parsed.value.value, sourceName, profile)
      if (!decoded.value) {
        const result = { ...decoded.result, document: parsed.value.value }
        if (profile === "portable") cache.set(key, result)
        return result
      }
      if (decoded.value.action === "replan") {
        const fragment = decoded.value.spec.fragment
        const rejected = (["result_protocol", "delivery_node"] as const)
          .filter((field) => fragment[field] !== undefined)
          .map((field) =>
            DagValidation.diagnostic({
              code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
              path: `fragment.${field}`,
              message: `${field} only applies to start; replans preserve the existing capture and delivery configuration`,
              hint: `Remove "${field}" from the fragment. Delivery selection is maintained by the runtime across replans.`,
            }),
          )
        if (rejected.length > 0) {
          const result = { ...invalidResult(sourceName, profile, rejected), document: decoded.value.spec }
          if (profile === "portable") cache.set(key, result)
          return result
        }
      }
      const compiled = compileAction(decoded.value, input.known_dependencies)
      if (!compiled.nodes) {
        const result = { ...invalidResult(sourceName, profile, compiled.diagnostics), document: decoded.value.spec }
        if (profile === "portable") cache.set(key, result)
        return result
      }
      if (profile === "environment" && !options.loadEnvironment) {
        return {
          ...invalidResult(sourceName, profile, [
            DagValidation.diagnostic({
              code: DagValidation.DIAGNOSTIC_CODES.environmentUnavailable,
              path: "$environment",
              message: "environment validation requires a live catalog loader",
              hint: "Provide agents, prompt assets, and model resolution for environment validation",
            }),
          ]),
          document: decoded.value.spec,
        }
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
      const validation = yield* DagValidation.validatePostCompile({
        source: sourceName,
        profile,
        config: {
          ...compiled.config,
          ...(nodeDefaults ? { node_defaults: nodeDefaults } : {}),
        },
        nodes,
        blocks: compiled.blocks,
        directory: input.environment?.directory,
        catalogs,
        structural: input.action === "start",
      })
      const prepared = validation.valid ? prepareGraph(decoded.value, nodes, nodeDefaults) : undefined
      const result = {
        ...validation,
        document: decoded.value.spec,
        ...(prepared ? { prepared } : {}),
      } satisfies Result
      if (profile === "portable") cache.set(key, result)
      return result
    })

  return { prepare }
}

function prepareGraph(decoded: DecodedAction, nodes: NodeConfig[], nodeDefaults?: NodeDefaults): PreparedGraph {
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
      ...(spec.config.result_protocol ? { result_protocol: spec.config.result_protocol } : {}),
      ...(deliveryNode ? { delivery_node: deliveryNode } : {}),
      mode: spec.mode ?? "standard",
      ...(spec.config.max_concurrency !== undefined ? { max_concurrency: spec.config.max_concurrency } : {}),
      ...(spec.config.max_node_replan_attempts !== undefined
        ? { max_node_replan_attempts: spec.config.max_node_replan_attempts }
        : {}),
      ...(spec.config.max_total_nodes !== undefined ? { max_total_nodes: spec.config.max_total_nodes } : {}),
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

function decodeAction(action: Action, value: unknown, source: string, profile: DagValidation.Profile) {
  const options = {
    ...DagValidation.STRICT_PARSE_OPTIONS,
    errors: "all",
  } as const
  if (action === "start") {
    const decoded = Schema.decodeUnknownResult(DagValidation.StartSpec, options)(value)
    if (decoded._tag === "Success") return { value: { action, spec: decoded.success } } as const
    return { result: invalidResult(source, profile, DagValidation.schemaDiagnostics(decoded.failure)) }
  }
  if (action === "extend") {
    const decoded = Schema.decodeUnknownResult(DagValidation.ExtendSpec, options)(value)
    if (decoded._tag === "Success") return { value: { action, spec: decoded.success } } as const
    return { result: invalidResult(source, profile, DagValidation.schemaDiagnostics(decoded.failure)) }
  }
  // Replan-only tail (start/extend returned above). Guard the envelope BEFORE
  // the union decode so a missing top-level `fragment` reports the real mistake
  // instead of the misleading "blocks/nodes graph" union error.
  const envelope = DagValidation.replanEnvelopeDiagnostic(value)
  if (envelope) return { result: invalidResult(source, profile, [envelope]) }
  const decoded = Schema.decodeUnknownResult(DagValidation.ReplanSpec, options)(value)
  if (decoded._tag === "Success") return { value: { action, spec: decoded.success } } as const
  return { result: invalidResult(source, profile, DagValidation.schemaDiagnostics(decoded.failure)) }
}

function compileAction(
  decoded: DecodedAction,
  knownDependencies?: string[],
): {
  nodes?: NodeConfig[]
  diagnostics: DagValidation.Diagnostic[]
  blocks?: readonly import("./blocks").DagBlocks.WorkflowBlock[]
  node_defaults?: NodeDefaults
  config: { mode?: "standard" | "deep"; max_total_nodes?: number; delivery_node?: string }
} {
  if (decoded.action === "extend") {
    const extend = decoded.spec
    const compiled = DagValidation.compileBlockSource(extend, { known_dependencies: knownDependencies })
    return {
      ...compiled,
      blocks: "blocks" in extend ? extend.blocks : undefined,
      config: {},
    }
  }
  const graph = decoded.action === "start" ? decoded.spec.config : decoded.spec.fragment
  const compiled = DagValidation.compileGraphSource(graph, { known_dependencies: knownDependencies })
  return {
    ...compiled,
    blocks: "blocks" in graph ? graph.blocks : undefined,
    node_defaults: graph.node_defaults,
    config: decoded.action === "start" ? { ...graph, mode: decoded.spec.mode } : graph,
  }
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

function cacheKey(input: PrepareInput, profile: DagValidation.Profile) {
  const content =
    input.source.kind === "yaml" ? input.source.content : (JSON.stringify(input.source.value) ?? "undefined")
  const context = JSON.stringify({
    version: VALIDATOR_VERSION,
    action: input.action,
    profile,
    source: input.source.kind === "yaml" ? input.source.source : (input.source.source ?? "<inline>"),
    directory: input.environment?.directory,
    parent: input.environment?.parent,
    known_dependencies: input.known_dependencies,
    node_defaults: input.node_defaults,
  })
  return new Bun.CryptoHasher("sha256").update(`${context}\0${content}`).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
