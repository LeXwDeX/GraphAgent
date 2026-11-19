// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { NODE_TERMINAL_STATUS_VALUES } from "@graphagent/schema/dag-status"
import { Dag } from "@/dag/dag"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { LiveNode, PriorFinding, PriorRound } from "@/dag/blocks"
import { reviewRoundQuietStreak } from "@/dag/review-lifecycle"
import { normalizeOutput } from "@/dag/runtime/verdict"
import { isRecord } from "@/util/record"
import type { Tool } from "../tool"
import { loadAuthoringSource } from "./files"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

export interface MutationSessionContext {
  readonly directory: string
  readonly projectID: string
  readonly model: { id: string; providerID: string } | undefined
}

/**
 * The review gate the calling session fixes for every workflow it starts: DAG
 * mode on makes it strict whatever the spec's source or declaration, because
 * the mode runs unattended (ADR-0006). `run.start` and every spec action (list,
 * read, validate, draft) spread this into the authoring call, so a spec that
 * validates here is one the start accepts. Mutations never use it: they are
 * checked against the gate their workflow froze at start.
 */
export const sessionReviewGate = (session: { readonly dagMode?: "on" | "off" }) =>
  session.dagMode === "on" ? ({ review_gate: "strict" } as const) : ({} as const)

/** The review loop stops after five rounds, or once two consecutive rounds
 * raise no new upheld finding; the remaining open items are reported instead
 * of starting another round. */
export const MAX_REVIEW_ROUNDS = 5

const record = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = normalizeOutput(value)
  return isRecord(parsed) ? parsed : undefined
}

/**
 * Resolve a review block's prior_round from the referenced workflow's stored
 * outputs (#1031 M6). The reference must name a review decision of a workflow
 * owned by this session. Prior findings are the lane required actions with the
 * prior arbitration's disposition attached; the authoring agent never types
 * them.
 */
export const priorRoundLoader =
  (dag: Dag.Interface, sessionID: string) =>
  (reference: { workflow_id: string; review_id: string }): Effect.Effect<PriorRound, string> =>
    Effect.gen(function* () {
      const workflow = yield* dag.store.getWorkflow(reference.workflow_id).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(`workflow "${reference.workflow_id}" does not exist`)
      if (workflow.sessionId !== sessionID)
        return yield* Effect.fail(`workflow "${reference.workflow_id}" is not owned by this session`)
      const config = Dag.parseWorkflowConfig(workflow.config)
      if (!config) return yield* Effect.fail(`workflow "${reference.workflow_id}" has an unreadable config`)
      const decision = config.nodes.find((node) => node.id === reference.review_id)
      if (!decision) return yield* Effect.fail(`review "${reference.review_id}" is not in workflow ${reference.workflow_id}`)
      const laneIDs = decision.depends_on.filter(
        (dependency) => config.nodes.find((node) => node.id === dependency)?.review_lane !== undefined,
      )
      // prior_round continues a review decision, never an arbitrary completed
      // node. A verification or implementation node has no arbitration
      // record, so accepting it would restart at round 1 with empty findings
      // and silently skip the referenced review's open items and round ceiling.
      if (decision.review_arbitration !== true && decision.review === undefined && laneIDs.length === 0)
        return yield* Effect.fail(
          `review "${reference.review_id}" is not a review decision; prior_round must reference a review block's decision node`,
        )
      const rows = yield* dag.store.getCurrentNodes(reference.workflow_id).pipe(Effect.orDie)
      const decisionRow = rows.find((row) => row.id === reference.review_id)
      const decisionOutput = record(decisionRow?.output)
      if (!decisionRow || decisionRow.status !== "completed" || decisionOutput === undefined)
        return yield* Effect.fail(`review "${reference.review_id}" has no completed structured output`)
      const findings = laneIDs.flatMap((laneID) => {
        const row = rows.find((candidate) => candidate.id === laneID)
        const actions = record(row?.output)?.required_actions
        if (!Array.isArray(actions)) return []
        return actions.map((action, index): PriorFinding => {
          const ref = `${reference.workflow_id}/${laneID}/${index}`
          return {
            ref,
            node: laneID,
            index,
            action: typeof action === "string" ? action : JSON.stringify(action),
          }
        })
      })
      const dispositions = Array.isArray(decisionOutput.dispositions) ? decisionOutput.dispositions : []
      for (const item of dispositions) {
        if (!isRecord(item) || typeof item.node !== "string" || !Number.isInteger(item.index)) continue
        if (item.decision !== "upheld" && item.decision !== "refuted") continue
        const novelty =
          item.novelty === "new"
            ? ("new" as const)
            : isRecord(item.novelty) && typeof item.novelty.dup_of === "string"
              ? { dup_of: item.novelty.dup_of }
              : undefined
        if (!novelty) continue
        const target = findings.find((finding) => finding.node === item.node && finding.index === item.index)
        if (!target) continue
        findings[findings.indexOf(target)] = {
          ...target,
          disposition: {
            novelty,
            decision: item.decision,
            evidence: typeof item.evidence === "string" ? item.evidence : "",
          },
        }
      }
      const round = decision.review_round ?? 1
      // The round's own stored dispositions decide its novelty; the compiled
      // review_quiet_rounds is only the streak the round entered with. A round
      // that predates arbitration dispositions counts its stored lane actions.
      const { newFindings, quietRounds } = reviewRoundQuietStreak(
        decisionOutput,
        decision.review_quiet_rounds ?? 0,
        findings.length,
      )
      // A successor must also inherit the findings this decision left open. A
      // lane that did not re-raise an item does not resolve it; `resolved` is
      // the only authority on it. The stored prior findings keep the original
      // ref and action text, so the next round must still resolve that ref.
      const stillOpen = new Map<string, string>()
      for (const item of Array.isArray(decisionOutput.resolved) ? decisionOutput.resolved : []) {
        if (!isRecord(item) || typeof item.ref !== "string" || item.how !== "still_open") continue
        stillOpen.set(item.ref, typeof item.evidence === "string" ? item.evidence : "")
      }
      for (const finding of decision.prior_findings ?? []) {
        const evidence = stillOpen.get(finding.ref)
        if (evidence === undefined) continue
        findings.push({ ...finding, disposition: { novelty: "new", decision: "upheld", evidence } })
      }
      if (round >= MAX_REVIEW_ROUNDS)
        return yield* Effect.fail(
          `review loop stopped: ${MAX_REVIEW_ROUNDS} rounds reached; report the remaining open findings instead of starting another round`,
        )
      if (quietRounds >= 2)
        return yield* Effect.fail(
          "review loop stopped: two consecutive rounds raised no new upheld finding; report the remaining open findings instead of starting another round",
        )
      return {
        workflow_id: reference.workflow_id,
        review_id: reference.review_id,
        round,
        quiet_rounds: quietRounds,
        new_findings: newFindings,
        findings,
      }
    })

