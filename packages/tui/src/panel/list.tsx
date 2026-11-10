// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { entries, groupBy, isDeepEqual } from "remeda"
import * as fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, For, on, onMount, Show, type JSX } from "solid-js"
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
  /** One-line description shown below the selected item. */
  description?: string
  disabled?: boolean
  suggested?: boolean
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
  title: string
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
  const [selected, setSelected] = createSignal(initialIndex())
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

  // The initial selection is derived from the current value before the first paint.
  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current === undefined) return
        const index = flat().findIndex((item) => isDeepEqual(item.value, current))
        if (index >= 0) setSelected(index)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      filtered,
      () => {
        const current = props.current
        const index = current === undefined ? -1 : flat().findIndex((item) => isDeepEqual(item.value, current))
        setSelected(index >= 0 ? Math.min(index, Math.max(0, flat().length - 1)) : 0)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (selected() < flat().length) return
    setSelected(Math.max(0, flat().length - 1))
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
    setSelected(index)
    const item = items[index]
    if (!item) return
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
    const result: PanelHint[] = [
      { key: "panel.previous", label: t("panel.hint.previous") },
      { key: "panel.next", label: t("panel.hint.next") },
    ]
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
                    return (
                      <>
                        <box
                          ref={(element: BoxRenderable) => {
                            rowRefs.set(item.id, element)
                          }}
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
                        <Show when={isSelected() && item.description}>
                          <text flexShrink={0} fg={theme.textMuted} wrapMode="none">
                            {truncateCells(item.description!, descriptionBudget(), ambiguousWidth())}
                          </text>
                        </Show>
                      </>
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
