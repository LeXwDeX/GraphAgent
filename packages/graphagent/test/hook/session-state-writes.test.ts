// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppLayer } from "@/effect/app-runtime"
import { SessionHooks } from "@/hook/session-hooks"
import { SessionAttention } from "@/notification/attention"
import { ClientDetach } from "@/session/client-detach"
import { SessionLifecycle } from "@/session/lifecycle"
import { SessionStatus } from "@/session/status"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * Issue #1070: hooks do not write session state. A hook returns data to the
 * owner of the transition; the hook module itself writes no session state except
 * the one allowed write, `Session.setTitle` for a `sessionTitle` a hook returned
 * (`hook/CONTEXT.md`, "Writes to session state").
 */

const HOOK_DIR = path.resolve(import.meta.dir, "../../src/hook")

function hookFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return hookFiles(full)
    return entry.endsWith(".ts") ? [full] : []
  })
}

// The methods of `Session.Interface` that change session state.
const SESSION_WRITES = [
  "create",
  "fork",
  "touch",
  "setTitle",
  "setArchived",
  "setAgent",
  "setModelSelection",
  "setMetadata",
  "setPermission",
  "setDagMode",
  "setDagBudget",
  "setRevert",
  "clearRevert",
  "setSummary",
  "writeMessageDiff",
  "deleteMessageDiff",
  "setWorkspace",
  "applyUpdate",
  "remove",
  "updateMessage",
  "removeMessage",
  "removePart",
  "updatePart",
  "settle",
  "updatePartDelta",
]

describe("hooks do not write session state", () => {
  const sources = hookFiles(HOOK_DIR).map(
    (file) => [path.relative(HOOK_DIR, file), readFileSync(file, "utf8")] as const,
  )

  test("the hook module never touches the live status or the client attention of a session", () => {
    const offenders = sources
      .filter(([, text]) => /SessionStatus|SessionAttention|session\/status|notification\/attention/.test(text))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  test("the only session write left in the hook module is the title a hook returned", () => {
    const write = new RegExp(`\\bsessions?\\.(${SESSION_WRITES.join("|")})\\(`, "g")
    const writes = sources.flatMap(([file, text]) => [...text.matchAll(write)].map((match) => `${file}: ${match[1]}`))
    expect(writes).toEqual(["session-context.ts: setTitle"])
  })
})

const it = testEffect(AppLayer.pipe(Layer.provideMerge(SessionHooks.defaultLayer)))

describe("detaching a local client", () => {
  it.instance("clears the session's status and attention, then ends its hooks once", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const lifecycle = yield* SessionLifecycle.Service
      const status = yield* SessionStatus.Service
      const attention = yield* SessionAttention.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* lifecycle.create({})
      const audit = path.join(instance.directory, "session-end.jsonl")
      yield* hooks.add(session.id, {
        event: "SessionEnd",
        hooks: [{ type: "command", command: `cat >> '${audit}'; echo >> '${audit}'` }],
      })
      yield* status.set(session.id, { type: "busy" })
      yield* attention.update(session.id, {
        clientID: "client",
        clientType: "terminal",
        activity: 1,
        backgroundView: true,
      })
      expect((yield* status.get(session.id)).type).toBe("busy")
      expect(yield* attention.viewing(session.id)).toBe(true)

      const detach = ClientDetach.local({
        sessionID: session.id,
        directory: instance.directory,
        reason: "prompt_input_exit",
      })
      yield* detach
      expect((yield* status.get(session.id)).type).toBe("idle")
      expect(yield* attention.viewing(session.id)).toBe(false)
      const rows = yield* pollWithTimeout(
        Effect.promise(async () => {
          const text = await fs.readFile(audit, "utf8").catch(() => "")
          const lines = text.split("\n").filter((line) => line.trim())
          return lines.length > 0 ? lines.map((line) => JSON.parse(line)) : undefined
        }),
        "SessionEnd did not run",
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        hook_event_name: "SessionEnd",
        session_id: session.id,
        reason: "prompt_input_exit",
      })

      // A second detach has nothing left to end: the session is already claimed as ended.
      yield* detach
      expect(
        (yield* Effect.promise(() => fs.readFile(audit, "utf8"))).split("\n").filter((line) => line.trim()),
      ).toHaveLength(1)
    }),
  )
})
