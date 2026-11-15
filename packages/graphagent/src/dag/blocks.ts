// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema } from "effect"
import type { NodeConfig } from "./dag"

export const WORKFLOW_BLOCK_KINDS = [
  "explore",
  "plan",
  "prototype",
  "debug",
  "coding",
  "verify",
  "review",
  "synthesize",
] as const

export type WorkflowBlockKind = (typeof WORKFLOW_BLOCK_KINDS)[number]

/** Workflow-level review gate (config.review_gate). `strict` enables the
 * review-coverage requirements; `standard` keeps them advisory. */
export const REVIEW_GATES = ["strict", "standard"] as const
export type ReviewGate = (typeof REVIEW_GATES)[number]

/** Independent review dimensions a review block can expand into. Every lane
 * runs as its own read-only node and the decision arbitrates all of them. */
export const REVIEW_LENSES = ["standards", "intent", "completeness", "security", "tests", "performance"] as const
export type ReviewLens = (typeof REVIEW_LENSES)[number]

const DEFAULT_REVIEW_LENSES: readonly ReviewLens[] = ["standards", "intent"]

/** A finding carried from a previous review round. `ref` names the exact
 * prior required action as `<workflow_id>/<lane node>/<index>`; the prior
 * arbitration's disposition travels with it so the next round can resolve it. */
export interface PriorFinding {
  readonly ref: string
  readonly node: string
  readonly index: number
  readonly action: string
  readonly disposition?: {
    readonly novelty: "new" | { readonly dup_of: string }
    readonly decision: "upheld" | "refuted"
    readonly evidence: string
  }
}

/** The previous round a review block continues. The engine resolves these
 * stored outputs at compile time and injects them as prior findings; the
 * authoring agent never fills them by hand. */
export interface PriorRound {
  readonly workflow_id: string
  readonly review_id: string
  /** 1-based round number of the referenced decision. */
  readonly round: number
  /** Consecutive referenced rounds that raised no new upheld finding. */
  readonly quiet_rounds: number
  readonly new_findings: number
  readonly findings: readonly PriorFinding[]
}

/** One acceptance criterion (config.acceptance). The completeness lane judges
 * each item and cites evidence for its status. */
export const AcceptanceItem = Schema.Struct({
  id: Schema.String.annotate({
    description: "Stable acceptance id the completeness lane reports against (for example AC1)",
  }),
  text: Schema.String.annotate({ description: "Acceptance criterion the delivered work must satisfy" }),
})
export type AcceptanceItem = typeof AcceptanceItem.Type
export const AcceptanceItems = Schema.Array(AcceptanceItem)

export class WorkflowBlock extends Schema.Class<WorkflowBlock>("WorkflowBlock")({
  id: Schema.String.annotate({ description: "Unique block identifier; dependencies target block IDs" }),
  kind: Schema.Literals(WORKFLOW_BLOCK_KINDS).annotate({
    description: "Composable workflow block; debug and review expand into evidence-gathering subgraphs",
  }),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Block IDs this block waits for. Defaults to []",
  }),
  instruction: Schema.optional(Schema.String).annotate({
    description: "Task-specific instruction added to the block's built-in execution contract",
  }),
  worker_type: Schema.optional(Schema.String).annotate({
    description: "Optional configured agent override; defaults from the block kind",
  }),
  worker_config: Schema.optional(
    Schema.Struct({
      timeout_ms: Schema.Number,
    }),
  ).annotate({
    description:
      "{ timeout_ms } — bounds the node from permit acquisition to completion; time spent queued does not count and the queue wait never fails the node — the clock starts only when the slot is acquired. A running node that exceeds it escalates to the parent for adjudication (capped deadline extensions) before failing. Overrides config.node_defaults.worker_config",
  }),
  required: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether failure is terminal. Decision and verification blocks default to true; volume blocks to false",
  }),
  report_to_parent: Schema.optional(Schema.Boolean).annotate({
    description:
      "Override wake behavior. Review decisions, synthesis, and a review route's verification gate report by default; a reporting block with dependents becomes a blocking checkpoint, and the compiler gates its dependents on verdicts",
  }),
  fan_out: Schema.optional(Schema.String).annotate({
    description:
      "(coding only) Plan block ID in depends_on whose work packages fan this writer out at runtime: two or more disjoint packages run as parallel writers joined by an implementation aggregator under this block's ID; fewer packages run this writer unchanged",
  }),
  lenses: Schema.optional(Schema.Array(Schema.Literals(REVIEW_LENSES))).annotate({
    description:
      "(review only) Independent review lanes, one node per lens: standards, intent, completeness, security, tests, performance. Defaults to [standards, intent]",
  }),
  skeptics: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))).annotate({
    description:
      "(review only) Adversarial skeptic lanes, 0-4. Each assumes the change is wrong and attacks from a rotated angle: evidence existence, minimal counterexample, alternative explanation, boundaries and concurrency. Defaults to 0",
  }),
  prior_round: Schema.optional(
    Schema.Struct({
      workflow_id: Schema.String.annotate({ description: "Prior workflow whose stored review outputs seed this round" }),
      review_id: Schema.String.annotate({ description: "Review decision node id inside the prior workflow" }),
    }),
  ).annotate({
    description:
      "(review only) Continue a review loop: the engine reads the referenced workflow's lane findings and arbitration dispositions and injects them as prior findings. Never fill prior findings by hand",
  }),
}) {}

export interface WorkflowBlockGraph {
  objective: string
  blocks: WorkflowBlock[]
}

export interface WorkflowBlockCompileOptions {
  known_dependencies?: string[]
  /** Effective review gate fixed before compilation (run.start derives it from
   * the session mode or a deep spec; mutations reuse the persisted value). The
   * strict review-coverage requirements read the same frozen value. */
  review_gate?: ReviewGate
  /** config.acceptance entries projected into the completeness lane. */
  acceptance?: readonly AcceptanceItem[]
  /** Prior-round findings resolved from stored workflow outputs, keyed by
   * `<workflow_id>/<review_id>`. Only a live authoring caller supplies them. */
  prior_rounds?: Readonly<Record<string, PriorRound>>
}

// An ACCEPT must refute, by lane and index, every required action a review
// lane raised (review-lifecycle acceptConsistencyErrors enforces it).
const REFUTED_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["node", "index", "reason"],
    properties: {
      node: { type: "string" },
      index: { type: "integer" },
      reason: { type: "string" },
    },
  },
} as const

// Cross-round arbitration: one disposition per lane required action (whatever
// the verdict) and one resolution per prior finding. `novelty` is either the
// literal "new" or { dup_of: <prior finding ref> }.
const DISPOSITIONS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["node", "index", "novelty", "decision", "evidence"],
    properties: {
      node: { type: "string" },
      index: { type: "integer" },
      novelty: { type: ["string", "object"] },
      decision: { type: "string", enum: ["upheld", "refuted"] },
      evidence: { type: "string" },
    },
  },
} as const

