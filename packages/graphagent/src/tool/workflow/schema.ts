// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Dag } from "@/dag/dag"
import { DagValidation } from "@/dag/validation"
import { Schema } from "effect"

export const DEFAULT_RESULT_PAGE_CHARS = 8_000
export const MAX_RESULT_PAGE_CHARS = 12_000

export class ResultCursor extends Schema.Class<ResultCursor>("WorkflowResultCursor")({
  version: Schema.Literal(1),
  workflow_id: Dag.ID,
  node_id: Dag.NodeID,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const ResultCursorJSON = Schema.fromJsonString(ResultCursor)
export const ResultCursorToken = Schema.String.pipe(Schema.brand("WorkflowResultCursorToken"))
export type ResultCursorToken = typeof ResultCursorToken.Type
export const decodeResultCursor = Schema.decodeUnknownOption(ResultCursorJSON)
export const encodeResultCursor = (cursor: ResultCursor) =>
  ResultCursorToken.make(Buffer.from(JSON.stringify(cursor)).toString("base64url"))

// Exported so the committed workflow library can be validated in tests.
export const StartSpec = DagValidation.StartSpec
// Distinct re-export for test files that import multiple tools' Parameters
// without aliasing (the repo forbids import aliases).
export { Parameters as WorkflowParameters }

// ============================================================================
// Parameters: a single `params` root property carrying the action union.
// OpenAI's tools contract expects `parameters` to be a JSON Schema object; a
// root-level combinator (anyOf/oneOf/allOf) is outside that contract and
// OpenAI-compatible backends reject it — DeepSeek with an explicit schema
// error, GLM by silently emitting empty tool arguments. Nesting the union one
// level down keeps every discriminated branch intact while the schema root
// stays a plain object on every transport.
//
// Four actions group the operations: spec (library/authoring), run
// (start/extend), inspect (durable reads), control (live mutations). Every
// group is flattened into one branch per operation so `params` stays a
// single-level union of discriminated objects — no nested anyOf for the
// action discriminator, which OpenAI-compatible transports also reject.
// Annotations are terse on purpose: the serialized description plus this
// schema is the per-turn tool-definition budget.
// ============================================================================

export type Metadata = {
  workflowId?: Dag.ID
  nodeId?: Dag.NodeID
  truncated?: boolean
  nextCursor?: ResultCursorToken
  added?: string[]
  cancel?: string[]
  restart?: string[]
  replace?: string[]
  graphRev?: number
  blocked?: boolean
  diagnosticSummary?: string
}

const specPath = Schema.String.annotate({ description: "Saved workflow name or .yaml/.yml path" })
const workflowID = Dag.ID
const nodeID = Dag.NodeID
const op = <const L extends string>(name: L) => Schema.Literal(name)
const act = <const L extends string>(name: L) => Schema.Literal(name)

// ============================================================================
// Draft wire schema — a compact mirror of DagValidation.WorkflowGraphSchema.
// The parameter boundary only needs to reject drifted field names and types;
// the authoring layer remains the single semantic authority (blocks XOR nodes,
// objective required for blocks). Descriptions are deliberately terse because
// this branch dominates the tool-definition budget.
// ============================================================================

const PromptInput = Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
const CompactPrompt = Schema.Struct({
  inline: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  input: PromptInput,
})
// Exported for the drift guard in test/tool/workflow-draft-parity.test.ts:
// every authoring schema field must be representable on the wire.
export const CompactBlock = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["explore", "plan", "prototype", "debug", "coding", "verify", "review", "synthesize"]),
  depends_on: Schema.optional(Schema.Array(Schema.String)),
  instruction: Schema.optional(Schema.String),
  worker_type: Schema.optional(Schema.String),
  worker_config: Schema.optional(Schema.Struct({ timeout_ms: Schema.Number })),
  required: Schema.optional(Schema.Boolean),
  report_to_parent: Schema.optional(Schema.Boolean),
  fan_out: Schema.optional(Schema.String),
})
export const CompactNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  worker_type: Schema.String,
  depends_on: Schema.Array(Schema.String),
  required: Schema.optional(Schema.Boolean),
  skip_ok: Schema.optional(Schema.Boolean),
  prompt_template: CompactPrompt,
  worker_config: Schema.optional(Schema.Struct({ timeout_ms: Schema.optional(Schema.Number) })),
  input_mapping: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  report_to_parent: Schema.optional(Schema.Boolean),
  condition: Schema.optional(Schema.String),
  restart: Schema.optional(Schema.Boolean),
  cancel: Schema.optional(Schema.Boolean),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  review: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["design", "diff"]),
      implementation_node_id: Schema.optional(Schema.String),
      verification_node_id: Schema.optional(Schema.String),
    }),
  ),
  fan_out: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  isolation: Schema.optional(Schema.Literal("worktree")),
})
export const CompactNodeDefaults = Schema.Struct({
  required: Schema.optional(Schema.Boolean),
  worker_config: Schema.optional(Schema.Struct({ timeout_ms: Schema.optional(Schema.Number) })),
  report_to_parent: Schema.optional(Schema.Boolean),
})
const GraphBudgetFields = {
  node_defaults: Schema.optional(CompactNodeDefaults),
  delivery_node: Schema.optional(Schema.String),
  max_concurrency: Schema.optional(Schema.Number),
  max_node_replan_attempts: Schema.optional(Schema.Number),
  max_total_nodes: Schema.optional(Schema.Number),
  workspace: Schema.optional(Schema.String),
  // #1030 D9-g: workflow-level worktree. Start-only; the authoring boundary
  // rejects it in replan fragments and validates it against config.workspace.
  isolation: Schema.optional(Schema.Literal("worktree")),
}
export const DraftGraph = Schema.Struct({
  name: Schema.String,
  objective: Schema.optional(Schema.String),
  blocks: Schema.optional(Schema.Array(CompactBlock)),
  nodes: Schema.optional(Schema.Array(CompactNode)),
  ...GraphBudgetFields,
})

