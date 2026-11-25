// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { EscapePriority, useBindings } from "../keymap"
import { MARK_CELLS } from "../ui/layout"
import { textFg } from "../ui/text"
import { cellWidth, type AmbiguousWidth } from "../ui/width"
import { remoteLine } from "../util/remote-text"
import { PanelShell, type PanelHint, type PanelTab } from "./shell"

/**
 * A checked lead owns no state: the caller passes the current value back and
 * receives `onToggle` when the selected row is toggled.
 */
export type DetailCheckLead = { kind: "check"; checked: boolean; disabled?: boolean }
export type DetailLead = DetailCheckLead | JSX.Element

function checkLead(lead: DetailLead | undefined): DetailCheckLead | undefined {
  if (!lead || typeof lead !== "object" || !("kind" in lead) || lead.kind !== "check") return undefined
  return lead
}

/** The rendered (non-check) lead, if any. Check leads hold data instead. */
function elementLead(lead: DetailLead | undefined): JSX.Element | undefined {
  if (lead === undefined || checkLead(lead)) return undefined
  return lead as JSX.Element
}

export interface DetailRow<T = unknown> {
  id: string
  /** Rendered before the aligned columns; a check lead toggles through `onToggle`. */
  lead?: DetailLead
  /** Aligned columns; strings are padded to the widest cell in the column. */
  cells: readonly (string | JSX.Element)[]
  value?: T
  selectable?: boolean
  /**
   * One-line note for the row, drawn on the panel's fixed note line (under the rows, outside the scroll area) while the
   * row is selected, never under the row. Line breaks become spaces, and what is wider than the line is cut. A panel
   * where some row has a note keeps that line as the selection moves, blank for the rows without one.
   */
  note?: string
  /** Wrapped text the row opens below itself with `panel.submit`, never by being selected. */
  body?: string
  /**
   * Space on the row calls `onToggle` although it has no check lead, as for a fold; the text is what the hint says the
   * key does while the row is selected. A row without it, and without a check lead, leaves space unanswered.
   */
  toggleLabel?: string
}

export interface DetailPanelProps<T = unknown> {
  /** May include status tags. */
  title: string | JSX.Element
  command?: string
  tabs?: readonly PanelTab[]
  activeTab?: string
  onTab?: (id: string) => void
  /** Top summary area, for example a DAG progress bar and counts. */
  summary?: JSX.Element
  rows?: readonly DetailRow<T>[]
  selected?: string
  onSelect?(row: DetailRow<T>): void
  onActivate?(row: DetailRow<T>): void
  /** Space on the selected row; check leads flip their caller-held state here. */
  onToggle?(row: DetailRow<T>): void
  /** Scrollable text or rich content, for example a /btw answer. */
  body?: string | JSX.Element
  /** Single-line input, for example an API key or OAuth code. */
  input?: { placeholder?: string; secret?: boolean; onSubmit(value: string): void }
  /** Overrides the submit hint label when `onActivate` is provided. */
  activateLabel?: string
  /**
   * When a row's body is open. `"folded"` (the default) opens none of them by itself: the selection opens nothing,
   * `panel.submit` opens the row it is on and again closes it, and the rows it has opened are remembered by row id.
   * `"selected"` keeps the body of the selected row open — the trust review and the DAG panel, whose rows are read
   * where they are — and leaves `panel.submit` to `onActivate`, as does a panel whose rows have no bodies at all.
   */
  rowBody?: "folded" | "selected"
  /** Single-letter action hints from the owning panel. */
  hints: readonly PanelHint[]
  tone?: "default" | "warning"
}

/** The gap after a text column of the rows, before the next cell. */
export const COLUMN_GAP = 2
/** Rows a page key moves, the count `ListPanel` uses too. */
const PAGE_ROWS = 10
/** What the check lead of a row draws: the box, and the gap to the first column. */
const CHECK_LEAD = { on: "[x] ", off: "[ ] " } as const
/** Cells a check lead takes. A panel that fits its last cell to what the lead and the columns leave takes it from here. */
export const CHECK_LEAD_CELLS = cellWidth(CHECK_LEAD.on)