const RESOLVED_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["ref", "how", "evidence"],
    properties: {
      ref: { type: "string" },
      how: { type: "string", enum: ["fixed", "refuted", "still_open"] },
      evidence: { type: "string" },
    },
  },
} as const

const NOT_EXAMINED_SCHEMA = { type: "array", items: { type: "string" } } as const

const GENERAL_VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "required_actions", "dispositions", "resolved"],
  properties: {
    verdict: {
      type: "string",
      enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"],
    },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array" },
    refuted: REFUTED_SCHEMA,
    dispositions: DISPOSITIONS_SCHEMA,
    resolved: RESOLVED_SCHEMA,
  },
} as const

const LANE_REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "required_actions"],
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array", items: { type: "string" } },
    not_examined: NOT_EXAMINED_SCHEMA,
  },
} as const

// The completeness lane judges every config.acceptance item and reports what
// the work delivers beyond them. Missing items and unlisted expectations are
// blocking, so they also enter required_actions (missing/partial evidence is
// carried per item above).
export const COMPLETENESS_REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "required_actions", "acceptance", "unlisted"],
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array", items: { type: "string" } },
    not_examined: NOT_EXAMINED_SCHEMA,
    acceptance: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "status", "evidence"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["covered", "partial", "missing"] },
          evidence: { type: "string" },
        },
      },
    },
    unlisted: { type: "array", items: { type: "string" } },
  },
} as const

// Adversarial skeptic contract: the spec's fixed wording; lanes rotate through
// these angles so repeated skeptics do not duplicate one review.
const SKEPTIC_CONTRACT =
  "Assume the change or conclusion is wrong. Demonstrate a concrete failing input, violated acceptance item, regression, or unsupported claim with reproducible evidence; report only what you can demonstrate, each as a required action."

const SKEPTIC_ANGLES = [
  "verify that every cited piece of evidence exists and says what the report claims",
  "construct a counterexample or the smallest reproduction that breaks the conclusion",
  "propose and test an alternative explanation for the observed result",
  "probe boundaries, edge cases, and concurrency for a failure the report missed",
] as const

export const IMPLEMENTATION_SCHEMA = {
  type: "object",
  required: ["summary", "changed_files", "fingerprint"],
  properties: {
    summary: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    fingerprint: { type: "string" },
  },
} as const

// A plan that drives a fan-out writer submits its work packages structurally;
// how many packages and where the boundaries fall stay the planner's call.
const WORK_PACKAGES_SCHEMA = {
  type: "object",
  required: ["summary", "packages"],
  properties: {
    summary: { type: "string" },
    packages: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "instruction", "write_set"],
        properties: {
          id: { type: "string" },
          instruction: { type: "string" },
          write_set: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const

const FAN_OUT_PLAN_CONTRACT =
  "Your packages drive parallel implementation: each package becomes one writer running concurrently in the same workspace. Split only where the work is genuinely independent; return a single package when it is not. Give each package a short id (letters, numbers, hyphens, underscores), a self-contained instruction, and its write_set of repository-relative files or directories. Write sets must be triple-disjoint across packages: source files, generated artifacts, and lockfiles never overlap, and no package may trigger a shared build."

const VERIFICATION_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    summary: { type: "string" },
    evidence: { type: "array" },
  },
} as const

const DIFF_REVIEW_SCHEMA = {
  type: "object",
  required: [
    "verdict",
    "implementation_fingerprint",
    "summary",
    "findings",
    "required_actions",
    "dispositions",
    "resolved",
  ],
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
    implementation_fingerprint: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array" },
    refuted: REFUTED_SCHEMA,
    dispositions: DISPOSITIONS_SCHEMA,
    resolved: RESOLVED_SCHEMA,
  },
} as const

const WRITER_KINDS = new Set<WorkflowBlockKind>(["coding", "prototype"])

/** Read-only profiles may judge but never change the workspace. Strict review
 * lanes and arbitration must use one of these; anything else is treated as
 * write-capable. Mirrors the isolation validation's static catalog so a block
 * compile and a persisted graph agree. */
const READ_ONLY_PROFILES = new Set(["plan", "explore", "auditor", "review", "verify", "verification"])

export function isReadOnlyProfile(workerType: string) {
  return READ_ONLY_PROFILES.has(workerType) || /^(?:review|verify|verification)-/.test(workerType)
}

/** #1030 D9-h: worker types whose job is to judge the workspace, never to
 * change it. The built-in `auditor` agent is the read-only worker that review
 * lanes, skeptics, verification, and synthesis use by default. */
export function isReviewWorker(workerType: string) {
  return workerType === "review" || workerType.startsWith("review-")
}

export function isReadOnlyWorker(workerType: string) {
  return isReviewWorker(workerType) || workerType === "auditor"
}

/** The effective workspace-write policy of a node. An explicit
 * `workspace_writes` wins; otherwise read-only workers deny writes and every
 * other worker keeps its agent permission. */
export function workspaceWritesOf(
  node: Pick<NodeConfig, "workspace_writes"> | undefined,
  workerType: string,
): "allow" | "deny" {
  return node?.workspace_writes ?? (isReadOnlyWorker(workerType) ? "deny" : "allow")
}

// Shared execution discipline for every block that runs shell commands. A
// silent long command reads as hung and invites manual interrupts; keep the
// rule in one place so all command-heavy contracts stay in sync.
const SHELL_DISCIPLINE =
  "Bound any long-running or potentially silent shell command with `timeout <seconds>`, and stream progress (`--reporter=dot`-style or write output to a file you tail); never pipe unbounded output through a silent buffer such as a bare `| tail`."