const TERMINAL_NODE_STATUSES: ReadonlySet<string> = new Set(NODE_TERMINAL_STATUS_VALUES)

/** The live workflow's nodes as their persisted definitions, each marked settled
 * or not (#1073). A superseded revision is not part of the graph a fragment
 * attaches to, so only current rows count. */
const liveNodesOf = (dag: Dag.Interface, workflowID: string, config: ReturnType<typeof Dag.parseWorkflowConfig>) =>
  Effect.gen(function* () {
    const rows = yield* dag.store.getCurrentNodes(workflowID).pipe(Effect.orDie)
    const status = new Map(rows.map((row) => [row.id, row.status]))
    return (config?.nodes ?? []).flatMap((definition): LiveNode[] => {
      const current = status.get(definition.id)
      return current === undefined ? [] : [{ definition, terminal: TERMINAL_NODE_STATUSES.has(current) }]
    })
  })

/** Assemble the authoring context shared by extend and replan from a live
 * workflow: its persisted node defaults and workspace, its current node IDs as
 * the known dependency set, and the spec source at `specPath`. An extend also
 * reads the live nodes, so a block that depends on a reporting checkpoint is
 * gated like it would be inside one start document. */
export const prepareMutation = (
  dag: Dag.Interface,
  authoring: Authoring,
  input: {
    readonly action: "extend" | "replan"
    readonly workflow: { readonly id: string; readonly config: string }
    readonly specPath: string
    readonly sessionID: string
    readonly session: MutationSessionContext
    readonly ctx: Tool.Context
  },
) =>
  Effect.gen(function* () {
    const workflowConfig = Dag.parseWorkflowConfig(input.workflow.config)
    const knownDependencies = (yield* dag.store.getNodes(input.workflow.id).pipe(Effect.orDie)).map((node) => node.id)
    const source = yield* loadAuthoringSource(
      input.specPath,
      input.session.directory,
      input.session.projectID,
      input.ctx,
    ).pipe(Effect.orDie)
    // A fragment is validated under the workflow's frozen review gate, never
    // the current session mode: switching DAG mode after start must not change
    // the gate level of a live workflow.
    const reviewGate = workflowConfig?.review_gate ?? (workflowConfig?.mode === "deep" ? "strict" : undefined)
    const liveNodes = input.action === "extend" ? yield* liveNodesOf(dag, input.workflow.id, workflowConfig) : undefined
    return yield* authoring.prepare({
      action: input.action,
      source,
      profile: "environment",
      environment: { directory: input.session.directory, parent: input.session.model },
      executionWorkspace: workflowConfig?.workspace,
      known_dependencies: knownDependencies,
      node_defaults: workflowConfig?.node_defaults,
      ...(reviewGate !== undefined ? { review_gate: reviewGate } : {}),
      ...(workflowConfig?.acceptance !== undefined ? { acceptance: workflowConfig.acceptance } : {}),
      prior_rounds: priorRoundLoader(dag, input.sessionID),
      ...(liveNodes !== undefined ? { live_nodes: liveNodes } : {}),
    })
  })
