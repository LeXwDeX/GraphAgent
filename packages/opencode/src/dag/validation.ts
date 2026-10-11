// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Workflow spec validation authority.
 *
 * Side-effect-free rule core shared by WorkflowAuthoring and Dag.create /
 * Dag.replan. Raw source orchestration belongs exclusively to
 * WorkflowAuthoring; this module never chooses or reads a source.
 *
 * Profiles:
 * - portable — proves a spec can be distributed on its own (no dependency on
 *              one user's project prompts, models, or agents);
 * - environment — portable plus resolution against the current project/global
 *              prompt directories and the agent/skill/model catalogs.
 *
 * Validation never creates workflows, publishes DAG events, registers nodes,
 * spawns child sessions, or writes files.
 */

export * as DagValidation from "./validation"

import { Effect, Option, Schema } from "effect"
import { buildGraph } from "@opencode-ai/core/dag/core/scheduling"
import { CycleError } from "@opencode-ai/core/dag/core/graph"
import { validateRequiredNodes } from "@opencode-ai/core/dag/core/required-validator"
import type { NodeConfig } from "./dag"
import { DEFAULT_WORKFLOW_CONFIG } from "./dag"
import { DagBlocks } from "./blocks"
import { AdmissionInput, ExecutionMode } from "./admission"
import { validateReviewLifecycle } from "./review-lifecycle"
import { conditionReference, conditionSyntaxError, parseInputMappingReference } from "./runtime/eval"
import { unsupportedSchemaKeywords } from "./runtime/capture"
import { placeholderKeys, templateSourceById } from "./templates/resolve"

// ============================================================================
// Diagnostic contract
// ============================================================================

export const DIAGNOSTIC_CODES = {
  schemaInvalid: "schema.invalid",
  // Reserved vocabulary from the design: source exclusivity is enforced by the
  // discriminated parameter schema before any diagnostic path runs.
  graphSourceConflict: "graph.source_conflict",
  // A replan document is missing its required top-level `fragment` envelope. A
  // dedicated code (not the generic union schemaInvalid) so the parent agent can
  // recognize the exact mistake and retry deterministically instead of reusing a
  // wrong conclusion across attempts.
  replanEnvelopeMissing: "replan.envelope_missing",
  blockCompileFailed: "block.compile_failed",
  dagInvalid: "dag.invalid",
  promptUnboundVariable: "prompt.unbound_variable",
  promptMissingAsset: "prompt.missing_asset",
  promptNonportableAsset: "prompt.nonportable_asset",
  workerUnknown: "worker.unknown",
  modelUnavailable: "model.unavailable",
  environmentUnavailable: "environment.unavailable",
  schemaKeywordWarning: "schema.keyword_warning",
} as const

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES]

export const DiagnosticCodeSchema = Schema.Literals(Object.values(DIAGNOSTIC_CODES))

export const DiagnosticSchema = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  code: DiagnosticCodeSchema,
  /** Field or asset path, e.g. `config.blocks` or `nodes[verify].prompt_template.id`. */
  path: Schema.String,
  message: Schema.String,
  hint: Schema.String,
})
export type Diagnostic = typeof DiagnosticSchema.Type

/** Structural validation errors carry the shared diagnostics so callers can
 * compare validate/start/replan rejections code by code (spec: one authority). */
export class StructuralValidationError extends Schema.TaggedErrorClass<StructuralValidationError>()(
  "StructuralValidationError",
  { diagnostics: Schema.mutable(Schema.Array(DiagnosticSchema)) },
) {
  /** The message text tools and tests have always seen, derived from the
   * shared diagnostic messages. The legacy render format is decided at
   * construction time via the legacy-class tag — never by re-parsing
   * message text. */
  override get message() {
    return this.diagnostics.map((d) => legacyValidationMessage(d)).join("; ")
  }
}

export type Profile = "portable" | "environment"

export interface CompiledNodeSummary {
  id: string
  name: string
  worker_type: string
  depends_on: string[]
  required: boolean
  report_to_parent: boolean
  has_output_schema: boolean
  review_phase?: "design" | "diff"
}

export interface ValidationResult {
  source: string
  profile: Profile
  valid: boolean
  errors: Diagnostic[]
  warnings: Diagnostic[]
  nodes: CompiledNodeSummary[]
}

export function diagnostic(input: {
  severity?: "error" | "warning"
  code: DiagnosticCode
  path: string
  message: string
  hint?: string
}): Diagnostic {
  return {
    severity: input.severity ?? "error",
    code: input.code,
    path: input.path,
    message: input.message,
    hint: input.hint ?? "",
  }
}

/** Stable ordering: field path, then code, then message. Same input always
 * yields the same diagnostic order, so validate output is diffable. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  )
}

export type YamlParseResult = { parsed: true; value: unknown } | { parsed: false; diagnostic: Diagnostic }

/** YAML parsing belongs to the validation authority so the workflow tool,
 * config CI, generation, and release packaging cannot drift on parse-error
 * codes or paths. */
export function parseYaml(content: string): YamlParseResult {
  try {
    return { parsed: true, value: Bun.YAML.parse(content) }
  } catch {
    return {
      parsed: false,
      diagnostic: diagnostic({
        code: DIAGNOSTIC_CODES.schemaInvalid,
        path: "$",
        message: "file is not parseable YAML",
        hint: "Fix the YAML syntax before validation can run",
      }),
    }
  }
}

function summarizeNodes(nodes: readonly NodeConfig[]): CompiledNodeSummary[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    worker_type: node.worker_type,
    depends_on: [...node.depends_on],
    required: node.required ?? false,
    report_to_parent: node.report_to_parent ?? false,
    has_output_schema: node.output_schema !== undefined,
    ...(node.review ? { review_phase: node.review.phase } : {}),
  }))
}

// ============================================================================
// Spec schemas — the single decode authority for inline and file-backed input
// ============================================================================

const PromptInput = Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
/** A prompt template selects exactly one source: inline text or an asset id.
 * Both present is ambiguous; neither is a spawn-time guarantee the runtime
 * cannot keep. */
export const PromptTemplateSource = Schema.Union([
  Schema.Struct({
    inline: Schema.String.annotate({
      description: "Inline prompt text; bind {{placeholders}} via input or input_mapping",
    }),
    input: PromptInput,
  }),
  Schema.Struct({
    id: Schema.String.annotate({
      description: "Prompt asset id resolved from .opencode/dag-prompts (project, then global)",
    }),
    input: PromptInput,
  }),
])