const BLOCK_CONTRACTS: Record<WorkflowBlockKind, string> = {
  explore:
    `Inspect the target read-only and prefer primary repository or runtime evidence. Separate confirmed facts, inferences, and unknowns; map ownership, constraints, conventions, and file references. Return an evidence map that downstream blocks can cite. Do not implement or hide unresolved uncertainty. ${SHELL_DISCIPLINE}`,
  plan: "Produce a decision- or implementation-ready plan from repository evidence and dependency outputs. State the selected boundary, ordered options or work packages, dependencies, acceptance checks, falsifiers, and unresolved risks. Stop rather than inventing a user-owned product decision. Do not implement.",
  prototype:
    "Answer one falsifiable uncertainty with the smallest disposable experiment. State the hypothesis and success signal first, separate observations from inference, and do not integrate prototype code unless explicitly promoted by confirmed scope. Submit its changed-file list and a stable fingerprint so downstream verification and review bind to the exact experiment.",
  debug:
    `Minimize the reproduced failure, rank falsifiable hypotheses, instrument the discriminating boundary, and identify the smallest causal explanation. Distinguish cause from symptom and correlated damage. Return the narrowest safe repair boundary and a regression check that would fail without that repair; stop if evidence does not establish a cause. ${SHELL_DISCIPLINE}`,
  coding:
    `Implement only the bounded production change and preserve unrelated work. When an observable automated seam exists, establish a failing check, make the smallest change that passes it, then refactor without breaking the check; otherwise record the evidence-backed reason before implementation. Run focused checks and stop on ownership or interface drift. Submit the aggregate changed-file list and a stable fingerprint of the actual implementation state. ${SHELL_DISCIPLINE}`,
  verify:
    `Verify the supplied work against every acceptance criterion using deterministic checks where available. Bind evidence to the supplied implementation fingerprint and submit exact commands, results, and an explicit PASS or FAIL verdict. Missing evidence or any failed required check is FAIL; do not repair or hide failures in this block. ${SHELL_DISCIPLINE}`,
  review:
    "Review independently against repository standards and the confirmed intent. Bind findings to the supplied implementation fingerprint, cite concrete evidence, separate required actions from suggestions, and reject stale, duplicated, or unsupported claims. Do not implement fixes inside the review lane.",
  synthesize:
    "Combine dependency outputs into one decision-ready result. Resolve conflicts by evidence strength, preserve material uncertainty, and state the outcome, rationale, acceptance evidence, residual risks, and next action. Do not invent consensus or new facts absent from dependency evidence.",
}

export function compileWorkflowBlocks(
  graph: WorkflowBlockGraph,
  options: WorkflowBlockCompileOptions = {},
): NodeConfig[] {
  requireValidBlockGraph(graph, options)
  requireValidReviewRoutes(graph.blocks)
  requireReviewCoverage(graph, options)
  const { blocks, aggregations, verifyAggregators } = aggregateParallelWriters(graph.blocks)
  const reportingVerifications = reviewRouteVerificationGates(blocks, aggregations)
  const nodes = blocks.flatMap((block) =>
    compileBlock(graph.objective, block, blocks, aggregations, verifyAggregators, reportingVerifications, options),
  )
  const duplicateNodeIDs = uniqueDuplicates(nodes.map((node) => node.id))
  if (duplicateNodeIDs.length > 0) {
    throw new Error(
      `Block expansion creates duplicate node ids: ${duplicateNodeIDs.join(", ")}. Rename the colliding block`,
    )
  }
  return markConditionalDescendants(nodes)
}

/**
 * A conditional branch root is an explicit accepted branch. Every required
 * descendant of that root belongs to the same mutually-exclusive branch, so a
 * cascade skip is expected there too. Unrelated nodes stay strict; an explicit
 * skip_ok value is never overwritten.
 */
function markConditionalDescendants(nodes: NodeConfig[]): NodeConfig[] {
  const accepted = new Set(
    nodes.filter((node) => node.condition !== undefined && node.skip_ok === true).map((node) => node.id),
  )
  for (;;) {
    const added = nodes.filter(
      (node) =>
        !accepted.has(node.id)
        && node.skip_ok === undefined
        && node.depends_on.some((dependency) => accepted.has(dependency)),
    )
    if (added.length === 0) break
    for (const node of added) accepted.add(node.id)
  }
  return nodes.map((node) =>
    accepted.has(node.id) && node.skip_ok === undefined ? { ...node, skip_ok: true } : node,
  )
}

