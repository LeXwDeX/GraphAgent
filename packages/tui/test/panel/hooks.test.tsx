// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { Ticker } from "../../src/context/ticker"
import type { HookStatusEvent } from "../../src/context/hook-status"
import { setLanguage } from "../../src/i18n"
import { HooksPanel } from "../../src/panel/hooks"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"
import { json } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function fakeTicker(now = 1_005_000): Ticker {
  const [second] = createSignal(0)
  return {
    frame: () => 0,
    second,
    subscribe: () => () => {},
    subscribeSecond: () => () => {},
    at: () => () => {},
    now: () => now,
  }
}

function hookEvent(phase: HookStatusEvent["phase"], overrides: Partial<HookStatusEvent> = {}): HookStatusEvent {
  return {
    sessionID: "ses_test",
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

async function settle(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  await Bun.sleep(30)
  await app.renderOnce()
}

async function waitFor(app: Awaited<ReturnType<typeof renderAppPanel>>, condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await Bun.sleep(20)
    await app.renderOnce()
    if (condition()) return
  }
  throw new Error(`timed out waiting for ${message}`)
}

type CancelCall = { pathname: string; method: string }

async function renderHooks(options: {
  seed?: (hooks: AppPanelTestContext["hooks"]) => void
  handler?: (url: URL) => Response | undefined
  onSetup?: (context: AppPanelTestContext) => void
}) {
  const tmp = await shellState()
  const calls: CancelCall[] = []
  const app = await renderAppPanel(() => <PanelSurface spec={{ id: "hooks", render: () => <HooksPanel /> }} />, {
    width: 100,
    height: 24,
    state: tmp.path,
    ticker: fakeTicker(),
    setup: (context) => {
      options.seed?.(context.hooks)
      options.onSetup?.(context)
    },
    handler: (url) => {
      if (url.pathname.endsWith("/hook/policy/cancel")) {
        calls.push({ pathname: url.pathname, method: "POST" })
        return options.handler?.(url) ?? json({ cancelled: true })
      }
      return options.handler?.(url)
    },
  })
  return { app, tmp, calls }
}

test("lists running hooks with elapsed time and timeout", async () => {
  const { app } = await renderHooks({ seed: (hooks) => hooks.update(hookEvent("started")) })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("运行中的 hook")
    expect(frame).toContain("policy check")
    expect(frame).toContain("已运行 5s · 超时 30s")
    expect(frame).toContain("Checking model policy")
  } finally {
    app.renderer.destroy()
  }
})

test("cancels a hook only after the second enter", async () => {
  let toastText: string | undefined
  const { app, tmp, calls } = await renderHooks({
    seed: (hooks) => hooks.update(hookEvent("started")),
    onSetup: (context) => {
      const original = context.toast.show
      context.toast.show = (options) => {
        toastText = options.text
        original(options)
      }
    },
  })
  try {
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("再次回车取消 policy check")
    expect(calls).toHaveLength(0)

    app.mockInput.pressEnter()
    await waitFor(app, () => calls.length === 1, "cancel request")
    await waitFor(app, () => toastText === "已取消 policy check", "cancel toast")
    expect(calls[0]?.pathname).toBe("/session/ses_test/hook/policy/cancel")
    expect(app.captureCharFrame()).toContain("没有运行中的 hook")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("never offers a confirmation for a non-cancellable hook", async () => {
  let toastText: string | undefined
  const { app, tmp, calls } = await renderHooks({
    seed: (hooks) => hooks.update(hookEvent("started", { cancellable: false })),
    onSetup: (context) => {
      const original = context.toast.show
      context.toast.show = (options) => {
        toastText = options.text
        original(options)
      }
    },
  })
  try {
    app.mockInput.pressEnter()
    await waitFor(app, () => toastText === "该 hook 不可取消", "not-cancellable toast")
    expect(app.captureCharFrame()).not.toContain("再次回车取消")
    expect(app.captureCharFrame()).toContain("policy check")
    expect(calls).toHaveLength(0)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("never offers a confirmation when the cancel endpoint is unavailable", async () => {
  let toastText: string | undefined
  const { app, tmp, calls } = await renderHooks({
    seed: (hooks) => hooks.update(hookEvent("started")),
    onSetup: (context) => {
      context.sdk.client.session.hook.cancel = undefined as never
      const original = context.toast.show
      context.toast.show = (options) => {
        toastText = options.text
        original(options)
      }
    },
  })
  try {
    app.mockInput.pressEnter()
    await waitFor(app, () => toastText === "该 hook 不可取消", "not-cancellable toast")
    expect(app.captureCharFrame()).not.toContain("再次回车取消")
    expect(calls).toHaveLength(0)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("keeps the entry and reports a hook that already stopped", async () => {
  let toastText: string | undefined
  const { app, tmp } = await renderHooks({
    seed: (hooks) => hooks.update(hookEvent("started")),
    handler: (url) => (url.pathname.endsWith("/cancel") ? json({ cancelled: false }) : undefined),
    onSetup: (context) => {
      const original = context.toast.show
      context.toast.show = (options) => {
        toastText = options.text
        original(options)
      }
    },
  })
  try {
    app.mockInput.pressEnter()
    await settle(app)
    app.mockInput.pressEnter()
    await waitFor(app, () => toastText === "policy check 已不在运行", "missed toast")
    expect(app.captureCharFrame()).toContain("policy check")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})