export const NodeSchema = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique node identifier, used in depends_on" }),
  name: Schema.String.annotate({ description: "Human-readable node name" }),
  worker_type: Schema.String.annotate({ description: "Agent type (explore, build, general, plan, or custom)" }),
  depends_on: Schema.Array(Schema.String).annotate({ description: "Node IDs this node waits for ([] for root)" }),
  required: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true and this node fails, the workflow terminalizes as failed. Inherits config.node_defaults.required",
  }),
  prompt_template: PromptTemplateSource.annotate({
    description:
      'Template: exactly one of { id: "..." } or { inline: "...", input: {...} }. Direct dependency outputs are available as {{node-id}} by default',
  }),
  worker_config: Schema.optional(
    Schema.Struct({
      timeout_ms: Schema.optional(Schema.Number),
    }),
  ).annotate({
    description:
      "{ timeout_ms } — bounds the node from admission to completion; queue wait counts toward the budget and an expired queued node fails without spawning. A running node that exceeds it escalates to the parent for adjudication (capped deadline extensions) before failing. Inherits config.node_defaults.worker_config",
  }),
  input_mapping: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      'Optional variable-to-source map, e.g. { resultA: "node-a", count: "node-b.output.count" }. Omit to expose each direct dependency under its node ID',
  }),
  report_to_parent: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, the parent agent is woken when this node completes or fails. Inherits config.node_defaults.report_to_parent",
  }),
  condition: Schema.optional(Schema.String).annotate({
    description: "Expression evaluated before spawn; node is skipped if false",
  }),
  restart: Schema.optional(Schema.Boolean).annotate({
    description:
      "(replan only) Re-spawn this running node with new prompt. Running nodes only — terminal (completed/failed/skipped) nodes are immutable; to retry a failed node, add a replacement node under a new id",
  }),
  cancel: Schema.optional(Schema.Boolean).annotate({ description: "(replan only) Cancel this node" }),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "JSON Schema for the child's final JSON answer (historical submit_result workflows keep their tool protocol)",
  }),
  review: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["design", "diff"]),
      implementation_node_id: Schema.optional(Schema.String),
      verification_node_id: Schema.optional(Schema.String),
    }),
  ).annotate({
    description:
      "(deep review workers) design reviews pre-implementation artifacts; diff reviews require implementation_node_id, verification_node_id, and authoring-validated wiring: transitive review→verification→implementation dependencies, input_mapping for the diff artifact, fingerprint, and verification output, a PASS-gated condition, and a verdict+implementation_fingerprint output_schema; deep mode additionally requires the diff review to feed a required final gate conditioned on verdict ACCEPT. Violations are authoring errors in deep mode, warnings in standard mode.",
  }),
})

const NodeDefaults = Schema.Struct({
  required: Schema.optional(Schema.Boolean),
  worker_config: Schema.optional(
    Schema.Struct({
      timeout_ms: Schema.optional(Schema.Number),
    }),
  ),
  report_to_parent: Schema.optional(Schema.Boolean),
})

const GraphBudgetFields = {
  result_protocol: Schema.optional(Schema.Literals(["final_response", "submit_result"])).annotate({
    description:
      "Result capture protocol. New workflows default to final_response; submit_result is legacy compatibility.",
  }),
  delivery_node: Schema.optional(Schema.String).annotate({
    description:
      "Final node whose answer is copied once into the main conversation. A unique terminal synthesize block is selected automatically; otherwise delivery is a result index.",
  }),
  max_concurrency: Schema.optional(Schema.Number).annotate({ description: "Max parallel nodes. Default: 5" }),
  max_node_replan_attempts: Schema.optional(Schema.Number).annotate({
    description: "Max replan restarts per node ID. Default: 5",
  }),
  max_total_nodes: Schema.optional(Schema.Number).annotate({
    description: "Cumulative node cap across the workflow lifetime. Default: 100",
  }),
} as const

/** High-level graph: objective + composable blocks compiled into nodes. */
export const BlocksGraphSchema = Schema.Struct({
  name: Schema.String.annotate({ description: "Workflow name" }),
  objective: Schema.String.annotate({
    description: "Injected into every generated child prompt; required for blocks",
  }),
  blocks: Schema.Array(DagBlocks.WorkflowBlock).annotate({
    description: "Composable blocks compiled into nodes by the runtime",
  }),
  node_defaults: Schema.optional(NodeDefaults).annotate({
    description: "Defaults inherited by nodes that omit required, worker_config, or report_to_parent",
  }),
  ...GraphBudgetFields,
})

/** Low-level graph: explicit node declarations. */
export const NodesGraphSchema = Schema.Struct({
  name: Schema.String.annotate({ description: "Workflow name" }),
  nodes: Schema.Array(NodeSchema).annotate({ description: "Low-level node declarations" }),
  node_defaults: Schema.optional(NodeDefaults).annotate({
    description: "Defaults inherited by nodes that omit required, worker_config, or report_to_parent",
  }),
  ...GraphBudgetFields,
})

/** A start/replan graph carries exactly one source shape: blocks or nodes. */
export const WorkflowGraphSchema = Schema.Union([BlocksGraphSchema, NodesGraphSchema])

export const StartSpec = Schema.Struct({
  title: Schema.optional(Schema.String),
  mode: Schema.optional(ExecutionMode),
  admission: Schema.optional(AdmissionInput),
  config: WorkflowGraphSchema,
})

/** Extend adds exactly one graph source: objective+blocks or nodes. */
export const ExtendSpec = Schema.Union([
  Schema.Struct({
    objective: Schema.String.annotate({ description: "Injected into every generated child prompt" }),
    blocks: Schema.Array(DagBlocks.WorkflowBlock),
  }),
  Schema.Struct({
    nodes: Schema.Array(NodeSchema),
  }),
])

export const ReplanSpec = Schema.Struct({
  fragment: WorkflowGraphSchema,
})

export type StartSpec = typeof StartSpec.Type
export type StartGraph = typeof WorkflowGraphSchema.Type
export type ExtendGraph = typeof ExtendSpec.Type
export type NodeSpec = typeof NodeSchema.Type

/** The validator decodes untrusted model/YAML input; unknown keys are
 * rejected so a foreign field can never be silently dropped or defaulted. */
export const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" as const }

// ============================================================================
// Schema-error → diagnostics
// ============================================================================

interface LeafIssue {
  path: string
  message: string
}

function issuePathSegment(segment: unknown): string {
  return typeof segment === "number" ? `[${segment}]` : `[${JSON.stringify(String(segment))}]`
}

