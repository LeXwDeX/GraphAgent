// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagNodeTimeout from "./node-timeout"

import { Clock, DateTime, Effect } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import { InvalidTransitionError } from "@graphagent/core/dag/core/types"
import type { DagCommandCore, ID, WorkflowLock } from "./command-core"
import { DEFAULT_WORKFLOW_CONFIG, parseWorkflowConfig } from "./workflow-config"
import type { NodeExecutionAttempt } from "./dag"

/**
 * The node-timeout commands: escalation, the replan re-time and the dedicated
 * parent-facing extension. They run on the one `Core` the layer built, so they
 * see the same services and guards as every other command module.
 */
export const make = (environment: DagCommandCore.Core) =>
  Effect.gen(function* () {
    const { events, store, guardWorkflowNotTerminal, guardNodeAttempt } = environment
    // Timeout escalation publishes no status transition — the node stays
    // RUNNING (see the NodeTimeoutEscalated projector). Only the extension
    // count, seq, and wake flag change.
    //
    // Ticket B (method-A — stale-read suppression): the deadline watcher reads
    // the durable row WITHOUT the workflow lock (spawn.ts readNode). Between
    // that stale snapshot and this command acquiring the lock, a replan's
    // nodeExtendTimeout may have moved the deadline into the future. Escalating
    // then would charge a max_timeout_extensions budget unit for a node that is
    // no longer overdue — a spurious T8 (the cosmetic residue self-documented
    // at loop.ts:870-880). The caller passes the deadline it OBSERVED
    // (node.deadlineMs); this command re-reads the node FRESH under the workflow
    // lock and, when the deadline has moved strictly past the observed value,
    // suppresses the escalation (no publish, no budget increment). Budget only
    // counts a real extension (a deadline that actually moved), not a stale-read
    // cosmetic recount. Suppression returns void, exactly like a publish, so the
    // watcher's self-renewal loop (S1) keeps supervising — a running node is
    // never orphaned (N1). When staleDeadlineMs is omitted (existing callers,
    // test setups) the guard is inert: back-compat is unconditional publish.
    const nodeTimeoutEscalated = Effect.fn("Dag.nodeTimeoutEscalated")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      childSessionID: string,
      timeoutExtensions: number,
      staleDeadlineMs?: number | null,
      attempt?: NodeExecutionAttempt,
    ) {
      const workflow = yield* guardWorkflowNotTerminal(dagID, "timeout escalation")
      if (attempt || staleDeadlineMs != null) {
        const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
        if (!node) return yield* Effect.fail(new InvalidTransitionError(nodeID, "missing", "timeout escalation"))
        yield* guardNodeAttempt(node, workflow.graphRev, attempt)
        if (attempt && node.status !== "running") {
          return yield* Effect.fail(new InvalidTransitionError(nodeID, node.status, "timeout escalation"))
        }
        if (
          staleDeadlineMs != null &&
          node.status === "running" &&
          node.deadlineMs != null &&
          node.deadlineMs > staleDeadlineMs
        )
          return
      }
      yield* events.publish(DagEvent.NodeTimeoutEscalated, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        childSessionID: childSessionID as never,
        timeoutExtensions,
        timestamp: yield* DateTime.now,
      })
    })
    // Adjudication of a timeout escalation (ADR-0003). Replan with a new
    // worker_config.timeout_ms recomputes the absolute deadline and records it
    // as a durable event — the direct-write path (store.updateNodeDeadline) is
    // abolished so the deadline survives replay. The guard runs HERE, in the
    // command layer, holding the workflow lock and BEFORE publish. The return
    // is a synchronous state verdict (error = state — the orchestrator observes
    // it directly, NOT via the publish chain, whose projector return value is
    // discarded). NodeDeadlineExtended is only appended on success, so it is the
    // success log; the projector does a pure idempotent fold. The contract is
    // FOUR-VALUED so the rejection reasons stay distinguishable (C1):
    //   1  = success (deadline written, NodeDeadlineExtended appended)
    //   0  = TERMINAL rejection (node not running / missing — caller drops the
    //        stale watcher; the node is done)
    //  -2  = Q2 delivery-gate rejection (node STILL running but its escalation
    //        wake is undelivered — caller MUST keep supervision; killing the
    //        watcher here would orphan a running node and defeat the cap
    //        backstop, violating N1)
    //  -3  = cumulative timeout-extension cap exhausted; the watcher still
    //        owns the running node and enforces the terminal timeout verdict
    // The single caller (loop.ts WorkflowReplanned handler) branches on this:
    // < 0 keeps the watcher (covers -2 here and -1 write-failure mapped by the
    // caller's catchCause), === 0 clears it. Dag.extendTimeout (the dedicated
    // parent-facing re-time command below) is the second caller: it maps 1 →
    // extended, -2 → escalation_undelivered, -3 → cap_exhausted,
    // 0 → not_running, and needs no
    // watcher swap (the self-healing watcher re-reads the moved deadline). The
    // only typed-error channel beyond this explicit 1/0/-2 is withWorkflowLock
    // (getNode/publish orDie their work).
    const nodeExtendTimeout = Effect.fn("Dag.nodeExtendTimeout")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      newDeadlineMs: number,
      attempt?: NodeExecutionAttempt,
    ) {
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      // running-guard: a node that terminalized between the caller's read and
      // this command is rejected (race-free — we hold the workflow lock).
      if (!node || node.status !== "running") return 0
      if (
        attempt &&
        (node.replanAttempts !== attempt.replanAttempts ||
          (attempt.childSessionID !== undefined && node.childSessionId !== attempt.childSessionID))
      )
        return 0
      // Q2 delivery gate (ADR-0002): never re-time an escalation the main agent
      // has not seen. Defense in depth — the primary gate is loop.ts:800, but
      // the command stays self-protecting so a future caller cannot bypass it.
      // Returns -2 (NOT 0): the node is still running, so the caller must keep
      // its watcher (N1). See the four-valued contract above.
      if (node.escalationPending && !node.wakeReported) return -2
      // The watcher enforces the same cap on its next deadline read. Reject
      // re-timing here under the workflow lock as well: otherwise a delivered
      // escalation at the cap can be moved up to 24 hours into the future.
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return 0
      const maxExtensions =
        parseWorkflowConfig(workflow.config)?.max_timeout_extensions ?? DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions
      if (node.timeoutExtensions >= maxExtensions) return -3
      yield* events.publish(DagEvent.NodeDeadlineExtended, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        deadlineMs: newDeadlineMs,
        timeoutExtensions: node.timeoutExtensions,
        timestamp: yield* DateTime.now,
      })
      return 1
    })

    // P0-A: dedicated parent-facing timeout extension. Grants an escalated
    // RUNNING node more time WITHOUT a full graph replan — the incident chain
    // this replaces forced the parent to resubmit the entire fragment (an
    // envelope-error trap) just to change one number, and a rejected replan then
    // drove a whole-workflow cancel. Reuses the exact durable path the replan
    // re-time uses (nodeExtendTimeout → NodeDeadlineExtended, with its Q2
    // delivery gate and cumulative cap). A formal escalation must be pending
    // and delivered before this command can extend the deadline; an elapsed
    // clock alone is not an adjudication token.
    // Does NOT bump replanAttempts, restart the agent, or touch the graph; the
    // self-healing deadline watcher (spawn.ts) re-reads the moved deadline on its
    // next wake, so supervision is never absent and no watcher swap is needed.
    const extendTimeout = Effect.fn("Dag.extendTimeout")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      timeoutMs: number,
    ) {
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node || node.status !== "running") return { status: "not_running" as const }
      if (!node.escalationPending) return { status: "no_escalation" as const }
      if (!node.wakeReported) return { status: "escalation_undelivered" as const }
      const now = yield* Clock.currentTimeMillis
      const deadlineMs = now + timeoutMs
      const written = yield* nodeExtendTimeout(lock, dagID, nodeID, deadlineMs, {
        replanAttempts: node.replanAttempts,
        ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
      })
      if (written === 1) return { status: "extended" as const, deadlineMs }
      // -2 = Q2 delivery-gate rejection (escalation wake undelivered, node still
      // running); 0 = the node is not running (pending/queued/terminal). Neither
      // grants an extension.
      if (written === -2) return { status: "escalation_undelivered" as const }
      if (written === -3) return { status: "cap_exhausted" as const }
      return { status: "not_running" as const }
    })

    return { nodeTimeoutEscalated, nodeExtendTimeout, extendTimeout }
  })
