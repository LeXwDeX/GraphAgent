// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { CliRenderEvents, type CliRenderer, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { KEYMAP_EXTENSION_CONTEXT } from "@opentui/keymap"
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
  /**
   * Mounted transcript rows: the content children that hold content. The header
   * spacer, the window controller, and the placeholder boxes that stand in for
   * unmounted rows are all childless; a mounted row hosts its renderer.
   */
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
  // Solid's `useBindings` never goes through `keymap.registerLayer`: it owns a
  // layer slot and swaps its content with `layers.replaceLayer`, which the
  // keymap does not expose on its public surface. A counter that wraps only the
  // public method stays at zero while every effect re-run still compiles and
  // swaps a layer (#1025 P3). Count both entry points; they never call each
  // other, so a layer is counted once.
  const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalReplaceLayer = layers.replaceLayer
  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalGetCommandBindings = keymap.getCommandBindings
  // oxlint-disable-next-line typescript-eslint/unbound-method -- wrapped below with explicit receiver
  const originalGetCommandEntries = keymap.getCommandEntries

  keymap.registerLayer = ((layer) => {
    counts.registerLayer++
    return originalRegisterLayer.call(keymap, layer)
  }) as typeof keymap.registerLayer
  layers.replaceLayer = ((slot, layer) => {
    // `replaceLayer(slot, undefined)` only tears the slot down (a component
    // unmounting); that is not a registration.
    if (layer !== undefined) counts.registerLayer++
    return originalReplaceLayer.call(layers, slot, layer)
  }) as typeof layers.replaceLayer
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
      return scroll.getChildren().filter((node) => node.getChildren().length > 0).length
    },
    scrollChildren(scroll) {
      return scroll.getChildren().length
    },
    dispose() {
      renderer.off(CliRenderEvents.FRAME, onFrame)
      renderer.requestRender = originalRequestRender
      keymap.registerLayer = originalRegisterLayer
      layers.replaceLayer = originalReplaceLayer
      keymap.getCommandBindings = originalGetCommandBindings
      keymap.getCommandEntries = originalGetCommandEntries
    },
  }
}