function compileBlock(
  objective: string,
  block: WorkflowBlock,
  blocks: WorkflowBlock[],
  aggregations: Map<string, WriterAggregation>,
  verifyAggregators: Map<string, string[]>,
  reportingVerifications: ReadonlySet<string>,
  options: WorkflowBlockCompileOptions,
): NodeConfig[] {
  const dependencies = block.depends_on ?? []
  const required = block.required ?? (block.kind === "plan" || block.kind === "verify" || block.kind === "synthesize")
  const reviewDependency = dependencies.find(
    (dependency) => blocks.find((candidate) => candidate.id === dependency)?.kind === "review",
  )
  const condition = reviewDependency ? `${reviewDependency}.output.verdict == "ACCEPT"` : undefined
  const drivesFanOut = block.kind === "plan" && blocks.some((candidate) => candidate.fan_out === block.id)

  if (block.kind === "debug") {
    const evidenceID = `${block.id}--evidence`
    return [
      node({
        id: evidenceID,
        name: `${block.id}: reproduce and collect evidence`,
        workerType: block.worker_type ?? "explore",
        dependencies,
        objective,
        instruction: block.instruction,
        contract:
          "Reproduce or characterize the failure read-only where possible. Capture exact symptoms, commands, logs, boundaries, and the smallest falsifiable observations. Do not patch the code.",
        required: false,
        reportToParent: false,
        workerConfig: block.worker_config,
        condition,
        skipOk: condition !== undefined ? true : undefined,
        blockKind: block.kind,
        generatedHelper: "evidence",
      }),
      node({
        id: block.id,
        name: `${block.id}: diagnose root cause`,
        workerType: block.worker_type ?? "general",
        dependencies: [evidenceID],
        objective,
        instruction: block.instruction,
        contract: BLOCK_CONTRACTS.debug,
        required: block.required ?? true,
        reportToParent: block.report_to_parent ?? false,
        workerConfig: block.worker_config,
        blockKind: block.kind,
      }),
    ]
  }

  if (block.kind === "review") {
    const aggregation = aggregations.get(block.id)
    const conventionalRoute = aggregation ? undefined : implementationReviewRoute(block, blocks)
    const implementationID = aggregation ? aggregation.aggregatorID : conventionalRoute?.implementation.id
    const verificationID = aggregation ? aggregation.verificationID : conventionalRoute?.verification.id
    const route = implementationID && verificationID ? { implementationID, verificationID } : undefined
    const reviewCondition = route ? `${route.verificationID}.output.verdict == "PASS"` : condition
    const reviewEvidence = route
      ? {
          implementation_changed_files: `${route.implementationID}.output.changed_files`,
          implementation_fingerprint: `${route.implementationID}.output.fingerprint`,
          verification: `${route.verificationID}.output`,
        }
      : undefined
    const strict = options.review_gate === "strict"
    const priorRound = block.prior_round
      ? options.prior_rounds?.[`${block.prior_round.workflow_id}/${block.prior_round.review_id}`]
      : undefined
    const descriptors = reviewLaneDescriptors(block, options.acceptance)
    const lanes = descriptors.map((descriptor) =>
      node({
        id: `${block.id}--${descriptor.suffix}`,
        name: `${block.id}: ${descriptor.name}`,
        workerType: block.worker_type ?? "auditor",
        dependencies,
        objective,
        instruction: block.instruction,
        contract: descriptor.contract,
        required: false,
        reportToParent: false,
        workerConfig: block.worker_config,
        condition: reviewCondition,
        inputMapping: reviewEvidence,
        outputSchema: descriptor.schema,
        targetSensitive: true,
        blockKind: block.kind,
        reviewLane: descriptor.suffix,
      }),
    )
    const laneIDs = lanes.map((lane) => lane.id)
    const laneReviewMapping = Object.fromEntries(
      descriptors.map((descriptor) => [
        `${descriptor.suffix.replace(/-/g, "_")}_review`,
        `${block.id}--${descriptor.suffix}.output`,
      ]),
    )
    const lanesWithDecision = [
      ...lanes,
      node({
        id: block.id,
        name: `${block.id}: review decision`,
        workerType: block.worker_type ?? "auditor",
        dependencies: [...laneIDs, ...(route ? [route.verificationID] : [])],
        objective,
        instruction: block.instruction,
        contract: [
          "Arbitrate the independent reviews finding by finding.",
          route
            ? "Reject unsupported claims, deduplicate overlaps, and submit ACCEPT or REJECT while echoing the supplied implementation fingerprint exactly."
            : "Reject unsupported claims, deduplicate overlaps, and submit one structured result with verdict ACCEPT, REVISE, REJECT, or BLOCKED.",
          "Use ACCEPT only when no material required action remains: leave required_actions empty and list every required action a review lane raised in refuted as { node, index, reason } with the evidence that disproves it. The runtime rejects an ACCEPT that does neither.",
          "Whatever the verdict, submit dispositions covering every required action each lane raised ({ node, index, novelty: \"new\" or { dup_of: <prior ref> }, decision: upheld|refuted, evidence }) and resolved covering every prior finding ({ ref, how: fixed|refuted|still_open, evidence }).",
          priorRound
            ? "The supplied prior findings are the previous round's unresolved and resolved items; adjudicate each one explicitly rather than restating it as new."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        required: block.required ?? true,
        reportToParent: block.report_to_parent ?? true,
        workerConfig: block.worker_config,
        condition: reviewCondition,
        // The strict gate makes the decision a non-skippable required node:
        // a failed verification closes the route and the workflow fails
        // instead of completing with the review silently skipped.
        skipOk: strict ? false : reviewCondition !== undefined ? true : undefined,
        inputMapping: route
          ? {
              ...reviewEvidence,
              ...laneReviewMapping,
            }
          : undefined,
        review: route
          ? {
              phase: "diff",
              implementation_node_id: route.implementationID,
              verification_node_id: route.verificationID,
            }
          : undefined,
        outputSchema: route ? DIFF_REVIEW_SCHEMA : GENERAL_VERDICT_SCHEMA,
        targetSensitive: true,
        blockKind: block.kind,
        reviewLenses: reviewLenses(block),
        priorRound: block.prior_round,
        priorFindings: priorRound?.findings,
        reviewRound: priorRound ? priorRound.round + 1 : 1,
        // The streak travels forward: two consecutive quiet rounds stop the
        // loop (the loader refuses to start a successor beyond that).
        reviewQuietRounds: priorRound
          ? priorRound.new_findings === 0
            ? priorRound.quiet_rounds + 1
            : 0
          : undefined,
        reviewNewFindings: priorRound?.new_findings,
        priorPrompt: priorRound && priorRound.findings.length > 0 ? "Prior findings (from the referenced review round):\n{{prior_findings}}" : undefined,
        priorInput: priorRound && priorRound.findings.length > 0 ? { prior_findings: priorRound.findings } : undefined,
      }),
    ]
    if (!aggregation) return lanesWithDecision
    return [
      node({
        id: aggregation.aggregatorID,
        name: `${block.id}: aggregate parallel implementation evidence`,
        workerType: "explore",
        dependencies: aggregation.writerIDs,
        objective,
        contract: AGGREGATOR_CONTRACT,
        required: true,
        reportToParent: false,
        workerConfig: block.worker_config,
        inputMapping: aggregatorEvidenceMapping(aggregation.writerIDs),
        outputSchema: IMPLEMENTATION_SCHEMA,
        blockKind: block.kind,
        aggregatesWriters: true,
        generatedHelper: "aggregate",
      }),
      ...lanesWithDecision,
    ]
  }

  const verifyAggregatorIDs = verifyAggregators.get(block.id)
  const verifyAggregator = verifyAggregatorIDs && verifyAggregatorIDs.length > 0 ? verifyAggregatorIDs[0] : undefined
  // #349/BLK-3: one verify node serving two parallel-writer review routes
  // would be rewired onto two aggregators, but the verify contract binds ONE
  // implementation reference and ONE fingerprint — mapping only the first
  // (the old silent behavior) lets the second route's write-set escape the
  // review binding. Reject the shape instead: fan the routes together
  // first, exactly like multi-review-gate dependencies.
  if (verifyAggregatorIDs && verifyAggregatorIDs.length > 1) {
    throw new Error(
      `Verify block "${block.id}" serves multiple parallel-writer review routes (${verifyAggregatorIDs.join(", ")}) — the verification contract binds a single implementation fingerprint. Fan the routes into one review block first, or give each route its own verify block`,
    )
  }
  // A synthesize that follows a review is the route's final gate: it must map
  // the review output so unresolvedReviewOutcomes/finalReviewGates recognize
  // an ACCEPTed review as resolved (issue #304) — the same binding contract
  // the verify aggregation path already honors.
  const synthesizeGateBinding =
    block.kind === "synthesize" && reviewDependency
      ? { [`${reviewDependency.replace(/-/g, "_")}_review`]: `${reviewDependency}.output` }
      : undefined
  // A review-route verification gate reports to the parent by default: on
  // FAIL every review lane and the decision are condition-skipped and the
  // route settles COMPLETED. Without a reporting node the parent never sees
  // the failed verdict and reopen-extend has no reporting checkpoint to
  // route the correction back through. Its dependents are all gated on its
  // verdict, so it is a well-formed reporting checkpoint.
  const routeVerificationGate = block.report_to_parent === undefined && reportingVerifications.has(block.id)
  return [
    node({
      id: block.id,
      name: `${block.id}: ${block.kind}`,
      workerType: block.worker_type ?? defaultBlockWorker(block.kind),
      dependencies,
      objective,
      instruction: block.instruction,
      contract: drivesFanOut ? `${BLOCK_CONTRACTS.plan} ${FAN_OUT_PLAN_CONTRACT}` : BLOCK_CONTRACTS[block.kind],
      required,
      reportToParent: block.report_to_parent ?? (block.kind === "synthesize" || routeVerificationGate),
      // The verification contract already demands a deterministic PASS/FAIL;
      // the direction-adjudication clause (replan/reject) does not apply.
      adversarial: routeVerificationGate ? false : undefined,
      workerConfig: block.worker_config,
      condition,
      skipOk: condition !== undefined ? true : undefined,
      inputMapping: verifyAggregator
        ? {
            implementation_changed_files: `${verifyAggregator}.output.changed_files`,
            implementation_fingerprint: `${verifyAggregator}.output.fingerprint`,
          }
        : synthesizeGateBinding,
      outputSchema: WRITER_KINDS.has(block.kind)
        ? IMPLEMENTATION_SCHEMA
        : block.kind === "verify"
          ? VERIFICATION_SCHEMA
          : drivesFanOut
            ? WORK_PACKAGES_SCHEMA
            : undefined,
      fanOut: block.fan_out,
      targetSensitive: block.kind === "verify" || block.kind === "synthesize",
      blockKind: block.kind,
    }),
  ]
}

interface ReviewLaneDescriptor {
  suffix: string
  name: string
  contract: string
  schema: Record<string, unknown>
}

/** One lane per lens, then one per skeptic. Skeptic angles rotate in a fixed
 * order so numbered skeptics never repeat the same attack. */
function reviewLaneDescriptors(
  block: WorkflowBlock,
  acceptance: readonly AcceptanceItem[] | undefined,
): ReviewLaneDescriptor[] {
  const lenses = reviewLenses(block)
  const skeptics = Array.from({ length: block.skeptics ?? 0 }, (_, index) => {
    const number = index + 1
    const angle = SKEPTIC_ANGLES[index % SKEPTIC_ANGLES.length]
    return {
      suffix: `skeptic-${number}`,
      name: `skeptic review ${number}`,
      contract: `${SKEPTIC_CONTRACT} Attack angle: ${angle}.`,
      schema: LANE_REVIEW_SCHEMA,
    } satisfies ReviewLaneDescriptor
  })
  return [
    ...lenses.map((lens) => ({
      suffix: lens,
      name: `${lens} review`,
      contract: reviewLaneContract(lens, acceptance),
      schema: lens === "completeness" ? COMPLETENESS_REVIEW_SCHEMA : LANE_REVIEW_SCHEMA,
    })),
    ...skeptics,
  ]
}

function reviewLenses(block: WorkflowBlock): readonly ReviewLens[] {
  const lenses = block.lenses ?? DEFAULT_REVIEW_LENSES
  if (lenses.length === 0) throw new Error(`Block "${block.id}" must declare at least one review lens`)
  const repeated = uniqueDuplicates([...lenses])
  if (repeated.length > 0) throw new Error(`Block "${block.id}" repeats review lens: ${repeated.join(", ")}`)
  return lenses
}

const LENS_ACTION_RULE =
  "List only blocking items in required_actions; ACCEPT requires it to be empty."

const LENS_FOCUS: Record<ReviewLens, string> = {
  standards:
    "Focus on documented repository standards, architecture constraints, correctness, and verification evidence.",
  intent: "Focus on the confirmed goal, scope, acceptance criteria, and user-visible behavior.",
  completeness:
    "Judge every acceptance item as covered, partial, or missing and attach concrete evidence for each status. List every material expectation the work delivers that no acceptance item names in unlisted. Put every missing item and every unlisted expectation in required_actions; ACCEPT requires it to be empty.",
  security:
    "Focus on exploitable security defects: untrusted input reaching privileged operations, secret or credential exposure, injection, path traversal, authorization gaps, and unsafe defaults. Cite the concrete attack path.",
  tests:
    "Focus on test validity and coverage: whether the changed behavior is exercised by meaningful deterministic checks, whether the tests assert the intended contract rather than the implementation, and whether a regression would fail without the change. Cite the exact test or the missing case.",
  performance:
    "Focus on performance and resource behavior: algorithmic complexity, unbounded work or memory, repeated I/O or network calls on hot paths, and concurrency contention introduced by the change. Cite the concrete scenario and its cost.",
}

function reviewLaneContract(lens: ReviewLens, acceptance: readonly AcceptanceItem[] | undefined): string {
  return lens === "completeness"
    ? `${BLOCK_CONTRACTS.review} ${LENS_FOCUS[lens]} ${acceptanceSection(acceptance)}`
    : `${BLOCK_CONTRACTS.review} ${LENS_FOCUS[lens]} ${LENS_ACTION_RULE}`
}

function acceptanceSection(acceptance: readonly AcceptanceItem[] | undefined): string {
  if (!acceptance || acceptance.length === 0)
    return "No config.acceptance items were supplied: return an empty acceptance list and put every uncovered expectation in unlisted."
  return `Acceptance items:\n${acceptance.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`
}

function node(input: {
  id: string
  name: string
  workerType: string
  dependencies: readonly string[]
  objective: string
  instruction?: string
  contract: string
  required: boolean
  reportToParent: boolean
  workerConfig?: { timeout_ms: number }
  condition?: string
  /** Accept a false condition on this required node. Set only at intentional
   * mutually-exclusive branch points; an explicit false keeps the node a hard
   * failure (the strict review decision uses it). */
  skipOk?: boolean
  inputMapping?: Record<string, string>
  review?: NodeConfig["review"]
  outputSchema?: Record<string, unknown>
  /** Overrides the reporting-checkpoint adjudication clause (default: reportToParent). */
  adversarial?: boolean
  fanOut?: string
  /** #944: the node judges the current working tree. */
  targetSensitive?: boolean
  /** The block kind that produced this node; persisted so replay-time gates
   * (recover/retry) keep block semantics without the authored blocks. */
  blockKind?: WorkflowBlockKind
  /** Review lane suffix (lens or skeptic-N); lane nodes are read-only. */
  reviewLane?: string
  /** Lenses the review decision arbitrates (persisted review contract). */
  reviewLenses?: readonly ReviewLens[]
  /** Prior round this decision continues, persisted for round accounting. */
  priorRound?: NonNullable<WorkflowBlock["prior_round"]>
  /** Findings resolved from the prior round's stored outputs. */
  priorFindings?: readonly PriorFinding[]
  reviewRound?: number
  reviewQuietRounds?: number
  reviewNewFindings?: number
  /** Prompt fragment carrying the prior findings JSON. */
  priorPrompt?: string
  priorInput?: Record<string, unknown>
  /** The compiler-generated fan-out aggregator under a review block id. */
  aggregatesWriters?: boolean
  /** The compiler chose this helper node's worker; no author override applies. */
  generatedHelper?: "aggregate" | "evidence"
}): NodeConfig {
  // issue #387: an instruction equal to the objective (after trim and
  // line-ending normalization) would render the same content twice in the
  // single child prompt — the objective section already carries it, so the
  // instruction is dropped instead of duplicated. Equivalence is exact, not
  // fuzzy: an instruction carrying the objective plus additional detail stays.
  const equivalent = (a: string, b: string) => a.trim().replace(/\r\n/g, "\n") === b.trim().replace(/\r\n/g, "\n")
  const instructionText = input.instruction?.trim() ?? ""
  const hasInstruction = instructionText !== "" && !equivalent(instructionText, input.objective)
  const instruction = hasInstruction ? "Block-specific instruction:\n{{instruction}}" : ""
  // issue #323: a reporting checkpoint adjudicates a direction, so its
  // prompt must demand adversarial independent verification. The production
  // incident: a gate confirmed parent-supplied "defect evidence" that was a
  // production no-op because it re-read the parent's narrative instead of
  // the source. Upstream claims are hypotheses, not facts.
  const adversarial = (input.adversarial ?? input.reportToParent)
    ? "As a reporting checkpoint you adjudicate this direction: treat upstream and parent-supplied claims as hypotheses to verify, never facts to confirm. Independently read the relevant source before endorsing, spot-check at least three of the most load-bearing claims (name the count you actually inspected), cite what you actually inspected, and replan or reject the direction when a load-bearing claim does not survive inspection."
    : ""
  return {
    id: input.id,
    name: input.name,
    worker_type: input.workerType,
    depends_on: [...input.dependencies],
    required: input.required,
    report_to_parent: input.reportToParent,
    prompt_template: {
      inline: [
        "Workflow objective:\n{{objective}}",
        instruction,
        input.contract,
        adversarial,
        input.priorPrompt ?? "",
        "Use dependency outputs as evidence and return a concise artifact that downstream blocks can consume. Do not ask the user questions from this child session.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      input: {
        objective: input.objective,
        ...(hasInstruction ? { instruction: instructionText } : {}),
        ...input.priorInput,
      },
    },
    ...(input.workerConfig ? { worker_config: input.workerConfig } : {}),
    ...(input.condition ? { condition: input.condition } : {}),
    ...(input.skipOk !== undefined ? { skip_ok: input.skipOk } : {}),
    ...(input.inputMapping ? { input_mapping: input.inputMapping } : {}),
    ...(input.review ? { review: input.review } : {}),
    ...(input.outputSchema ? { output_schema: input.outputSchema } : {}),
    ...(input.fanOut ? { fan_out: input.fanOut } : {}),
    ...(input.targetSensitive ? { target_sensitive: true } : {}),
    ...(input.blockKind ? { block: input.blockKind } : {}),
    ...(input.reviewLane ? { review_lane: input.reviewLane } : {}),
    ...(input.reviewLenses ? { review_lenses: [...input.reviewLenses], review_arbitration: true } : {}),
    ...(input.priorRound ? { prior_round: input.priorRound } : {}),
    ...(input.priorFindings && input.priorFindings.length > 0 ? { prior_findings: [...input.priorFindings] } : {}),
    ...(input.reviewRound !== undefined ? { review_round: input.reviewRound } : {}),
    ...(input.reviewQuietRounds !== undefined ? { review_quiet_rounds: input.reviewQuietRounds } : {}),
    ...(input.reviewNewFindings !== undefined ? { review_new_findings: input.reviewNewFindings } : {}),
    ...(input.aggregatesWriters ? { aggregates_writers: true } : {}),
    ...(input.generatedHelper ? { generated_helper: input.generatedHelper } : {}),
  }
}

/** The worker a block kind runs when it does not override one. */
export function defaultBlockWorker(kind: WorkflowBlockKind) {
  if (kind === "explore") return "explore"
  if (kind === "plan") return "plan"
  if (kind === "coding" || kind === "prototype") return "build"
  // Judging work is read-only: verification, synthesis, and review lanes run on
  // the built-in auditor. A synthesize that must write declares worker_type.
  if (kind === "verify" || kind === "synthesize") return "auditor"
  return "general"
}

/**
 * A non-writer block whose explicit worker override runs with workspace
 * writes. The strict gate rejects it: only coding and prototype writers may
 * change the workspace, and each needs a fingerprint-bound diff review, so a
 * write-capable synthesize/verify/explore/review block would run unreviewed
 * work. An override equal to the kind's default is not an escalation.
 */
export function nonWriterWorkerOverride(
  kind: WorkflowBlockKind,
  workerType: string | undefined,
): string | undefined {
  if (WRITER_KINDS.has(kind) || workerType === undefined || workerType === defaultBlockWorker(kind))
    return undefined
  return workspaceWritesOf(undefined, workerType) === "allow" ? workerType : undefined
}

function requireValidBlockGraph(graph: WorkflowBlockGraph, options: WorkflowBlockCompileOptions) {
  if (graph.objective.trim() === "") throw new Error("Block workflow requires a non-empty objective")
  if (graph.blocks.length === 0) throw new Error("Block workflow requires at least one block")

  const blockIDs = graph.blocks.map((block) => block.id)
  const duplicateBlockIDs = uniqueDuplicates(blockIDs)
  if (duplicateBlockIDs.length > 0) {
    throw new Error(`Block workflow has duplicate block ids: ${duplicateBlockIDs.join(", ")}`)
  }

  const known = new Set([...blockIDs, ...(options.known_dependencies ?? [])])
  graph.blocks.forEach((block) => {
    if (block.id.trim() === "") throw new Error("Block workflow contains an empty block id")
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(block.id)) {
      throw new Error(`Block "${block.id}" must use only letters, numbers, underscores, and hyphens`)
    }
    ;(block.depends_on ?? []).forEach((dependency) => {
      if (!known.has(dependency)) {
        throw new Error(`Block "${block.id}" depends on unknown block "${dependency}"`)
      }
    })
    if (block.fan_out !== undefined) requireValidFanOut(block, graph.blocks)
    if (block.kind !== "review") {
      if (block.lenses !== undefined)
        throw new Error(`Block "${block.id}" declares lenses, which only review blocks support`)
      if (block.skeptics !== undefined)
        throw new Error(`Block "${block.id}" declares skeptics, which only review blocks support`)
      if (block.prior_round !== undefined)
        throw new Error(`Block "${block.id}" declares prior_round, which only review blocks support`)
    }
    if (block.prior_round !== undefined) {
      if (block.prior_round.workflow_id.trim() === "")
        throw new Error(`Block "${block.id}" prior_round.workflow_id must not be empty`)
      if (block.prior_round.review_id.trim() === "")
        throw new Error(`Block "${block.id}" prior_round.review_id must not be empty`)
    }
    const reviewDependencies = (block.depends_on ?? []).filter(
      (dependency) => graph.blocks.find((candidate) => candidate.id === dependency)?.kind === "review",
    )
    if (reviewDependencies.length > 1) {
      throw new Error(
        `Block "${block.id}" depends on multiple review gates (${reviewDependencies.join(", ")}); fan them into one review block first`,
      )
    }
  })
  topologicalBlocks(graph.blocks)
}

