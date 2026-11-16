// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * How an external command guard meets an unattended session (#1324 P4).
 *
 * A guard is an ordinary PreToolUse hook in the user's own hooks file. It fires
 * for the tool calls of child sessions like for any other, and early: before
 * the tool's own permission request. What it could not see until now is that
 * the session has nobody to ask, and what it denied never reached the node's
 * report. This module supplies both:
 *
 * - `permissionMode`: the `permission_mode` the tool hooks of an unattended
 *   session are told. Under the `allow` and `readonly` tiers the tier alone
 *   decides what the session does, whatever mode its hook policy holds, so the
 *   hook hears `dontAsk` (no one can be asked, an unsure guard should deny) or
 *   `plan` (read-only). The `ask` tier states nothing of its own: the session's
 *   mode applies as before.
 * - `recordDenial`: a PreToolUse hook's deny of a DAG node's call becomes the
 *   durable `dag.node.safety_denied` event with the fixed rule `HOOK`, next to
 *   the denials of the safety list, so `inspect`, coverage and the wake text
 *   carry it. A task child has no node row and records nothing.
 *
 * GraphAgent bundles no guard, downloads none and names none in code: what sits
 * behind the hook is the user's own.
 */

import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ChildPolicy } from "@/session/child/policy"
import type { SessionID } from "@/session/schema"
import { Database } from "@graphagent/core/database/database"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DateTime, Effect, Option, Schema } from "effect"

/** The rule id a hook's denial carries on `NodeSafetyDenied`. */
export const RULE_ID = "HOOK"

/** What an unattended session's tool hooks are told, or nothing when its own mode stands. */
export type UnattendedMode = "dontAsk" | "plan" | undefined

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const READ_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])

/**
 * The permission key a tool's calls ask under: the file tools share `edit`, the
 * MCP resource tools `read`, and every other tool, an MCP server tool included,
 * is its own key. The permission service derives the same key privately; the
 * test beside this file pins the two together.
 */
export function permissionKey(tool: string): string {
  return EDIT_TOOLS.has(tool) ? "edit" : READ_TOOLS.has(tool) ? "read" : tool
}

/** The event keeps at most 200 characters of the hook's reason; the model reads the whole of it in the tool result. */
function summaryOf(reason: string) {
  return reason.length > 200 ? `${reason.slice(0, 197)}...` : reason
}

/**
 * The run policy of a session under the `dag.permission` tier in force now. The
 * tier is read from the global `dag` section on every call and never cached, so
 * a switch reaches a node that is already running. A session with no active
 * child run (every root session, a finished child) has no policy, and nothing
 * is read for it.
 */
const runPolicyOf = Effect.fnUntraced(function* (sessionID: SessionID) {
  if (Option.isNone(ChildPolicy.subjectOf(sessionID))) return Option.none<ChildPolicy.AskPolicy>()
  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  const tier = config ? ((yield* config.dagGlobal()).permission ?? "allow") : "allow"
  return yield* ChildPolicy.askOf(database?.db)(sessionID, tier)
})

/**
 * The `permission_mode` the tool hooks of `sessionID` are told when the tier decides it. It runs at every tool
 * hook event, and for a root session it ends at the registry lookup, so it carries no span of its own.
 */
export const permissionMode = Effect.fnUntraced(function* (sessionID: SessionID) {
  const run = yield* runPolicyOf(sessionID)
  const mode: UnattendedMode =
    Option.isNone(run) || !run.value.unattended
      ? undefined
      : run.value.mode === "allow"
        ? "dontAsk"
        : run.value.mode === "readonly"
          ? "plan"
          : undefined
  return mode
})

/**
 * Records a PreToolUse hook's deny of one tool call. Only a DAG node has a row
 * to carry it. A failure to record is logged and never changes the verdict: the
 * call stays denied.
 */
export const recordDenial = Effect.fn("HookGuard.recordDenial")(function* (input: {
  readonly sessionID: SessionID
  readonly tool: string
  readonly reason: string
}) {
  const subject = ChildPolicy.subjectOf(input.sessionID)
  if (Option.isNone(subject)) return
  const owner = subject.value.owner
  if (owner.kind !== "dag_node") return
  const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
  // A malformed internal owner must not turn a denial into a defect; the call stays denied, only the row is skipped.
  const dagID = Schema.decodeUnknownOption(DagEvent.DagID)(owner.workflowID)
  if (!events || Option.isNone(dagID)) return
  yield* events
    .publish(DagEvent.NodeSafetyDenied, {
      dagID: dagID.value,
      nodeID: DagEvent.NodeID.make(owner.nodeID),
      attempt: Math.max(0, Math.trunc(owner.attempt)),
      ruleID: RULE_ID,
      permission: permissionKey(input.tool),
      summary: summaryOf(input.reason),
      timestamp: yield* DateTime.now,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("DAG hook denial could not be recorded", { cause })),
    )
})

export * as HookGuard from "./hook-guard"
