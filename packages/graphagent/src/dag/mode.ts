// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-level DAG mode state (Issue #1013 / #1031 M1/M2).
 *
 * The mode lives on the session row (`dagMode`) so it survives a process
 * restart; the model-facing state lives in a runtime-context slot, which is
 * process memory only. `set` writes both, and the request builder re-derives
 * the slot from the row because a restarted process starts with an empty
 * registry. It reads the live row (`DagModeReader.durableMode`) rather than the
 * turn loop's snapshot, since `/dag-mode` can run inside an active turn.
 *
 * M2 split the user's choice into three layers: L1 (`SYSTEM`, constant, in the
 * system prompt when the workflow tool is published), L2 (`state`, a runtime
 * slot that follows the live switch, limits and budget) and L3 (`REMINDER`, a
 * note written into the user message once, when the mode turns on).
 */
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { DagMode as DagModeType } from "@graphagent/schema/dag-mode"
import { EngineProcess } from "@/session/engine-process"
import { SessionRole } from "@/session/role"
import type { RuntimeSlots } from "@/session/runtime-slots"
import type { SessionID } from "@/session/schema"
import type { UnavailableReason } from "./mode-status"

export const KEY = "dag_mode"

/**
 * L1: the mechanism and its authorization semantics. Constant for the life of
 * the conversation, so it belongs to the cached system prefix. It enters the
 * system prompt only for a main session whose workflow tool is published;
 * custom agent prompts replace this text, which is why the block cannot stay in
 * `graphagent.txt` (`# DAG workflows` was removed there).
 */
export const SYSTEM = [
  "# DAG workflows",
  "You can run workflows through the workflow tool: dependency graphs of agent nodes with parallel workers, worktree isolation, multi-lens review and arbitration, adversarial skeptics, structured outputs, replanning, and recovery. Nodes report only to you and never ask the user; relay what the user needs to know, and answer node messages with the agent tool. Node permission prompts are never yours to answer. By default they do not reach the user: a node call that matches the safety list is denied with a reason and the node continues, and you are told in the report. Under other user settings a node may wait for the user's approval or be limited to read-only tools; the dag_mode block states the setting when it is not the default. The workflow view in the interface is read-only: when the user asks to change a workflow, check it and act through the workflow tool.",
  "DAG mode is a per-session setting that only the user can change, with a user-only command; the latest dag_mode <runtime_context> block reports it. When it reports ON, follow that block. When it reports OFF, or no dag_mode block is present, start a workflow only when the user explicitly asks, in a message or with /dag-auto. An explicit instruction in the current user message (work directly, or use a workflow) overrides the setting for that request. Never change DAG mode or the DAG budget yourself, by any means.",
  "Load the dag-auto skill before authoring a workflow. Model tiers come from the dag configuration; nodes do not pin models.",
].join("\n")

/** L3: the note a user turn carries when the mode turns on (`SessionReminders.settle`). */
export const REMINDER =
  "[Follow the latest dag_mode context: orchestrate this request unless it is conversational, trivial, or the user asked to work directly for this request.]"

/** L3 cleared note: the turn that finds the mode off says the earlier note no longer applies. */
export const REMINDER_CLEARED = "[The earlier DAG mode note no longer applies: follow the latest dag_mode context.]"

/** L2 cleared block: a session that was switched off announces it once. */
export const CLEARED =
  "DAG mode: OFF. Workflows already running continue: handle their checkpoints and bounded repair within the same workflow to a terminal state; start no successor workflow unless the user asks."

/** The mode a session row reports, defaulting old rows to off. */
export function get(session: { readonly dagMode?: DagModeType }): DagModeType {
  return session.dagMode ?? "off"
}

/**
 * Creation-time resolution: an explicit value wins, then the global config
 * default, then off. A child session always starts off — only a top-level
 * session owns a workflow budget.
 */
export function resolveInitial(input: {
  readonly explicit?: DagModeType
  readonly parentID?: SessionID
  readonly global?: { readonly mode?: DagModeType }
}): DagModeType {
  if (SessionRole.isChild(input)) return "off"
  return input.explicit ?? input.global?.mode ?? "off"
}

/**
 * #1031 M5: the session's live token-budget tier. DagBudget owns the numbers;
 * the request builder merges the cached value into L2 so a warning/exhausted
 * line survives every ordinary turn publication.
 */
export type BudgetTier = "normal" | "warn" | "exhausted"

export interface BudgetState {
  readonly used: number
  readonly cacheRead: number
  readonly budget: number | null
  readonly warnRatio: number
  readonly tier: BudgetTier
}

