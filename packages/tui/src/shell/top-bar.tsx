// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { subagentMarkerToken } from "../session/subagents"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import {
  DESCRIPTION_SEPARATOR,
  PATH_SEPARATOR,
  SUBAGENT_SWITCH_KEYS,
  layoutSubagentPath,
  type SubagentPathPart,
  type SubagentView,
} from "./subagent-path"

/** Right-hand information shown by the top bar. Empty parts are omitted. */
export type TopBarRight = {
  model?: string
  reasoning?: string
  context?: string
}

/** The path of a sub-agent view (#1033 2): the sessions above it, then the sub-agent itself. */
export type TopBarSubagent = SubagentView & {
  /** Opens the session of an ancestor segment when that segment is clicked. */
  onOpen?: (sessionID: string) => void
}

/** Place of the viewed sub-agent among its siblings. */
export type TopBarPosition = {
  index: number
  total: number
}

export type TopBarProps = {
  /** Session title after the `›` separator. */
  path?: string
  /** Replaces `path` while a sub-agent is viewed. */
  subagent?: TopBarSubagent
  /** Shown on the right of a sub-agent view, with the keys that move it unless it is the only one. */
  position?: TopBarPosition
  right?: TopBarRight
}

/** Below this terminal width the model name and context usage are hidden. */
export const TOP_BAR_WIDE_WIDTH = 100

const PADDING = 2
const GAP = 2
const MARK = "GraphAgent"
const MARK_PREFIX = `◇─◆ ${MARK}`
const PART_SEPARATOR = " · "
const POSITION_GAP = "  "

/** The position text and the keys that move it within `budget` cells; the keys are the first to go. */
function positionBlock(position: TopBarPosition | undefined, budget: number, ambiguousWidth: AmbiguousWidth) {
  if (!position || budget <= 0) return undefined
  const text = t("subagent.position", { index: position.index, total: position.total })
  const keys = position.total > 1 ? SUBAGENT_SWITCH_KEYS : ""
  if (keys && cellWidth(text + POSITION_GAP + keys, ambiguousWidth) <= budget) return { text, keys }
  const shown = truncateCells(text, budget, ambiguousWidth)
  return shown ? { text: shown, keys: "" } : undefined
}

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

    // Where the viewer is among the siblings outranks the model details: those give way while it stays.
    const place = positionBlock(props.position, maxRight, aw)
    const placeWidth = place ? cellWidth(place.text + (place.keys ? POSITION_GAP + place.keys : ""), aw) : 0
    const subagent = props.subagent
    // The path of a sub-agent view outranks them too: the model shown here is the user's, not the sub-agent's, so it
    // gets only what is left beside the whole path, and is dropped rather than cut.
    const pathWidth = subagent
      ? (layoutSubagentPath({ ...subagent, budget: Number.MAX_SAFE_INTEGER, ambiguousWidth: aw })?.width ?? 0) +
        cellWidth(PATH_SEPARATOR, aw)
      : 0
    const partsBudget = Math.max(
      0,
      (subagent ? maxRight - pathWidth : maxRight) - (placeWidth > 0 ? placeWidth + GAP : 0),
    )

    while (visible().length > 0 && cellWidth(visible().join(PART_SEPARATOR), aw) > partsBudget) {
      if (included.has("model")) included.delete("model")
      else if (included.has("context")) included.delete("context")
      else if (subagent) included.delete("reasoning")
      else break
    }

    let right = visible().join(PART_SEPARATOR)
    if (cellWidth(right, aw) > partsBudget) right = truncateCells(right, partsBudget, aw)

    const placeGap = right && place ? GAP : 0
    const rightWidth = cellWidth(right, aw) + placeGap + placeWidth
    const content = inner - (rightWidth > 0 ? rightWidth + GAP : 0)
    const pathBudget = content - markWidth - cellWidth(PATH_SEPARATOR, aw)
    const subpath =
      subagent && pathBudget > 0
        ? layoutSubagentPath({ ...subagent, budget: pathBudget, ambiguousWidth: aw })
        : undefined
    const path = !subagent && props.path && pathBudget > 0 ? truncateCells(props.path, pathBudget, aw) : undefined
    const leftWidth = subpath
      ? markWidth + cellWidth(PATH_SEPARATOR, aw) + subpath.width
      : cellWidth(MARK_PREFIX + (path ? PATH_SEPARATOR + path : ""), aw)
    const gap = rightWidth > 0 ? Math.max(GAP, inner - leftWidth - rightWidth) : 0

    return {
      right,
      place,
      placeGap,
      path: path || undefined,
      subpath,
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
      <Show when={layout().subpath}>
        {(subpath) => <SubagentPath parts={subpath().parts} onOpen={props.subagent?.onOpen} />}
      </Show>
      <Show when={layout().right || layout().place}>
        <box width={layout().gap} flexShrink={0} />
        <Show when={layout().right}>
          <text fg={theme.textMuted} wrapMode="none">
            {layout().right}
          </text>
        </Show>
        <Show when={layout().place}>
          {(place) => (
            <>
              <box width={layout().placeGap} flexShrink={0} />
              <text wrapMode="none">
                <span style={{ fg: theme.textMuted }}>{place().text}</span>
                <Show when={place().keys}>
                  <span style={{ fg: theme.textDim }}>{POSITION_GAP + place().keys}</span>
                </Show>
              </text>
            </>
          )}
        </Show>
      </Show>
    </box>
  )
}

/** The segments of a sub-agent path, each after its separator; the ancestors can be clicked to open them. */
function SubagentPath(props: { parts: readonly SubagentPathPart[]; onOpen?: (sessionID: string) => void }) {
  const { theme } = useTheme()
  return (
    <For each={props.parts}>
      {(part) => (
        <>
          <text fg={theme.textMuted} wrapMode="none">
            {PATH_SEPARATOR}
          </text>
          <PathPart part={part} onOpen={props.onOpen} />
        </>
      )}
    </For>
  )
}

/** One segment. A part is fixed for the life of its node: a new layout makes new parts. */
function PathPart(props: { part: SubagentPathPart; onOpen?: (sessionID: string) => void }) {
  const { theme } = useTheme()
  const part = props.part
  if (part.type === "ancestor") {
    const id = part.id
    return (
      <text fg={theme.text} wrapMode="none" onMouseUp={() => props.onOpen?.(id)}>
        {part.text}
      </text>
    )
  }
  if (part.type === "fold") {
    return (
      <text fg={theme.textDim} wrapMode="none">
        {part.text}
      </text>
    )
  }
  return (
    <text fg={theme.text} wrapMode="none">
      <Show when={part.marker}>
        {(marker) => <span style={{ fg: theme[subagentMarkerToken(marker())] }}>{part.glyph}</span>}
      </Show>
      <b>{part.kind}</b>
      <Show when={part.description}>
        <span style={{ fg: theme.textMuted }}>{DESCRIPTION_SEPARATOR + part.description}</span>
      </Show>
      <Show when={part.tag}>
        <span style={{ fg: theme.textMuted }}>{DESCRIPTION_SEPARATOR + part.tag}</span>
      </Show>
    </text>
  )
}
