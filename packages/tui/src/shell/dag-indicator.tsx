// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { useTheme } from "../context/theme"
import { t, type MessageKey } from "../i18n"
import { cellWidth, type AmbiguousWidth } from "../ui/width"

/**
 * Footer indicator for the session's DAG mode (#886 3.9). `unavailable` means
 * the mode is on but the main agent cannot start workflows right now.
 */
export type DagIndicatorState = "on" | "off" | "unavailable"

/** Below this terminal width the indicator keeps only its marker glyph. */
export const DAG_INDICATOR_NARROW_WIDTH = 80

type DagIndicatorToken = "primary" | "textDim" | "warning"

const LABEL_KEYS: Record<DagIndicatorState, MessageKey> = {
  on: "dagmode.footer.on",
  off: "dagmode.footer.off",
  unavailable: "dagmode.footer.unavailable",
}

const TOKENS: Record<DagIndicatorState, DagIndicatorToken> = {
  on: "primary",
  off: "textDim",
  unavailable: "warning",
}

/** Theme token that colors the indicator in `state`. Never animated. */
export function dagIndicatorToken(state: DagIndicatorState): DagIndicatorToken {
  return TOKENS[state]
}

/**
 * Footer text for `state`: the translated label, or only its leading marker
 * glyph (`◆` / `◇`) when `compact`.
 */
export function dagIndicatorText(state: DagIndicatorState, compact: boolean): string {
  const label = t(LABEL_KEYS[state])
  return compact ? (Array.from(label)[0] ?? "") : label
}

/** Terminal width where the indicator renders in the compact form. */
export function dagIndicatorCompact(terminalWidth: number): boolean {
  return terminalWidth < DAG_INDICATOR_NARROW_WIDTH
}

/**
 * Footer columns the indicator takes from the left cluster, including the gap
 * that separates it from its neighbor; 0 while it is hidden.
 */
export function dagIndicatorReserve(
  state: DagIndicatorState | undefined,
  terminalWidth: number,
  ambiguousWidth: AmbiguousWidth,
): number {
  if (!state) return 0
  return cellWidth(dagIndicatorText(state, dagIndicatorCompact(terminalWidth)), ambiguousWidth) + 1
}

export type DagIndicatorProps = {
  state: DagIndicatorState
  /** Marker glyph only, for terminals narrower than `DAG_INDICATOR_NARROW_WIDTH`. */
  compact?: boolean
}

/** Static display of the DAG mode: no animation, no timers, no data access. */
export function DagIndicator(props: DagIndicatorProps) {
  const { theme } = useTheme()
  return (
    <text fg={theme[TOKENS[props.state]]} wrapMode="none">
      {dagIndicatorText(props.state, props.compact ?? false)}
    </text>
  )
}
