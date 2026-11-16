// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { useLocal } from "../../src/context/local"
import { json } from "../fixture/tui-sdk"
import { mountRoute } from "../routes/dag-mode-harness"

/**
 * `LocalProvider` no longer imports the toast (#886 acceptance 34): it reports through the `notify` callback the
 * app provides, and the app turns each notice into a footer toast. These cases mount it the way `app.tsx` does
 * (`ToastLocalProvider`) and check that a notice reaches the toast with the text, level and duration it had when
 * the data layer called the toast itself, at the moment it did.
 */

const agent = { name: "build", mode: "primary", permission: [], options: {}, native: true }

async function mount(handler?: Parameters<typeof mountRoute>[0]["handler"]) {
  let local!: ReturnType<typeof useLocal>
  const harness = await mountRoute({
    route: { type: "home" },
    withAgentAndModel: true,
    handler,
    view: () => {
      local = useLocal()
      return <box />
    },
  })
  return { harness, local: () => local }
}

/** Every toast the footer holds: the one on show and the ones queued behind it. */
function toasts(harness: Awaited<ReturnType<typeof mount>>["harness"]) {
  const store = harness.toast()
  return [store.currentToast, ...store.queued].filter((item) => item !== null)
}

test("an unknown agent raises a warning notice that shows as a toast", async () => {
  const { harness, local } = await mount()
  try {
    expect(toasts(harness).map((item) => item.text)).not.toContain("Agent not found: missing")
    local().agent.set("missing")
    expect(toasts(harness)).toContainEqual(
      expect.objectContaining({ text: "Agent not found: missing", level: "warning", duration: 3000 }),
    )
  } finally {
    await harness.dispose()
  }
})

test("the favorite shortcut without a favorite raises an info notice", async () => {
  const { harness, local } = await mount()
  try {
    local().model.cycleFavorite(1)
    expect(toasts(harness)).toContainEqual(
      expect.objectContaining({
        text: "Add a favorite model to use this shortcut",
        level: "info",
        duration: 3000,
      }),
    )
  } finally {
    await harness.dispose()
  }
})

test("a model that is not valid raises a warning notice and is not selected", async () => {
  const { harness, local } = await mount()
  try {
    const before = local().model.current()
    expect(await local().model.set({ providerID: "ghost", modelID: "missing" })).toBe(false)
    expect(toasts(harness)).toContainEqual(
      expect.objectContaining({ text: "Model ghost/missing is not valid", level: "warning", duration: 3000 }),
    )
    expect(local().model.current()).toEqual(before)

    // Favoriting goes through the same check and the same notice.
    local().model.toggleFavorite({ providerID: "ghost", modelID: "other" })
    expect(toasts(harness)).toContainEqual(
      expect.objectContaining({ text: "Model ghost/other is not valid", level: "warning", duration: 3000 }),
    )
    expect(local().model.favorite()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("an agent whose configured model is not valid raises its notice once the agents load", async () => {
  const { harness } = await mount((url) =>
    url.pathname === "/agent" ? json([{ ...agent, model: { providerID: "ghost", modelID: "missing" } }]) : undefined,
  )
  try {
    expect(toasts(harness)).toContainEqual(
      expect.objectContaining({
        text: "Agent build's configured model ghost/missing is not valid",
        level: "warning",
        duration: 3000,
      }),
    )
  } finally {
    await harness.dispose()
  }
})