/** The compact wire shape of a draft graph; the authoring layer owns the
 * blocks-xor-nodes and objective-for-blocks rules. */
export type DraftGraphType = Schema.Schema.Type<typeof DraftGraph>

// ---------------------------------------------------------------------------
// spec: list/read/draft/validate — the saved-spec library and pre-flight.
// ---------------------------------------------------------------------------

const SpecList = Schema.Struct({ action: act("spec"), operation: op("list") })
const SpecRead = Schema.Struct({ action: act("spec"), operation: op("read"), spec_path: specPath })
const SpecDraft = Schema.Struct({
  action: act("spec"),
  operation: op("draft").annotate({ description: "Write a start spec; creates no workflow" }),
  title: Schema.optional(Schema.String),
  config: DraftGraph,
})
const SpecValidate = Schema.Struct({
  action: act("spec"),
  operation: op("validate").annotate({ description: "Pre-flight without creating a workflow" }),
  spec_path: specPath,
  profile: Schema.optional(Schema.Literals(["portable", "environment"])).annotate({
    description: "portable checks; environment also resolves prompts, workers, models",
  }),
})

// ---------------------------------------------------------------------------
// run: start/extend — create a workflow or grow a live one.
// ---------------------------------------------------------------------------

const RunStart = Schema.Struct({ action: act("run"), operation: op("start"), spec_path: specPath })
const RunExtend = Schema.Struct({
  action: act("run"),
  operation: op("extend").annotate({ description: "Add nodes or blocks to a live workflow" }),
  workflow_id: workflowID,
  spec_path: specPath,
})

// ---------------------------------------------------------------------------
// inspect: status/result — durable reads.
// ---------------------------------------------------------------------------

const InspectStatus = Schema.Struct({ action: act("inspect"), operation: op("status"), workflow_id: workflowID })
const InspectResult = Schema.Struct({
  action: act("inspect"),
  operation: op("result").annotate({ description: "Node output; file-backed results return content_ref/path" }),
  workflow_id: workflowID,
  node_id: nodeID,
  cursor: Schema.optional(ResultCursorToken).annotate({ description: "Page cursor from the previous page" }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULT_PAGE_CHARS }))),
})

