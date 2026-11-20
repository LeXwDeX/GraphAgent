// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { subagentMarkerToken } from "../session/subagents"
import { GUTTER, NARROW_WIDTH, contentWidth } from "../ui/layout"
import { cellWidth, truncateCells, truncateCellsLeft, type AmbiguousWidth } from "../ui/width"
import { remoteLine } from "../util/remote-text"
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
  /** Working directory, with the home directory written `~`; shown after the mark, before the title (#1674). */
  directory?: string
  /** Branch of `directory`, in parentheses after it. It is the first thing to give way when the row is short. */
  branch?: string
  /** Replaces `path` and `directory` while a sub-agent is viewed. */
  subagent?: TopBarSubagent
  /** Shown on the right of a sub-agent view, with the keys that move it unless it is the only one. */
  position?: TopBarPosition
  right?: TopBarRight
}

const GAP = 2
const MARK = "GraphAgent"
const MARK_PREFIX = `◇─◆ ${MARK}`
const PART_SEPARATOR = " · "
const POSITION_GAP = "  "
/** Between the mark and the directory. */
const LOCATION_GAP = "  "
const BRANCH_OPEN = " ("
const BRANCH_CLOSE = ")"
/** Stands in front of the levels of a directory that was cut from its left. */
const CUT = "…"

/** The position text and the keys that move it within `budget` cells; the keys are the first to go. */
function positionBlock(position: TopBarPosition | undefined, budget: number, ambiguousWidth: AmbiguousWidth) {
  if (!position || budget <= 0) return undefined
  const text = t("subagent.position", { index: position.index, total: position.total })
  const keys = position.total > 1 ? SUBAGENT_SWITCH_KEYS : ""
  if (keys && cellWidth(text + POSITION_GAP + keys, ambiguousWidth) <= budget) return { text, keys }
  const shown = truncateCells(text, budget, ambiguousWidth)
  return shown ? { text: shown, keys: "" } : undefined
}

/**
 * The shapes a directory takes as the bar gets short, the widest first: as it is, then `…/` and its last two levels,
 * then its last level alone. A shape that is not narrower than the one before it is left out, so a path the cut would
 * not shorten is never cut.
 */
export function directoryForms(directory: string, ambiguousWidth: AmbiguousWidth): string[] {
  const levels = directory.split(/[\\/]+/).filter((level) => level !== "")
  const separator = /[\\/]/.exec(directory)?.[0] ?? "/"
  const forms = [directory]
  const add = (form: string) => {
    if (cellWidth(form, ambiguousWidth) < cellWidth(forms[forms.length - 1], ambiguousWidth)) forms.push(form)
  }
  if (levels.length > 2) add(CUT + separator + levels.slice(-2).join(separator))
  if (levels.length > 1) add(levels[levels.length - 1])
  return forms
}

type LeftFit = {
  directory?: string
  branch?: string
  title?: string
  /** The model name has to give way too, because nothing before it left the title its room. */
  dropModel: boolean
}

/**
 * What follows the mark at the left of the bar, given the cells that are left beside the right-hand details with the
 * model name kept (`room.kept`) and without it (`room.dropped`). Things give way in this order, and a step is taken
 * only when the ones before it did not make the row fit: the branch, the directory to `…/` and its last two levels,
 * the directory to its last level, the model name, the title (cut with `…`, and gone when not one cell is left for it).
 * The title and the context usage on the right are the last to go. Where the title is gone and the directory still does
 * not fit, the directory is cut from its left, which keeps the level that tells one project from another.
 */