/**
 * Everything L2 renders. The request builder supplies the live values: the mode
 * from the durable row, the budget from the same row plus the global `dag`
 * config, and availability from the resolved tools, permissions and model.
 */
export interface Snapshot {
  readonly mode: DagModeType
  /** Effective DAG token budget; null means unlimited. */
  readonly budget: number | null
  /** Effective global node concurrency: the scheduler's DAG layer (`dag.concurrency` or its default, bounded by the child pool). */
  readonly concurrency: number
  /** The user's per-workflow node ceiling (`dag.max_total_nodes`, 100 while unset). */
  readonly maxTotalNodes: number
  /** M5 live usage and tier; merged from the process cache when omitted. */
  readonly budgetState?: BudgetState
  readonly unavailable?: UnavailableReason
  /** The `plan` agent may start only read-only workflows. */
  readonly plan?: boolean
  /** A non-interactive run must not decide product questions. */
  readonly noninteractive?: boolean
  /** `dag.permission` (#1324); L2 states a tier other than the default `allow`. */
  readonly permission?: ConfigV1.DagPermission
}

const belts = (input: Snapshot) => [
  "- Run every substantive request as workflows to raise parallelism, collaboration, and review quality. Work directly only for conversational turns, answers already in context, trivial mechanical edits verifiable with one command, commands the user asked to run as given, or when the user asked to work directly for this request; then say why in one short clause.",
  "- Do not ask whether to orchestrate. State the plan in one line (stages, approximate agent count), then start.",
  "- Stage multi-phase work as understand, design, implement, review: one workflow per stage, or one workflow with a reporting checkpoint between stages. Read each stage's result before the next. At most one live workflow per user objective; independent objectives may run in parallel.",
  "- Run independent work in parallel; parallel writers need disjoint write sets or worktree isolation.",
  "- Collaborate: answer node messages promptly with the agent tool, and pass a finding to parallel nodes it affects.",
  "- Add skeptic lanes for risky conclusions. Repeat review rounds until two consecutive rounds raise no new upheld finding.",
  "- Every finding ends fixed, refuted with evidence, or reported to the user as open. The engine appends a coverage-and-truncation section to the delivered report; end your final report with it plus one usage line: \"DAG usage: N nodes, X tokens\" (add \"≈ $Y\" only when pricing is configured).",
  `- Thoroughness outranks token cost within the user's limits: concurrency ${input.concurrency} shared by all sessions, ${input.maxTotalNodes} nodes per workflow, DAG token budget ${input.budget === null ? "unlimited" : `${input.budget} tokens`}. Only the user can raise a limit; never work around one. A successor stage for remaining in-scope work is not a workaround.`,
  "- DAG mode covers orchestration only. Fixes for a review-only request, commits, pushes, releases, product decisions, and new permissions or credentials still need the user.",
  ...(input.plan
    ? [
        "- Plan mode is active: start only read-only workflows (research, design, review). Workflows started earlier keep running; do not add writers to them.",
      ]
    : []),
  ...(input.noninteractive
    ? [
        "- Non-interactive run: do not decide product questions; finish what needs no decision and end with a list of decisions the user must make.",
      ]
    : []),
  "- If a workflow cannot be authored or started, work directly and tell the user this request was not orchestrated, and why.",
  "Load the dag-auto skill for the playbook.",
]

/** M5 budget-tier lines appended to L2 (Issue #1031 §M2 wording). */
function budgetLines(budget: BudgetState | undefined): string[] {
  if (!budget || budget.budget === null || budget.budget <= 0) return []
  if (budget.tier === "exhausted")
    return [
      "DAG token budget exhausted: the engine paused this session's workflows and cancelled their running nodes. Report what is done and missing; only the user can raise the budget; the engine resumes them when it is raised.",
    ]
  if (budget.tier === "warn") {
    const pct = Math.floor((budget.used / budget.budget) * 100)
    return [`DAG token budget: over ${pct}% used. Prefer finishing and reporting over new stages.`]
  }
  return []
}

/**
 * #1324: the user's tier for unattended permissions, stated when it is not the
 * default so the main agent can plan around waits or a read-only tool surface.
 * The default tier adds nothing, which keeps L2 byte for byte as it was (within
 * 2.3 KB); the one line this adds keeps ask and readonly within 2.5 KB.
 */
