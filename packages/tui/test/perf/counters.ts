import { CliRenderEvents, type CliRenderer, type Renderable } from "@opentui/core"
import type { OpenTuiKeymap } from "../../src/keymap"

export type CounterSnapshot = {
  frameEvents: number
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
  dispose(): void
}

export function createCounters(renderer: CliRenderer, keymap: OpenTuiKeymap): PerfCounters {
  const counts: CounterSnapshot = {
    frameEvents: 0,
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

  const snapshot = (): CounterSnapshot => ({ ...counts })
  const delta = (before: CounterSnapshot): CounterSnapshot => ({
    frameEvents: counts.frameEvents - before.frameEvents,
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
    dispose() {
      renderer.off(CliRenderEvents.FRAME, onFrame)
      keymap.registerLayer = originalRegisterLayer
      keymap.getCommandBindings = originalGetCommandBindings
      keymap.getCommandEntries = originalGetCommandEntries
    },
  }
}