function collectLeafIssues(issue: unknown, path: readonly string[], out: LeafIssue[]) {
  if (!isRecord(issue)) return
  const nextPath = Array.isArray(issue.path) ? [...path, ...issue.path.map(issuePathSegment)] : path
  const children: unknown[] = []
  if (Array.isArray(issue.issues)) children.push(...issue.issues)
  if (issue.issue !== undefined) children.push(issue.issue)
  const tag = typeof issue._tag === "string" ? issue._tag : ""
  if (tag === "AnyOf" || tag === "UnionMember") {
    for (const value of Object.values(issue)) {
      if (value !== null && typeof value === "object" && "_tag" in value) children.push(value)
    }
  }
  if (children.length > 0) {
    for (const child of children) collectLeafIssues(child, nextPath, out)
    return
  }
  const message = typeof issue.message === "string" ? issue.message : tag
  if (message) out.push({ path: nextPath.join("") || "$", message })
}

// High-frequency authoring drift: fields the model reaches for from
// neighboring vocabularies, mapped to the field that exists. The decode leaf
// only carries the tag ("UnexpectedKey"); the offending field name lives in
// the diagnostic path, so both are matched.
const FIELD_DRIFT_HINTS: Record<string, string> = {
  worker: "worker_type",
  workers: "worker_type",
  agent: "worker_type",
  timeout: "worker_config: { timeout_ms }",
  timeouts: "worker_config: { timeout_ms }",
  timeout_ms: "worker_config: { timeout_ms }",
  prompt: "instruction",
  task: "instruction",
  objective: "config.objective",
  graph: "config",
  spec: "config",
  nodes: "blocks (or vice versa — exactly one graph source)",
  blocks: "nodes (or vice versa — exactly one graph source)",
}

function driftHint(path: string, message: string) {
  for (const [wrong, right] of Object.entries(FIELD_DRIFT_HINTS)) {
    if (message.includes(`"${wrong}"`) || path.includes(`["${wrong}"]`)) {
      return `Did you mean "${right}"? Every block field is one of id, kind, depends_on, instruction, worker_type, worker_config, required, report_to_parent; objective lives inside config`
    }
  }
  return "Fix the field shape; blocks graphs need name+objective+blocks, nodes graphs need name+nodes"
}

export function schemaDiagnostics(error: unknown, basePath = ""): Diagnostic[] {
  const leaves: LeafIssue[] = []
  collectLeafIssues(
    isRecord(error) && error.issue !== undefined ? error.issue : error,
    basePath ? [basePath] : [],
    leaves,
  )
  if (leaves.length === 0) {
    return [diagnostic({ code: DIAGNOSTIC_CODES.schemaInvalid, path: basePath || "$", message: String(error) })]
  }
  return sortDiagnostics(
    leaves.map((leaf) =>
      diagnostic({
        code: DIAGNOSTIC_CODES.schemaInvalid,
        path: leaf.path,
        message: leaf.message,
        hint: driftHint(leaf.path, leaf.message),
      }),
    ),
  )
}

/**
 * Replan envelope guard. A replan document must carry a top-level `fragment`
 * wrapping the graph. When it is missing, the generic `ReplanSpec` union decode
 * reports a misleading "blocks graphs need name+objective+blocks / nodes graphs
 * need name+nodes" error that hides the real mistake — the absent envelope key.
 * Surface the envelope error directly, with a targeted hint keyed on the
 * top-level keys that ARE present. An `undefined`/`null` fragment counts as
 * missing: legacy file normalization rewrites a fragment-less replan doc to
 * `{ ...originalKeys, fragment: undefined }`, so the key can exist yet be empty.
 * Returns `undefined` when the envelope is present, letting normal decode run.
 */
export function replanEnvelopeDiagnostic(value: unknown): Diagnostic | undefined {
  if (isRecord(value) && value.fragment != null) return undefined
  const keys = isRecord(value) ? Object.keys(value) : []
  const targeted = keys.includes("blocks")
    ? 'Move "name", "objective", and "blocks" under "fragment".'
    : keys.includes("config")
      ? '"config" is the start envelope; replan requires "fragment".'
      : keys.includes("nodes")
        ? 'Move "nodes" under "fragment".'
        : keys.includes("name")
          ? 'Wrap the graph in a top-level "fragment" key.'
          : 'Wrap the graph fields in a top-level "fragment" key.'
  return diagnostic({
    code: DIAGNOSTIC_CODES.replanEnvelopeMissing,
    path: "$",
    message: 'replan file is missing required top-level key "fragment"',
    hint: `${targeted}\n\nExpected:\n\nfragment:\n  name: workflow-name\n  nodes:\n    - id: node-id\n      ...`,
  })
}

// ============================================================================
// Graph compilation (blocks → nodes) as diagnostics
// ============================================================================

export type BlockSource =
  { objective: string; blocks: readonly DagBlocks.WorkflowBlock[] } | { nodes: readonly NodeSpec[] }

export function compileBlockSource(
  source: BlockSource,
  options: { known_dependencies?: string[] } = {},
): { nodes?: NodeConfig[]; diagnostics: Diagnostic[] } {
  if ("blocks" in source) {
    try {
      const nodes = DagBlocks.compileWorkflowBlocks(
        { objective: source.objective, blocks: [...source.blocks] },
        { known_dependencies: options.known_dependencies },
      )
      return { nodes, diagnostics: [] }
    } catch (error) {
      return {
        diagnostics: [
          diagnostic({
            code: DIAGNOSTIC_CODES.blockCompileFailed,
            path: "config.blocks",
            message: error instanceof Error ? error.message : String(error),
            hint: "Blocks must satisfy the writer-serialization and review-route contracts; inline compiled nodes if you need a shape blocks cannot express",
          }),
        ],
      }
    }
  }
  return { nodes: source.nodes.map(materializeNode), diagnostics: [] }
}

function materializeNode(node: NodeSpec): NodeConfig {
  return {
    ...node,
    depends_on: [...node.depends_on],
    prompt_template: {
      ...node.prompt_template,
      ...(node.prompt_template.input ? { input: { ...node.prompt_template.input } } : {}),
    },
    ...(node.worker_config ? { worker_config: { ...node.worker_config } } : {}),
    ...(node.input_mapping ? { input_mapping: { ...node.input_mapping } } : {}),
    ...(node.output_schema ? { output_schema: { ...node.output_schema } } : {}),
    ...(node.review ? { review: { ...node.review } } : {}),
  }
}