function fitLeft(input: {
  directory?: string
  branch?: string
  title?: string
  room: { kept: number; dropped: number }
  ambiguousWidth: AmbiguousWidth
}): LeftFit {
  const aw = input.ambiguousWidth
  const width = (text: string) => cellWidth(text, aw)
  const titleWidth = input.title ? width(PATH_SEPARATOR + input.title) : 0

  type Step = { directory?: string; branch?: string }
  const forms = input.directory ? directoryForms(input.directory, aw) : []
  const steps: Step[] = forms.length > 0 ? [{ directory: forms[0], branch: input.branch }] : [{}]
  if (forms.length > 0 && input.branch) steps.push({ directory: forms[0] })
  for (const form of forms.slice(1)) steps.push({ directory: form })
  const stepWidth = (step: Step) => (step.directory ? width(directoryText(step.directory, step.branch)) : 0)

  for (const step of steps) {
    if (stepWidth(step) + titleWidth <= input.room.kept) return { ...step, title: input.title, dropModel: false }
  }
  const last = steps[steps.length - 1]
  const lastWidth = stepWidth(last)
  if (lastWidth + titleWidth <= input.room.dropped) return { ...last, title: input.title, dropModel: true }

  const titleRoom = input.room.dropped - lastWidth - width(PATH_SEPARATOR)
  const title = input.title && titleRoom > 0 ? truncateCells(input.title, titleRoom, aw) : ""
  if (title || !last.directory || lastWidth <= input.room.dropped) {
    return { ...last, title: title || undefined, dropModel: true }
  }
  const directory = truncateCellsLeft(last.directory, input.room.dropped - width(LOCATION_GAP), aw)
  return { directory: directory || undefined, dropModel: true }
}

/** The directory as the bar draws it after the mark, with its branch when it has one. */
function directoryText(directory: string, branch?: string) {
  return LOCATION_GAP + directory + (branch ? BRANCH_OPEN + branch + BRANCH_CLOSE : "")
}

export function TopBar(props: TopBarProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const width = () => dimensions().width

  const layout = createMemo(() => {
    const aw = ambiguousWidth()
    const inner = Math.max(1, contentWidth(width()))
    const markWidth = cellWidth(MARK_PREFIX, aw)
    // Below the narrow breakpoint the model name and context usage are hidden.
    const wide = width() >= NARROW_WIDTH
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

    // The right-hand side with the details in `keys`, and the cells it leaves after the mark.
    const sideOf = (keys: ReadonlySet<string>) => {
      let right = parts
        .filter((part) => keys.has(part.key))
        .map((part) => part.text!)
        .join(PART_SEPARATOR)
      if (cellWidth(right, aw) > partsBudget) right = truncateCells(right, partsBudget, aw)
      const placeGap = right && place ? GAP : 0
      const sideWidth = cellWidth(right, aw) + placeGap + placeWidth
      return { right, placeGap, width: sideWidth, room: inner - (sideWidth > 0 ? sideWidth + GAP : 0) - markWidth }
    }
    const kept = sideOf(included)
    const separatorWidth = cellWidth(PATH_SEPARATOR, aw)

    // A sub-agent view draws its own path and no directory (#1674): the path of its sessions is what says where it is.
    const subpath =
      subagent && kept.room - separatorWidth > 0
        ? layoutSubagentPath({ ...subagent, budget: kept.room - separatorWidth, ambiguousWidth: aw })
        : undefined

    // Otherwise the directory and the title give way by `fitLeft`'s order, and the model name is one of the steps.
    const lean = new Set(included)
    lean.delete("model")
    const directory = subagent || !props.directory ? undefined : remoteLine(props.directory) || undefined
    const branch = directory && props.branch ? remoteLine(props.branch) || undefined : undefined
    const fit = subagent
      ? undefined
      : fitLeft({
          directory,
          branch,
          title: props.path,
          room: { kept: kept.room, dropped: sideOf(lean).room },
          ambiguousWidth: aw,
        })
    const side = fit?.dropModel ? sideOf(lean) : kept
    const location = fit?.directory ? directoryText(fit.directory, fit.branch) : undefined
    const title = fit?.title || undefined

    const leftWidth = subpath
      ? markWidth + separatorWidth + subpath.width
      : markWidth + (location ? cellWidth(location, aw) : 0) + (title ? cellWidth(PATH_SEPARATOR + title, aw) : 0)
    const gap = side.width > 0 ? Math.max(GAP, inner - leftWidth - side.width) : 0

    return {
      right: side.right,
      place,
      placeGap: side.placeGap,
      location,
      path: title,
      subpath,
      gap,
    }
  })

  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={GUTTER} paddingRight={GUTTER}>
      <text wrapMode="none">
        <span style={{ fg: theme.textMuted }}>◇─</span>
        <span style={{ fg: theme.primary }}>◆</span>
        <span> </span>
        <b>{MARK}</b>
        <Show when={layout().location}>
          <span style={{ fg: theme.textMuted }}>{layout().location}</span>
        </Show>
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