// ---------------------------------------------------------------------------
// control: live mutations.
// ---------------------------------------------------------------------------

const ControlPause = Schema.Struct({ action: act("control"), operation: op("pause"), workflow_id: workflowID })
const ControlResume = Schema.Struct({ action: act("control"), operation: op("resume"), workflow_id: workflowID })
const ControlCancel = Schema.Struct({ action: act("control"), operation: op("cancel"), workflow_id: workflowID })
const ControlComplete = Schema.Struct({ action: act("control"), operation: op("complete"), workflow_id: workflowID })
const ControlStep = Schema.Struct({ action: act("control"), operation: op("step"), workflow_id: workflowID })
const ControlCancelNode = Schema.Struct({
  action: act("control"),
  operation: op("cancel_node").annotate({
    description: "Cancel one non-terminal node; required nodes still fail the workflow",
  }),
  workflow_id: workflowID,
  node_id: nodeID,
  reason: Schema.optional(Schema.String).annotate({ description: "Audit reason" }),
})
const ControlReplan = Schema.Struct({
  action: act("control"),
  operation: op("replan").annotate({ description: "Apply a fragment: add/cancel/restart/replace nodes" }),
  workflow_id: workflowID,
  spec_path: specPath,
})
const ControlRecover = Schema.Struct({
  action: act("control"),
  operation: op("recover").annotate({ description: "Retry nodes and descendants, keeping valid completed work" }),
  workflow_id: workflowID,
  node_ids: Schema.Array(nodeID)
    .check(Schema.isMinLength(1))
    .annotate({ description: "Nodes to retry; downstream closure is invalidated" }),
  expected_graph_rev: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Exact graph_rev from status",
  }),
  resume_cancelled: Schema.optional(Schema.Boolean).annotate({
    description: "Set true only to recover a cancelled workflow",
  }),
})
const ControlExtendTimeout = Schema.Struct({
  action: act("control"),
  operation: op("extend_timeout").annotate({
    description: "Extend one RUNNING node with a delivered timeout escalation",
  }),
  workflow_id: workflowID,
  node_id: nodeID,
  timeout_ms: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 86_400_000 })).annotate({
    description: "Fresh timeout from now, 1s-24h",
  }),
})
const ControlRetarget = Schema.Struct({
  action: act("control"),
  operation: op("retarget").annotate({
    description: "Change workspace/fingerprint and restart target-sensitive nodes",
  }),
  workflow_id: workflowID,
  workspace: Schema.optional(Schema.String).annotate({ description: "Linked worktree; omit to keep the current one" }),
  fingerprint: Schema.optional(Schema.String).annotate({
    description: "Expected fingerprint: computed git value or 'none'",
  }),
  node_ids: Schema.optional(
    Schema.Array(nodeID)
      .check(Schema.isMinLength(1))
      .annotate({ description: "Running target-sensitive nodes; omit for all" }),
  ),
  reason: Schema.optional(Schema.String),
})

const ActionParams = Schema.Union([
  SpecList,
  SpecRead,
  SpecDraft,
  SpecValidate,
  RunStart,
  RunExtend,
  InspectStatus,
  InspectResult,
  ControlPause,
  ControlResume,
  ControlCancel,
  ControlComplete,
  ControlStep,
  ControlCancelNode,
  ControlReplan,
  ControlRecover,
  ControlExtendTimeout,
  ControlRetarget,
])

export const Parameters = Schema.Struct({ params: ActionParams })

export type WorkflowParams = Schema.Schema.Type<typeof Parameters>["params"]
export type ControlParams = Extract<WorkflowParams, { action: "control" }>
export type RunParams = Extract<WorkflowParams, { action: "run" }>
export type InspectParams = Extract<WorkflowParams, { action: "inspect" }>
export type SpecParams = Extract<WorkflowParams, { action: "spec" }>
