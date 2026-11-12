// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DOMAINS } from "@graphagent/schema/lifecycle-status"
// `@graphagent/tui` does not export its lifecycle mirror, and parity needs the module itself, not a copy.
import { isPullableDomain } from "../../../../tui/src/context/lifecycle-mirror"

/**
 * #1069: the TUI mirror asks the server about a lifecycle ref only when the
 * server can answer it. A ref of a domain without a registered resolver always
 * comes back unknown, so asking costs a request per transition (one per turn
 * for `turn`) for a null. The client keeps its own list of askable domains
 * (`isPullableDomain`); the server's truth is where resolvers are registered
 * with the lifecycle service. The two must not drift: a resolver the client does
 * not know is never consulted, and a domain the client asks about without a
 * resolver wastes a request on every transition.
 */
const serverSource = path.resolve(import.meta.dir, "../../../src")

/** Every domain a resolver is registered for, with the files that register it. */
function registrations() {
  const found = new Map<string, string[]>()
  for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: serverSource })) {
    const text = readFileSync(path.join(serverSource, file), "utf8")
    for (const match of text.matchAll(/\bregister\(\s*\{\s*domain:\s*"([^"]+)"/g)) {
      found.set(match[1], [...(found.get(match[1]) ?? []), file])
    }
  }
  return found
}

describe("TUI lifecycle mirror and server resolver registrations", () => {
  test("the scan finds the registration sites it is meant to read", () => {
    // If registration is ever written another way, this fails instead of the
    // parity below passing on an empty scan.
    const found = registrations()
    expect([...found.keys()]).toContain("job")
    expect([...found.keys()]).toContain("goal")
  })

  test("register each domain once, and only domains of the lifecycle vocabulary", () => {
    const found = registrations()
    expect([...found].filter(([, files]) => files.length > 1)).toEqual([])
    expect([...found.keys()].filter((domain) => !DOMAINS.some((known) => known === domain))).toEqual([])
  })

  test("ask about exactly the domains the server registers a resolver for", () => {
    const registered = [...registrations().keys()].toSorted()
    const asked = DOMAINS.filter((domain) => isPullableDomain(domain)).toSorted()
    expect(
      registered.filter((domain) => !asked.some((known) => known === domain)),
      "the server registers a resolver the TUI never asks about: add the domain to PULLABLE_DOMAINS in packages/tui/src/context/lifecycle-mirror.ts",
    ).toEqual([])
    expect(
      asked.filter((domain) => !registered.includes(domain)),
      "the TUI asks about a domain the server has no resolver for: every ref of it comes back unknown",
    ).toEqual([])
  })
})
