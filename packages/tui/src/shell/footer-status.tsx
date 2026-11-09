// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useTicker } from "../context/ticker-context"
import { useTheme } from "../context/theme"
import { formatKeySequence, useKeymapSelector, useLeaderActive } from "../keymap"
import { TuiLog } from "../util/log"
import { toastDuration, useToast, type CurrentToast } from "../ui/toast"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"

const STATUS_SUFFIX = " /status"
const TOAST_MIN_BUDGET = 10
/** Room for the agent name, action hint and the gap before the shared slot. */
const LEFT_RESERVE = 28

/**
 * Lists the keys that can follow the leader key while it is pending. The
 * keymap clears the sequence on timeout, which unmounts this hint.
 */
function LeaderPendingKeys() {
  const config = useTuiConfig()
  const { theme } = useTheme()
  const leader = useLeaderActive()
  const active = useKeymapSelector((keymap) => keymap.getActiveKeys({ includeMetadata: true }))
  const keys = createMemo(() => {
    if (!leader()) return []
    const seen = new Set<string>()
    return active().flatMap((item) => {
      const key = formatKeySequence([{ stroke: item.stroke, display: item.display, tokenName: item.tokenName }], config)
      if (!key || seen.has(key)) return []
      seen.add(key)
      return [key]
    })
  })

  return (
    <Show when={keys().length > 0}>
      <text fg={theme.textMuted} wrapMode="none">
        {keys().join("  ")}
      </text>
    </Show>
  )
}

function ToastLine(props: { toast: CurrentToast }) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const budget = () => Math.max(TOAST_MIN_BUDGET, dimensions().width - LEFT_RESERVE)

  const color = () => {
    if (props.toast.level === "success") return theme.success
    if (props.toast.level === "warning") return theme.warning
    if (props.toast.level === "error") return theme.error
    return theme.textMuted
  }

  const truncated = () => cellWidth(props.toast.text, ambiguousWidth()) > budget()

  const label = () => {
    if (!truncated()) return props.toast.text
    const suffixWidth = cellWidth(STATUS_SUFFIX, ambiguousWidth())
    const suffix = props.toast.level === "error" && budget() > suffixWidth + 4 ? STATUS_SUFFIX : ""
    return `${truncateCells(props.toast.text, budget() - cellWidth(suffix, ambiguousWidth()), ambiguousWidth())}${suffix}`
  }

  // The footer is allowed to shorten a message, never to lose it: the full
  // text already sits in the status panel's recent messages, and the log keeps
  // a copy whenever truncation actually happened.
  createEffect(
    on(
      () => [props.toast.id, props.toast.text] as const,
      ([, text]) => {
        if (truncated()) TuiLog.write("warn", "toast text truncated in footer", text)
      },
    ),
  )

  return (
    <text fg={color()} wrapMode="none" onMouseDown={props.toast.onActivate}>
      {label()}
    </text>
  )
}

/**
 * Transient footer content. The right-hand footer position is shared, with the
 * leader hint taking precedence over a toast and hook progress. The footer owns
 * toast timing because it is the only component here inside `TickerProvider`.
 */
export function useFooterStatus(progress?: Accessor<JSX.Element | undefined>): Accessor<JSX.Element | undefined> {
  const toast = useToast()
  const leader = useLeaderActive()
  const ticker = useTicker()

  createEffect(
    on(
      () => [toast.currentToast?.id, toast.currentToast?.text] as const,
      () => {
        const current = toast.currentToast
        if (!current) return
        const cancel = ticker.at(ticker.now() + toastDuration(current), () => toast.dismiss())
        onCleanup(cancel)
      },
    ),
  )

  return createMemo(() => {
    if (leader()) return <LeaderPendingKeys />
    const current = toast.currentToast
    if (current) return <ToastLine toast={current} />
    return progress?.()
  })
}
