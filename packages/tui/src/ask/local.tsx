// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { EscapePriority, GRAPHAGENT_BASE_MODE, useBindings } from "../keymap"
import { t } from "../i18n"
import { PanelShell, type PanelHint } from "../panel/shell"
import type { AskRequest } from "./ask-queue"

type ConfirmAsk = Extract<AskRequest, { kind: "confirm" }>
type ChoiceAsk = Extract<AskRequest, { kind: "choice" }>

interface LocalOption {
  id: string
  label: string
}

function move(selected: number, delta: number, total: number) {
  if (total === 0) return 0
  return (((selected + delta + total) % total) + total) % total
}

/** Minimal confirm surface for the unified ask queue (wired by PR4b). */
export function ConfirmAskPrompt(props: { ask: ConfirmAsk }) {
  const { theme } = useTheme()
  const [store, setStore] = createStore({ selected: 0 })
  let settled = false

  const options = createMemo<LocalOption[]>(() => [
    { id: "confirm", label: props.ask.confirmLabel },
    { id: "cancel", label: props.ask.cancelLabel },
  ])

  function finish(ok: boolean) {
    if (settled) return
    settled = true
    props.ask.resolve(ok)
  }

  function choose(id: string) {
    finish(id === "confirm")
  }

  const hints = createMemo<PanelHint[]>(() => [
    { key: "ask.local.previous", label: t("ask.hint.previous") },
    { key: "ask.local.next", label: t("ask.hint.next") },
    { key: "ask.local.select", label: t("ask.hint.confirm") },
    { key: "ask.local.cancel", label: t("ask.hint.cancel") },
  ])

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    priority: EscapePriority.modal,
    commands: [
      { name: "app.exit", title: "Cancel", category: "Ask", run: () => finish(false) },
      {
        name: "ask.local.previous",
        title: "Previous option",
        category: "Ask",
        run: () => setStore("selected", (value) => move(value, -1, options().length)),
      },
      {
        name: "ask.local.next",
        title: "Next option",
        category: "Ask",
        run: () => setStore("selected", (value) => move(value, 1, options().length)),
      },
      {
        name: "ask.local.select",
        title: "Confirm selection",
        category: "Ask",
        run: () => choose(options()[store.selected]?.id ?? "cancel"),
      },
      { name: "ask.local.cancel", title: "Cancel", category: "Ask", run: () => finish(false) },
    ],
    bindings: [
      { key: "up", desc: "Previous option", group: "Ask", cmd: "ask.local.previous" },
      { key: "down", desc: "Next option", group: "Ask", cmd: "ask.local.next" },
      { key: "return", desc: "Confirm selection", group: "Ask", cmd: "ask.local.select" },
      ...options().map((option, index) => ({
        key: String(index + 1),
        desc: option.label,
        group: "Ask",
        cmd: () => {
          setStore("selected", index)
          choose(option.id)
        },
      })),
    ],
  }))

  useBindings(() => ({
    priority: EscapePriority.ask,
    bindings: [{ key: "escape", desc: "Cancel", group: "Ask", cmd: "ask.local.cancel" }],
  }))

  return (
    <PanelShell title={props.ask.title} tone={props.ask.danger ? "warning" : "default"} hints={hints()}>
      <Show when={props.ask.body}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.ask.body}</text>
        </box>
      </Show>
      <box flexDirection="column" paddingTop={1}>
        <For each={options()}>
          {(option, index) => {
            const selected = () => index() === store.selected
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                backgroundColor={selected() ? theme.backgroundSelected : undefined}
                onMouseOver={() => setStore("selected", index())}
                onMouseUp={() => {
                  setStore("selected", index())
                  choose(option.id)
                }}
              >
                <text fg={selected() ? theme.warning : theme.textMuted} flexShrink={0}>
                  {`${index() + 1}.`}
                </text>
                <text fg={selected() ? theme.warning : theme.text}>{option.label}</text>
              </box>
            )
          }}
        </For>
      </box>
    </PanelShell>
  )
}

/** Minimal choice surface for the unified ask queue (wired by PR4b). */
export function ChoiceAskPrompt(props: { ask: ChoiceAsk }) {
  const { theme } = useTheme()
  const [store, setStore] = createStore({ selected: 0 })
  let settled = false

  function finish(id: string | undefined) {
    if (settled) return
    settled = true
    props.ask.resolve(id)
  }

  const hints = createMemo<PanelHint[]>(() => [
    { key: "ask.local.previous", label: t("ask.hint.previous") },
    { key: "ask.local.next", label: t("ask.hint.next") },
    { key: "ask.local.select", label: t("ask.hint.select") },
    { key: "ask.local.cancel", label: t("ask.hint.cancel") },
  ])

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    priority: EscapePriority.modal,
    commands: [
      { name: "app.exit", title: "Cancel", category: "Ask", run: () => finish(undefined) },
      {
        name: "ask.local.previous",
        title: "Previous option",
        category: "Ask",
        run: () => setStore("selected", (value) => move(value, -1, props.ask.options.length)),
      },
      {
        name: "ask.local.next",
        title: "Next option",
        category: "Ask",
        run: () => setStore("selected", (value) => move(value, 1, props.ask.options.length)),
      },
      {
        name: "ask.local.select",
        title: "Choose option",
        category: "Ask",
        run: () => finish(props.ask.options[store.selected]?.id),
      },
      { name: "ask.local.cancel", title: "Cancel", category: "Ask", run: () => finish(undefined) },
    ],
    bindings: [
      { key: "up", desc: "Previous option", group: "Ask", cmd: "ask.local.previous" },
      { key: "down", desc: "Next option", group: "Ask", cmd: "ask.local.next" },
      { key: "return", desc: "Choose option", group: "Ask", cmd: "ask.local.select" },
      ...props.ask.options.slice(0, 9).map((option, index) => ({
        key: String(index + 1),
        desc: option.label,
        group: "Ask",
        cmd: () => {
          setStore("selected", index)
          finish(option.id)
        },
      })),
    ],
  }))

  useBindings(() => ({
    priority: EscapePriority.ask,
    bindings: [{ key: "escape", desc: "Cancel", group: "Ask", cmd: "ask.local.cancel" }],
  }))

  return (
    <PanelShell title={props.ask.title} hints={hints()}>
      <Show when={props.ask.body}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.ask.body}</text>
        </box>
      </Show>
      <box flexDirection="column" paddingTop={1}>
        <For each={props.ask.options}>
          {(option, index) => {
            const selected = () => index() === store.selected
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                backgroundColor={selected() ? theme.backgroundSelected : undefined}
                onMouseOver={() => setStore("selected", index())}
                onMouseUp={() => {
                  setStore("selected", index())
                  finish(option.id)
                }}
              >
                <text fg={selected() ? theme.warning : theme.textMuted} flexShrink={0}>
                  {`${index() + 1}.`}
                </text>
                <text fg={selected() ? theme.warning : theme.text}>{option.label}</text>
              </box>
            )
          }}
        </For>
      </box>
    </PanelShell>
  )
}
