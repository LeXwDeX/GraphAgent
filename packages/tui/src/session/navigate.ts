// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionStatus } from "@graphagent/sdk"
import { useRoute, type Route } from "../context/route"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import { useToast, type ToastOptions } from "../ui/toast"
import { remoteLine } from "../util/remote-text"

interface NavigateRoute {
  navigate(route: Route): void
}

interface NavigateSync {
  readonly data: { readonly session_status: Readonly<Record<string, SessionStatus | undefined>> }
}

interface NavigateToast {
  show(options: ToastOptions): void
}

export interface OpenSubAgentInput {
  route: NavigateRoute
  sync: NavigateSync
  toast: NavigateToast
}

/**
 * The one way into a sub-agent session: the Task row, a DAG node, `<leader>down` and the sibling keys all call it.
 * It moves the route and, when that session is retrying, says why in the footer. Registering interest and loading
 * the snapshot belong to the session route, which does both (in that order) whenever its session id changes.
 */
export function openSubAgent(sessionID: string, input: OpenSubAgentInput): void {
  const status = input.sync.data.session_status[sessionID]
  input.route.navigate({ type: "session", sessionID })
  if (status?.type !== "retry") return
  input.toast.show({
    text: t("subagent.retry", { message: remoteLine(status.message) }),
    level: "warning",
    dedupeKey: "subagent.retry",
  })
}

/** Context-bound `openSubAgent`; call in component setup. */
export function useOpenSubAgent() {
  const route = useRoute()
  const sync = useSync()
  const toast = useToast()
  return (sessionID: string) => openSubAgent(sessionID, { route, sync, toast })
}

/** Why a sub-agent session can no longer be shown. */
export type SubAgentLoss =
  /** The server has no such session. */
  | { kind: "notFound" }
  /** It was deleted while it was on screen. */
  | { kind: "deleted" }
  /** Loading it failed; `message` is the error as the server or the transport reported it. */
  | { kind: "failed"; message: string }

export interface ReturnToParentInput {
  route: NavigateRoute
  toast: NavigateToast
}

const LOSS_TOAST_MS = 5_000

/**
 * A sub-agent session that is gone takes the user back to its parent session, where it was started from, and says so
 * in the footer. Home is for sessions without a parent; the callers keep that case as it was.
 */
export function returnToParent(parentID: string, loss: SubAgentLoss, input: ReturnToParentInput): void {
  input.route.navigate({ type: "session", sessionID: parentID })
  if (loss.kind === "deleted") {
    input.toast.show({ text: t("subagent.deleted"), level: "info", dedupeKey: "subagent.unavailable" })
    return
  }
  input.toast.show({
    text:
      loss.kind === "failed" ? t("subagent.loadFailed", { message: remoteLine(loss.message) }) : t("subagent.notFound"),
    level: "error",
    duration: LOSS_TOAST_MS,
    dedupeKey: "subagent.unavailable",
  })
}
