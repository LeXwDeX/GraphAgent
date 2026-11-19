// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { entries, groupBy, isDeepEqual } from "remeda"
import * as fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, For, on, onMount, Show, untrack, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { EscapePriority, useBindings } from "../keymap"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { PanelShell, type PanelHint, type PanelTab } from "./shell"

export interface ListItem<T> {
  id: string
  value: T
  title: string
  /** Group heading; items with the same group render together. */
  group?: string
  /** Leading symbol such as a status marker. */
  lead?: JSX.Element | string
  /** Trailing content such as a timestamp, shortcut, or state. */
  trail?: JSX.Element | string
  /** One-line description shown below the selected item; a list of lines shows one row each. */
  description?: string | readonly string[]
  disabled?: boolean
  suggested?: boolean
}

/** The rows of an item's description: none for an empty one, and no empty rows. */
function descriptionLines(description: string | readonly string[] | undefined): readonly string[] | undefined {
  const lines = (typeof description === "string" ? [description] : (description ?? [])).filter((line) => line !== "")
  return lines.length > 0 ? lines : undefined
}

export interface ListAction<T> {
  /** Keymap command name, for example "session.pin.toggle". */
  key: string
  /** Label shown in the hint row. */
  label: string
  run(item: ListItem<T>): void | Promise<void>
  when?: (item: ListItem<T> | undefined) => boolean
}

export interface ListPanelProps<T> {
  /** A string is measured and truncated by the shell; JSX is left to flex layout, as `PanelShell` takes it. */
  title: JSX.Element | string
  command?: string
  items: readonly ListItem<T>[]
  /** Initial selection; also gets the current-value marker. */
  current?: T
  /**
   * Defaults to true. With a filter input, action keys use their configured ctrl+<key> bindings.
   * Set `client: false` when the owner searches server-side and only needs the input.
   */
  filter?: boolean | { placeholder?: string; client?: boolean }
  tabs?: readonly PanelTab[]
  activeTab?: string
  onTab?: (id: string) => void
  onSelect(item: ListItem<T>): void
  /**
   * Opts in to a selection that survives the items changing. The selection always follows its item (by `id`) when the
   * item moves, and without this prop it starts over, at the current value or the first item, whenever `items`
   * changes. With it, a change of `items` leaves the selection on its item (an item that is gone leaves it at the
   * same place, cut to the list), and it starts over only when this value changes (or the template's own filter text,
   * for a list it filters itself). For an owner that narrows the items itself: pass what it narrows by.
   */
  selectionKey?: string
  /** Fires on every filter edit with the remaining items; used by previewing panels. */
  onFilter?(value: string, items: readonly ListItem<T>[]): void
  /** Preview hook, used by panels such as the theme picker. */
  onMove?(item: ListItem<T>): void
  actions?: readonly ListAction<T>[]
  empty?: JSX.Element
  loading?: boolean
}