export function DetailPanel<T = unknown>(props: DetailPanelProps<T>) {
  const { theme } = useTheme()
  const kv = useKV()
  let scroll: ScrollBoxRenderable | undefined

  const [internalSelected, setInternalSelected] = createSignal<string | undefined>(firstSelectableId())
  // The rows whose body `panel.submit` has opened, by row id: moving the selection opens and closes nothing.
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  let input: InputRenderable | undefined
  let inputRow: BoxRenderable | undefined
  const rowRefs = new Map<string, BoxRenderable>()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const selectableRows = createMemo(() => (props.rows ?? []).filter((row) => row.selectable !== false))
  const selectedId = createMemo(() => {
    if (props.selected !== undefined) return props.selected
    const internal = internalSelected()
    if (internal && (props.rows ?? []).some((row) => row.id === internal)) return internal
    return firstSelectableId()
  })
  const selectedRow = createMemo(() => (props.rows ?? []).find((row) => row.id === selectedId()))
  // A panel where some row has a note keeps the line for it as the selection moves, blank for the rows without one, so
  // the rows and the height of the panel do not change with the selection. A panel where none has one has no such line.
  const hasNote = createMemo(() => (props.rows ?? []).some((row) => row.selectable !== false && !!row.note))
  const note = createMemo(() => {
    if (!hasNote()) return undefined
    const row = selectedRow()
    return row?.selectable !== false && row?.note ? remoteLine(row.note) : ""
  })
  const tabs = createMemo(() => props.tabs ?? [])

  const columnWidths = createMemo(() => {
    const widths: number[] = []
    for (const row of props.rows ?? []) {
      row.cells.forEach((cell, index) => {
        if (typeof cell !== "string") return
        widths[index] = Math.max(widths[index] ?? 0, cellWidth(cell, ambiguousWidth()))
      })
    }
    return widths
  })

  function firstSelectableId() {
    return (props.rows ?? []).find((row) => row.selectable !== false)?.id
  }

  function select(row: DetailRow<T>) {
    if (row.selectable === false) return
    if (props.selected === undefined) setInternalSelected(row.id)
    props.onSelect?.(row)
  }

  /** One step, wrapping round both ends. */
  function move(direction: number) {
    const rows = selectableRows()
    if (rows.length === 0) return
    const current = rows.findIndex((row) => row.id === selectedId())
    const next = rows[(((current < 0 ? 0 : current + direction) % rows.length) + rows.length) % rows.length]
    if (!next) return
    if (props.selected === undefined) setInternalSelected(next.id)
    props.onSelect?.(next)
    queueMicrotask(() => {
      const ref = rowRefs.get(next.id)
      if (!ref || ref.isDestroyed) return
      scroll?.scrollChildIntoView(ref)
    })
  }

  /** A page of rows up or down; at the first or the last row it stops, where `move` wraps round. */
  function page(direction: number) {
    const rows = selectableRows()
    if (rows.length === 0) return
    const current = rows.findIndex((row) => row.id === selectedId())
    moveTo((current < 0 ? 0 : current) + direction * PAGE_ROWS)
  }

  /** A place in the list, held between its ends: the first and the last row have nowhere further to go. */
  function moveTo(index: number) {
    const rows = selectableRows()
    if (rows.length === 0) return
    const next = rows[Math.min(rows.length - 1, Math.max(0, index))]
    if (!next) return
    if (props.selected === undefined) setInternalSelected(next.id)
    props.onSelect?.(next)
    queueMicrotask(() => {
      const ref = rowRefs.get(next.id)
      if (!ref || ref.isDestroyed) return
      scroll?.scrollChildIntoView(ref)
    })
  }

  /** Whether the row's body is open: the selected row's under `rowBody: "selected"`, the others only after
   * `panel.submit`. */
  function bodyOpen(row: DetailRow<T>) {
    if (props.rowBody === "selected") return selectedId() === row.id
    return expanded()[row.id] === true
  }

  function toggleBody(row: DetailRow<T>) {
    setExpanded((current) => ({ ...current, [row.id]: current[row.id] !== true }))
  }

  function activate() {
    const row = selectedRow()
    if (!row) return
    // The key opens the row it is on when the panel leaves its rows' bodies to it; a panel that keeps the key for an
    // action of its own says `rowBody: "selected"` and gets it back.
    if (props.rowBody !== "selected" && row.body !== undefined) {
      toggleBody(row)
      return
    }
    props.onActivate?.(row)
  }

  function toggle() {
    const row = selectedRow()
    if (!row || !props.onToggle) return
    if (row.toggleLabel !== undefined) {
      props.onToggle(row)
      return
    }
    const lead = checkLead(row.lead)
    if (!lead || lead.disabled) return
    props.onToggle(row)
  }

  function submitInput() {
    if (!props.input) return
    if (!input || input.isDestroyed) return
    const value = input.value
    if (!value) return
    props.input.onSubmit(value)
    input.value = ""
  }

  useBindings(() => ({
    priority: EscapePriority.modal,
    enabled: () => props.input === undefined,
    commands: [
      { name: "panel.previous", title: "Previous row", category: "Panel", run: () => move(-1) },
      { name: "panel.next", title: "Next row", category: "Panel", run: () => move(1) },
      { name: "panel.page_up", title: "Page up", category: "Panel", run: () => page(-1) },
      { name: "panel.page_down", title: "Page down", category: "Panel", run: () => page(1) },
      { name: "panel.home", title: "First row", category: "Panel", run: () => moveTo(0) },
      { name: "panel.end", title: "Last row", category: "Panel", run: () => moveTo(selectableRows().length - 1) },
      { name: "panel.submit", title: "Activate row", category: "Panel", run: activate },
      { name: "panel.toggle", title: "Toggle row", category: "Panel", run: toggle },
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
      { key: "space", cmd: "panel.toggle", desc: "Toggle row", group: "Panel" },
      { key: "left", cmd: "panel.tab.previous", desc: "Previous tab", group: "Panel" },
      { key: "right", cmd: "panel.tab.next", desc: "Next tab", group: "Panel" },
    ],
  }))

  useBindings(() => ({
    priority: 1,
    enabled: () => props.input !== undefined,
    commands: [{ name: "panel.submit", title: "Submit input", category: "Panel", run: submitInput }],
    bindings: [{ key: "return", cmd: "panel.submit", desc: "Submit input", group: "Panel" }],
  }))

  /** Keeps the input in the view: the terminal draws the cursor at the input with the focus, and a scroll that took it
   * out of the view would leave the cursor on the screen above the panel. A scroll that moves nothing changes nothing,
   * so this cannot loop (13.7). */
  function keepInputInView() {
    if (!inputRow || inputRow.isDestroyed) return
    scroll?.scrollChildIntoView(inputRow)
  }

  createEffect(() => {
    if (!props.input) return
    queueMicrotask(() => {
      if (!input || input.isDestroyed) return
      input.focus()
      keepInputInView()
    })
  })

  onMount(() => {
    const current = selectedRow()
    if (!current) return
    queueMicrotask(() => {
      const ref = rowRefs.get(current.id)
      if (!ref || ref.isDestroyed) return
      scroll?.scrollChildIntoView(ref)
    })
  })

  function cycleTab(direction: number) {
    const all = tabs()
    if (all.length < 2) return
    const active = props.activeTab ?? all[0]?.id
    const index = all.findIndex((tab) => tab.id === active)
    if (index < 0) return
    const next = all[(index + direction + all.length) % all.length]
    if (next) props.onTab?.(next.id)
  }

  const hints = createMemo<PanelHint[]>(() => {
    const result: PanelHint[] = []
    if (!props.input) {
      if (selectableRows().length > 1) {
        result.push({ key: "panel.previous", also: "panel.next", label: t("panel.hint.move") })
      }
      if (tabs().length > 1) {
        result.push({ key: "panel.tab.previous", also: "panel.tab.next", label: t("panel.hint.tab") })
      }
      const row = selectedRow()
      if (props.onToggle && row && (checkLead(row.lead) || row.toggleLabel !== undefined)) {
        result.push({ key: "panel.toggle", label: row.toggleLabel ?? t("panel.hint.toggle") })
      }
      if (props.onActivate) result.push({ key: "panel.submit", label: props.activateLabel ?? t("panel.hint.activate") })
      else if (row?.body !== undefined && props.rowBody !== "selected")
        result.push({ key: "panel.submit", label: bodyOpen(row) ? t("panel.hint.collapse") : t("panel.hint.expand") })
    }
    result.push(...props.hints)
    return result
  })

  function padCell(text: string, index: number, last: boolean): string {
    const width = columnWidths()[index] ?? cellWidth(text, ambiguousWidth())
    const padded = text + " ".repeat(Math.max(0, width - cellWidth(text, ambiguousWidth())))
    return last ? padded : padded + " ".repeat(COLUMN_GAP)
  }

  return (
    <PanelShell
      scrollRef={(element) => {
        scroll = element
        if (element) element.verticalScrollBar.onChange = keepInputInView
      }}
      title={props.title}
      command={props.command}
      tabs={props.tabs}
      activeTab={props.activeTab}
      onTab={props.onTab}
      hints={hints()}
      tone={props.tone}
      note={note()}
    >
      <Show when={props.summary}>
        <box flexShrink={0} flexDirection="column">
          {props.summary}
        </box>
      </Show>
      <For each={props.rows ?? []}>
        {(row) => {
          const isSelected = () => selectedId() === row.id
          const selectable = row.selectable !== false
          return (
            <>
              <box
                ref={(element: BoxRenderable) => {
                  rowRefs.set(row.id, element)
                }}
                height={1}
                flexShrink={0}
                flexDirection="row"
                overflow="hidden"
                backgroundColor={isSelected() && selectable ? theme.backgroundSelected : undefined}
                onMouseDown={() => select(row)}
                onMouseUp={() => {
                  if (!selectable) return
                  // A row with a lead owns a separate action; a click there must
                  // not also submit the row.
                  if (row.lead !== undefined) return
                  props.onActivate?.(row)
                }}
              >
                <text flexShrink={0} fg={isSelected() ? theme.primary : theme.textDim} wrapMode="none">
                  {isSelected() && selectable ? "› " : "  "}
                </text>
                <Show
                  when={checkLead(row.lead)}
                  fallback={
                    elementLead(row.lead) ? (
                      <box flexShrink={0} flexDirection="row">
                        {elementLead(row.lead)}
                      </box>
                    ) : undefined
                  }
                >
                  {(lead) => (
                    <box
                      flexShrink={0}
                      flexDirection="row"
                      onMouseDown={() => {
                        select(row)
                        if (lead().disabled) return
                        props.onToggle?.(row)
                      }}
                    >
                      <text
                        wrapMode="none"
                        fg={
                          lead().disabled
                            ? textFg(theme, "disabled")
                            : lead().checked
                              ? theme.success
                              : textFg(theme, "secondary")
                        }
                      >
                        {lead().checked ? CHECK_LEAD.on : CHECK_LEAD.off}
                      </text>
                    </box>
                  )}
                </Show>
                <For each={row.cells}>
                  {(cell, index) => (
                    <Show
                      when={typeof cell === "string"}
                      fallback={
                        <box flexShrink={0} flexDirection="row">
                          {cell}
                        </box>
                      }
                    >
                      <text flexShrink={0} wrapMode="none">
                        {padCell(cell as string, index(), index() === row.cells.length - 1)}
                      </text>
                    </Show>
                  )}
                </For>
              </box>
              <Show when={row.body !== undefined && bodyOpen(row)}>
                <box flexShrink={0} paddingLeft={MARK_CELLS} paddingBottom={1}>
                  <text wrapMode="word" fg={textFg(theme, "body")}>
                    {row.body!}
                  </text>
                </box>
              </Show>
            </>
          )
        }}
      </For>
      <Show when={props.body !== undefined}>
        <Show
          when={typeof props.body === "string"}
          fallback={
            <box flexShrink={0} flexDirection="column">
              {props.body}
            </box>
          }
        >
          <text wrapMode="word">{props.body as string}</text>
        </Show>
      </Show>
      <Show when={props.input}>
        <box
          ref={(element: BoxRenderable) => {
            inputRow = element
          }}
          height={1}
          flexShrink={0}
          flexDirection="row"
        >
          <text flexShrink={0} fg={theme.primary} wrapMode="none">
            ›{" "}
          </text>
          <box flexGrow={1} flexShrink={1}>
            <input
              ref={(element: InputRenderable) => {
                input = element
              }}
              width="100%"
              placeholder={props.input?.placeholder ?? t("panel.input.placeholder")}
              placeholderColor={textFg(theme, "secondary")}
              focusedBackgroundColor={theme.backgroundPanel}
              focusedTextColor={textFg(theme, "body")}
              cursorColor={theme.primary}
            />
          </box>
        </box>
      </Show>
    </PanelShell>
  )
}
