// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Renderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  Show,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { EscapePriority, useBindings } from "../keymap"
import { createPanelHost, PanelHost, PanelHostProvider, type PanelHostApi, type PanelSpec } from "../panel/host"

/**
 * Non-modal detail panel stacked above the composer. It keeps focus in the
 * input, never dims the main area, and sits on its own escape layer. Content
 * and close semantics belong to the owning feature (C3).
 */
export interface AsidePanelSpec {
  id?: string
  render(): JSX.Element
  onClose?(): void
}

/**
 * Queue entry for the bottom-zone state machine. The full permission,
 * question, confirm, and choice union lives in `ask/ask-queue.ts`; the zone
 * only needs a stable identity and the surface that renders it.
 */
export interface AskRequest {
  id: string
  render(): JSX.Element
}

/** Active bottom-zone surface: ask wins over panel, and panel wins over composer. */
export type BottomState =
  | { kind: "composer"; aside?: AsidePanelSpec }
  | { kind: "panel"; stack: PanelSpec[] }
  | { kind: "ask"; queue: AskRequest[]; suspended?: PanelSpec[] }

export interface BottomZoneOptions {
  host?: PanelHostApi
  aside?: AsidePanelSpec
  ask?: readonly AskRequest[]
}

export interface BottomZoneStateApi {
  state: Accessor<BottomState>
  host: PanelHostApi
  aside: Accessor<AsidePanelSpec | undefined>
  /** True while a panel or ask surface covers the main area. */
  dimmed: Accessor<boolean>
  /** The composer stays mounted through every state so drafts survive. */
  composerVisible: Accessor<boolean>
  openAside(spec: AsidePanelSpec): void
  closeAside(): AsidePanelSpec | undefined
  /** Appends local requests; the head is shown first and panels are suspended. */
  ask(...requests: readonly AskRequest[]): void
  /**
   * Replaces the declarative permission/question queue while keeping local
   * confirm/choice entries. The route calls this from a memo over `askQueue`.
   */
  setAsk(requests: readonly AskRequest[]): void
  /** Removes the head request; panels resume once the queue drains. */
  resolveAsk(): AskRequest | undefined
  clearAsk(): readonly AskRequest[]
}

export function createBottomZoneState(options: BottomZoneOptions = {}): BottomZoneStateApi {
  const host = options.host ?? createPanelHost()
  const [aside, setAside] = createSignal<AsidePanelSpec | undefined>(options.aside)
  // Declarative entries mirror the server ask stores; local entries belong to
  // surrounding UI (confirm/choice in PR4b). The declarative head answers first.
  const [declarative, setDeclarative] = createSignal(options.ask ?? [])
  const [local, setLocal] = createSignal<AskRequest[]>([])
  const queue = createMemo(() => [...declarative(), ...local()])

  const state = createMemo<BottomState>(() => {
    const asks = queue()
    if (asks.length > 0) return { kind: "ask", queue: [...asks], suspended: [...host.stack()] }
    const panels = host.stack()
    if (panels.length > 0) return { kind: "panel", stack: [...panels] }
    return { kind: "composer", aside: aside() }
  })

  return {
    state,
    host,
    aside,
    dimmed: () => state().kind !== "composer",
    composerVisible: () => state().kind === "composer",
    openAside(spec) {
      setAside(spec)
    },
    closeAside() {
      const current = aside()
      if (!current) return undefined
      setAside(undefined)
      return current
    },
    ask(...requests) {
      if (requests.length === 0) return
      setLocal((current) => [...current, ...requests])
    },
    setAsk(requests) {
      setDeclarative(() => [...requests])
    },
    resolveAsk() {
      const head = queue()[0]
      if (!head) return undefined
      if (declarative().length > 0) setDeclarative((current) => current.slice(1))
      else setLocal((current) => current.slice(1))
      return head
    },
    clearAsk() {
      const cleared = queue()
      if (cleared.length === 0) return cleared
      setDeclarative([])
      setLocal([])
      return cleared
    },
  }
}

