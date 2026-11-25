// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, InputRenderable, Renderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { isDeepEqual } from "remeda"
import * as fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { EscapePriority, useBindings } from "../keymap"
import { remoteLine } from "../util/remote-text"
import { textFg } from "../ui/text"
import { PanelShell, type PanelHint, type PanelTab } from "./shell"

/** How many items PageUp and PageDown move the selection by. */
const PAGE_ITEMS = 10

function sameStrings(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Whether `node` is in the tree under `ancestor`: a row that has been taken out of it cannot be scrolled to. */
function within(node: Renderable, ancestor: Renderable) {
  for (let at: Renderable | null = node; at; at = at.parent) if (at === ancestor) return true
  return false
}

/**
 * The ref of an element that is kept under a key while it is mounted. The entry goes with the element, unless another
 * element has taken the key by then (an item that changes group is mounted in its new group before the old one goes).
 */
function remember(elements: Map<string, BoxRenderable>, key: string) {
  return (element: BoxRenderable) => {
    elements.set(key, element)
    onCleanup(() => {
      if (elements.get(key) === element) elements.delete(key)
    })
  }
}

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
  /**
   * What there is to know about the item beyond its title, as data (a path, a state, a time). It is drawn on the
   * panel's fixed note line while the item is selected and never under the row, so the rows do not move with the
   * selection. Line breaks become spaces, and what is wider than the line is cut. A text that only explains what the
   * title already says is not a detail: leave it out.
   */
  detail?: string
  disabled?: boolean
  suggested?: boolean
}

