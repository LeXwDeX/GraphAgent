// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"

/** Right-hand information shown by the top bar. Empty parts are omitted. */
export type TopBarRight = {
  model?: string
  reasoning?: string
  context?: string
}

export type TopBarProps = {
  /** Session title after the `›` separator. */
  path?: string
  right?: TopBarRight
}

/** Below this terminal width the model name and context usage are hidden. */
export const TOP_BAR_WIDE_WIDTH = 100

const PADDING = 2
const GAP = 2
const MARK = "GraphAgent"
const MARK_PREFIX = `◇─◆ ${MARK}`
const PATH_SEPARATOR = " › "
const PART_SEPARATOR = " · "

export function TopBar(props: TopBarProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const width = () => dimensions().width

  const layout = createMemo(() => {
    const aw = ambiguousWidth()
    const inner = Math.max(1, width() - PADDING)
    const markWidth = cellWidth(MARK_PREFIX, aw)
    const wide = width() >= TOP_BAR_WIDE_WIDTH
    const value = props.right

    const parts = [
      { key: "model", text: value?.model, wide: true },
      { key: "reasoning", text: value?.reasoning, wide: false },
      { key: "context", text: value?.context, wide: true },
    ].filter((part) => Boolean(part.text))

    const included = new Set(parts.filter((part) => wide || !part.wide).map((part) => part.key))
    const visible = () => parts.filter((part) => included.has(part.key)).map((part) => part.text!)
    const maxRight = Math.max(0, inner - markWidth - GAP)

    while (visible().length > 0 && cellWidth(visible().join(PART_SEPARATOR), aw) > maxRight) {
      if (included.has("model")) included.delete("model")
      else if (included.has("context")) included.delete("context")
      else break
    }

    let right = visible().join(PART_SEPARATOR)
    if (cellWidth(right, aw) > maxRight) right = truncateCells(right, maxRight, aw)

    const content = inner - (right ? cellWidth(right, aw) + GAP : 0)
    const pathBudget = content - markWidth - cellWidth(PATH_SEPARATOR, aw)
    const path = props.path && pathBudget > 0 ? truncateCells(props.path, pathBudget, aw) : undefined
    const left = MARK_PREFIX + (path ? PATH_SEPARATOR + path : "")
    const gap = right ? Math.max(GAP, inner - cellWidth(left, aw) - cellWidth(right, aw)) : 0

    return {
      right,
      path: path || undefined,
      gap,
    }
  })

  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text wrapMode="none">
        <span style={{ fg: theme.textMuted }}>◇─</span>
        <span style={{ fg: theme.primary }}>◆</span>
        <span> </span>
        <b>{MARK}</b>
        <Show when={layout().path}>
          <span style={{ fg: theme.textMuted }}>{PATH_SEPARATOR}</span>
          <span style={{ fg: theme.text }}>{layout().path}</span>
        </Show>
      </text>
      <Show when={layout().right}>
        <box width={layout().gap} flexShrink={0} />
        <text fg={theme.textMuted} wrapMode="none">
          {layout().right}
        </text>
      </Show>
    </box>
  )
}
