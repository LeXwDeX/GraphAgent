// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useBindings, useKeymap, useKeymapSelector } from "@opentui/keymap/solid"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, type JSX } from "solid-js"
import { createCounters, type PerfCounters } from "./counters"

/**
 * Negative controls for the P3/P4 counters. A counter that reads zero proves
 * nothing until the same counter is shown to read more than zero for the failure
 * it guards: the layer counter used to wrap `keymap.registerLayer`, which Solid's
 * `useBindings` never calls, so the cascade it was meant to catch counted as 0.
 */

const command = { name: "perf.control", run() {} }
const binding = { key: "x", cmd: "perf.control" }

type TestApp = Awaited<ReturnType<typeof testRender>>

// oxlint-disable-next-line typescript-eslint/unbound-method -- identity checks only, never called
const registerLayerOf = (keymap: ReturnType<typeof createDefaultOpenTuiKeymap>) => keymap.registerLayer

/** Mounts `body` under a real default keymap with the perf counters attached, and runs `run` while it is alive. */
async function withCounters(
  body: () => JSX.Element,
  run: (context: { app: TestApp; counters: PerfCounters }) => Promise<void>,
) {
  let counters!: PerfCounters
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    counters = createCounters(renderer, keymap)
    onCleanup(() => counters.dispose())
    return <KeymapProvider keymap={keymap}>{body()}</KeymapProvider>
  }
  const app = await testRender(() => <Harness />, { width: 40, height: 10 })
  try {
    await app.renderOnce()
    await run({ app, counters })
  } finally {
    app.renderer.destroy()
  }
}

async function typeKeys(app: TestApp, keys: string) {
  for (const key of keys) {
    app.mockInput.pressKey(key)
    await app.renderOnce()
  }
}

/** A component whose bindings depend on a signal that changes with every key. */
function KeyDriven(props: { readIn: "accessor" | "enabled" }) {
  const renderer = useRenderer()
  const [presses, setPresses] = createSignal(0)
  const onKey = () => setPresses((value) => value + 1)
  renderer.keyInput.on("keypress", onKey)
  onCleanup(() => renderer.keyInput.off("keypress", onKey))
  useBindings(() => ({
    // Read in the accessor, the effect that registers the layer depends on the
    // signal. Read in `enabled`, the keymap evaluates it lazily on dispatch.
    enabled: props.readIn === "accessor" ? presses() >= 0 : () => presses() >= 0,
    commands: [command],
    bindings: [binding],
  }))
  return <box />
}

test("a useBindings accessor that reads a per-key signal is counted on every key", async () => {
  await withCounters(
    () => <KeyDriven readIn="accessor" />,
    async ({ app, counters }) => {
      const before = counters.snapshot()
      await typeKeys(app, "abcdefghij")

      expect(counters.delta(before).registerLayer).toBe(10)
    },
  )
})

test("a per-key signal read inside `enabled` registers nothing", async () => {
  await withCounters(
    () => <KeyDriven readIn="enabled" />,
    async ({ app, counters }) => {
      const before = counters.snapshot()
      await typeKeys(app, "abcdefghij")

      expect(counters.delta(before).registerLayer).toBe(0)
    },
  )
})

test("the public registerLayer path is still counted", async () => {
  let register!: () => () => void
  function Probe() {
    const keymap = useKeymap()
    register = () => keymap.registerLayer({ commands: [command], bindings: [binding] })
    return <box />
  }
  await withCounters(
    () => <Probe />,
    async ({ counters }) => {
      const before = counters.snapshot()
      const off = register()
      off()

      expect(counters.delta(before).registerLayer).toBe(1)
    },
  )
})

test("tearing a useBindings layer down is not a registration", async () => {
  let setShown!: (value: boolean) => void
  function Toggle() {
    const [shown, set] = createSignal(true)
    setShown = set
    return <>{shown() ? <KeyDriven readIn="enabled" /> : <box />}</>
  }
  await withCounters(
    () => <Toggle />,
    async ({ app, counters }) => {
      const before = counters.snapshot()
      setShown(false)
      await app.renderOnce()

      expect(counters.delta(before).registerLayer).toBe(0)
    },
  )
})

test("mounting a useBindings layer is a registration", async () => {
  let setShown!: (value: boolean) => void
  function Toggle() {
    const [shown, set] = createSignal(false)
    setShown = set
    return <>{shown() ? <KeyDriven readIn="enabled" /> : <box />}</>
  }
  await withCounters(
    () => <Toggle />,
    async ({ app, counters }) => {
      const before = counters.snapshot()
      setShown(true)
      await app.renderOnce()

      expect(counters.delta(before).registerLayer).toBe(1)
    },
  )
})

test("dispose puts the keymap methods back", async () => {
  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>
  function Harness() {
    keymap = createDefaultOpenTuiKeymap(useRenderer())
    return <KeymapProvider keymap={keymap}>{<box />}</KeymapProvider>
  }
  const app = await testRender(() => <Harness />, { width: 20, height: 4 })
  try {
    const original = registerLayerOf(keymap)
    const counters = createCounters(app.renderer, keymap)
    expect(registerLayerOf(keymap)).not.toBe(original)
    counters.dispose()
    expect(registerLayerOf(keymap)).toBe(original)
  } finally {
    app.renderer.destroy()
  }
})

test("the selector counter moves when a keymap selector re-evaluates", async () => {
  // P4 counts the queries selectors make; a state change re-runs every
  // `useKeymapSelector`, so setting keymap data must move the counter.
  let setData!: (value: number) => void
  function Selector() {
    const keymap = useKeymap()
    setData = (value) => keymap.setData("perf.control", value)
    useKeymapSelector((instance) => instance.getCommandEntries({ visibility: "registered" }).length)
    return <box />
  }
  await withCounters(
    () => <Selector />,
    async ({ counters }) => {
      const before = counters.snapshot()
      setData(1)
      setData(2)

      expect(counters.delta(before).selectorEvaluations).toBeGreaterThan(0)
    },
  )
})