function requireValidFanOut(block: WorkflowBlock, blocks: WorkflowBlock[]) {
  if (block.kind !== "coding") throw new Error(`Block "${block.id}" uses fan_out, which only coding blocks support`)
  const source = blocks.find((candidate) => candidate.id === block.fan_out)
  if (source?.kind !== "plan") {
    throw new Error(`Block "${block.id}" fan_out "${block.fan_out}" must name a plan block`)
  }
  if (!(block.depends_on ?? []).includes(source.id)) {
    throw new Error(`Block "${block.id}" fan_out "${source.id}" must also be listed in its depends_on`)
  }
  const sharing = blocks.filter((candidate) => candidate.fan_out === source.id).map((candidate) => candidate.id)
  if (sharing.length > 1) {
    throw new Error(`Plan block "${source.id}" fans out more than one writer (${sharing.join(", ")}); keep one`)
  }
}

// Injected between parallel implementation writers and their verification
// gate: an explore-type worker enforcing the contract below. Detection is a
// behavioral contract, not an engine guarantee (#347) — the engine computes
// no intersection or union itself. The contract makes the worker reconcile
// the declared write-sets against the workspace's actual git status so
// undeclared edits fail loudly instead of escaping the union+fingerprint
// review binding, and computes the fingerprint over the actually-changed set.
export const AGGREGATOR_CONTRACT =
  "Collect the supplied changed-file lists and summaries from each parallel implementation writer. Run git status --porcelain in the workspace to observe the actually-changed set. If any file path appears in more than one declared list, do not submit; fail the node naming the exact overlapping paths. If the actually-changed set contains paths no writer declared, do not submit; fail the node naming the undeclared paths — undeclared edits must not slip past the review binding. Otherwise submit the union of the actually-changed set and one stable fingerprint computed at this convergence point over exactly that set (for example a sha256 over the sorted union of current file contents, reporting the exact commands used). Do not modify any file."

