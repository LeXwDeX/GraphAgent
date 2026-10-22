// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

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
      "{ timeout_ms } — bounds the node from admission to completion; queue wait counts toward the budget and an expired queued node fails without spawning. A running node that exceeds it escalates to the parent for adjudication (capped deadline extensions) before failing. Overrides config.node_defaults.worker_config",
  }),
  required: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether failure is terminal. Decision and verification blocks default to true; volume blocks to false",
  }),
  report_to_parent: Schema.optional(Schema.Boolean).annotate({
    description: "Override wake behavior. Review decisions, synthesis, and a review route's verification gate report by default",
  }),
  fan_out: Schema.optional(Schema.String).annotate({
    description:
      "(coding only) Plan block ID in depends_on whose work packages fan this writer out at runtime: two or more disjoint packages run as parallel writers joined by an implementation aggregator under this block's ID; fewer packages run this writer unchanged",
  }),
}) {}

export interface WorkflowBlockGraph {
  objective: string
  blocks: WorkflowBlock[]
}

export interface WorkflowBlockCompileOptions {
  known_dependencies?: string[]
}

const GENERAL_VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "required_actions"],
  properties: {
    verdict: {
      type: "string",
      enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"],
    },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array" },
  },
} as const

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
  required: ["verdict", "implementation_fingerprint", "summary", "findings", "required_actions"],
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
    implementation_fingerprint: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array" },
  },
} as const

const WRITER_KINDS = new Set<WorkflowBlockKind>(["coding", "prototype"])

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
  const { blocks, aggregations, verifyAggregators } = aggregateParallelWriters(graph.blocks)
  const reportingVerifications = reviewRouteVerificationGates(blocks, aggregations)
  const nodes = blocks.flatMap((block) =>
    compileBlock(graph.objective, block, blocks, aggregations, verifyAggregators, reportingVerifications),
  )
  const duplicateNodeIDs = uniqueDuplicates(nodes.map((node) => node.id))
  if (duplicateNodeIDs.length > 0) {
    throw new Error(
      `Block expansion creates duplicate node ids: ${duplicateNodeIDs.join(", ")}. Rename the colliding block`,
    )
  }
  return nodes
}

function compileBlock(
  objective: string,
  block: WorkflowBlock,
  blocks: WorkflowBlock[],
  aggregations: Map<string, WriterAggregation>,
  verifyAggregators: Map<string, string[]>,
  reportingVerifications: ReadonlySet<string>,
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
      }),
    ]
  }

  if (block.kind === "review") {
    const aggregation = aggregations.get(block.id)
    const legacyRoute = aggregation ? undefined : implementationReviewRoute(block, blocks)
    const implementationID = aggregation ? aggregation.aggregatorID : legacyRoute?.implementation.id
    const verificationID = aggregation ? aggregation.verificationID : legacyRoute?.verification.id
    const route = implementationID && verificationID ? { implementationID, verificationID } : undefined
    const reviewCondition = route ? `${route.verificationID}.output.verdict == "PASS"` : condition
    const reviewEvidence = route
      ? {
          implementation_changed_files: `${route.implementationID}.output.changed_files`,
          implementation_fingerprint: `${route.implementationID}.output.fingerprint`,
          verification: `${route.verificationID}.output`,
        }
      : undefined
    const lanes = [
      node({
        id: `${block.id}--standards`,
        name: `${block.id}: standards review`,
        workerType: block.worker_type ?? "general",
        dependencies,
        objective,
        instruction: block.instruction,
        contract: `${BLOCK_CONTRACTS.review} Focus on documented repository standards, architecture constraints, correctness, and verification evidence.`,
        required: false,
        reportToParent: false,
        workerConfig: block.worker_config,
        condition: reviewCondition,
        inputMapping: reviewEvidence,
      }),
      node({
        id: `${block.id}--intent`,
        name: `${block.id}: intent review`,
        workerType: block.worker_type ?? "general",
        dependencies,
        objective,
        instruction: block.instruction,
        contract: `${BLOCK_CONTRACTS.review} Focus on the confirmed goal, scope, acceptance criteria, and user-visible behavior.`,
        required: false,
        reportToParent: false,
        workerConfig: block.worker_config,
        condition: reviewCondition,
        inputMapping: reviewEvidence,
      }),
      node({
        id: block.id,
        name: `${block.id}: review decision`,
        workerType: block.worker_type ?? "general",
        dependencies: [`${block.id}--standards`, `${block.id}--intent`, ...(route ? [route.verificationID] : [])],
        objective,
        instruction: block.instruction,
        contract: [
          "Arbitrate the two independent reviews finding by finding.",
          route
            ? "Reject unsupported claims, deduplicate overlaps, and submit ACCEPT or REJECT while echoing the supplied implementation fingerprint exactly."
            : "Reject unsupported claims, deduplicate overlaps, and submit one structured result with verdict ACCEPT, REVISE, REJECT, or BLOCKED.",
          "Use ACCEPT only when no material required action remains.",
        ].join(" "),
        required: block.required ?? true,
        reportToParent: block.report_to_parent ?? true,
        workerConfig: block.worker_config,
        condition: reviewCondition,
        inputMapping: route
          ? {
              ...reviewEvidence,
              standards_review: `${block.id}--standards.output`,
              intent_review: `${block.id}--intent.output`,
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
      }),
    ]
    if (!aggregation) return lanes
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
      }),
      ...lanes,
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
      workerType: block.worker_type ?? workerType(block.kind),
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
    }),
  ]
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
  inputMapping?: Record<string, string>
  review?: NodeConfig["review"]
  outputSchema?: Record<string, unknown>
  /** Overrides the reporting-checkpoint adjudication clause (default: reportToParent). */
  adversarial?: boolean
  fanOut?: string
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
        "Use dependency outputs as evidence and return a concise artifact that downstream blocks can consume. Do not ask the user questions from this child session.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      input: {
        objective: input.objective,
        ...(hasInstruction ? { instruction: instructionText } : {}),
      },
    },
    ...(input.workerConfig ? { worker_config: input.workerConfig } : {}),
    ...(input.condition ? { condition: input.condition } : {}),
    ...(input.inputMapping ? { input_mapping: input.inputMapping } : {}),
    ...(input.review ? { review: input.review } : {}),
    ...(input.outputSchema ? { output_schema: input.outputSchema } : {}),
    ...(input.fanOut ? { fan_out: input.fanOut } : {}),
  }
}

function workerType(kind: WorkflowBlockKind) {
  if (kind === "explore") return "explore"
  if (kind === "plan") return "plan"
  if (kind === "coding" || kind === "prototype") return "build"
  return "general"
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