/** The detail of an item as one line, empty for none: line breaks become spaces, escapes and control characters go. */
function detailLine<T>(item: ListItem<T> | undefined): string {
  return item?.detail === undefined ? "" : remoteLine(item.detail)
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
  const tuiConfig = useTuiConfig()
  let scroll: ScrollBoxRenderable | undefined

  const [filter, setFilter] = createSignal("")
  // The rows and the group headings that are mounted, to bring the selected row into view.
  const rowRefs = new Map<string, BoxRenderable>()
  const headingRefs = new Map<string, BoxRenderable>()
  let input: InputRenderable | undefined

  const filterEnabled = () => props.filter !== false
  const clientFilter = () => props.filter === false || typeof props.filter !== "object" || props.filter.client !== false
  const placeholder = () => (typeof props.filter === "object" ? props.filter.placeholder : undefined)
  const actions = createMemo(() => props.actions ?? [])

  const filtered = createMemo(() => {
    const items = props.items.filter((item) => item.disabled !== true)
    if (!filterEnabled() || !clientFilter()) return items
    const needle = filter().trim().toLowerCase()
    if (!needle) return items
    return fuzzysort.go(needle, items, { key: "title" }).map((result) => result.obj)
  })

  // The groups, in the order their first item comes, compared by value. What an item says of its group follows the
  // owner's data (a sub-agent moves between groups as its state does), so this is worked out again and again, and a
  // group that is still there must not be mounted anew for it. The items of a group are told apart the same way, by
  // id, where the group is drawn.
  const groups = createMemo<string[]>(() => [...new Set(filtered().map((item) => item.group ?? ""))], [], {
    equals: sameStrings,
  })
  // The items in the order they are drawn, the items of a group together.
  const flat = createMemo(() => {
    const items = filtered()
    const names = groups()
    return names.length < 2 ? items : names.flatMap((name) => items.filter((item) => (item.group ?? "") === name))
  })
  const itemByID = createMemo(() => new Map(flat().map((item) => [item.id, item] as const)))
  // Where each item stands, as its group and its id in the order drawn. It changes when rows come, go or move to
  // another group, and does not change when only what an item says changes.
  const places = createMemo<string[]>(() => flat().map((item) => `${item.group ?? ""}\u0000${item.id}`), [], {
    equals: sameStrings,
  })
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
  // A list where some item has a detail keeps the line for it as the selection moves, blank for the items that have
  // none, so the rows and the height of the panel do not change with the selection. A list where none has one has no
  // such line. The first item with a detail ends the search, and only the selected item is read after that.
  const hasDetail = createMemo(() => props.items.some((item) => item.disabled !== true && detailLine(item) !== ""))
  const note = createMemo(() => (hasDetail() ? detailLine(selectedItem()) : undefined))

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

  /**
   * Brings the selected row into the view of the scroll area, and the heading of its group with it when it is the first
   * row of the group: the heading is above the row, and a view that stops at the row's top edge would leave it out.
   */
  function reveal() {
    revealQueued = false
    const item = untrack(selectedItem)
    const row = item ? rowRefs.get(item.id) : undefined
    if (!item || !row || !scroll || scroll.isDestroyed || !within(row, scroll)) return
    scroll.scrollChildIntoView(row)
    const group = item.group ?? ""
    if (!group || untrack(flat).find((candidate) => (candidate.group ?? "") === group)?.id !== item.id) return
    const heading = headingRefs.get(group)
    if (heading && within(heading, scroll)) scroll.scrollChildIntoView(heading)
  }

  // A row that an update has just made is in the tree only when the update is over, and the scroll area refuses to be
  // scrolled to a node that is not under it, so the request waits for the end of the update. Several asked for at
  // once are one.
  let revealQueued = false
  function scheduleReveal() {
    if (revealQueued) return
    revealQueued = true
    queueMicrotask(reveal)
  }

  // The selected row is in view after anything that could have taken it out: the selection moves (a key, a click, the
  // list starting over at the first row), or rows come, go or change group (the owner's data refreshes, the filter
  // narrows the list). It is not asked of the wheel, which only moves the view: that is the user's to do, and the
  // next key that moves the selection brings the view back to it.
  createEffect(on([() => selectedItem()?.id, places, () => props.loading], scheduleReveal))

  function moveTo(next: number, preview = true) {
    const items = flat()
    if (items.length === 0) return
    const index = ((next % items.length) + items.length) % items.length
    const item = items[index]
    if (!item) return
    const stays = selectedItem()?.id === item.id
    setSelectedID(item.id)
    // A move that leaves the selection where it is changes nothing the effect above follows, and the wheel may have
    // taken the view away from it.
    if (stays) scheduleReveal()
    if (preview) props.onMove?.(item)
  }

  function move(direction: number) {
    moveTo(selected() + direction)
  }

  /** A page of items up or down; at the first or the last item it stops, where `move` wraps round. */
  function page(direction: number) {
    const last = flat().length - 1
    if (last < 0) return
    moveTo(Math.min(last, Math.max(0, selected() + direction * PAGE_ITEMS)))
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
      { name: "panel.page_up", title: "Page up", category: "Panel", run: () => page(-1) },
      { name: "panel.page_down", title: "Page down", category: "Panel", run: () => page(1) },
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
      note={note()}
      filter={
        filterEnabled() ? (
          // On the shell's fixed filter row, not in the scroll area: it stays in view, and the cursor with it.
          <>
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
                placeholderColor={textFg(theme, "secondary")}
                focusedBackgroundColor={theme.backgroundPanel}
                focusedTextColor={textFg(theme, "body")}
                cursorColor={theme.primary}
              />
            </box>
          </>
        ) : undefined
      }
    >
      <Show when={!props.loading} fallback={<text fg={textFg(theme, "secondary")}>{t("panel.list.loading")}</text>}>
        <Show
          when={flat().length > 0}
          fallback={props.empty ?? <text fg={textFg(theme, "secondary")}>{t("panel.list.empty")}</text>}
        >
          <For each={groups()}>
            {(group, groupIndex) => {
              // The ids of the group's items, in order. A row is mounted for an id, so the owner building its items
              // again with the same ids (a refresh of the data) keeps the rows it has; only an item that changes group
              // is mounted anew, in its new group.
              const ids = createMemo<string[]>(
                () => filtered().flatMap((item) => ((item.group ?? "") === group ? [item.id] : [])),
                [],
                { equals: sameStrings },
              )
              return (
                <>
                  <Show when={group}>
                    <box
                      ref={remember(headingRefs, group)}
                      height={groupIndex() > 0 ? 2 : 1}
                      flexShrink={0}
                      paddingTop={groupIndex() > 0 ? 1 : 0}
                    >
                      <text fg={textFg(theme, "group")} wrapMode="none">
                        {group}
                      </text>
                    </box>
                  </Show>
                  <For each={ids()}>
                    {(id) => {
                      // The row reads its item where it is drawn, so an item built again under the same id changes the
                      // row's text and not the row.
                      const item = createMemo(() => itemByID().get(id))
                      const isSelected = () => selectedItem()?.id === id
                      const isCurrent = () => currentItem()?.id === id
                      // The row is one line whether it is selected or not: what there is to say about the selected
                      // item goes on the note line of the shell, so no row moves as the selection does.
                      return (
                        <Show when={item()}>
                          {(shown) => (
                            <box
                              ref={remember(rowRefs, id)}
                              height={1}
                              flexShrink={0}
                              flexDirection="row"
                              backgroundColor={isSelected() ? theme.backgroundSelected : undefined}
                              onMouseDown={() => moveTo(flat().findIndex((candidate) => candidate.id === id))}
                              onMouseUp={() => props.onSelect(shown())}
                            >
                              <text
                                flexShrink={0}
                                fg={isCurrent() || isSelected() ? theme.primary : theme.textDim}
                                wrapMode="none"
                              >
                                {isCurrent() ? "● " : isSelected() ? "› " : "  "}
                              </text>
                              <Show
                                when={typeof shown().lead === "string"}
                                fallback={<box flexShrink={0}>{shown().lead}</box>}
                              >
                                <text flexShrink={0} wrapMode="none">
                                  {shown().lead as string}
                                </text>
                              </Show>
                              <text
                                flexGrow={1}
                                flexShrink={1}
                                overflow="hidden"
                                wrapMode="none"
                                attributes={isSelected() ? TextAttributes.BOLD : undefined}
                              >
                                {shown().title}
                              </text>
                              <Show
                                when={typeof shown().trail === "string"}
                                fallback={<box flexShrink={0}>{shown().trail}</box>}
                              >
                                <text flexShrink={0} fg={textFg(theme, "secondary")} wrapMode="none">
                                  {shown().trail as string}
                                </text>
                              </Show>
                            </box>
                          )}
                        </Show>
                      )
                    }}
                  </For>
                </>
              )
            }}
          </For>
        </Show>
      </Show>
    </PanelShell>
  )
}