interface WriterAggregation {
  aggregatorID: string
  writerIDs: string[]
  verificationID: string
}

/**
 * The aggregator's per-writer evidence mapping. #349/BLK-02: writer ids may
 * mix hyphens and underscores ("foo-bar" vs "foo_bar") whose -→_ normalization
 * collides on the same mapping key — Object.fromEntries would silently drop
 * one writer's evidence (and its files escape the aggregator's overlap
 * detection), so the shape is rejected at compile time.
 */
export function aggregatorEvidenceMapping(writerIDs: string[]): Record<string, string> {
  const seen = new Map<string, string>()
  for (const writerID of writerIDs) {
    const key = writerID.replace(/-/g, "_")
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new Error(
        `Parallel implementation writers "${prior}" and "${writerID}" normalize to the same input-mapping key "${key}" — their aggregator evidence keys would collide. Rename one of the writers so the ids differ beyond hyphens vs underscores`,
      )
    }
    seen.set(key, writerID)
  }
  return Object.fromEntries(
    writerIDs.flatMap((writerID: string) => [
      [`${writerID.replace(/-/g, "_")}_changed_files`, `${writerID}.output.changed_files`],
      [`${writerID.replace(/-/g, "_")}_summary`, `${writerID}.output.summary`],
    ]),
  )
}

