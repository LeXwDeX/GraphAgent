// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { InputRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t, type MessageKey } from "../i18n"
import { EscapePriority, useBindings } from "../keymap"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { PanelShell, type PanelHint, type PanelTab } from "./shell"

export type SettingRow =
  | {
      id: string
      label: string
      kind: "choice"
      value: string
      options: readonly { value: string; label: string }[]
      description?: string
      onChange(value: string): void
    }
  | {
      id: string
      label: string
      kind: "toggle"
      value: boolean
      description?: string
      onChange(value: boolean): void
    }
  | {
      id: string
      label: string
      kind: "text"
      value: string
      secret?: boolean
      description?: string
      /** Returns a message key; a non-empty result blocks the commit. */
      validate?(value: string): string | undefined
      /** Muted trailing note, for example the current session state. */
      suffix?: () => string
      onChange(value: string): void
    }
  | {
      id: string
      label: string
      kind: "action"
      valueLabel?: string
      description?: string
      run(): void
    }

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

export function SettingsPanel(props: SettingsPanelProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const [internalTab, setInternalTab] = createSignal<string | undefined>(props.activeTab ?? props.tabs[0]?.id)
  const [selected, setSelected] = createSignal(0)
  const [editing, setEditing] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  let editInput: InputRenderable | undefined

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const activeTabId = () => props.activeTab ?? internalTab() ?? props.tabs[0]?.id
  const currentTab = () => props.tabs.find((tab) => tab.id === activeTabId()) ?? props.tabs[0]
  // Track the id alone: rows are rebuilt when a setting changes, and observing
  // the tab object would reset the selection after every toggle.
  const activeTabKey = createMemo(() => currentTab()?.id)
  const rows = () => currentTab()?.rows ?? []
  const selectedRow = () => rows()[selected()]
  const valueBudget = () => Math.max(4, Math.floor((dimensions().width - 8) / 2))

  createEffect(
    on(
      activeTabKey,
      () => {
        setSelected(0)
        setEditing(undefined)
        setError(undefined)
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

  function move(direction: number) {
    const all = rows()
    if (all.length === 0) return
    setSelected((current) => (current + direction + all.length) % all.length)
    setEditing(undefined)
    setError(undefined)
  }

  function moveTo(index: number) {
    if (rows().length === 0) return
    setSelected(((index % rows().length) + rows().length) % rows().length)
    setEditing(undefined)
    setError(undefined)
  }

  function cycleChoice(row: Extract<SettingRow, { kind: "choice" }>) {
    if (row.options.length === 0) return
    const index = row.options.findIndex((option) => option.value === row.value)
    const next = row.options[(index + 1) % row.options.length]
    if (next) row.onChange(next.value)
  }

  function beginEdit(row: Extract<SettingRow, { kind: "text" }>) {
    setError(undefined)
    setEditing(row.id)
  }

  function activate() {
    const row = selectedRow()
    if (!row) return
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
      { name: "panel.page_up", title: "Page up", category: "Panel", run: () => move(-10) },
      { name: "panel.page_down", title: "Page down", category: "Panel", run: () => move(10) },
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
    const result: PanelHint[] = [
      { key: "panel.previous", label: t("panel.hint.previous") },
      { key: "panel.next", label: t("panel.hint.next") },
    ]
    if (props.tabs.length > 1) result.push({ key: "panel.tab.next", label: t("panel.hint.tab") })
    result.push({ key: "panel.submit", label: submitLabel })
    result.push(...(props.hints ?? []))
    return result
  })

  function displayValue(row: SettingRow): string {
    if (row.kind === "choice") {
      return row.options.find((option) => option.value === row.value)?.label ?? t("panel.setting.empty")
    }
    if (row.kind === "toggle") return row.value ? t("panel.setting.on") : t("panel.setting.off")
    if (row.kind === "action") return row.valueLabel ?? ""
    if (row.secret) return row.value ? t("panel.setting.masked") : t("panel.setting.empty")
    return row.value || t("panel.setting.empty")
  }

  return (
    <PanelShell
      title={props.title}
      command={props.command}
      tabs={props.tabs}
      activeTab={activeTabId()}
      onTab={selectTab}
      hints={hints()}
    >
      <For each={rows()}>
        {(row, index) => {
          const isSelected = () => selected() === index()
          const isEditing = () => editing() === row.id
          return (
            <>
              <box
                height={1}
                flexShrink={0}
                flexDirection="row"
                backgroundColor={isSelected() ? theme.backgroundSelected : undefined}
                onMouseDown={() => moveTo(index())}
                onMouseUp={() => {
                  moveTo(index())
                  if (row.kind === "text") beginEdit(row)
                  else if (row.kind === "action") row.run()
                  else if (row.kind === "choice") cycleChoice(row)
                  else row.onChange(!row.value)
                }}
              >
                <text width={2} flexShrink={0} fg={isSelected() ? theme.primary : theme.textDim} wrapMode="none">
                  {isSelected() ? "› " : "  "}
                </text>
                <text
                  flexShrink={1}
                  overflow="hidden"
                  wrapMode="none"
                  attributes={isSelected() ? TextAttributes.BOLD : undefined}
                >
                  {row.label}
                </text>
                <box flexGrow={1} flexShrink={1} />
                <Show
                  when={isEditing()}
                  fallback={
                    <Show when={row.kind === "text" && (row as Extract<SettingRow, { kind: "text" }>).suffix?.()}>
                      <text flexShrink={0} fg={theme.textDim} wrapMode="none">
                        {truncateCells(
                          (row as Extract<SettingRow, { kind: "text" }>).suffix!(),
                          valueBudget(),
                          ambiguousWidth(),
                        )}{" "}
                      </text>
                    </Show>
                  }
                >
                  <box width={Math.max(8, valueBudget())} flexShrink={0}>
                    <input
                      ref={(element: InputRenderable) => {
                        editInput = element
                      }}
                      width="100%"
                      value={row.kind === "text" ? row.value : ""}
                      placeholder={t("panel.input.placeholder")}
                      placeholderColor={theme.textMuted}
                      focusedBackgroundColor={theme.backgroundPanel}
                      focusedTextColor={theme.text}
                      cursorColor={theme.primary}
                    />
                  </box>
                </Show>
                <Show when={!isEditing()}>
                  <text flexShrink={0} fg={theme.textMuted} wrapMode="none">
                    {truncateCells(displayValue(row), valueBudget(), ambiguousWidth())}
                  </text>
                </Show>
              </box>
              <Show when={isSelected() && row.description}>
                <text flexShrink={0} fg={theme.textMuted} wrapMode="none">
                  {truncateCells(row.description!, Math.max(0, dimensions().width - 8), ambiguousWidth())}
                </text>
              </Show>
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