export function compileGraphSource(
  graph: StartGraph,
  options: { known_dependencies?: string[] } = {},
): { nodes?: NodeConfig[]; diagnostics: Diagnostic[] } {
  if ("blocks" in graph) {
    return compileBlockSource({ objective: graph.objective, blocks: graph.blocks }, options)
  }
  return compileBlockSource({ nodes: graph.nodes }, options)
}

// ============================================================================
// Structural diagnostics — shared by validate, create, and replan
// ============================================================================

/** A parseable condition may only reference the node's direct dependencies —
 * anything else silently resolves to undefined and evaluates false at spawn. */
export function conditionReferenceErrors(nodes: readonly NodeConfig[]): string[] {
  return nodes.flatMap((node) => {
    const ref = conditionReference(node.condition)
    if (!ref || node.depends_on.includes(ref)) return []
    return [
      `node "${node.id}" condition references "${ref}" which is not in its depends_on (condition inputs come from direct dependencies only; this would silently evaluate false)`,
    ]
  })
}

/** Inline prompt templates may only reference bound variables: static
 * prompt_template.input keys, input_mapping target names, or (without
 * input_mapping) the direct depends_on ids. Id templates are resolved from
 * disk and are binding-checked by the environment profile. */
export function templateBindingErrors(nodes: readonly NodeConfig[]): string[] {
  return nodes.flatMap((node) => {
    const template = node.prompt_template.inline
    if (template === undefined) return []
    const bound = new Set([
      ...Object.keys(node.prompt_template.input ?? {}),
      ...Object.keys(node.input_mapping ?? Object.fromEntries(node.depends_on.map((dep) => [dep, dep]))),
    ])
    return placeholderKeys(template)
      .filter((key) => !bound.has(key))
      .map(
        (key) =>
          `node "${node.id}" prompt_template references unbound variable "{{${key}}}" (bind it via prompt_template.input, input_mapping, or depends_on)`,
      )
  })
}

export interface StructuralInput {
  nodes: readonly NodeConfig[]
  delivery_node?: string
  mode?: ExecutionMode
  max_total_nodes?: number
  /** Nodes already registered in a live workflow; counts toward the ceiling. */
  existing_node_count?: number
  /** Node ids already present in a live workflow; valid dependency targets for
   * replan/extend fragments whose depends_on may reference them. */
  known_node_ids?: ReadonlySet<string>
  /** Graph node_defaults for nodes that omit a field (authoring graphs are not
   * default-normalized). */
  node_defaults?: { readonly required?: boolean }
}

// Legacy byte-compat: Dag.create has always reported one structural class at
// a time in a fixed sequence. Each helper tags its diagnostics with that
// class index so callers can restore the historical ordering without
// re-parsing message text — the ordering lives with the message authors.
const legacyClassByDiagnostic = new WeakMap<Diagnostic, number>()

// Classes whose messages pass through as-is in the legacy render; every
// other structural class is prefixed with "Invalid workflow config:".
const RAW_LEGACY_CLASSES = new Set([4, 5, 7])

function tagLegacyClass(diagnostics: Diagnostic[], classIndex: number): Diagnostic[] {
  for (const d of diagnostics) legacyClassByDiagnostic.set(d, classIndex)
  return diagnostics
}

export function sortLegacyStructural(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return sortDiagnostics([...diagnostics]).sort(
    (a, b) => (legacyClassByDiagnostic.get(a) ?? 8) - (legacyClassByDiagnostic.get(b) ?? 8),
  )
}

/** Legacy message render driven by the structural class tag, never by
 * re-parsing message text. Schema-decode diagnostics (untagged) render with
 * the historical "Invalid workflow config:" wrapper. */
function legacyValidationMessage(d: Diagnostic): string {
  const cls = legacyClassByDiagnostic.get(d)
  if (cls !== undefined && RAW_LEGACY_CLASSES.has(cls)) return d.message
  return `Invalid workflow config: ${d.message}`
}

function duplicateNodeIds(nodes: readonly NodeConfig[]): string[] {
  const ids = nodes.map((node) => node.id)
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
}

function duplicateIdDiagnostics(duplicates: string[]): Diagnostic[] {
  if (duplicates.length === 0) return []
  return [
    diagnostic({
      code: DIAGNOSTIC_CODES.dagInvalid,
      path: "nodes",
      message: `duplicate node ids: ${duplicates.join(", ")}`,
      hint: "Every node id must be unique; rename the colliding node",
    }),
  ]
}

function danglingDependencyDiagnostics(nodes: readonly NodeConfig[], knownNodeIds?: ReadonlySet<string>): Diagnostic[] {
  const idSet = new Set(nodes.map((node) => node.id))
  if (knownNodeIds) for (const id of knownNodeIds) idSet.add(id)
  const dangling = nodes.flatMap((node) =>
    node.depends_on.filter((dep) => !idSet.has(dep)).map((dep) => ({ node, dep })),
  )
  if (dangling.length === 0) return []
  return [
    diagnostic({
      code: DIAGNOSTIC_CODES.dagInvalid,
      path: "nodes",
      message: dangling.map(({ node, dep }) => `node "${node.id}" depends on unknown node "${dep}"`).join("; "),
      hint: "depends_on may only reference node ids declared in this graph",
    }),
  ]
}

function conditionDiagnostics(nodes: readonly NodeConfig[], grandfathered?: ReadonlySet<string>): Diagnostic[] {
  // The evaluator supports one comparison; anything else (===, !==, &&, ||)
  // would otherwise be accepted here and mis-route silently at spawn time.
  // Grandfathered nodes carry a condition persisted before this check existed:
  // re-rejecting it would block every later mutation of the workflow, and the
  // runtime already fails such a node loudly (evaluateCondition ok:false).
  const syntax = nodes.flatMap((node) => {
    if (grandfathered?.has(node.id)) return []
    const error = conditionSyntaxError(node.condition)
    if (!error) return []
    return [
      diagnostic({
        code: DIAGNOSTIC_CODES.dagInvalid,
        path: `nodes[${node.id}].condition`,
        message: `node "${node.id}" ${error}`,
        hint: 'Use a single comparison such as gate.output.verdict == "ACCEPT"; express "not equal" with !=',
      }),
    ]
  })
  const errors = conditionReferenceErrors(nodes)
  if (errors.length === 0) return syntax
  return [
    ...syntax,
    diagnostic({
      code: DIAGNOSTIC_CODES.dagInvalid,
      path: "nodes",
      message: errors.join("; "),
      hint: "A condition may only read outputs of the node's direct depends_on",
    }),
  ]
}

