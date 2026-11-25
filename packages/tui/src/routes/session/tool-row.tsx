// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { children, createMemo, createSignal, For, Match, Show, Switch, type Accessor } from "solid-js"
import { BoxRenderable, type RGBA } from "@opentui/core"
import { useRenderer, type JSX } from "@opentui/solid"
import type { ToolPart } from "@graphagent/sdk"
import { Spinner } from "../../component/spinner"
import { useKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { t } from "../../i18n"
import { ROW_INDENT } from "../../ui/layout"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../../ui/width"
import { alwaysSeparate, setPreLayoutSiblingMargin } from "../../util/layout"
import { remoteLine } from "../../util/remote-text"
import { errorDenied, foldHint } from "./fold"

/** How a call stands, which the dot in front of its name tells (#1614). */
export type ToolRowState = "pending" | "running" | "done" | "failed" | "denied" | "waiting"

/**
 * The state of a call from its part. A call that waits for a permission is still pending or running as far as the
 * part knows, but what the reader has to do is answer, so that is what the row says.
 */
export function toolRowState(state: ToolPart["state"], waiting: boolean): ToolRowState {
  if (state.status === "completed") return "done"
  if (state.status === "error") return errorDenied(state.error) ? "denied" : "failed"
  if (waiting) return "waiting"
  return state.status === "running" ? "running" : "pending"
}

/** Cells the dot takes in front of the name: the glyph and a space. */
const DOT_CELLS = 2
/** What opens the line under the call, and the cells it takes, which every line under that line keeps. */
const RESULT_MARK = "  ⎿ "
const RESULT_INDENT = 4
/** What the muted tail of a result line is set off with. */
export const DETAIL_SEPARATOR = " · "
/** Cells the tag keeps off the end of the title, and the action off the end of the result line. */
const TAG_GAP = 2
const ACTION_GAP = 2
/** The result text is cut to leave room for the action, but not below this: the action gives way first. */
const MIN_RESULT_CELLS = 8

export interface ToolRowProps {
  state: ToolRowState
  /** The tool's identifier, in bold; it is the same in every language. */
  name: string
  /** What the call acts on, muted after the name: one line, cut to the room the row has. */
  arg?: string
  /**
   * The line under the call. A string is one line, cut to the room the row has and drawn in the color of the state;
   * anything else is drawn as it comes, wrapped by the room it is given.
   */
  result?: string | JSX.Element
  /** The color of a string `result`, where the state's own is not the one that says it. */
  resultColor?: RGBA
  /** The color of the dot, and of the spinner of a call that runs, where the state's own is not the one that says it. */
  dotColor?: RGBA
  /**
   * What stands at the right end of the first line, dim. It is drawn only whole, with at least two cells between it and
   * the title; a title that leaves it no room is not cut for it, the tag is left out.
   */
  tag?: string
  /** What a running call has printed last: muted, after the result on the same line, and cut to what the result leaves. */
  detail?: string
  /**
   * What a string `result` line ends with, after the result and its `detail`: the `note` set off with ` · `, dim, then
   * the `action` two cells on, muted and in the text color while the pointer is on the row. Each is drawn whole or not
   * at all. The note is drawn only where the result fits whole beside it; the action costs the result a cut, but not
   * below a few cells.
   */
  note?: string
  action?: string
  /**
   * The lines the fold of the call's output leaves out, which the hint under the row counts; 0 when the fold only cuts
   * a long line. Absent when nothing folds, and for a row that opens without saying so: it has no hint.
   */
  hidden?: number
  /**
   * Whether the row is open: its `children` stand under the result line, and, when the row has a hint (`hidden`), the
   * hint under them closes it.
   */
  expanded?: boolean
  /** The binding of `view.expand.toggle`, which the hint names; empty while it is unbound. */
  expandKey?: string
  /** What the open row draws under its result line. */
  children?: JSX.Element
  /** What a click on the row does. A row without one is not clickable, and does not answer the mouse. */
  onClick?: () => void
  /** Whether the row is on screen, which the spinner of a running call asks. */
  visible?: Accessor<boolean>
  /** The content width of the transcript. */
  width: number
}

/**
 * The row of one tool call, as the prototype draws it (#1614): the call on the first line, a dot in the color of its
 * state, the tool's name in bold and what it acts on muted after it; its result on the line under it, behind a `⎿`;
 * and, when the output of the call folds, one more line that counts what the fold leaves out and names the key that
 * opens it. A call that runs has a braille spinner for its dot, which follows the ticker only while the row is on screen.
 *
 * The row draws what it is given and reads no data: the caller says what each state reads, and what a click does.
 * Hovering a row that has a click paints this row's own arg, and the word of its `action`, in the text color and nothing
 * else, so the mouse costs the frame of one row and no store write.
 */
export function ToolRow(props: ToolRowProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  // Cells a line of the row has, after its indent.
  const inner = () => Math.max(1, props.width - ROW_INDENT)
  const resultRoom = () => Math.max(1, inner() - RESULT_INDENT)

  const dot = () => {
    if (props.dotColor) return props.dotColor
    switch (props.state) {
      case "done":
        return theme.success
      case "failed":
      case "denied":
        return theme.error
      case "waiting":
        return theme.warning
      default:
        return theme.textMuted
    }
  }
  const resultFg = () => {
    if (props.resultColor) return props.resultColor
    switch (props.state) {
      case "running":
        return theme.primary
      case "waiting":
        return theme.warning
      case "failed":
      case "denied":
        return theme.error
      case "pending":
        return theme.textMuted
      default:
        return theme.text
    }
  }

  const arg = createMemo(() => {
    if (!props.arg) return ""
    const aw = ambiguousWidth()
    return truncateCells(remoteLine(props.arg), inner() - DOT_CELLS - cellWidth(props.name, aw) - 1, aw)
  })
  // The tag is the first to give way: it needs the whole title to fit with room to spare, and is left out otherwise.
  const tag = createMemo(() => {
    if (!props.tag) return ""
    const aw = ambiguousWidth()
    const title = DOT_CELLS + cellWidth(props.name, aw) + (arg() ? 1 + cellWidth(arg(), aw) : 0)
    const whole = !props.arg || arg() === remoteLine(props.arg)
    return whole && title + TAG_GAP + cellWidth(props.tag, aw) <= inner() ? props.tag : ""
  })

  const result = children(() => props.result)
  // A string result: the line, and what goes after it when there is room: the tail, then the note and the action.
  const line = createMemo(() => {
    const text = result()
    if (typeof text !== "string") return undefined
    const aw = ambiguousWidth()
    const width = (value: string) => cellWidth(value, aw)
    let note = props.note ? DETAIL_SEPARATOR + props.note : ""
    let action = props.action ? " ".repeat(ACTION_GAP) + props.action : ""
    // The action may cost the result a cut, down to a few cells; the note costs it none: it is left out unless the
    // result fits whole beside it.
    if (resultRoom() - width(action) < Math.min(width(text), MIN_RESULT_CELLS)) action = ""
    if (width(text) > resultRoom() - width(note) - width(action)) note = ""
    const room = resultRoom() - width(note) - width(action)
    const head = truncateCells(text, Math.max(1, room), aw)
    if (!props.detail || head !== text) return { head, tail: "", note, action }
    const left = room - width(head) - width(DETAIL_SEPARATOR)
    const tail = left > 1 ? truncateCells(props.detail, left, aw) : ""
    return { head, tail: tail ? DETAIL_SEPARATOR + tail : "", note, action }
  })

  const hint = createMemo(() => {
    if (props.hidden === undefined) return ""
    const text = foldHint({ expanded: Boolean(props.expanded), hidden: props.hidden }, props.expandKey ?? "")
    return truncateCells(text, resultRoom(), ambiguousWidth())
  })

  return (
    <box
      paddingLeft={ROW_INDENT}
      flexShrink={0}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        // A click that ends a selection is not a click on the row.
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      ref={(el: BoxRenderable) => {
        // A row is a block of its own, one line or more: the one after it keeps a blank line from it even before it has a height.
        alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) =>
          previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)) ? 1 : 0,
        )
      }}
    >
      <box flexDirection="row">
        <box width={DOT_CELLS} flexShrink={0}>
          <Switch>
            <Match when={props.state === "running"}>
              <Spinner color={props.dotColor ?? theme.primary} visible={props.visible} />
            </Match>
            <Match when={true}>
              <text fg={dot()}>⏺</text>
            </Match>
          </Switch>
        </box>
        <text fg={theme.text} wrapMode="none">
          <b>{props.name}</b>
          <Show when={arg()}>
            <span style={{ fg: hover() ? theme.text : theme.textMuted }}>{" " + arg()}</span>
          </Show>
        </text>
        <Show when={tag()}>
          <box flexGrow={1} />
          <text fg={theme.textDim} wrapMode="none" flexShrink={0}>
            {tag()}
          </text>
        </Show>
      </box>
      <Show when={result()}>
        <box flexDirection="row">
          <text fg={theme.textDim} wrapMode="none" flexShrink={0}>
            {RESULT_MARK}
          </text>
          <Show
            when={line()}
            fallback={
              <box flexGrow={1} flexShrink={1}>
                {result()}
              </box>
            }
          >
            {(text) => (
              <text fg={resultFg()} wrapMode="none">
                {text().head}
                <Show when={text().tail}>
                  <span style={{ fg: theme.textMuted }}>{text().tail}</span>
                </Show>
                <Show when={text().note}>
                  <span style={{ fg: theme.textDim }}>{text().note}</span>
                </Show>
                <Show when={text().action}>
                  <span style={{ fg: hover() ? theme.text : theme.primary }}>{text().action}</span>
                </Show>
              </text>
            )}
          </Show>
        </box>
      </Show>
      <Show when={props.expanded}>
        <box paddingLeft={RESULT_INDENT}>{props.children}</box>
      </Show>
      <Show when={hint()}>
        <box paddingLeft={RESULT_INDENT}>
          <text fg={theme.textDim} wrapMode="none">
            {hint()}
          </text>
        </box>
      </Show>
    </box>
  )
}