function permissionLines(permission: Snapshot["permission"]): string[] {
  if (permission === "ask")
    return [
      "Node permissions: ask. Each node edit, command, or MCP call waits for the user's approval; expect waits and keep graphs small.",
    ]
  if (permission === "readonly")
    return [
      "Node permissions: read-only. Nodes cannot edit files, and can run only read-only git and gh queries; plan research and review work only.",
    ]
  return []
}

function onText(input: Snapshot): string {
  if (input.unavailable)
    return `DAG mode: ON but unavailable (${input.unavailable}). Work directly and tell the user once that DAG mode cannot run.`
  return [
    "DAG mode: ON (set by the user for this session).",
    ...belts(input),
    ...budgetLines(input.budgetState),
    ...permissionLines(input.permission),
  ].join("\n")
}

/** L2: the state block for one snapshot. Off clears a previously sent block. */
export function state(input: Snapshot): RuntimeSlots.Slot {
  return {
    key: KEY,
    parts: input.mode === "on" ? [onText(input)] : [],
    cleared: CLEARED,
  }
}

// Process-memory mirrors of the last L2 snapshot and budget tier per session.
// DagBudget rewrites L2 between turns; the request builder (which does not
// read usage itself) merges the cached tier into every fresh snapshot.
const snapshots = new Map<SessionID, Snapshot>()
const budgets = new Map<SessionID, BudgetState>()

/** Publish L2 for this process. */
export function set(sessionID: SessionID, input: Snapshot): void {
  const merged: Snapshot = { ...input, budgetState: input.budgetState ?? budgets.get(sessionID) }
  snapshots.set(sessionID, merged)
  EngineProcess.runtimes.runtimeSlots.set(sessionID, KEY, state(merged))
}

/**
 * Record a budget-tier change and republish L2 when this process already built
 * a snapshot for the session. Without a base snapshot the tier is only cached:
 * the next request merges it before the model sees anything.
 */
export function setBudget(sessionID: SessionID, budget: BudgetState): void {
  budgets.set(sessionID, budget)
  const base = snapshots.get(sessionID)
  if (base) set(sessionID, { ...base, budgetState: budget })
}

/** The last budget tier this process computed for the session, if any. */
export function budgetState(sessionID: SessionID): BudgetState | undefined {
  return budgets.get(sessionID)
}

/**
 * Drop this process's snapshot and budget tier of a session that was deleted for good (#1584); `Session.remove`
 * is the only caller. The two maps otherwise keep one entry for every session that ever ran DAG mode here.
 */
export function forget(sessionID: SessionID): void {
  snapshots.delete(sessionID)
  budgets.delete(sessionID)
}

export type ReceiptKind = "on" | "off" | "status" | "budget"

export type ReceiptValues = Record<string, string | number | boolean | undefined>

export interface ReceiptMetadata {
  readonly command: "dag-mode"
  readonly receipt: {
    readonly kind: ReceiptKind
    readonly values: ReceiptValues
  }
}

/** Metadata of the ignored receipt part; the TUI renders it through i18n. */
export function receipt(kind: ReceiptKind, values: ReceiptValues): ReceiptMetadata {
  return { command: "dag-mode", receipt: { kind, values } }
}

const shown = (value: string | number | boolean | undefined) =>
  value === undefined || value === null || value === "" ? "—" : String(value)

/** Fallback text for clients that do not localize the receipt metadata. */
export function text(kind: ReceiptKind, values: ReceiptValues): string {
  switch (kind) {
    case "on": {
      const parts = [
        `DAG 模式已开启（本会话）；并发上限 ${shown(values.cap)}、节点上限 ${shown(values.nodes)}、token 预算 ${shown(values.budget)}。`,
      ]
      if (values.noBudget) parts.push("当前未设 token 预算。")
      if (values.unavailable) parts.push(`注意：${shown(values.unavailable)}，主 agent 无法启动工作流。`)
      return parts.join(" ")
    }
    case "off":
      return `DAG 模式已关闭；${shown(values.n)} 个运行中的工作流会继续到结束。`
    case "status":
      return `模式 ${shown(values.state)}；新会话默认 ${shown(values.default)}；并发 ${shown(values.running)}/${shown(values.cap)}；节点上限 ${shown(values.nodes)}；token ${shown(values.used)}/${shown(values.budget)}。`
    case "budget": {
      const resumed = typeof values.k === "number" && values.k > 0 ? ` 已恢复 ${values.k} 个工作流。` : ""
      return `本会话 DAG 预算已设为 ${shown(values.N)} token。${resumed}`
    }
    default:
      return ""
  }
}

export * as DagMode from "./mode"