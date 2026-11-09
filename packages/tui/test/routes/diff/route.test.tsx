// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RouteProvider, useRoute, type Route } from "../../../src/context/route"
import { useDiffNavigation } from "../../../src/routes/diff/route"
import { TestTuiContexts } from "../../fixture/tui-environment"

const sessionRoute = (): Route => ({ type: "session", sessionID: "session-1" })

async function renderNavigation(initialRoute: Route) {
  let route!: ReturnType<typeof useRoute>
  let navigation!: ReturnType<typeof useDiffNavigation>

  function Probe() {
    route = useRoute()
    navigation = useDiffNavigation()
    return <box />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <RouteProvider initialRoute={initialRoute}>
          <Probe />
        </RouteProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10 },
  )
  await app.renderOnce()
  return {
    app,
    route: () => JSON.parse(JSON.stringify(route.data)) as Route,
    navigation: () => navigation,
  }
}

test("open stores the current route as the return route", async () => {
  const harness = await renderNavigation(sessionRoute())
  try {
    harness.navigation().open({ mode: "git", sessionID: "session-1" })
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({
      type: "diff",
      params: { mode: "git", sessionID: "session-1" },
      returnRoute: { type: "session", sessionID: "session-1" },
    })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("opening from diff keeps the original return route instead of nesting", async () => {
  const harness = await renderNavigation({
    type: "diff",
    params: { mode: "git", sessionID: "session-1" },
    returnRoute: sessionRoute(),
  })
  try {
    harness.navigation().open({ mode: "branch", sessionID: "session-1" })
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({
      type: "diff",
      params: { mode: "branch", sessionID: "session-1" },
      returnRoute: { type: "session", sessionID: "session-1" },
    })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("close restores the return route from diff", async () => {
  const harness = await renderNavigation({
    type: "diff",
    params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1" },
    returnRoute: sessionRoute(),
  })
  try {
    harness.navigation().close()
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({ type: "session", sessionID: "session-1" })
  } finally {
    harness.app.renderer.destroy()
  }
})

test("close outside the diff route falls back to home", async () => {
  const harness = await renderNavigation(sessionRoute())
  try {
    harness.navigation().close()
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({ type: "home" })
  } finally {
    harness.app.renderer.destroy()
  }
})
