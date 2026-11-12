// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, type ParentProps } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { HookStatusProvider, useHookStatus, type HookPhase, type HookStatusEvent } from "../../src/context/hook-status"
import { TickerProvider } from "../../src/context/ticker-context"
import type { Ticker } from "../../src/context/ticker"
import { setLanguage } from "../../src/i18n"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { Footer, type FooterHint } from "../../src/shell/footer"
import { useFooterStatus } from "../../src/shell/footer-status"
import { HookProgress } from "../../src/shell/hook-progress"
import { FooterToastProvider, useToast } from "../../src/ui/toast"
import { ShellContexts, renderUntil, shellState } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function createResolvedKeymapConfig() {
  const keybinds = TuiKeybind.parse({})
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

function fakeTicker() {
  let now = 1_000_000
  const [second, setSecond] = createSignal(0)
  const ticker: Ticker = {
    frame: () => 0,
    second,
    subscribe: () => () => {},
    subscribeSecond: () => () => {},
    at: () => () => {},
    now: () => now,
  }
  return {
    ticker,
    advance(ms: number) {
      now += ms
      setSecond((value) => value + 1)
    },
  }
}

const hints: readonly FooterHint[] = [{ key: "/", label: "命令" }]

function hookEvent(phase: HookPhase, overrides: Partial<HookStatusEvent> = {}): HookStatusEvent {
  return {
    sessionID: "ses_a",
    hookID: "policy",
    event: "PreToolUse",
    descriptor: "policy check",
    statusMessage: "Checking model policy",
    phase,
    timeoutMs: 30_000,
    cancellable: true,
    startedAt: 1_000_000,
    ...overrides,
  }
}

type HookFooterProps = {
  sessionID: string
  onReady?: (hooks: ReturnType<typeof useHookStatus>, toast: ReturnType<typeof useToast>) => void
}

function HookFooter(props: HookFooterProps) {
  const hooks = useHookStatus()
  const toast = useToast()
  const status = useFooterStatus(() => <HookProgress sessionID={props.sessionID} />)
  props.onReady?.(hooks, toast)
  return <Footer agent="build" agentAction="tab" hints={hints} right={status()} />
}

function KeymapHarness(props: ParentProps) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createResolvedKeymapConfig()
  onCleanup(registerGraphagentKeymap(keymap, renderer, config))
  return <GraphagentKeymapProvider keymap={keymap}>{props.children}</GraphagentKeymapProvider>
}

async function renderHookFooter() {
  const state = await shellState()
  const fake = fakeTicker()
  let hooks!: ReturnType<typeof useHookStatus>
  let toast!: ReturnType<typeof useToast>
  const app = await testRender(
    () => (
      <ShellContexts state={state.path}>
        <KeymapHarness>
          <FooterToastProvider>
            <TickerProvider ticker={fake.ticker}>
              <HookStatusProvider>
                <HookFooter
                  sessionID="ses_a"
                  onReady={(value, toasts) => {
                    hooks = value
                    toast = toasts
                  }}
                />
              </HookStatusProvider>
            </TickerProvider>
          </FooterToastProvider>
        </KeymapHarness>
      </ShellContexts>
    ),
    { width: 80, height: 1 },
  )
  // The footer mounts once the providers are ready; wait for its `onReady` before a
  // test drives the hook store.
  await renderUntil(app, () => Boolean(hooks && toast), "the hook footer to mount")
  await app.renderOnce()
  return { app, fake, hooks: () => hooks, toast: () => toast }
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string, present: boolean) {
  await renderUntil(
    app,
    () => app.captureCharFrame().includes(text) === present,
    `the frame to ${present ? "show" : "hide"} ${JSON.stringify(text)}`,
  )
}

test("shows a started hook in the footer shared slot", async () => {
  const { app, hooks } = await renderHookFooter()
  try {
    expect(app.captureCharFrame()).not.toContain("hook policy check")
    hooks().update(hookEvent("started"))
    await waitForFrame(app, "hook policy check · 0s", true)
  } finally {
    app.renderer.destroy()
  }
})

test.each(["finished", "cancelled", "timeout"] as const)("hides the hook after %s", async (phase) => {
  const { app, hooks } = await renderHookFooter()
  try {
    hooks().update(hookEvent("started"))
    await waitForFrame(app, "hook policy check", true)
    hooks().update(hookEvent(phase))
    await waitForFrame(app, "hook policy check", false)
  } finally {
    app.renderer.destroy()
  }
})

test("counts elapsed time from startedAt", async () => {
  const { app, fake, hooks } = await renderHookFooter()
  try {
    hooks().update(hookEvent("started", { startedAt: fake.ticker.now() - 5_000 }))
    await waitForFrame(app, "hook policy check · 5s", true)
    fake.advance(2_000)
    await waitForFrame(app, "hook policy check · 7s", true)
  } finally {
    app.renderer.destroy()
  }
})

test("yields the shared slot to a toast and comes back after it is dismissed", async () => {
  const { app, hooks, toast } = await renderHookFooter()
  try {
    hooks().update(hookEvent("started"))
    await waitForFrame(app, "hook policy check", true)
    toast().show({ text: "toast wins", level: "info", duration: 30_000 })
    await waitForFrame(app, "toast wins", true)
    expect(app.captureCharFrame()).not.toContain("hook policy check")
    toast().dismiss()
    await waitForFrame(app, "hook policy check", true)
  } finally {
    app.renderer.destroy()
  }
})

test("ignores hooks that belong to another session", async () => {
  const { app, hooks } = await renderHookFooter()
  try {
    hooks().update(hookEvent("started", { sessionID: "ses_b" }))
    await waitForFrame(app, "hook policy check", false)
  } finally {
    app.renderer.destroy()
  }
})
