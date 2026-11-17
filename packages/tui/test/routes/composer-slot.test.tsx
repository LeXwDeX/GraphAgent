// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { AppRoutes } from "../fixture/route-frame"
import { json } from "../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "./dag-mode-harness"

// Routes install their prompt in the bottom zone's composer slot. These tests use the real home and session
// routes inside the app frame, the way `app.tsx` mounts them.

const mainID = "ses_slot_main"
const otherID = "ses_slot_other"
const childID = "ses_slot_child"

function mountApp(route: MountOptions["route"], extra: Partial<MountOptions> = {}) {
  return mountRoute({
    route,
    view: () => <AppRoutes />,
    frame: true,
    sessions: [sessionFixture(mainID), sessionFixture(otherID)],
    ...extra,
  })
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

function textareas(harness: Awaited<ReturnType<typeof mountApp>>) {
  return collect(harness.app.renderer.root).filter(
    (item): item is TextareaRenderable => item instanceof TextareaRenderable,
  )
}

test("a draft typed at home is waiting in the session prompt, and comes back home with it", async () => {
  const harness = await mountApp({ type: "home" })
  try {
    await harness.app.mockInput.typeText("from home")
    await harness.settle()
    expect(harness.promptDraft()).toBe("from home")

    harness.route().navigate({ type: "session", sessionID: mainID })
    await waitFor(() => harness.route().data.type === "session")
    await harness.settle()
    // One prompt, the session's, and it holds the draft.
    expect(textareas(harness)).toHaveLength(1)
    expect(harness.promptDraft()).toBe("from home")
    expect(await harness.frame()).toContain("from home")

    await harness.app.mockInput.typeText(", then session")
    await harness.settle()
    harness.route().navigate({ type: "home" })
    await waitFor(() => harness.route().data.type === "home")
    await harness.settle()
    expect(textareas(harness)).toHaveLength(1)
    expect(harness.promptDraft()).toBe("from home, then session")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a route that mounts after the previous one is gone installs its own composer", async () => {
  const harness = await mountApp({ type: "session", sessionID: mainID })
  try {
    const zone = harness.bottomZone()!
    const session = zone.composer()
    expect(session).toBeDefined()
    expect(harness.promptDraft()).toBe("")

    harness.route().navigate({ type: "home" })
    await waitFor(() => harness.route().data.type === "home")
    await harness.settle()
    // The home route replaced the session's composer; the session's cleanup did not take it away again.
    expect(zone.composer()).toBeDefined()
    expect(zone.composer()).not.toBe(session)
    expect(textareas(harness)).toHaveLength(1)
    expect(harness.promptDraft()).toBe("")
  } finally {
    await harness.dispose()
  }
})

test("the session prompt's @ file search runs in the session's directory", async () => {
  const directories: (string | null)[] = []
  const harness = await mountApp(
    { type: "session", sessionID: mainID },
    {
      sessions: [sessionFixture(mainID, { directory: "/work/elsewhere" })],
      handler: (url, request) => {
        if (url.pathname !== "/find/file") return undefined
        directories.push(request?.headers.get("x-graphagent-directory") ?? null)
        return json([])
      },
    },
  )
  try {
    await harness.app.mockInput.typeText("@")
    await waitFor(() => directories.length > 0)
    // The prompt is created inside the bottom zone, outside the session route's provider tree: the
    // session's location has to reach it all the same.
    expect(directories[0]).toBe(encodeURIComponent("/work/elsewhere"))
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent view has no prompt, and no footer of its own under the transcript", async () => {
  const harness = await mountApp(
    { type: "session", sessionID: childID },
    { sessions: [sessionFixture(mainID), sessionFixture(childID, { parentID: mainID })] },
  )
  try {
    await harness.settle()
    expect(textareas(harness)).toHaveLength(0)
    expect(harness.promptDraft()).toBeUndefined()
    // The old Parent/Prev/Next bar is gone: what a sub-agent view says about itself is the frame's top bar and footer.
    expect(await harness.frame()).not.toContain("Subagent")

    // The root session of the same tree has one.
    harness.route().navigate({ type: "session", sessionID: mainID })
    await waitFor(() => textareas(harness).length === 1)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