/** input_mapping is a data dependency, not a scheduling edge. Every declared
 * source therefore has to name an existing transitive predecessor; otherwise
 * the scheduler may start the consumer before the value exists. */
export function inputMappingDiagnostics(
  consumers: readonly NodeConfig[],
  graphNodes: readonly NodeConfig[] = consumers,
): Diagnostic[] {
  const byID = new Map(graphNodes.map((node) => [node.id, node]))

  const dependencyClosure = (consumer: NodeConfig) => {
    const closure = new Set<string>()
    const pending = [...consumer.depends_on]
    while (pending.length > 0) {
      const dependency = pending.pop()!
      if (closure.has(dependency)) continue
      closure.add(dependency)
      const node = byID.get(dependency)
      if (node) pending.push(...node.depends_on)
    }
    return closure
  }

  return consumers.flatMap((consumer) => {
    const closure = dependencyClosure(consumer)
    return Object.entries(consumer.input_mapping ?? {}).flatMap(([variable, source]) => {
      const path = `nodes[${consumer.id}].input_mapping.${variable}`
      const parsed = parseInputMappingReference(source)
      if (!parsed.ok) {
        return [
          diagnostic({
            code: DIAGNOSTIC_CODES.dagInvalid,
            path,
            message: `node "${consumer.id}" input_mapping variable "${variable}" has invalid source "${source}": ${parsed.error}`,
            hint: 'Use "node-id", "node-id.output", or "node-id.output.field"',
          }),
        ]
      }
      if (parsed.nodeID === consumer.id) {
        return [
          diagnostic({
            code: DIAGNOSTIC_CODES.dagInvalid,
            path,
            message: `node "${consumer.id}" input_mapping variable "${variable}" references itself via "${source}"`,
            hint: "Map inputs from a direct or transitive dependency",
          }),
        ]
      }
      if (!byID.has(parsed.nodeID)) {
        return [
          diagnostic({
            code: DIAGNOSTIC_CODES.dagInvalid,
            path,
            message: `node "${consumer.id}" input_mapping variable "${variable}" references unknown source node "${parsed.nodeID}" via "${source}"`,
            hint: "Map inputs from a node declared in this workflow",
          }),
        ]
      }
      if (!closure.has(parsed.nodeID)) {
        return [
          diagnostic({
            code: DIAGNOSTIC_CODES.dagInvalid,
            path,
            message: `node "${consumer.id}" input_mapping variable "${variable}" references unordered source node "${parsed.nodeID}" via "${source}"`,
            hint: `Add a direct or transitive depends_on path from "${consumer.id}" to "${parsed.nodeID}"`,
          }),
        ]
      }
      return []
    })
  })
}

/** A report_to_parent node wakes the parent for adjudication; a dependent
 * without a condition on that node's output is spawned the moment the
 * checkpoint completes, so the checkpoint verdict can never act first.
 * Block-compiled graphs gate dependents on the verdict (issue #294
 * REJECT-checkpoint shape); hand-built node graphs must do the same or keep
 * the checkpoint as a reporting leaf.
 *
 * Options:
 * - `exemptCheckpointIds` (DAG-02 runtime path): a checkpoint already
 *   terminal in the durable graph is settled and immutable (terminal nodes
 *   never re-run) — the ordering race the gate protects is in the past, so
 *   additive waves / reopens may attach dependents without a condition.
 *   Authoring never exempts: nothing is terminal there yet.
 * - `requireOutputSchema` (default true; the runtime replan path passes
 *   false): DAG-01's "gated checkpoints must declare output_schema" is an
 *   AUTHORING obligation — runtime-created graphs deliberately bypass
 *   authoring validation (CONTEXT.md), so the runtime gate polices the
 *   ordering race only, not the schema declaration. */
export function checkpointGateDiagnostics(
  nodes: readonly NodeConfig[],
  defaults?: { readonly report_to_parent?: boolean },
  options?: {
    readonly exemptCheckpointIds?: ReadonlySet<string>
    readonly requireOutputSchema?: boolean
  },
): Diagnostic[] {
  const reportsToParent = (node: NodeConfig) =>
    node.report_to_parent ?? defaults?.report_to_parent ?? DEFAULT_WORKFLOW_CONFIG.reportToParent
  const requireOutputSchema = options?.requireOutputSchema ?? true
  return nodes.flatMap((checkpoint) => {
    if (!reportsToParent(checkpoint)) return []
    if (options?.exemptCheckpointIds?.has(checkpoint.id)) return []
    const dependents = nodes.filter((dependent) => dependent.depends_on.includes(checkpoint.id))
    const ungated = dependents
      .filter((dependent) => conditionReference(dependent.condition) !== checkpoint.id)
      .map((dependent) =>
        diagnostic({
          code: DIAGNOSTIC_CODES.dagInvalid,
          path: `nodes[${dependent.id}].condition`,
          message:
            `reporting checkpoint "${checkpoint.id}" has dependent "${dependent.id}" that is not gated on its output` +
            ` — the engine spawns "${dependent.id}" as soon as "${checkpoint.id}" completes, so the checkpoint verdict cannot be acted on first`,
          hint:
            `Gate "${dependent.id}" with condition: "${checkpoint.id}.output.<field> == ..." (e.g. on its verdict) and declare output_schema on "${checkpoint.id}" so the gate reads a schema-validated verdict,` +
            ` keep "${checkpoint.id}" a reporting leaf, or set report_to_parent: false on "${checkpoint.id}" if downstream must run unconditionally`,
        }),
      )
    // DAG-01: a checkpoint whose output a gate reads must declare
    // output_schema. Without a schema the child may complete with a raw
    // string; the runtime normalizes JSON strings, but a prose reply
    // resolves no fields, so the `.output.<field>` gate is permanently
    // false and the gated subtree is silently skipped while the workflow
    // still reports COMPLETED. Make the unsatisfiable gate an authoring
    // error instead of a runtime trap.
    const gatedDependents = dependents.some((dependent) => conditionReference(dependent.condition) === checkpoint.id)
    const schemaRequired =
      gatedDependents && requireOutputSchema && checkpoint.output_schema === undefined
        ? [
            diagnostic({
              code: DIAGNOSTIC_CODES.dagInvalid,
              path: `nodes[${checkpoint.id}].output_schema`,
              message:
                `reporting checkpoint "${checkpoint.id}" is gated on its output but declares no output_schema` +
                ` — without a schema the child may complete with prose that resolves no fields, leaving the gate permanently false and silently skipping the gated subtree`,
              hint:
                `Declare output_schema on "${checkpoint.id}" (e.g. the verdict shape),` +
                ` keep "${checkpoint.id}" a reporting leaf, or set report_to_parent: false if downstream must run unconditionally`,
            }),
          ]
        : []
    return [...ungated, ...schemaRequired]
  })
}