export interface BottomZoneProps {
  state: BottomZoneStateApi
  /** Input area; it remains mounted while hidden so the draft is preserved. */
  composer: JSX.Element
}

const BottomZoneContext = createContext<BottomZoneStateApi>()

/**
 * Shares the bottom-zone state with adjacent regions such as the prompt and
 * command handlers. The host is provided here as well so panels can be pushed
 * from outside the rendered `BottomZone` subtree.
 */
export function BottomZoneProvider(props: ParentProps<{ state?: BottomZoneStateApi }>) {
  const state = props.state ?? createBottomZoneState()
  return (
    <BottomZoneContext.Provider value={state}>
      <PanelHostProvider host={state.host}>{props.children}</PanelHostProvider>
    </BottomZoneContext.Provider>
  )
}

/** Components shared by tests and the app; returns undefined outside a provider. */
export function useBottomZoneOptional() {
  return useContext(BottomZoneContext)
}

export function useBottomZone() {
  const state = useContext(BottomZoneContext)
  if (!state) throw new Error("useBottomZone must be used within a BottomZoneProvider")
  return state
}

function contains(root: Renderable, target: Renderable) {
  if (root === target) return true
  for (const child of root.getChildren()) {
    if (contains(child, target)) return true
  }
  return false
}

/**
 * Bottom state machine: ask > panel > composer. Panels suspend implicitly
 * because the host keeps its stack while the ask surface is shown; hidden
 * entries neither render nor keep key layers active. The composer is only
 * hidden, never unmounted, so its draft survives panels and asks.
 */
export function BottomZone(props: BottomZoneProps) {
  const renderer = useRenderer()
  let savedFocus: Renderable | undefined

  const aside = () => {
    const current = props.state.state()
    return current.kind === "composer" ? current.aside : undefined
  }
  const askHead = createMemo(() => {
    const current = props.state.state()
    return current.kind === "ask" ? current.queue[0] : undefined
  })

  createEffect(
    on(
      () => props.state.state().kind,
      (kind, previous) => {
        if (!previous || previous === kind) return
        if (previous === "composer") {
          const focused = renderer.currentFocusedRenderable
          if (!focused) return
          savedFocus = focused
          focused.blur()
          return
        }
        if (kind !== "composer") return
        const focus = savedFocus
        savedFocus = undefined
        if (!focus) return
        queueMicrotask(() => {
          if (focus.isDestroyed) return
          if (!contains(renderer.root, focus)) return
          focus.focus()
        })
      },
    ),
  )

  function dismissAside() {
    const spec = props.state.closeAside()
    spec?.onClose?.()
  }

  useBindings(() => ({
    priority: EscapePriority.detail,
    enabled: () => props.state.state().kind === "composer" && props.state.aside() !== undefined,
    commands: [
      {
        name: "panel.aside.close",
        title: "Close aside panel",
        category: "Panel",
        run: dismissAside,
      },
    ],
    bindings: [{ key: "escape", cmd: "panel.aside.close", desc: "Close aside panel", group: "Panel" }],
  }))

  return (
    <PanelHostProvider host={props.state.host}>
      <box width="100%" flexShrink={0} flexDirection="column">
        <Show when={aside()}>
          {(spec) => (
            <box width="100%" flexShrink={0}>
              {spec().render()}
            </box>
          )}
        </Show>
        <box width="100%" flexShrink={0} visible={props.state.composerVisible()}>
          {props.composer}
        </box>
        <Show when={props.state.state().kind === "panel"}>
          <PanelHost host={props.state.host} />
        </Show>
        <Show when={askHead()} keyed>
          {(request) => (
            <box width="100%" flexShrink={0}>
              {request.render()}
            </box>
          )}
        </Show>
      </box>
    </PanelHostProvider>
  )
}
