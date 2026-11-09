// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { useRenderer } from "@opentui/solid"
import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  Show,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { EscapePriority, useBindings, useGraphagentModeStack } from "../keymap"

/** Panels keep their own stack; the bottom zone renders only while it has an entry. */
export const MAX_PANEL_DEPTH = 3

export interface PanelSpec {
  id?: string
  render: () => JSX.Element
  /** Runs when the host closes this entry through escape or ctrl+c. */
  onClose?: () => void
}

export interface PanelHostApi {
  stack: Accessor<readonly PanelSpec[]>
  depth: Accessor<number>
  top: Accessor<PanelSpec | undefined>
  /** Returns false when the stack is already at MAX_PANEL_DEPTH. */
  push(spec: PanelSpec): boolean
  pop(): PanelSpec | undefined
  /** Pops the top entry and runs its `onClose` hook. */
  close(): PanelSpec | undefined
  clear(): void
  /** Clears the stack and runs every `onClose` hook in last-in-first-out order. */
  closeAll(): void
}

export function createPanelHost(): PanelHostApi {
  const [stack, setStack] = createSignal<readonly PanelSpec[]>([])

  const push = (spec: PanelSpec) => {
    let added = false
    setStack((current) => {
      if (current.length >= MAX_PANEL_DEPTH) return current
      added = true
      return [...current, spec]
    })
    return added
  }

  return {
    stack,
    depth: () => stack().length,
    top: () => stack().at(-1),
    push,
    pop() {
      const top = stack().at(-1)
      if (!top) return undefined
      setStack((current) => current.slice(0, -1))
      return top
    },
    close() {
      const top = stack().at(-1)
      if (!top) return undefined
      setStack((current) => current.slice(0, -1))
      top.onClose?.()
      return top
    },
    clear() {
      setStack([])
    },
    closeAll() {
      const entries = [...stack()].reverse()
      if (entries.length === 0) return
      setStack([])
      for (const entry of entries) entry.onClose?.()
    },
  }
}

const PanelHostContext = createContext<PanelHostApi>()

export function PanelHostProvider(props: ParentProps<{ host?: PanelHostApi }>) {
  const host = props.host ?? createPanelHost()
  return <PanelHostContext.Provider value={host}>{props.children}</PanelHostContext.Provider>
}

export function usePanelHost() {
  const host = useContext(PanelHostContext)
  if (!host) throw new Error("usePanelHost must be used within a PanelHostProvider")
  return host
}

/** Zero means the hint row should not advertise the host close binding. */
export function usePanelHostDepth() {
  return useContext(PanelHostContext)?.depth() ?? 0
}

/**
 * Renders the top entry of the host stack. Only the top panel is mounted so
 * lower entries cannot keep keymap layers active while a child panel is open.
 */
export function PanelHost(props: { host: PanelHostApi }) {
  const renderer = useRenderer()
  const modeStack = useGraphagentModeStack()

  createEffect(() => {
    if (props.host.depth() === 0) return
    const popMode = modeStack.push("modal")
    onCleanup(popMode)
  })

  function closeTop() {
    props.host.close()
  }

  function closeAll() {
    props.host.closeAll()
  }

  useBindings(() => ({
    priority: EscapePriority.modal,
    enabled: props.host.depth() > 0 && !renderer.getSelection()?.getSelectedText(),
    commands: [
      {
        name: "panel.close",
        title: "Close panel",
        category: "Panel",
        run: closeTop,
      },
      {
        name: "panel.close_all",
        title: "Close all panels",
        category: "Panel",
        run: closeAll,
      },
    ],
    bindings: [
      { key: "escape", cmd: "panel.close", desc: "Close panel", group: "Panel" },
      { key: "ctrl+c", cmd: "panel.close_all", desc: "Close all panels", group: "Panel" },
    ],
  }))

  return (
    <Show when={props.host.top()} keyed>
      {(entry) => (
        <box width="100%" flexShrink={0}>
          {entry.render()}
        </box>
      )}
    </Show>
  )
}
