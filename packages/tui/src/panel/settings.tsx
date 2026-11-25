// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t, type MessageKey } from "../i18n"
import { EscapePriority, formatKeyBindings, useBindings, useKeymapSelector } from "../keymap"
import { MARK_CELLS } from "../ui/layout"
import { textFg } from "../ui/text"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { PanelShell, usePanelInnerWidth, type PanelHint, type PanelTab } from "./shell"

interface SettingRowBase {
  id: string
  label: string
  /** Explains the row; drawn on the line under the rows (the panel's note) while the row is selected. */
  description?: string
  /** Muted note after the value, for example the current session state. */
  suffix?: () => string | undefined
  /** Rendered dimmed; activation is ignored when the write path is unavailable. */
  disabled?: boolean
  /**
   * A row that reports rather than holds a setting. It keeps the normal colors and can be selected, to read its
   * description, but activating it by key or click does nothing and the hint row offers no change.
   */
  readonly?: boolean
}

export type SettingRow =
  | (SettingRowBase & {
      kind: "choice"
      value: string
      options: readonly { value: string; label: string }[]
      /** Overrides the value text when no option matches, for example a custom rule. */
      valueLabel?: string
      onChange(value: string): void
    })
  | (SettingRowBase & {
      kind: "toggle"
      value: boolean
      onChange(value: boolean): void
    })
  | (SettingRowBase & {
      kind: "text"
      value: string
      secret?: boolean
      /** Returns a message key; a non-empty result blocks the commit. */
      validate?(value: string): string | undefined
      onChange(value: string): void
    })
  | (SettingRowBase & {
      kind: "action"
      valueLabel?: string
      run(): void
    })

export interface SettingsTab {
  id: string
  label: string
  rows: readonly SettingRow[]
}

export interface SettingsPanelProps {
  title: string
  command?: string
  tabs: readonly SettingsTab[]
  activeTab?: string
  onTab?(id: string): void
  hints?: readonly PanelHint[]
}

/**
 * A row is three columns: the selection marker (`MARK_CELLS`), the name, then the value right after it. The last cell of
 * the name column stays empty, so that a name cut to the column never runs into the value.
 */
const NAME_WIDTH = 22
/** Between the value, the suffix and the hint to change the value. */
const SEGMENT_GAP = "   "
/** Before the "change (i/n)" hint of a selected row; tighter than `SEGMENT_GAP` (prototype). */
const CYCLE_GAP = "  "
/** Rows a page key moves, the count `ListPanel` uses too. */
const PAGE_ROWS = 10

/** The name cut and padded to its column by `cellWidth`, so that the column is as wide as the terminal draws it. */
function nameCell(label: string, ambiguousWidth: AmbiguousWidth): string {
  // One cell less than the column: its last cell stays empty (above). A cell of the panel's own column, not of the frame.
  const text = truncateCells(label, NAME_WIDTH - 1, ambiguousWidth)
  return text + " ".repeat(NAME_WIDTH - cellWidth(text, ambiguousWidth))
}

interface ValueLine {
  value: string
  /** With its gap in front; empty when there is none. */
  suffix: string
  /** With its gap in front; empty when there is none. */
  cycle: string
}

/**
 * What follows the name: the value, then the suffix, then the hint to change the value. A line wider than `width` is
 * cut from the tail. The hint goes first, whole (a stub of it says nothing), then the suffix is shortened until it is
 * gone, and the value last.
 */