function aggregateParallelWriters(blocks: WorkflowBlock[]) {
  const aggregations = new Map<string, WriterAggregation>()
  for (const block of blocks) {
    if (block.kind !== "review") continue
    const topology = reviewWriterTopology(block, blocks)
    if (!topology) continue
    if (canonicalWriter(topology, blocks)) continue
    aggregations.set(block.id, {
      aggregatorID: `${block.id}--aggregate`,
      writerIDs: topology.implementations.map((writer) => writer.id),
      verificationID: topology.verification.id,
    })
  }
  if (aggregations.size === 0) {
    return { blocks, aggregations, verifyAggregators: new Map<string, string[]>() }
  }
  const writerToAggregators = new Map<string, string[]>()
  for (const aggregation of aggregations.values()) {
    for (const writerID of aggregation.writerIDs) {
      writerToAggregators.set(writerID, [...(writerToAggregators.get(writerID) ?? []), aggregation.aggregatorID])
    }
  }
  const aggregatorIDs = new Set([...aggregations.values()].map((aggregation) => aggregation.aggregatorID))
  const verifyAggregators = new Map<string, string[]>()
  const rewired = blocks.map((block) => {
    if (block.kind !== "verify") return block
    const original = block.depends_on ?? []
    const replaced = [...new Set(original.flatMap((dependency) => writerToAggregators.get(dependency) ?? [dependency]))]
    if (replaced.length === original.length && replaced.every((dependency, index) => dependency === original[index])) {
      return block
    }
    verifyAggregators.set(block.id, replaced.filter((dependency) => aggregatorIDs.has(dependency)))
    return new WorkflowBlock({
      id: block.id,
      kind: block.kind,
      depends_on: replaced,
      instruction: block.instruction,
      worker_type: block.worker_type,
      worker_config: block.worker_config,
      required: block.required,
      report_to_parent: block.report_to_parent,
    })
  })
  topologicalBlocks(rewired)
  return { blocks: rewired, aggregations, verifyAggregators }
}

/**
 * Verify blocks that serve as the verification gate of a review route and
 * whose every direct dependent is a review block routed through them. Those
 * dependents compile into lanes and a decision conditioned on the verify
 * verdict, so the gate may report to the parent without an ungated dependent.
 */
function reviewRouteVerificationGates(blocks: WorkflowBlock[], aggregations: Map<string, WriterAggregation>) {
  const routedReviews = new Map<string, Set<string>>()
  for (const block of blocks) {
    if (block.kind !== "review") continue
    const verificationID = aggregations.get(block.id)?.verificationID ?? implementationReviewRoute(block, blocks)?.verification.id
    if (!verificationID) continue
    routedReviews.set(verificationID, new Set([...(routedReviews.get(verificationID) ?? []), block.id]))
  }
  return new Set(
    [...routedReviews].flatMap(([verificationID, reviews]) => {
      const dependents = blocks.filter((block) => (block.depends_on ?? []).includes(verificationID))
      return dependents.length > 0 && dependents.every((block) => reviews.has(block.id)) ? [verificationID] : []
    }),
  )
}

