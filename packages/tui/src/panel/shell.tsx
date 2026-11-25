// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { ActiveBinding } from "@opentui/keymap"
import { useTerminalDimensions } from "@opentui/solid"
import { children, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { formatKeyBindings, useKeymapSelector } from "../keymap"
import { FRAME_PADDING, MARK_CELLS, NARROW_WIDTH, panelInnerWidth } from "../ui/layout"
import { selectedAttributes, textAttributes, textFg, textStyle, titleFg } from "../ui/text"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { usePanelHostDepth } from "./host"

export interface PanelTab {
  id: string
  label: string
  badge?: string
}

export interface PanelHint {
  /** Keymap command name; the displayed keys come from the registered bindings. */
  key: string
  /**
   * The command of the opposite direction, when one entry stands for both ("↑↓ select": `key` moves up, `also` moves
   * down; the tab keys write "←→"). The keys of the two sit side by side while they are the arrow keys of one pair, up
   * then down or left then right. Bound to anything else (a rebound key) the two are written as separate entries, each
   * with this label, so a wrong "↑↓" is never drawn.
   */
  also?: string
  label: string
  when?: () => boolean
}

type HintBinding = Pick<ActiveBinding, "sequence">

/** The arrow keys that read as one pair when written side by side, the first one then the second one. */
const ARROW_PAIRS: ReadonlyMap<string, string> = new Map([
  ["up", "down"],
  ["left", "right"],
])

/** A key written as one symbol, such as an arrow: it can run into the next one without a separator. */
const SYMBOL_KEY = /^[^\p{L}\p{N}\s]$/u

/** The name of the key a command is bound to when that is a single unmodified key, however many layers bind it. */
function bareKeyName(bindings: readonly HintBinding[] | undefined): string | undefined {
  let name: string | undefined
  for (const { sequence } of bindings ?? []) {
    const [part] = sequence
    if (sequence.length !== 1 || !part || part.tokenName || part.patternName) return undefined
    const { stroke } = part
    if (stroke.ctrl || stroke.shift || stroke.meta || stroke.super || stroke.hyper) return undefined
    if (name !== undefined && name !== stroke.name) return undefined
    name = stroke.name
  }
  return name
}

/** Writes the keys of a pair side by side: symbols run together ("↑↓", "←→"), key names are told apart ("up/down"). */
export function joinPairKeys(first: string, second: string) {
  return SYMBOL_KEY.test(first) && SYMBOL_KEY.test(second) ? first + second : `${first}/${second}`
}

/**
 * What a hint writes in the hint row, one string for each entry: the keys, then the label. A hint with `also` is one
 * entry while its two commands are bound to the two arrow keys of a pair, two entries otherwise. A command with no
 * binding writes nothing.
 */
export function hintEntries(
  hint: PanelHint,
  bindings: ReadonlyMap<string, readonly HintBinding[]>,
  format: (bindings: readonly HintBinding[] | undefined) => string | undefined,
): string[] {
  const first = bindings.get(hint.key)
  const keys = format(first)
  if (!hint.also) return keys ? [`${keys} ${hint.label}`] : []
  const second = bindings.get(hint.also)
  const alsoKeys = format(second)
  const firstName = bareKeyName(first)
  const secondName = bareKeyName(second)
  if (keys && alsoKeys && firstName && secondName && ARROW_PAIRS.get(firstName) === secondName) {
    return [`${joinPairKeys(keys, alsoKeys)} ${hint.label}`]
  }
  return [keys, alsoKeys].flatMap((text) => (text ? [`${text} ${hint.label}`] : []))
}

export interface PanelShellProps {
  /** Top-left heading. Strings are measured and truncated; JSX is left to flex layout. */
  title: JSX.Element | string
  tabs?: readonly PanelTab[]
  activeTab?: string
  onTab?: (id: string) => void
  /** Top-right muted command name, for example "/config". */
  command?: string
  tone?: "default" | "warning"
  /** Footer hints supplied by the template; the host common close hint is appended. */
  hints: readonly PanelHint[]
  /** Maximum content rows, the filter row included; defaults to `panelMaxRows` of the terminal height. */
  maxRows?: number
  /**
   * The filter input, one row between the title row and the content. It sits outside the scroll area, so it stays where
   * it is however far the content scrolls, and so does the terminal cursor, which is drawn at the focused input: inside
   * the scroll area the input scrolls away and the cursor is left on the screen where it was, above the panel. The row
   * is one of the rows of `maxRows`, the content has the rest. Left out, the panel takes no row for it. It is laid out
   * in a row, so several elements can be given side by side.
   */
  filter?: JSX.Element
  /**
   * One muted line between the content and the hint row, for the explanation of what is selected. It starts under the
   * names of the rows, past their selection mark (`MARK_CELLS`). It sits outside the scroll area, so it stays in view
   * however far the content scrolls. Left out, the panel takes no row for it; an empty string keeps the row, blank, so
   * that a panel whose selection only sometimes has a note keeps its height.
   */
  note?: string
  /** A status color for the note line instead of the T4 secondary; a state, not a level (13.6). */
  noteToken?: "error" | "warning" | "success"
  /**
   * The panel spans the whole terminal, not the content area between the gutters that the bottom zone keeps around
   * a panel (#1671): the fullscreen ask, which sits in a layer of its own.
   */
  fullscreen?: boolean
  /**
   * Receives the content scroll container. Templates use it to reveal the
   * selected row; it is an internal extension of the shared shell.
   */
  scrollRef?: (scroll: ScrollBoxRenderable | undefined) => void
  children: JSX.Element
}

/** Below this width the command and secondary tab information are hidden first. */
export const PANEL_NARROW_WIDTH = NARROW_WIDTH

/** The rows of content a panel shows unless it asks for another number: 45% of the terminal height, 14 at the most. */
export function panelMaxRows(terminalHeight: number) {
  return Math.min(14, Math.floor(terminalHeight * 0.45))
}

/**
 * The cells of text inside a panel's frame, following the terminal: the width `PanelShell` lays its title, note and hint
 * rows out in. A panel that lays out columns of its own (names, states, values) takes the room it has from here, not
 * from the terminal width less a number of its own, so that the shell and the panel cannot disagree on where a line ends
 * (#1672). At least 1. `fullscreen` is the shell's own prop, for a panel that spans the whole terminal. `dimensions` is
 * the terminal size a caller has read already: given, no second `resize` listener is added to the renderer.
 */
export function usePanelInnerWidth(
  options: { fullscreen?: () => boolean | undefined; dimensions?: () => { width: number } } = {},
) {
  const dimensions = options.dimensions ?? useTerminalDimensions()
  return () => Math.max(1, panelInnerWidth(dimensions().width, options.fullscreen?.() === true))
}

const GAP = 2
const TAB_GAP = 2
const TITLE_MIN_WIDTH = 8
const HINT_SEPARATOR = " · "
/** The filter row is one line, and takes one of the rows that `maxRows` allows. */
const FILTER_ROWS = 1

export function PanelShell(props: PanelShellProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const hostDepth = usePanelHostDepth()
  const [contentRows, setContentRows] = createSignal<number>()
  // Resolved once: the elements of the filter are created here, and a second read of the prop would create them again.
  const filter = children(() => props.filter)

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  // The text inside the frame, which the panels that lay out columns of their own take their room from too.
  const innerWidth = usePanelInnerWidth({ dimensions, fullscreen: () => props.fullscreen })
  const maxRows = () => Math.max(1, props.maxRows ?? panelMaxRows(dimensions().height))
  // What the scroll area may take: the rows of the panel, less the filter row when there is one.
  const scrollRows = () => Math.max(1, maxRows() - (filter() ? FILTER_ROWS : 0))
  // The scrollbox fills the remaining main-axis space by default; measuring the
  // content lets the panel hug its rows up to the configured maximum.
  const viewportRows = () => Math.min(scrollRows(), Math.max(1, contentRows() ?? scrollRows()))

  const hints = createMemo<PanelHint[]>(() => {
    const seen = new Set<string>()
    const result: PanelHint[] = []
    for (const hint of props.hints) {
      if (seen.has(hint.key)) continue
      seen.add(hint.key)
      if (hint.also) seen.add(hint.also)
      result.push(hint)
    }
    if (hostDepth > 0 && !seen.has("panel.close")) {
      result.push({ key: "panel.close", label: t("panel.hint.close") })
    }
    return result
  })

  const hintCommands = createMemo(() => hints().flatMap((hint) => (hint.also ? [hint.key, hint.also] : [hint.key])))
  const hintBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({ visibility: "registered", commands: hintCommands() }),
  )
  const hintText = createMemo(() =>
    hints()
      .filter((hint) => hint.when?.() !== false)
      .flatMap((hint) => hintEntries(hint, hintBindings(), (found) => formatKeyBindings(found, tuiConfig)))
      .join(HINT_SEPARATOR),
  )

  const layout = createMemo(() => {
    const aw = ambiguousWidth()
    const inner = innerWidth()
    const narrow = dimensions().width < PANEL_NARROW_WIDTH
    const tabs = props.tabs ?? []
    const activeId = props.activeTab ?? tabs[0]?.id
    const command = narrow ? undefined : props.command
    const commandWidth = command ? cellWidth(command, aw) : 0
    const titleIsString = typeof props.title === "string"
    const titleText = titleIsString ? (props.title as string) : ""
    const titleWidth = titleIsString ? cellWidth(titleText, aw) : 0

    const allTabs = tabs.map((tab) => {
      const active = tab.id === activeId
      const text = active ? `[${tab.label}]` : tab.label
      const badge = narrow ? undefined : tab.badge
      const tabWidth = cellWidth(text, aw) + (badge ? 1 + cellWidth(badge, aw) : 0)
      return { id: tab.id, text, badge, active, width: tabWidth }
    })

    const fullTabsWidth = allTabs.reduce((sum, tab) => sum + TAB_GAP + tab.width, 0)
    const minTitle = titleIsString ? Math.min(titleWidth, TITLE_MIN_WIDTH) : TITLE_MIN_WIDTH
    const tabsBudget = Math.max(0, inner - commandWidth - (command ? GAP : 0) - minTitle)

    let shownTabs = allTabs
    if (fullTabsWidth > tabsBudget) {
      const active = allTabs.find((tab) => tab.active) ?? allTabs[0]
      shownTabs = active
        ? [
            {
              ...active,
              badge: undefined,
              text: truncateCells(active.text, Math.max(0, tabsBudget - TAB_GAP), aw),
            },
          ]
        : []
    }
    const tabsWidth = shownTabs.reduce(
      (sum, tab) => sum + TAB_GAP + cellWidth(tab.text, aw) + (tab.badge ? 1 + cellWidth(tab.badge, aw) : 0),
      0,
    )

    const titleBudget = Math.max(0, inner - tabsWidth - commandWidth - (command ? GAP : 0))
    const title = titleIsString ? truncateCells(titleText, titleBudget, aw) : undefined

    return { title, tabs: shownTabs, command }
  })

  return (
    <box
      width="100%"
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      borderStyle="rounded"
      border={["top", "right", "bottom", "left"]}
      borderColor={props.tone === "warning" ? theme.borderWarning : theme.border}
      paddingLeft={FRAME_PADDING}
      paddingRight={FRAME_PADDING}
    >
      <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        <Show
          when={typeof props.title === "string"}
          fallback={
            <box flexShrink={1} overflow="hidden">
              {props.title}
            </box>
          }
        >
          <text
            flexShrink={1}
            overflow="hidden"
            wrapMode="none"
            fg={titleFg(theme, props.tone)}
            attributes={textAttributes("title")}
          >
            {layout().title}
          </text>
        </Show>
        <For each={layout().tabs}>
          {(tab) => (
            <>
              <text flexShrink={0} wrapMode="none">{`${" ".repeat(TAB_GAP)}`}</text>
              <box
                flexShrink={0}
                height={1}
                backgroundColor={tab.active ? theme.backgroundSelected : undefined}
                onMouseUp={() => props.onTab?.(tab.id)}
              >
                <text
                  flexShrink={0}
                  wrapMode="none"
                  fg={tab.active ? textFg(theme, "title") : textFg(theme, "secondary")}
                  attributes={selectedAttributes(tab.active)}
                >
                  {tab.text}
                  <Show when={tab.badge}>
                    <span style={textStyle(theme, "hint")}> {tab.badge}</span>
                  </Show>
                </text>
              </box>
            </>
          )}
        </For>
        <box flexGrow={1} flexShrink={1} />
        <Show when={layout().command}>
          <text flexShrink={0} wrapMode="none" fg={textFg(theme, "hint")}>
            {layout().command}
          </text>
        </Show>
      </box>
      <Show when={filter()}>
        <box height={FILTER_ROWS} flexShrink={0} flexDirection="row" overflow="hidden">
          {filter()}
        </box>
      </Show>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => props.scrollRef?.(element)}
        width="100%"
        height={viewportRows()}
        maxHeight={scrollRows()}
        flexShrink={0}
        scrollbarOptions={{ visible: false }}
      >
        <box
          width="100%"
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function (this: BoxRenderable) {
            const rows = this.height
            if (rows > 0 && rows !== contentRows()) setContentRows(rows)
          }}
        >
          {props.children}
        </box>
      </scrollbox>
      <Show when={props.note !== undefined}>
        <text
          height={1}
          flexShrink={0}
          fg={props.noteToken ? theme[props.noteToken] : textFg(theme, "secondary")}
          wrapMode="none"
        >
          {`${" ".repeat(MARK_CELLS)}${truncateCells(props.note!, Math.max(0, innerWidth() - MARK_CELLS), ambiguousWidth())}`}
        </text>
      </Show>
      <text height={1} flexShrink={0} fg={textFg(theme, "hint")} wrapMode="none">
        {truncateCells(hintText(), innerWidth(), ambiguousWidth())}
      </text>
    </box>
  )
}
