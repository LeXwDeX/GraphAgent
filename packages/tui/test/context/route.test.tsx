// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { unwrap } from "solid-js/store"
import {
  RouteProvider,
  snapshotRoute,
  useRoute,
  type DiffRoute,
  type Route,
  type SessionRoute,
} from "../../src/context/route"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider } from "../../src/context/runtime"

const paths = {
  cwd: "/tmp/opencode/packages/tui",
  home: "/tmp/opencode/home",
  state: "/tmp/opencode/state",
  worktree: "/tmp/opencode",
}

async function renderStartup(initialRoute: unknown) {
  let route!: ReturnType<typeof useRoute>

  function Probe() {
    route = useRoute()
    return <box />
  }

  const app = await testRender(
    () => (
      <TuiPathsProvider value={paths}>
        <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
          <TuiStartupProvider value={{ initialRoute, skipInitialLoading: false }}>
            <RouteProvider>
              <Probe />
            </RouteProvider>
          </TuiStartupProvider>
        </TuiTerminalEnvironmentProvider>
      </TuiPathsProvider>
    ),
    { width: 40, height: 10 },
  )
  await app.renderOnce()
  return {
    app,
    route: () => unwrap(route.data) as Route,
  }
}

test("startup resolves a home deep link", async () => {
  const harness = await renderStartup({ type: "home" })
  try {
    expect(harness.route()).toEqual({ type: "home" })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("startup resolves a session deep link", async () => {
  const harness = await renderStartup({ type: "session", sessionID: "session-1" })
  try {
    expect(harness.route()).toEqual({ type: "session", sessionID: "session-1" })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("startup rejects the internal diff route and falls back to home", async () => {
  const harness = await renderStartup({
    type: "diff",
    params: { mode: "git", sessionID: "session-1" },
    returnRoute: { type: "session", sessionID: "session-1" },
  })
  try {
    expect(harness.route()).toEqual({ type: "home" })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("startup drops plugin routes and malformed values", async () => {
  for (const value of [
    { type: "plugin", name: "diff", params: {} },
    { type: "session" },
    { type: "session", sessionID: 1 },
    "session:session-1",
  ]) {
    const harness = await renderStartup(value)
    try {
      expect(harness.route()).toEqual({ type: "home" })
    } finally {
      harness.app.renderer.destroy()
    }
  }
})

test("startup without a deep link starts on home", async () => {
  const harness = await renderStartup(undefined)
  try {
    expect(harness.route()).toEqual({ type: "home" })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("snapshotRoute copies home and session routes shallowly", () => {
  const session: SessionRoute = { type: "session", sessionID: "session-1", prompt: { input: "draft", parts: [] } }
  const copy = snapshotRoute(session) as SessionRoute
  expect(copy).toEqual(session)
  expect(copy).not.toBe(session)
  expect(snapshotRoute({ type: "home" })).toEqual({ type: "home" })
})

test("snapshotRoute copies the diff params and return route chain", () => {
  const route: DiffRoute = {
    type: "diff",
    params: { mode: "git", sessionID: "session-1", messageID: "message-1" },
    returnRoute: { type: "session", sessionID: "session-1" },
  }
  const copy = snapshotRoute(route)
  expect(copy).toEqual(route)
  expect(copy).not.toBe(route)
  expect(copy.type).toBe("diff")
  if (copy.type !== "diff") throw new Error("expected a diff route")
  expect(copy.params).not.toBe(route.params)
  expect(copy.returnRoute).not.toBe(route.returnRoute)
})