export function ListPanel<T>(props: ListPanelProps<T>) {
  const { theme } = useTheme()
  const kv = useKV()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  const [filter, setFilter] = createSignal("")
  const rowRefs = new Map<string, BoxRenderable>()
  let input: InputRenderable | undefined

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const filterEnabled = () => props.filter !== false
  const clientFilter = () => props.filter === false || typeof props.filter !== "object" || props.filter.client !== false
  const placeholder = () => (typeof props.filter === "object" ? props.filter.placeholder : undefined)
  const descriptionBudget = () => Math.max(0, dimensions().width - 8)
  const actions = createMemo(() => props.actions ?? [])

  const filtered = createMemo(() => {
    const items = props.items.filter((item) => item.disabled !== true)
    if (!filterEnabled() || !clientFilter()) return items
    const needle = filter().trim().toLowerCase()
    if (!needle) return items
    return fuzzysort.go(needle, items, { key: "title" }).map((result) => result.obj)
  })

  const grouped = createMemo(
    () => entries(groupBy(filtered(), (item) => item.group ?? "")) as [string, ListItem<T>[]][],
  )
  const flat = createMemo(() => grouped().flatMap(([, items]) => items))
  // The selection is an item, kept by its id; where it stands in `flat()` is looked up every time. An item that moves
  // (the owner reorders its items, or a `group` that follows data regroups them) takes the selection with it. One that
  // is gone leaves the selection at the place it had, cut to the list, and the effect below hands it to the item there.
  const [selectedID, setSelectedID] = createSignal<string | undefined>(flat()[initialIndex()]?.id)
  const selected = createMemo<number>((previous) => {
    const items = flat()
    const id = selectedID()
    const index = id === undefined ? -1 : items.findIndex((item) => item.id === id)
    return index >= 0 ? index : Math.min(previous, Math.max(0, items.length - 1))
  }, initialIndex())
  const selectedItem = createMemo(() => flat()[selected()])
  const currentItem = createMemo(() => {
    const current = props.current
    if (current === undefined) return undefined
    return flat().find((item) => isDeepEqual(item.value, current))
  })

  function initialIndex() {
    const current = props.current
    if (current === undefined) return 0
    const index = flat().findIndex((item) => isDeepEqual(item.value, current))
    return index >= 0 ? index : 0
  }

  function select(index: number) {
    setSelectedID(flat()[index]?.id)
  }

  /** Starts the selection over: on the current value, or the first item. */
  function reset() {
    const current = props.current
    const index = current === undefined ? -1 : flat().findIndex((item) => isDeepEqual(item.value, current))
    select(index >= 0 ? index : 0)
  }

  // The initial selection is derived from the current value before the first paint.
  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current === undefined) return
        const index = flat().findIndex((item) => isDeepEqual(item.value, current))
        if (index >= 0) select(index)
      },
      { defer: true },
    ),
  )

  // A list that did not ask to keep its selection (no `selectionKey`) starts over whenever its items change. One that did
  // starts over when its key changes, or the filter text the template matches the items by (an owner that narrows
  // them itself matches nothing here, so only its key counts).
  const resetKey = createMemo(() =>
    props.selectionKey === undefined
      ? undefined
      : `${filterEnabled() && clientFilter() ? filter() : ""}\u0000${props.selectionKey}`,
  )
  createEffect(on(resetKey, () => reset(), { defer: true }))
  createEffect(
    on(
      filtered,
      () => {
        if (props.selectionKey === undefined) reset()
      },
      { defer: true },
    ),
  )

  // The place of a selection whose item is gone is now another item's: that one is the selected item from here on,
  // so a later move of it is followed too.
  createEffect(() => {
    const id = flat()[selected()]?.id
    if (id !== undefined && id !== untrack(selectedID)) setSelectedID(id)
  })

  onMount(() => {
    if (!filterEnabled()) return
    queueMicrotask(() => {
      if (!input || input.isDestroyed) return
      input.focus()
    })
  })

  function scrollTo(item: ListItem<T>) {
    queueMicrotask(() => {
      const row = rowRefs.get(item.id)
      if (!row || row.isDestroyed) return
      scroll?.scrollChildIntoView(row)
    })
  }

  function moveTo(next: number, preview = true) {
    const items = flat()
    if (items.length === 0) return
    const index = ((next % items.length) + items.length) % items.length
    const item = items[index]
    if (!item) return
    setSelectedID(item.id)
    if (preview) props.onMove?.(item)
    scrollTo(item)
  }

  function move(direction: number) {
    moveTo(selected() + direction)
  }

  function submit() {
    const item = selectedItem()
    if (!item) return
    props.onSelect(item)
  }

  function runAction(action: ListAction<T>) {
    const item = selectedItem()
    if (action.when?.(item) === false) return
    if (!item) return
    void action.run(item)
  }

  function cycleTab(direction: number) {
    const tabs = props.tabs ?? []
    if (tabs.length < 2) return
    const active = props.activeTab ?? tabs[0]?.id
    const index = tabs.findIndex((tab) => tab.id === active)
    if (index < 0) return
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    if (next) props.onTab?.(next.id)
  }

  useBindings(() => ({
    priority: EscapePriority.modal,
    commands: [
      { name: "panel.previous", title: "Previous item", category: "Panel", run: () => move(-1) },
      { name: "panel.next", title: "Next item", category: "Panel", run: () => move(1) },
      { name: "panel.page_up", title: "Page up", category: "Panel", run: () => move(-10) },
      { name: "panel.page_down", title: "Page down", category: "Panel", run: () => move(10) },
      { name: "panel.home", title: "First item", category: "Panel", run: () => moveTo(0) },
      {
        name: "panel.end",
        title: "Last item",
        category: "Panel",
        run: () => moveTo(flat().length - 1),
      },
      { name: "panel.submit", title: "Select item", category: "Panel", run: submit },
      { name: "panel.tab.next", title: "Next tab", category: "Panel", run: () => cycleTab(1) },
      { name: "panel.tab.previous", title: "Previous tab", category: "Panel", run: () => cycleTab(-1) },
      ...actions().map((action) => ({
        name: action.key,
        title: action.label,
        category: "Panel",
        run: () => runAction(action),
      })),
    ],
    bindings: [
      { key: "up", cmd: "panel.previous", desc: "Previous item", group: "Panel" },
      { key: "down", cmd: "panel.next", desc: "Next item", group: "Panel" },
      { key: "pageup", cmd: "panel.page_up", desc: "Page up", group: "Panel" },
      { key: "pagedown", cmd: "panel.page_down", desc: "Page down", group: "Panel" },
      { key: "home", cmd: "panel.home", desc: "First item", group: "Panel" },
      { key: "end", cmd: "panel.end", desc: "Last item", group: "Panel" },
      { key: "return", cmd: "panel.submit", desc: "Select item", group: "Panel" },
      ...(filterEnabled()
        ? [
            { key: "tab", cmd: "panel.tab.next", desc: "Next tab", group: "Panel" },
            { key: "shift+tab", cmd: "panel.tab.previous", desc: "Previous tab", group: "Panel" },
          ]
        : [
            { key: "left", cmd: "panel.tab.previous", desc: "Previous tab", group: "Panel" },
            { key: "right", cmd: "panel.tab.next", desc: "Next tab", group: "Panel" },
          ]),
      ...actions().flatMap((action) => tuiConfig.keybinds.get(action.key)),
    ],
  }))

  const hints = createMemo<PanelHint[]>(() => {
    const result: PanelHint[] = [{ key: "panel.previous", also: "panel.next", label: t("panel.hint.move") }]
    if ((props.tabs?.length ?? 0) > 1) result.push({ key: "panel.tab.next", label: t("panel.hint.tab") })
    result.push({ key: "panel.submit", label: t("panel.hint.activate") })
    for (const action of actions()) {
      result.push({
        key: action.key,
        label: action.label,
        when: () => action.when?.(selectedItem()) !== false,
      })
    }
    return result
  })

  return (
    <PanelShell
      scrollRef={(element) => (scroll = element)}
      title={props.title}
      command={props.command}
      tabs={props.tabs}
      activeTab={props.activeTab}
      onTab={props.onTab}
      hints={hints()}
    >
      <Show when={filterEnabled()}>
        <box height={1} flexShrink={0} flexDirection="row">
          <text flexShrink={0} fg={theme.textDim} wrapMode="none">
            ›{" "}
          </text>
          <box flexGrow={1} flexShrink={1}>
            <input
              ref={(element: InputRenderable) => {
                input = element
              }}
              width="100%"
              onInput={(value) => {
                setFilter(value)
                props.onFilter?.(value, filtered())
              }}
              placeholder={placeholder() ?? t("panel.list.filter")}
              placeholderColor={theme.textMuted}
              focusedBackgroundColor={theme.backgroundPanel}
              focusedTextColor={theme.text}
              cursorColor={theme.primary}
            />
          </box>
        </box>
      </Show>
      <Show when={!props.loading} fallback={<text fg={theme.textMuted}>{t("panel.list.loading")}</text>}>
        <Show
          when={flat().length > 0}
          fallback={props.empty ?? <text fg={theme.textMuted}>{t("panel.list.empty")}</text>}
        >
          <For each={grouped()}>
            {([group, items], groupIndex) => (
              <>
                <Show when={group}>
                  <box height={groupIndex() > 0 ? 2 : 1} flexShrink={0} paddingTop={groupIndex() > 0 ? 1 : 0}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                      {group}
                    </text>
                  </box>
                </Show>
                <For each={items}>
                  {(item) => {
                    const index = () => flat().findIndex((candidate) => candidate.id === item.id)
                    const isSelected = () => flat()[selected()]?.id === item.id
                    const isCurrent = () => currentItem()?.id === item.id
                    // The ref is the item's own column, the row with the lines of its description under it, so that
                    // scrolling it into view takes the lines along.
                    return (
                      <box
                        ref={(element: BoxRenderable) => {
                          rowRefs.set(item.id, element)
                        }}
                        flexDirection="column"
                        flexShrink={0}
                      >
                        <box
                          height={1}
                          flexShrink={0}
                          flexDirection="row"
                          backgroundColor={isSelected() ? theme.backgroundSelected : undefined}
                          onMouseDown={() => moveTo(index())}
                          onMouseUp={() => props.onSelect(item)}
                        >
                          <text
                            flexShrink={0}
                            fg={isCurrent() || isSelected() ? theme.primary : theme.textDim}
                            wrapMode="none"
                          >
                            {isCurrent() ? "● " : isSelected() ? "› " : "  "}
                          </text>
                          <Show when={typeof item.lead === "string"} fallback={<box flexShrink={0}>{item.lead}</box>}>
                            <text flexShrink={0} wrapMode="none">
                              {item.lead as string}
                            </text>
                          </Show>
                          <text
                            flexGrow={1}
                            flexShrink={1}
                            overflow="hidden"
                            wrapMode="none"
                            attributes={isSelected() ? TextAttributes.BOLD : undefined}
                          >
                            {item.title}
                          </text>
                          <Show when={typeof item.trail === "string"} fallback={<box flexShrink={0}>{item.trail}</box>}>
                            <text flexShrink={0} fg={theme.textMuted} wrapMode="none">
                              {item.trail as string}
                            </text>
                          </Show>
                        </box>
                        <Show when={isSelected() && descriptionLines(item.description)}>
                          {(lines) => (
                            <For each={lines()}>
                              {(line) => (
                                <text flexShrink={0} fg={theme.textMuted} wrapMode="none">
                                  {truncateCells(line, descriptionBudget(), ambiguousWidth())}
                                </text>
                              )}
                            </For>
                          )}
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </Show>
      </Show>
    </PanelShell>
  )
}
