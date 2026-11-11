// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { makeSessionRuntimes, type RequestPrefix } from "../../src/session/runtime"
import { SessionID } from "../../src/session/schema"

const prefix = (directory: string): RequestPrefix => ({
  directory,
  agent: { name: "build", mode: "primary", permission: [], options: {} },
  model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
  system: ["<environment>test</environment>"],
  tools: {},
  prefixTokens: 1_000,
  recordedAt: 1,
})

describe("SessionRuntimes.requestPrefixes", () => {
  test("remembers and forgets a session prefix", () => {
    const runtimes = makeSessionRuntimes()
    const sessionID = SessionID.make("ses_prefix_remember")
    runtimes.rememberRequestPrefix(sessionID, prefix("/work"))
    expect(runtimes.requestPrefixes.get(sessionID)?.directory).toBe("/work")
    runtimes.forgetRequestPrefix(sessionID)
    expect(runtimes.requestPrefixes.has(sessionID)).toBe(false)
  })

  test("session removal drops its prefix", async () => {
    const runtimes = makeSessionRuntimes()
    const sessionID = SessionID.make("ses_prefix_remove")
    runtimes.own(sessionID, "/work")
    runtimes.rememberRequestPrefix(sessionID, prefix("/work"))
    await Effect.runPromise(runtimes.remove(sessionID))
    expect(runtimes.requestPrefixes.has(sessionID)).toBe(false)
  })

  test("directory purge drops only the prefixes it owns", async () => {
    const runtimes = makeSessionRuntimes()
    const owned = SessionID.make("ses_prefix_owned")
    const other = SessionID.make("ses_prefix_other")
    runtimes.own(owned, "/work")
    runtimes.own(other, "/elsewhere")
    runtimes.rememberRequestPrefix(owned, prefix("/work"))
    runtimes.rememberRequestPrefix(other, prefix("/elsewhere"))
    await runtimes.purgeDirectory("/work")
    expect(runtimes.requestPrefixes.has(owned)).toBe(false)
    expect(runtimes.requestPrefixes.has(other)).toBe(true)
    await runtimes.purgeDirectory("/elsewhere")
  })
})