function bindingDiagnostics(nodes: readonly NodeConfig[]): Diagnostic[] {
  return templateBindingErrors(nodes).map((error) =>
    diagnostic({
      code: DIAGNOSTIC_CODES.promptUnboundVariable,
      path: "nodes",
      message: error,
      hint: "Bind the variable via prompt_template.input, input_mapping, or depends_on",
    }),
  )
}

export function effectiveMaxTotalNodes(maxTotalNodes: number | undefined) {
  return maxTotalNodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes
}

/** Reusable ceiling check: produces the historical diagnostic when the
 * cumulative node count exceeds the configured maximum. Shared by create
 * (existing_node_count + nodes.length) and replan (existing + add count). */
function ceilingExceeded(totalNodes: number, maxTotalNodes: number | undefined): Diagnostic[] {
  const max = effectiveMaxTotalNodes(maxTotalNodes)
  if (totalNodes <= max) return []
  return [
    diagnostic({
      code: DIAGNOSTIC_CODES.dagInvalid,
      path: "config.max_total_nodes",
      message: `Total node ceiling exceeded: ${totalNodes} nodes > ${max} max`,
      hint: "Reduce the graph or raise max_total_nodes deliberately",
    }),
  ]
}

function ceilingDiagnostics(input: StructuralInput): Diagnostic[] {
  return ceilingExceeded((input.existing_node_count ?? 0) + input.nodes.length, input.max_total_nodes)
}

/** Review-lifecycle diagnostics for one config. Shared by the structural
 * validator and Dag.replan's merged-config check. */