function requireValidReviewRoutes(blocks: WorkflowBlock[]) {
  blocks.filter((block) => block.kind === "review").forEach((block) => reviewWriterTopology(block, blocks))
}

/**
 * Strict review-coverage gate (config.review_gate "strict", which deep mode and
 * a session DAG mode of on fix at start). Writers must be covered by a
 * downstream diff review bound to their fingerprint; every review decision is a
 * required, non-skippable, read-only gate whose lenses include completeness;
 * and a writing graph must carry 1-50 uniquely identified acceptance items.
 * The standard gate keeps the same shape advisory (the caller reports
 * warnings).
 */
export function requireReviewCoverage(graph: WorkflowBlockGraph, options: WorkflowBlockCompileOptions = {}) {
  if (options.review_gate !== "strict") return
  const reviews = graph.blocks.filter((block) => block.kind === "review")
  const writers = graph.blocks.filter((block) => WRITER_KINDS.has(block.kind))
  const errors: string[] = []

  for (const writer of writers) {
    const covered = reviews.some((review) =>
      reviewWriterTopology(review, graph.blocks)?.implementations.some((candidate) => candidate.id === writer.id),
    )
    if (!covered) {
      errors.push(
        `Writer block "${writer.id}" has no downstream review gate bound to its implementation fingerprint; under the strict gate every writer needs verify → review (phase diff) whose implementation_node_id points at the writer or its fan-out aggregator`,
      )
    }
  }

  // A worker override can hand write capability to a block kind the writer
  // filter above never inspects, letting synthesized or exploratory work
  // change the tree outside every fingerprint-bound review.
  for (const block of graph.blocks) {
    const override = nonWriterWorkerOverride(block.kind, block.worker_type)
    if (override) {
      errors.push(
        `Block "${block.id}" (${block.kind}) overrides its worker to write-capable "${override}"; under the strict gate only coding and prototype writers may change the workspace, and each needs verify → review bound to its implementation fingerprint`,
      )
    }
  }

  for (const review of reviews) {
    if (review.required === false)
      errors.push(`Review block "${review.id}" must set required: true under the strict gate`)
    if (!reviewLenses(review).includes("completeness"))
      errors.push(`Review block "${review.id}" must include the completeness lens under the strict gate`)
    const workerType = review.worker_type ?? "auditor"
    if (!isReadOnlyProfile(workerType))
      errors.push(
        `Review block "${review.id}" lanes and arbitration use write-capable worker "${workerType}"; the strict gate requires a read-only profile such as auditor`,
      )
  }

  if (writers.length > 0) {
    const acceptance = options.acceptance ?? []
    if (acceptance.length === 0) {
      errors.push(
        "A strict workflow with writers must declare config.acceptance so the completeness lane can judge every criterion",
      )
    }
    if (acceptance.length > 50) errors.push(`config.acceptance has ${acceptance.length} items; the strict gate allows at most 50`)
    const repeated = uniqueDuplicates(acceptance.map((item) => item.id))
    if (repeated.length > 0)
      errors.push(`config.acceptance repeats id(s): ${repeated.join(", ")}; every acceptance id must be unique`)
  }

  if (errors.length > 0) throw new Error(errors.join("; "))
}

interface ReviewWriterTopology {
  implementations: WorkflowBlock[]
  verification: WorkflowBlock
}

function reviewWriterTopology(block: WorkflowBlock, blocks: WorkflowBlock[]): ReviewWriterTopology | undefined {
  const implementations = blocks.filter(
    (candidate) => WRITER_KINDS.has(candidate.kind) && dependsTransitively(blocks, block.id, candidate.id),
  )
  if (implementations.length === 0) return undefined
  const verifications = blocks.filter(
    (candidate) => candidate.kind === "verify" && dependsTransitively(blocks, block.id, candidate.id),
  )
  if (verifications.length !== 1) {
    throw new Error(
      `Implementation review "${block.id}" requires exactly one verification ancestor; found ${verifications.length}`,
    )
  }
  const verification = verifications[0]
  const verifiedImplementations = implementations.filter((candidate) =>
    dependsTransitively(blocks, verification.id, candidate.id),
  )
  if (verifiedImplementations.length !== implementations.length) {
    throw new Error(
      `Implementation review "${block.id}" requires its verification ancestor to depend on every implementation writer`,
    )
  }
  return { implementations: verifiedImplementations, verification }
}

function canonicalWriter(topology: ReviewWriterTopology, blocks: WorkflowBlock[]): WorkflowBlock | undefined {
  return topology.implementations.find((candidate) =>
    topology.implementations.every(
      (other) => other.id === candidate.id || dependsTransitively(blocks, candidate.id, other.id),
    ),
  )
}

function implementationReviewRoute(block: WorkflowBlock, blocks: WorkflowBlock[]) {
  const topology = reviewWriterTopology(block, blocks)
  if (!topology) return undefined
  const implementation = canonicalWriter(topology, blocks)
  if (!implementation) {
    // Unreachable for compiled graphs: aggregateParallelWriters injects an
    // aggregator whenever no canonical writer exists.
    throw new Error(`Implementation review "${block.id}" has no canonical serialized implementation writer`)
  }
  return { implementation, verification: topology.verification }
}

function dependsTransitively(
  blocks: WorkflowBlock[],
  blockID: string,
  dependencyID: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(blockID)) return false
  const dependencies = blocks.find((block) => block.id === blockID)?.depends_on ?? []
  if (dependencies.includes(dependencyID)) return true
  const nextVisited = new Set([...visited, blockID])
  return dependencies.some((dependency) => dependsTransitively(blocks, dependency, dependencyID, nextVisited))
}

function uniqueDuplicates(values: string[]) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function topologicalBlocks(blocks: WorkflowBlock[]) {
  const blockIDs = new Set(blocks.map((block) => block.id))
  const ordered: WorkflowBlock[] = []
  const remaining = new Map(
    blocks.map((block) => [
      block.id,
      new Set((block.depends_on ?? []).filter((dependency) => blockIDs.has(dependency))),
    ]),
  )
  while (remaining.size > 0) {
    const ready = blocks.filter((block) => remaining.get(block.id)?.size === 0)
    if (ready.length === 0) {
      throw new Error(`Block workflow contains a dependency cycle involving: ${[...remaining.keys()].join(", ")}`)
    }
    ready.forEach((block) => remaining.delete(block.id))
    remaining.forEach((dependencies) => ready.forEach((block) => dependencies.delete(block.id)))
    ordered.push(...ready)
  }
  return ordered
}

export * as DagBlocks from "./blocks"