/** The errors a call's diagnostics hold for one file, in words. */
export const diagnosticCount = (errors: number) =>
  t(errors === 1 ? "tool.row.diagnostics.one" : "tool.row.diagnostics.other", { n: errors })

/**
 * What a change did to a file, the line under the call of an edit or of a file of a patch: the lines it added and the
 * lines it removed, in the colors of success and of error, and how many errors the language server found in the file.
 * A count the server did not give is left out, and the others stand as they are.
 */
export function ChangeSummary(props: { additions?: number; deletions?: number; errors: number }) {
  const { theme } = useTheme()
  const counts = createMemo(() => {
    const list: Array<{ text: string; fg: RGBA }> = []
    if (props.additions !== undefined) list.push({ text: "+" + props.additions, fg: theme.success })
    // U+2212, the minus sign, and not the hyphen of a flag.
    if (props.deletions !== undefined) list.push({ text: "\u2212" + props.deletions, fg: theme.error })
    return list
  })
  return (
    <text fg={theme.text} wrapMode="none">
      <For each={counts()}>
        {(count, index) => <span style={{ fg: count.fg }}>{(index() ? " " : "") + count.text}</span>}
      </For>
      <Show when={props.errors > 0}>
        <span style={{ fg: theme.error }}>{DETAIL_SEPARATOR + diagnosticCount(props.errors)}</span>
      </Show>
    </text>
  )
}