function fitValueLine(
  width: number,
  parts: { value: string; suffix?: string; cycle?: string },
  ambiguousWidth: AmbiguousWidth,
): ValueLine {
  const value = truncateCells(parts.value, width, ambiguousWidth)
  let room = width - cellWidth(value, ambiguousWidth)
  let suffix = ""
  if (parts.suffix) {
    const gap = value === "" ? "" : SEGMENT_GAP
    const text = truncateCells(parts.suffix, room - cellWidth(gap, ambiguousWidth), ambiguousWidth)
    // Cut down to the ellipsis alone it says nothing: the suffix stays whole or in part, or is gone.
    if (text.replace("…", "") !== "") {
      suffix = `${gap}${text}`
      room -= cellWidth(suffix, ambiguousWidth)
    }
  }
  const cycle =
    parts.cycle && cellWidth(CYCLE_GAP + parts.cycle, ambiguousWidth) <= room ? `${CYCLE_GAP}${parts.cycle}` : ""
  return { value, suffix, cycle }
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const innerWidth = usePanelInnerWidth()
  const tuiConfig = useTuiConfig()

  const [internalTab, setInternalTab] = createSignal<string | undefined>(props.activeTab ?? props.tabs[0]?.id)
  const [selected, setSelected] = createSignal(0)
  const [editing, setEditing] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  let editInput: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const rowRefs = new Map<string, BoxRenderable>()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const activeTabId = () => props.activeTab ?? internalTab() ?? props.tabs[0]?.id
  const currentTab = () => props.tabs.find((tab) => tab.id === activeTabId()) ?? props.tabs[0]
  // Track the id alone: rows are rebuilt when a setting changes, and observing
  // the tab object would reset the selection after every toggle.
  const activeTabKey = createMemo(() => currentTab()?.id)
  const rows = () => currentTab()?.rows ?? []
  const selectedRow = () => rows()[selected()]
  const valueWidth = () => Math.max(0, innerWidth() - MARK_CELLS - NAME_WIDTH)
  // A tab where some row explains itself keeps the line for it as the selection moves, blank for the rows that do not,
  // so the panel does not change height with the selection. A tab where none does has no such line.
  const note = () =>
    rows().some((row) => row.description !== undefined && row.description !== "")
      ? (selectedRow()?.description ?? "")
      : undefined
  // The key shown in the hint to change a value is the one `panel.submit` has now, found as the hint row finds its keys.
  const submitBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({ visibility: "registered", commands: ["panel.submit"] }),
  )
  const submitKey = createMemo(() => formatKeyBindings(submitBindings().get("panel.submit"), tuiConfig))

  createEffect(
    on(
      activeTabKey,
      () => {
        setSelected(0)
        setEditing(undefined)
        setError(undefined)
        scrollTo(currentTab()?.rows[0])
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (selected() < rows().length) return
    setSelected(Math.max(0, rows().length - 1))
  })

  createEffect(() => {
    if (!editing()) return
    queueMicrotask(() => {
      if (!editInput || editInput.isDestroyed) return
      editInput.focus()
      keepEditInView()
    })
  })

  function selectTab(id: string) {
    setInternalTab(id)
    props.onTab?.(id)
  }

  function cycleTab(direction: number) {
    const tabs = props.tabs
    if (tabs.length < 2) return
    const index = tabs.findIndex((tab) => tab.id === activeTabId())
    if (index < 0) return
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    if (next) selectTab(next.id)
  }

  function scrollTo(row: SettingRow | undefined) {
    if (!row) return
    queueMicrotask(() => {
      const element = rowRefs.get(row.id)
      if (!element || element.isDestroyed) return
      scroll?.scrollChildIntoView(element)
    })
  }

  /**
   * Keeps the row being edited in the view. Its value is an input inside the scrolling content, and the terminal draws
   * the cursor at the input with the focus: a scroll that took the row out of the view would leave the cursor on the
   * screen above the panel. A scroll that does not move anything changes nothing, so this cannot loop (13.7).
   */
  function keepEditInView() {
    const id = editing()
    if (!id) return
    const element = rowRefs.get(id)
    if (!element || element.isDestroyed) return
    scroll?.scrollChildIntoView(element)
  }

  function move(direction: number) {
    const all = rows()
    if (all.length === 0) return
    const next = (selected() + direction + all.length) % all.length
    setSelected(next)
    setEditing(undefined)
    setError(undefined)
    scrollTo(all[next])
  }

  /** A page of rows up or down; at the first or the last row it stops, where `move` wraps round. */
  function page(direction: number) {
    const all = rows()
    if (all.length === 0) return
    moveTo(selected() + direction * PAGE_ROWS)
  }

  /** A place in the tab, held between its ends: the first and the last row have nowhere further to go. */
  function moveTo(index: number) {
    if (rows().length === 0) return
    const next = Math.min(rows().length - 1, Math.max(0, index))
    setSelected(next)
    setEditing(undefined)
    setError(undefined)
    scrollTo(rows()[next])
  }

  /** Whether activating the row does anything: not while its write path is missing, and never for a read-only row. */
  const actionable = (row: SettingRow) => !row.disabled && !row.readonly

  function cycleChoice(row: Extract<SettingRow, { kind: "choice" }>) {
    if (!actionable(row) || row.options.length === 0) return
    const index = row.options.findIndex((option) => option.value === row.value)
    const next = row.options[(index + 1) % row.options.length]
    if (next) row.onChange(next.value)
  }

  function beginEdit(row: Extract<SettingRow, { kind: "text" }>) {
    if (!actionable(row)) return
    setError(undefined)
    setEditing(row.id)
  }

  function activate() {
    const row = selectedRow()
    if (!row || !actionable(row)) return
    if (row.kind === "choice") cycleChoice(row)
    else if (row.kind === "toggle") row.onChange(!row.value)
    else if (row.kind === "action") row.run()
    else beginEdit(row)
  }

  function commitEdit() {
    const row = rows().find((candidate) => candidate.id === editing())
    if (!row || row.kind !== "text") return
    if (!editInput || editInput.isDestroyed) return
    const value = editInput.value
    const validation = row.validate?.(value)
    if (validation) {
      setError(validation)
      return
    }
    row.onChange(value)
    setEditing(undefined)
    setError(undefined)
  }

  function cancelEdit() {
    setEditing(undefined)
    setError(undefined)
  }

  useBindings(() => ({
    priority: EscapePriority.modal,
    enabled: () => editing() === undefined,
    commands: [
      { name: "panel.previous", title: "Previous row", category: "Panel", run: () => move(-1) },
      { name: "panel.next", title: "Next row", category: "Panel", run: () => move(1) },
      { name: "panel.page_up", title: "Page up", category: "Panel", run: () => page(-1) },
      { name: "panel.page_down", title: "Page down", category: "Panel", run: () => page(1) },
      { name: "panel.home", title: "First row", category: "Panel", run: () => moveTo(0) },
      {
        name: "panel.end",
        title: "Last row",
        category: "Panel",
        run: () => moveTo(rows().length - 1),
      },
      { name: "panel.submit", title: "Activate row", category: "Panel", run: activate },
      { name: "panel.tab.next", title: "Next tab", category: "Panel", run: () => cycleTab(1) },
      { name: "panel.tab.previous", title: "Previous tab", category: "Panel", run: () => cycleTab(-1) },
    ],
    bindings: [
      { key: "up", cmd: "panel.previous", desc: "Previous row", group: "Panel" },
      { key: "down", cmd: "panel.next", desc: "Next row", group: "Panel" },
      { key: "pageup", cmd: "panel.page_up", desc: "Page up", group: "Panel" },
      { key: "pagedown", cmd: "panel.page_down", desc: "Page down", group: "Panel" },
      { key: "home", cmd: "panel.home", desc: "First row", group: "Panel" },
      { key: "end", cmd: "panel.end", desc: "Last row", group: "Panel" },
      { key: "return", cmd: "panel.submit", desc: "Activate row", group: "Panel" },
      { key: "left", cmd: "panel.tab.previous", desc: "Previous tab", group: "Panel" },
      { key: "right", cmd: "panel.tab.next", desc: "Next tab", group: "Panel" },
    ],
  }))

  useBindings(() => ({
    priority: EscapePriority.modal + 1,
    enabled: () => editing() !== undefined,
    commands: [
      { name: "panel.submit", title: "Commit edit", category: "Panel", run: commitEdit },
      { name: "panel.cancel", title: "Cancel edit", category: "Panel", run: cancelEdit },
    ],
    bindings: [
      { key: "return", cmd: "panel.submit", desc: "Commit edit", group: "Panel" },
      { key: "escape", cmd: "panel.cancel", desc: "Cancel edit", group: "Panel" },
    ],
  }))

  const hints = createMemo<PanelHint[]>(() => {
    if (editing()) {
      return [
        { key: "panel.submit", label: t("panel.hint.submit") },
        { key: "panel.cancel", label: t("panel.hint.cancel") },
      ]
    }
    const row = selectedRow()
    const submitLabel =
      row?.kind === "text"
        ? t("panel.hint.edit")
        : row?.kind === "action"
          ? t("panel.hint.activate")
          : row?.kind === "choice" || row?.kind === "toggle"
            ? t("panel.hint.change")
            : t("panel.hint.activate")
    const result: PanelHint[] = [{ key: "panel.previous", also: "panel.next", label: t("panel.hint.move") }]
    if (props.tabs.length > 1) {
      result.push({ key: "panel.tab.previous", also: "panel.tab.next", label: t("panel.hint.tab") })
    }
    if (!row?.disabled && !row?.readonly) result.push({ key: "panel.submit", label: submitLabel })
    result.push(...(props.hints ?? []))
    return result
  })

  function displayValue(row: SettingRow): string {
    if (row.kind === "choice") {
      return (
        row.valueLabel ?? row.options.find((option) => option.value === row.value)?.label ?? t("panel.setting.empty")
      )
    }
    if (row.kind === "toggle") return row.value ? t("panel.setting.on") : t("panel.setting.off")
    if (row.kind === "action") return row.valueLabel ?? ""
    if (row.secret) return row.value ? t("panel.setting.masked") : t("panel.setting.empty")
    return row.value || t("panel.setting.empty")
  }

  /**
   * The hint to change the selected row's value, with the place of the value among the ones it takes. A toggle's two
   * values are on and off, in that order. None for a row that cannot be changed by the key, that has fewer than two
   * values to take, or whose value is none of the options (a custom rule), and none when the key has no binding.
   */
  function cycleHint(row: SettingRow): string | undefined {
    if (!actionable(row)) return undefined
    const key = submitKey()
    if (!key) return undefined
    if (row.kind === "toggle") return t("panel.setting.cycle", { key, index: row.value ? 1 : 2, total: 2 })
    if (row.kind !== "choice") return undefined
    const position = row.options.findIndex((option) => option.value === row.value)
    if (position < 0 || row.options.length < 2) return undefined
    return t("panel.setting.cycle", { key, index: position + 1, total: row.options.length })
  }

  return (
    <PanelShell
      title={props.title}
      command={props.command}
      tabs={props.tabs}
      activeTab={activeTabId()}
      onTab={selectTab}
      hints={hints()}
      note={note()}
      scrollRef={(element) => {
        scroll = element
        if (element) element.verticalScrollBar.onChange = keepEditInView
      }}
    >
      <For each={rows()}>
        {(row, index) => {
          const isSelected = () => selected() === index()
          const isEditing = () => editing() === row.id
          const valueColor = () =>
            row.disabled ? textFg(theme, "disabled") : isSelected() ? theme.primary : textFg(theme, "secondary")
          const line = createMemo(() =>
            fitValueLine(
              valueWidth(),
              {
                value: displayValue(row),
                suffix: row.suffix?.(),
                cycle: isSelected() ? cycleHint(row) : undefined,
              },
              ambiguousWidth(),
            ),
          )
          onCleanup(() => rowRefs.delete(row.id))
          return (
            <>
              <box
                ref={(element: BoxRenderable) => rowRefs.set(row.id, element)}
                height={1}
                flexShrink={0}
                flexDirection="row"
                backgroundColor={isSelected() ? theme.backgroundSelected : undefined}
                onMouseDown={() => moveTo(index())}
                onMouseUp={() => {
                  moveTo(index())
                  if (!actionable(row)) return
                  if (row.kind === "text") beginEdit(row)
                  else if (row.kind === "action") row.run()
                  else if (row.kind === "choice") cycleChoice(row)
                  else row.onChange(!row.value)
                }}
              >
                <text
                  width={MARK_CELLS}
                  flexShrink={0}
                  fg={isSelected() ? theme.primary : theme.textDim}
                  wrapMode="none"
                >
                  {isSelected() ? "› " : "  "}
                </text>
                <text
                  flexShrink={0}
                  wrapMode="none"
                  fg={row.disabled ? textFg(theme, "disabled") : textFg(theme, "body")}
                  attributes={isSelected() ? TextAttributes.BOLD : undefined}
                >
                  {nameCell(row.label, ambiguousWidth())}
                </text>
                <Show
                  when={isEditing()}
                  fallback={
                    <>
                      <text flexShrink={0} fg={valueColor()} wrapMode="none">
                        {line().value}
                      </text>
                      <Show when={line().suffix}>
                        <text flexShrink={0} fg={textFg(theme, "hint")} wrapMode="none">
                          {line().suffix}
                        </text>
                      </Show>
                      <Show when={line().cycle}>
                        <text flexShrink={0} fg={textFg(theme, "hint")} wrapMode="none">
                          {line().cycle}
                        </text>
                      </Show>
                    </>
                  }
                >
                  <box flexGrow={1} flexShrink={1}>
                    <input
                      ref={(element: InputRenderable) => {
                        editInput = element
                      }}
                      width="100%"
                      value={row.kind === "text" ? row.value : ""}
                      placeholder={t("panel.input.placeholder")}
                      placeholderColor={textFg(theme, "secondary")}
                      focusedBackgroundColor={theme.backgroundPanel}
                      focusedTextColor={textFg(theme, "body")}
                      cursorColor={theme.primary}
                    />
                  </box>
                </Show>
              </box>
              <Show when={isEditing() && error()}>
                <text flexShrink={0} fg={theme.warning} wrapMode="none">
                  {t(error() as MessageKey)}
                </text>
              </Show>
            </>
          )
        }}
      </For>
    </PanelShell>
  )
}
