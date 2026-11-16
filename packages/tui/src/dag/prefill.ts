// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Request templates for the main agent (#1032 4, 7.3). The `/dag` panel controls
 * nothing: when the user wants to step in, it fills one of these into the main
 * session's input. The user reads it, edits it and sends it, and the main agent
 * checks the workflow and acts through its workflow tool. Which templates are
 * offered follows what the display shows and only spares useless requests; it is
 * no permission check. Pure: the text is made with `t()`, the landing in the
 * input is `session/prefill.ts`.
 */

import { t, type MessageKey } from "../i18n"
import { remoteLine } from "../util/remote-text"
import { dagDisplayState, type DagNodeRow, type DagWorkflowSummary } from "./model"

export type DagRequestKind =
  /** Check the workflow and report. */
  | "inspect"
  /** Workflow level. */
  | "pause"
  | "resume"
  | "cancel"
  /** Node level, needs a selected node. */
  | "retry"
  | "cancel-node"
  | "extend-timeout"
  | "relay"
  /** DAG mode. */
  | "coverage"
  | "audit"
  | "narrow"
  | "cancel-all"

export interface DagRequestContext {
  readonly workflow: DagWorkflowSummary
  /** The selected node, for the node-level templates. */
  readonly node?: Pick<DagNodeRow, "name" | "status" | "error_class">
  /** Every workflow of the session tree; `cancel-all` is offered when one of them runs. Defaults to just `workflow`. */
  readonly workflows?: readonly DagWorkflowSummary[]
}

/** Workflow statuses in which work is being done. */
const RUNNING = new Set(["running", "stepping"])
/** Workflow statuses the main agent has not finished with. */
const ACTIVE = new Set(["running", "stepping", "paused"])

/**
 * The templates the display state offers, in a fixed order: the check, the
 * workflow-level ones, the node-level ones, then the DAG-mode ones.
 */
export function dagRequestKinds(ctx: DagRequestContext): readonly DagRequestKind[] {
  const { workflow, node } = ctx
  const kinds: DagRequestKind[] = ["inspect"]
  if (RUNNING.has(workflow.status)) kinds.push("pause")
  if (workflow.status === "paused") kinds.push("resume")
  if (ACTIVE.has(workflow.status)) kinds.push("cancel")
  if (node) {
    const state = dagDisplayState(node.status, node.error_class)
    if (state === "failed") kinds.push("retry")
    if (state === "running" || state === "queued" || state === "pending") kinds.push("cancel-node")
    // Only a node that is running has a timeout to extend and an agent to tell something.
    if (state === "running") kinds.push("extend-timeout", "relay")
  }
  if ((workflow.coverageCount ?? 0) > 0) kinds.push("coverage")
  kinds.push("audit", "narrow")
  if ((ctx.workflows ?? [workflow]).some((each) => RUNNING.has(each.status))) kinds.push("cancel-all")
  return kinds
}

const TEXT_KEYS: Record<DagRequestKind, MessageKey> = {
  inspect: "dagmode.prefill.inspect",
  pause: "dagmode.prefill.pause",
  resume: "dagmode.prefill.resume",
  cancel: "dagmode.prefill.cancel",
  retry: "dagmode.prefill.retry",
  "cancel-node": "dagmode.prefill.cancelNode",
  "extend-timeout": "dagmode.prefill.extendTimeout",
  relay: "dagmode.prefill.relay",
  coverage: "dagmode.prefill.coverage",
  audit: "dagmode.prefill.audit",
  narrow: "dagmode.prefill.narrow",
  "cancel-all": "dagmode.prefill.cancelAll",
}

const LABEL_KEYS: Record<DagRequestKind, MessageKey> = {
  inspect: "dagmode.prefill.inspect.label",
  pause: "dagmode.prefill.pause.label",
  resume: "dagmode.prefill.resume.label",
  cancel: "dagmode.prefill.cancel.label",
  retry: "dagmode.prefill.retry.label",
  "cancel-node": "dagmode.prefill.cancelNode.label",
  "extend-timeout": "dagmode.prefill.extendTimeout.label",
  relay: "dagmode.prefill.relay.label",
  coverage: "dagmode.prefill.coverage.label",
  audit: "dagmode.prefill.audit.label",
  narrow: "dagmode.prefill.narrow.label",
  "cancel-all": "dagmode.prefill.cancelAll.label",
}

const NODE_KINDS: ReadonlySet<DagRequestKind> = new Set(["retry", "cancel-node", "extend-timeout", "relay"])

/**
 * The text a template puts in the input, in the interface language. Names come
 * from the server and are cleaned of escapes and line breaks first. `relay` and
 * `narrow` stop at a colon where the user goes on writing. A node-level template
 * without a node comes back empty rather than naming nobody.
 */
export function dagRequestText(kind: DagRequestKind, ctx: DagRequestContext): string {
  if (NODE_KINDS.has(kind) && !ctx.node) return ""
  return t(TEXT_KEYS[kind], {
    title: remoteLine(ctx.workflow.title),
    id: remoteLine(ctx.workflow.id),
    name: ctx.node ? remoteLine(ctx.node.name) : "",
  })
}

/** A short name for a template, for the list the user picks from. */
export function dagRequestLabel(kind: DagRequestKind, ctx: DagRequestContext): string {
  return t(LABEL_KEYS[kind], { name: ctx.node ? remoteLine(ctx.node.name) : "" })
}
