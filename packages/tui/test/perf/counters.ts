// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { CliRenderEvents, type CliRenderer, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import type { OpenTuiKeymap } from "../../src/keymap"

export type CounterSnapshot = {
  frameEvents: number
  renderRequests: number
  registerLayer: number
  selectorEvaluations: number
  storeMessageWrites: number
  storePartWrites: number
}

export type PerfCounters = CounterSnapshot & {
  snapshot(): CounterSnapshot
  delta(before: CounterSnapshot): CounterSnapshot
  countStoreWrite(kind: "message" | "part"): void
  frames(): number
  mountedNodes(root: Renderable): number
  /** Mounted transcript rows: content children that registered a lifecycle pass, minus the controller. */
  mountedRows(scroll: ScrollBoxRenderable): number
  scrollChildren(scroll: ScrollBoxRenderable): number
  dispose(): void
}

export function createCounters(renderer: CliRenderer, keymap: OpenTuiKeymap): PerfCounters {
  const counts: CounterSnapshot = {
    frameEvents: 0,
    renderRequests: 0,
    registerLayer: 0,
    selectorEvaluations: 0,
    storeMessageWrites: 0,
    storePartWrites: 0,
  }

  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalRegisterLayer = keymap.registerLayer
  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalGetCommandBindings = keymap.getCommandBindings
  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalGetCommandEntries = keymap.getCommandEntries

  keymap.registerLayer = ((layer) => {
    counts.registerLayer++
    return originalRegisterLayer.call(keymap, layer)
  }) as typeof keymap.registerLayer
  keymap.getCommandBindings = ((query) => {
    counts.selectorEvaluations++
    return originalGetCommandBindings.call(keymap, query)
  }) as typeof keymap.getCommandBindings
  keymap.getCommandEntries = ((query) => {
    counts.selectorEvaluations++
    return originalGetCommandEntries.call(keymap, query)
  }) as typeof keymap.getCommandEntries

  const onFrame = () => counts.frameEvents++
  renderer.on(CliRenderEvents.FRAME, onFrame)

  // Frame requests stand in for rendered frames: the test renderer only draws
  // when `renderOnce` is called, so a ticker-driven repaint shows up here one
  // request per subscribed animation tick.
  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalRequestRender = renderer.requestRender
  renderer.requestRender = ((...args: Parameters<typeof originalRequestRender>) => {
    counts.renderRequests++
    return originalRequestRender.apply(renderer, args)
  }) as typeof renderer.requestRender

  const snapshot = (): CounterSnapshot => ({ ...counts })
  const delta = (before: CounterSnapshot): CounterSnapshot => ({
    frameEvents: counts.frameEvents - before.frameEvents,
    renderRequests: counts.renderRequests - before.renderRequests,
    registerLayer: counts.registerLayer - before.registerLayer,
    selectorEvaluations: counts.selectorEvaluations - before.selectorEvaluations,
    storeMessageWrites: counts.storeMessageWrites - before.storeMessageWrites,
    storePartWrites: counts.storePartWrites - before.storePartWrites,
  })

  const mountedNodes = (root: Renderable): number =>
    1 + root.getChildren().reduce((total, child) => total + mountedNodes(child), 0)

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- lifecycle pass hook is runtime-only
  const hasLifecyclePass = (node: Renderable) => typeof (node as { onLifecyclePass?: unknown }).onLifecyclePass === "function"

  return {
    get frameEvents() {
      return counts.frameEvents
    },
    get renderRequests() {
      return counts.renderRequests
    },
    get registerLayer() {
      return counts.registerLayer
    },
    get selectorEvaluations() {
      return counts.selectorEvaluations
    },
    get storeMessageWrites() {
      return counts.storeMessageWrites
    },
    get storePartWrites() {
      return counts.storePartWrites
    },
    snapshot,
    delta,
    countStoreWrite(kind) {
      counts[kind === "message" ? "storeMessageWrites" : "storePartWrites"]++
    },
    frames() {
      return renderer.getStats().frameCount || counts.frameEvents
    },
    mountedNodes,
    mountedRows(scroll) {
      const rows = scroll.getChildren().filter(hasLifecyclePass).length
      return Math.max(0, rows - 1)
    },
    scrollChildren(scroll) {
      return scroll.getChildren().length
    },
    dispose() {
      renderer.off(CliRenderEvents.FRAME, onFrame)
      renderer.requestRender = originalRequestRender
      keymap.registerLayer = originalRegisterLayer
      keymap.getCommandBindings = originalGetCommandBindings
      keymap.getCommandEntries = originalGetCommandEntries
    },
  }
}