export function reviewLifecycleDiagnostics(input: {
  name?: string
  mode?: ExecutionMode
  nodes: readonly NodeConfig[]
  /** Authoring graphs are not default-normalized; the final-gate check
   * resolves `required` through these defaults like Dag.create would. */
  node_defaults?: { readonly required?: boolean }
  /** Review nodes whose persisted PASS gate predates the evaluated check;
   * they keep the legacy textual check (see validateReviewLifecycle). */
  grandfathered?: ReadonlySet<string>
}) {
  const reviewLifecycle = validateReviewLifecycle(
    {
      name: input.name ?? "validation",
      mode: input.mode,
      nodes: [...input.nodes],
      ...(input.node_defaults?.required !== undefined
        ? { node_defaults: { required: input.node_defaults.required } }
        : {}),
    },
    { grandfathered: input.grandfathered },
  )
  return {
    errors: reviewLifecycle.errors.map((error) =>
      diagnostic({
        code: DIAGNOSTIC_CODES.dagInvalid,
        path: "nodes",
        message: `Invalid review lifecycle: ${error}`,
        hint: "Diff reviews need implementation + verification wiring; deep review workers must declare review.phase",
      }),
    ),
    warnings: reviewLifecycle.warnings.map((warning) =>
      diagnostic({
        severity: "warning",
        code: DIAGNOSTIC_CODES.dagInvalid,
        path: "nodes",
        message: `Review lifecycle diagnostic: ${warning}`,
        hint: "Standard mode records this without failing the workflow",
      }),
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// validateRequiredNodes builds its required-only graph with addEdge, which
// throws CycleError as soon as an edge closes a required cycle — before its
// own hasCycle() check can report it. Map that throw to the same result so a
// required cycle is a diagnostic, never a defect.
function requiredNodeValidation(nodes: readonly NodeConfig[]): { valid: boolean; errors: string[] } {
  try {
    return validateRequiredNodes({
      nodes: nodes.map((node) => ({
        id: node.id,
        depends_on: node.depends_on,
        required: node.required ?? false,
      })),
    })
  } catch (error) {
    if (error instanceof CycleError) return { valid: false, errors: ["Required nodes form a cycle"] }
    throw error
  }
}

// Duplicate ids make topology checks ambiguous (projector would silently
// merge the rows), so callers run these only on id-unique graphs.
function topologyDiagnostics(nodes: readonly NodeConfig[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const required = requiredNodeValidation(nodes)
  if (!required.valid) {
    diagnostics.push(
      ...tagLegacyClass(
        required.errors.map((error) =>
          diagnostic({
            code: DIAGNOSTIC_CODES.dagInvalid,
            path: "nodes",
            message: error,
            hint: "Required nodes must be reachable without depending on optional work",
          }),
        ),
        6,
      ),
    )
  }
  const cyclePath = findCycle(nodes)
  if (cyclePath) {
    diagnostics.push(
      ...tagLegacyClass(
        [
          diagnostic({
            code: DIAGNOSTIC_CODES.dagInvalid,
            path: "nodes",
            message: `Workflow config contains a dependency cycle: ${cyclePath.join(" -> ")}`,
            hint: "Break the cycle by removing one depends_on edge",
          }),
        ],
        7,
      ),
    )
  }
  return diagnostics
}

function outputSchemaKeywordDiagnostics(nodes: readonly NodeConfig[]): Diagnostic[] {
  return nodes.flatMap((node) => {
    if (!node.output_schema) return []
    const keywords = unsupportedSchemaKeywords(node.output_schema)
    if (keywords.length === 0) return []
    return [
      diagnostic({
        severity: "warning",
        code: DIAGNOSTIC_CODES.schemaKeywordWarning,
        path: `nodes[${node.id}].output_schema`,
        message: `output_schema uses keywords the subset validator does not enforce: ${keywords.join(", ")}`,
        hint: "They will be ignored at runtime; simplify the schema or accept the gap",
      }),
    ]
  })
}

/** Pure structural validation. No events, no store, no logging — callers
 * decide how to surface the diagnostics (tool output vs. create rejection). */
export function structuralDiagnostics(input: StructuralInput): Diagnostic[] {
  const duplicates = duplicateNodeIds(input.nodes)
  const review = reviewLifecycleDiagnostics({
    mode: input.mode,
    nodes: input.nodes,
    node_defaults: input.node_defaults,
  })
  return sortDiagnostics([
    ...(input.delivery_node !== undefined && !input.nodes.some((node) => node.id === input.delivery_node)
      ? [
          diagnostic({
            severity: "error",
            code: "schema.invalid",
            path: "config.delivery_node",
            message: `delivery_node "${input.delivery_node}" does not exist in the graph`,
          }),
        ]
      : []),
    ...tagLegacyClass(duplicateIdDiagnostics(duplicates), 0),
    ...tagLegacyClass(danglingDependencyDiagnostics(input.nodes, input.known_node_ids), 1),
    ...tagLegacyClass(inputMappingDiagnostics(input.nodes), 1),
    ...tagLegacyClass(conditionDiagnostics(input.nodes), 2),
    ...tagLegacyClass(bindingDiagnostics(input.nodes), 3),
    ...tagLegacyClass(ceilingDiagnostics(input), 4),
    ...tagLegacyClass(review.errors, 5),
    ...tagLegacyClass(review.warnings, 5),
    ...(duplicates.length === 0 ? topologyDiagnostics(input.nodes) : []),
    ...tagLegacyClass(outputSchemaKeywordDiagnostics(input.nodes), 8),
  ])
}

export interface ReplanStructuralInput {
  /** Full fragment nodes — checked for duplicate ids within the fragment. */
  fragmentNodes: readonly NodeConfig[]
  /** Fragment nodes that will actually (re)run (excludes cancel + terminal).
   * Condition, binding, dangling-dep, topology, and output-schema checks
   * run on these — a cancelled or terminal node never evaluates them. */
  rerunNodes: readonly NodeConfig[]
  /** Existing workflow node ids — valid dependency targets and ceiling baseline. */
  existingNodeIds: ReadonlySet<string>
  existingNodeCount: number
  /** New node ids being added by this replan (toward the lifetime ceiling). */
  addCount: number
  /** Merged config (existing + fragment) for review-lifecycle and
   * checkpoint-gate validation. */
  merged: {
    name?: string
    mode?: ExecutionMode
    nodes: readonly NodeConfig[]
    node_defaults?: { readonly report_to_parent?: boolean }
  }
  /** Durable nodes already terminal before this replan. Their reporting
   * verdicts are delivered — the checkpoint gate exempts them so additive
   * waves/reopens can attach dependents without a condition (DAG-02). */
  terminalNodeIds?: ReadonlySet<string>
  /** Merged-graph nodes carried with their persisted condition (not authored
   * or changed by this mutation). The condition-syntax and evaluated PASS-gate
   * checks added after those definitions were accepted are not re-applied to
   * them, so a legacy workflow stays mutable; new fragment conditions are
   * still held to the full grammar. */
  grandfatheredNodeIds?: ReadonlySet<string>
  config: { mode?: ExecutionMode; max_total_nodes?: number }
}

/** Replan structural validation through the same helper functions as create —
 * the authority lives here, not in Dag.replan. The scoping differs (fragment
 * vs whole-graph, rerun-only condition/binding, merged-config review), but
 * every check reuses the same underlying helper. */
export function replanStructuralDiagnostics(input: ReplanStructuralInput): Diagnostic[] {
  const knownIds = new Set<string>([...input.existingNodeIds, ...input.fragmentNodes.map((n) => n.id)])
  const duplicates = duplicateNodeIds(input.fragmentNodes)
  const review = reviewLifecycleDiagnostics({
    name: input.merged.name,
    mode: input.merged.mode,
    nodes: input.merged.nodes,
    grandfathered: input.grandfatheredNodeIds,
  })
  return sortDiagnostics([
    ...tagLegacyClass(duplicateIdDiagnostics(duplicates), 0),
    ...tagLegacyClass(danglingDependencyDiagnostics(input.rerunNodes, knownIds), 1),
    ...tagLegacyClass(inputMappingDiagnostics(input.rerunNodes, input.merged.nodes), 1),
    ...tagLegacyClass(conditionDiagnostics(input.rerunNodes, input.grandfatheredNodeIds), 2),
    ...tagLegacyClass(bindingDiagnostics(input.rerunNodes), 3),
    ...tagLegacyClass(ceilingExceeded(input.existingNodeCount + input.addCount, input.config.max_total_nodes), 4),
    ...tagLegacyClass(review.errors, 5),
    ...tagLegacyClass(review.warnings, 5),
    ...(duplicates.length === 0 ? topologyDiagnostics(input.rerunNodes) : []),
    ...tagLegacyClass(outputSchemaKeywordDiagnostics(input.rerunNodes), 8),
    // DAG-02: the checkpoint gate must police the MERGED graph too — a
    // fragment can attach a new dependent to an EXISTING reporting
    // checkpoint, which the fragment-scoped authoring check cannot see.
    // Pre-fix replan/extend skipped this gate entirely, so the dependent
    // was spawned the moment the checkpoint completed, before the parent
    // could read the verdict. Checkpoints already terminal in the durable
    // graph are exempt: they are settled and immutable, the race is past. The
    // output_schema obligation is authoring-only (requireOutputSchema:false)
    // — runtime-created graphs deliberately bypass authoring validation.
    ...checkpointGateDiagnostics(input.merged.nodes, input.merged.node_defaults, {
      exemptCheckpointIds: input.terminalNodeIds,
      requireOutputSchema: false,
    }),
  ])
}

function findCycle(nodes: readonly NodeConfig[]): string[] | null {
  try {
    const graph = buildGraph(
      nodes.map((node) => ({
        id: node.id,
        dependsOn: node.depends_on,
        status: "pending" as const,
        required: node.required ?? false,
      })),
    )
    return graph.hasCycle() ? (graph.findCycles()[0] ?? null) : null
  } catch (error) {
    if (error instanceof CycleError) return error.cycle
    throw error
  }
}

// ============================================================================
// Portable + environment validation
// ============================================================================

export interface EnvironmentCatalogs {
  /** Known worker types from the Agent catalog; undefined skips the check. */
  worker_types?: ReadonlySet<string>
  /** Resolves a node's model against this environment (dag.jsonc tiers,
   * worker agent model, parent session). undefined skips the check. */
  resolveModel?: (
    node: {
      id: string
      worker_type: string
      required: boolean
      model?: { modelID: string; providerID: string }
    },
    defaults?: {
      required?: boolean
      model?: { modelID: string; providerID: string }
    },
  ) => Effect.Effect<boolean>
}

/** Environment-only diagnostics for an already-compiled node list: prompt-id
 * resolution and bindings, worker catalog, and model
 * resolution. Used by start/extend/replan before any durable side effect. */
export function environmentDiagnostics(input: {
  nodes: readonly NodeConfig[]
  directory?: string
  catalogs?: EnvironmentCatalogs
  /** Graph-level required default, applied when a node does not declare one. */
  defaults?: { required?: boolean }
}): Effect.Effect<Diagnostic[]> {
  return Effect.gen(function* () {
    const diagnostics: Diagnostic[] = []
    for (const node of input.nodes) {
      diagnostics.push(...(yield* promptIdDiagnostics(node, input.directory)))
      if (input.catalogs?.worker_types && !input.catalogs.worker_types.has(node.worker_type)) {
        diagnostics.push(
          diagnostic({
            code: DIAGNOSTIC_CODES.workerUnknown,
            path: `nodes[${node.id}].worker_type`,
            message: `worker type "${node.worker_type}" is not in the current agent catalog`,
            hint: "Use a builtin agent type or register the custom agent before start",
          }),
        )
      }
      if (input.catalogs?.resolveModel) {
        const required = node.required ?? input.defaults?.required ?? DEFAULT_WORKFLOW_CONFIG.nodeRequired
        const resolves = yield* input.catalogs.resolveModel(
          { id: node.id, worker_type: node.worker_type, required, model: node.model },
          input.defaults,
        )
        if (!resolves) {
          diagnostics.push(
            diagnostic({
              code: DIAGNOSTIC_CODES.modelUnavailable,
              path: `nodes[${node.id}]`,
              message: `no model resolves for node "${node.id}"`,
              hint: "Configure dag.jsonc tiers, the worker agent model, or a parent-session model",
            }),
          )
        }
      }
    }
    return sortDiagnostics(diagnostics)
  })
}

function nodeBoundVariables(node: NodeConfig): Set<string> {
  return new Set([
    ...Object.keys(node.prompt_template.input ?? {}),
    ...Object.keys(node.input_mapping ?? Object.fromEntries(node.depends_on.map((dep) => [dep, dep]))),
  ])
}

function nonportablePromptDiagnostics(nodes: readonly NodeConfig[]): Diagnostic[] {
  return nodes.flatMap((node) => {
    const prompt = node.prompt_template
    if (prompt.id === undefined) return []
    return [
      diagnostic({
        code: DIAGNOSTIC_CODES.promptNonportableAsset,
        path: `nodes[${node.id}].prompt_template.id`,
        message: `prompt id "${prompt.id}" is not shipped with the template`,
        hint: "Inline the prompt content or ship the asset with the distributable package",
      }),
    ]
  })
}

function promptIdDiagnostics(node: NodeConfig, directory: string | undefined): Effect.Effect<Diagnostic[]> {
  return Effect.gen(function* () {
    const prompt = node.prompt_template
    if (prompt.id === undefined) return []
    if (!directory) {
      return [
        diagnostic({
          code: DIAGNOSTIC_CODES.promptMissingAsset,
          path: `nodes[${node.id}].prompt_template.id`,
          message: `prompt id "${prompt.id}" cannot be resolved without a project directory`,
          hint: "Inline the prompt content or validate from a project with dag-prompts",
        }),
      ]
    }
    // A missing or unsafe asset id is a typed failure; it becomes a diagnostic.
    const source = yield* templateSourceById(prompt.id, directory).pipe(Effect.option)
    if (Option.isNone(source)) {
      return [
        diagnostic({
          code: DIAGNOSTIC_CODES.promptMissingAsset,
          path: `nodes[${node.id}].prompt_template.id`,
          message: `prompt id "${prompt.id}" does not resolve in project or global dag-prompts`,
          hint: "Add <id>.md to .opencode/dag-prompts (project or global) or switch to an inline template",
        }),
      ]
    }
    const bound = nodeBoundVariables(node)
    return placeholderKeys(source.value)
      .filter((key) => !bound.has(key))
      .map((key) =>
        diagnostic({
          code: DIAGNOSTIC_CODES.promptUnboundVariable,
          path: `nodes[${node.id}].prompt_template.id`,
          message: `prompt asset "${prompt.id}" references unbound variable "{{${key}}}"`,
          hint: "Bind it via prompt_template.input, input_mapping, or depends_on",
        }),
      )
  })
}

/** Validate a decoded + compiled spec under the chosen profile. Shared by
 * the raw-entry validateSpec and the workflow start path. */
export function validatePostCompile(input: {
  source: string
  profile: Profile
  config: {
    mode?: ExecutionMode
    delivery_node?: string
    max_total_nodes?: number
    node_defaults?: { required?: boolean; report_to_parent?: boolean; model?: { modelID: string; providerID: string } }
  }
  nodes: readonly NodeConfig[]
  /** The original blocks when the graph used the high-level interface. */
  blocks?: readonly DagBlocks.WorkflowBlock[]
  directory?: string
  catalogs?: EnvironmentCatalogs
  /** Fragment actions are structurally validated by Dag.replan after merge;
   * authoring still owns profile checks without pretending a fragment is a
   * standalone graph. */
  structural?: boolean
}): Effect.Effect<ValidationResult> {
  return Effect.gen(function* () {
    const diagnostics = [
      ...(input.structural === false
        ? []
        : structuralDiagnostics({
            nodes: input.nodes,
            delivery_node: input.config.delivery_node,
            mode: input.config.mode,
            max_total_nodes: input.config.max_total_nodes,
            node_defaults: input.config.node_defaults,
          })),
      // DAG-02: the checkpoint gate is NOT a whole-graph structural check —
      // fragment actions (replan/extend) must satisfy it exactly like start.
      // Pre-fix it was skipped together with `structural`, so a replan could
      // attach an ungated dependent to a reporting checkpoint and the engine
      // spawned it the moment the checkpoint completed.
      ...checkpointGateDiagnostics(input.nodes, input.config.node_defaults),
    ]
    if (input.profile === "portable") diagnostics.push(...nonportablePromptDiagnostics(input.nodes))
    if (input.profile === "environment") {
      diagnostics.push(
        ...(yield* environmentDiagnostics({
          nodes: input.nodes,
          directory: input.directory,
          catalogs: input.catalogs,
          defaults: input.config.node_defaults,
        })),
      )
    }
    const errors = sortDiagnostics(diagnostics.filter((d) => d.severity === "error"))
    const warnings = sortDiagnostics(diagnostics.filter((d) => d.severity === "warning"))
    return {
      source: input.source,
      profile: input.profile,
      valid: errors.length === 0,
      errors,
      warnings,
      nodes: summarizeNodes(input.nodes),
    }
  })
}
