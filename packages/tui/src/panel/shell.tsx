// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import type { ActiveBinding } from "@opentui/keymap"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { formatKeyBindings, useKeymapSelector } from "../keymap"
import { NARROW_WIDTH, contentWidth, framedInnerWidth } from "../ui/layout"
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
  /** Maximum content rows; defaults to `panelMaxRows` of the terminal height. */
  maxRows?: number
  /**
   * One muted line between the content and the hint row, for the explanation of what is selected. It sits outside the
   * scroll area, so it stays in view however far the content scrolls. Left out, the panel takes no row for it; an empty
   * string keeps the row, blank, so that a panel whose selection only sometimes has a note keeps its height.
   */
  note?: string
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

const GAP = 2
const TAB_GAP = 2
const TITLE_MIN_WIDTH = 8
const HINT_SEPARATOR = " · "
/** The note starts under the names of the rows, past the two-cell selection marker. */
const NOTE_INDENT = 2

export function PanelShell(props: PanelShellProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const hostDepth = usePanelHostDepth()
  const [contentRows, setContentRows] = createSignal<number>()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  // The cells the frame spans, and inside it the text: the border and the padding come off both sides.
  const frameWidth = () => (props.fullscreen ? dimensions().width : contentWidth(dimensions().width))
  const innerWidth = () => Math.max(1, framedInnerWidth(frameWidth()))
  const maxRows = () => Math.max(1, props.maxRows ?? panelMaxRows(dimensions().height))
  // The scrollbox fills the remaining main-axis space by default; measuring the
  // content lets the panel hug its rows up to the configured maximum.
  const viewportRows = () => Math.min(maxRows(), Math.max(1, contentRows() ?? maxRows()))

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

  const titleColor = () => (props.tone === "warning" ? theme.warning : theme.primary)

  return (
    <box
      width="100%"
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      borderStyle="rounded"
      border={["top", "right", "bottom", "left"]}
      borderColor={props.tone === "warning" ? theme.borderWarning : theme.border}
      paddingLeft={1}
      paddingRight={1}
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
          <text flexShrink={1} overflow="hidden" wrapMode="none" fg={titleColor()} attributes={TextAttributes.BOLD}>
            {layout().title}
          </text>
        </Show>
        <For each={layout().tabs}>
          {(tab) => (
            <text
              flexShrink={0}
              wrapMode="none"
              onMouseUp={() => props.onTab?.(tab.id)}
              fg={tab.active ? theme.primary : theme.textMuted}
              attributes={tab.active ? TextAttributes.BOLD : undefined}
            >
              {`${" ".repeat(TAB_GAP)}${tab.text}`}
              <Show when={tab.badge}>
                <span style={{ fg: theme.textDim }}> {tab.badge}</span>
              </Show>
            </text>
          )}
        </For>
        <box flexGrow={1} flexShrink={1} />
        <Show when={layout().command}>
          <text flexShrink={0} wrapMode="none" fg={theme.textDim}>
            {layout().command}
          </text>
        </Show>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => props.scrollRef?.(element)}
        width="100%"
        height={viewportRows()}
        maxHeight={maxRows()}
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
        <text height={1} flexShrink={0} fg={theme.textMuted} wrapMode="none">
          {`${" ".repeat(NOTE_INDENT)}${truncateCells(props.note!, Math.max(0, innerWidth() - NOTE_INDENT), ambiguousWidth())}`}
        </text>
      </Show>
      <text height={1} flexShrink={0} fg={theme.textDim} wrapMode="none">
        {truncateCells(hintText(), innerWidth(), ambiguousWidth())}
      </text>
    </box>
  )
}
