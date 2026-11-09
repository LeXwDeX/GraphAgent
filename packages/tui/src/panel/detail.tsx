// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { EscapePriority, useBindings } from "../keymap"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { PanelShell, type PanelHint, type PanelTab } from "./shell"

export interface DetailRow<T = unknown> {
  id: string
  /** Aligned columns; strings are padded to the widest cell in the column. */
  cells: readonly (string | JSX.Element)[]
  value?: T
  selectable?: boolean
  /** One-line note shown only while the row is selected. */
  note?: string
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
  /** Scrollable text or rich content, for example a /btw answer. */
  body?: string | JSX.Element
  /** Single-line input, for example an API key or OAuth code. */
  input?: { placeholder?: string; secret?: boolean; onSubmit(value: string): void }
  /** Overrides the submit hint label when `onActivate` is provided. */
  activateLabel?: string
  /** Single-letter action hints from the owning panel. */
  hints: readonly PanelHint[]
  tone?: "default" | "warning"
}

const COLUMN_GAP = 2

export function DetailPanel<T = unknown>(props: DetailPanelProps<T>) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  const [internalSelected, setInternalSelected] = createSignal<string | undefined>(firstSelectableId())
  let input: InputRenderable | undefined
  const rowRefs = new Map<string, BoxRenderable>()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const innerWidth = () => Math.max(0, dimensions().width - 6)
  const selectableRows = createMemo(() => (props.rows ?? []).filter((row) => row.selectable !== false))
  const selectedId = createMemo(() => {
    if (props.selected !== undefined) return props.selected
    const internal = internalSelected()
    if (internal && (props.rows ?? []).some((row) => row.id === internal)) return internal
    return firstSelectableId()
  })
  const selectedRow = createMemo(() => (props.rows ?? []).find((row) => row.id === selectedId()))
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

  function activate() {
    const row = selectedRow()
    if (!row) return
    props.onActivate?.(row)
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
      { name: "panel.page_up", title: "Page up", category: "Panel", run: () => move(-10) },
      { name: "panel.page_down", title: "Page down", category: "Panel", run: () => move(10) },
      { name: "panel.home", title: "First row", category: "Panel", run: () => move(-selectableRows().length) },
      { name: "panel.end", title: "Last row", category: "Panel", run: () => move(selectableRows().length) },
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
    priority: 1,
    enabled: () => props.input !== undefined,
    commands: [{ name: "panel.submit", title: "Submit input", category: "Panel", run: submitInput }],
    bindings: [{ key: "return", cmd: "panel.submit", desc: "Submit input", group: "Panel" }],
  }))

  createEffect(() => {
    if (!props.input) return
    queueMicrotask(() => {
      if (!input || input.isDestroyed) return
      input.focus()
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
        result.push({ key: "panel.previous", label: t("panel.hint.previous") })
        result.push({ key: "panel.next", label: t("panel.hint.next") })
      }
      if (tabs().length > 1) result.push({ key: "panel.tab.next", label: t("panel.hint.tab") })
      if (props.onActivate) result.push({ key: "panel.submit", label: props.activateLabel ?? t("panel.hint.activate") })
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
      scrollRef={(element) => (scroll = element)}
      title={props.title}
      command={props.command}
      tabs={props.tabs}
      activeTab={props.activeTab}
      onTab={props.onTab}
      hints={hints()}
      tone={props.tone}
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
                  props.onActivate?.(row)
                }}
              >
                <text flexShrink={0} fg={isSelected() ? theme.primary : theme.textDim} wrapMode="none">
                  {isSelected() && selectable ? "› " : "  "}
                </text>
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
              <Show when={isSelected() && selectable && row.note}>
                <text flexShrink={0} fg={theme.textMuted} wrapMode="none">
                  {truncateCells(row.note!, innerWidth(), ambiguousWidth())}
                </text>
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
        <box height={1} flexShrink={0} flexDirection="row">
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
              placeholderColor={theme.textMuted}
              focusedBackgroundColor={theme.backgroundPanel}
              focusedTextColor={theme.text}
              cursorColor={theme.primary}
            />
          </box>
        </box>
      </Show>
    </PanelShell>
  )
}
