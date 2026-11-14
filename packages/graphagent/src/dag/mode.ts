// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-level DAG mode state (Issue #1013 / #1031 M1).
 *
 * The mode lives on the session row (`dagMode`) so it survives a process
 * restart; the model-facing state lives in a runtime-context slot, which is
 * process memory only. `set` writes both, and the request builder re-derives
 * the slot from the row because a restarted process starts with an empty
 * registry. It reads the live row (`DagModeReader.durableMode`) rather than the
 * turn loop's snapshot, since `/dag-mode` can run inside an active turn.
 */
import type { DagMode as DagModeType } from "@graphagent/schema/dag-mode"
import { EngineProcess } from "@/session/engine-process"
import type { RuntimeSlots } from "@/session/runtime-slots"
import type { SessionID } from "@/session/schema"

export const KEY = "dag_mode"

const ON_TEXT = [
  "<dag_mode>",
  "DAG mode is on for this session. The main agent may start workflows when the task benefits from parallel or staged work; every node spends tokens.",
  "</dag_mode>",
].join("\n")

export const CLEARED =
  "DAG mode is off for this session; the main agent starts a workflow only when the user explicitly asks for one."

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
  if (input.parentID) return "off"
  return input.explicit ?? input.global?.mode ?? "off"
}

/** The runtime-context slot for one mode. Off clears a previously sent block. */
export function slot(mode: DagModeType): RuntimeSlots.Slot {
  return {
    key: KEY,
    parts: mode === "on" ? [ON_TEXT] : [],
    cleared: CLEARED,
  }
}

/** Publish the mode to the model for this process. */
export function set(sessionID: SessionID, mode: DagModeType): void {
  EngineProcess.runtimes.runtimeSlots.set(sessionID, KEY, slot(mode))
}

/**
 * Re-derive the slot from a session snapshot. Idempotent and cheap, but a
 * snapshot goes stale while a turn runs; request building reads the live row
 * through `DagModeReader.durableMode` instead.
 */
export function ensure(session: { readonly id: SessionID; readonly dagMode?: DagModeType }): void {
  set(session.id, get(session))
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
    case "budget":
      return `本会话 DAG 预算已设为 ${shown(values.N)} token。`
    default:
      return ""
  }
}

export * as DagMode from "./mode"