// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { ReferenceInfo } from "@graphagent/sdk"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../src/i18n"
import { Home } from "../../src/routes/home"
import { json } from "../fixture/tui-sdk"
import { mountRoute, waitFor } from "../routes/dag-mode-harness"

/**
 * #886 5.7: the `@alias` popup lists the entries of `sync.data.reference`, which the bootstrap
 * fills from `GET /reference`. `sync-f1-data-layer.test.tsx` covers the store; these tests
 * mount the real prompt and its autocomplete and check what the popup does with that store.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const references: ReferenceInfo[] = [
  { name: "docs", path: "/repo/docs", description: "Project docs", source: { type: "local", path: "../docs" } },
  { name: "design", path: "/repo/design", source: { type: "git", repository: "https://example.test/org/design.git" } },
  { name: "vault", path: "/repo/vault", hidden: true, source: { type: "local", path: "vault" } },
]

async function mountHome(list: readonly ReferenceInfo[] = references) {
  const harness = await mountRoute({
    route: { type: "home" },
    view: () => <Home />,
    handler: (url) => {
      if (url.pathname === "/reference") return json(list)
      // Typing `@` also searches files; the popup under test only needs it to answer.
      if (url.pathname === "/find/file") return json([])
      return undefined
    },
  })
  await waitFor(() => harness.sync().data.reference.length === list.length)
  return harness
}

async function openPopup(harness: Awaited<ReturnType<typeof mountHome>>) {
  await harness.app.mockInput.typeText("@")
  await harness.settle()
}

test("typing @ lists the visible entries of sync.data.reference with their source", async () => {
  const harness = await mountHome()
  try {
    await openPopup(harness)
    const frame = harness.app.captureCharFrame()
    expect(frame).toContain("@docs ../docs")
    expect(frame).toContain("@design https://example.test/org/design.git")
    // Hidden references stay out of the popup.
    expect(frame).not.toContain("vault")
    // The popup reads the store the bootstrap filled; it never asks the server for the list itself.
    expect(harness.requested.filter((request) => request === "GET /reference")).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})

test("the popup follows the sync store while it is open", async () => {
  const harness = await mountHome()
  try {
    await openPopup(harness)
    expect(harness.app.captureCharFrame()).toContain("@docs")

    harness.sync().set("reference", [{ name: "api", path: "/repo/api", source: { type: "local", path: "../api" } }])
    await harness.settle()

    const frame = harness.app.captureCharFrame()
    expect(frame).toContain("@api ../api")
    expect(frame).not.toContain("@docs")
    expect(frame).not.toContain("@design")
    expect(harness.requested.filter((request) => request === "GET /reference")).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})

test("typing the alias narrows the list and choosing it inserts the reference directory", async () => {
  const harness = await mountHome()
  try {
    await openPopup(harness)
    await harness.app.mockInput.typeText("do")
    await harness.settle()
    const frame = harness.app.captureCharFrame()
    expect(frame).toContain("@docs ../docs")
    expect(frame).not.toContain("@design")

    harness.app.mockInput.pressEnter()
    await harness.settle()
    expect(harness.promptDraft()).toBe("@docs ")
    expect(harness.promptParts()).toMatchObject([
      { type: "file", mime: "application/x-directory", filename: "docs", url: "file:///repo/docs" },
    ])
    expect(harness.app.captureCharFrame()).not.toContain("@docs ../docs")
  } finally {
    await harness.dispose()
  }
})

test("a project without references lists no alias", async () => {
  const harness = await mountHome([])
  try {
    await openPopup(harness)
    const frame = harness.app.captureCharFrame()
    expect(frame).not.toContain("@docs")
    expect(frame).not.toContain("@design")
    expect(harness.promptDraft()).toBe("@")
  } finally {
    await harness.dispose()
  }
})
