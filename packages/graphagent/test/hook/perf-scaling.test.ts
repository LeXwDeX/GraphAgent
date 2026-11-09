// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@graphagent/core/global"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { AppLayer } from "@/effect/app-runtime"
import { SettingsHook } from "@/hook"
import { prepareObserver } from "@/hook/engine/run"
import { __matcherStats, resetMatcherStats } from "@/hook/match"
import { HookTranscript, __transcriptStats, resetTranscriptStats } from "@/hook/transcript"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppLayer)

// D1 PR3: preparing one Bash trigger must not scale with the size of the
// session. The transcript is materialized incrementally, prompt identity reads
// only the newest user messages, and matchers are compiled once. The thresholds
// below are acceptance targets from Issue #1018; the measured values are logged
// so a CI regression reports the actual numbers.
const SMALL = 50
const LARGE = 2000
const TRIGGERS = 20
const NO_MATCH_TRIGGERS = 1000

const writeHooks = (directory: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".agents", "hooks.json"),
      JSON.stringify({
        // A regex matcher exercises the compile cache: `Bash` matches, `Read` does not.
        PreToolUse: [{ matcher: "B.*", hooks: [{ type: "command", command: "true", timeout: 5 }] }],
      }),
    )
  })

const seed = (sessionID: SessionID, count: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const ids: MessageID[] = []
    for (let i = 0; i < count; i++) {
      const id = MessageID.ascending()
      ids.push(id)
      yield* sessions.updateMessage({
        id,
        sessionID,
        role: "user",
        time: { created: 1000 + i },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text: `message ${i}`,
      })
    }
    return ids
  })

const bash = { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } } as const
const read = { event: "PreToolUse", toolName: "read", toolInput: { filePath: "/tmp/a.ts" } } as const

const percentile = (samples: readonly number[], fraction: number) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

const transcriptFile = (sessionID: string) =>
  path.join(Global.Path.data, "hooks", "transcripts", createHash("sha256").update(sessionID).digest("hex") + ".jsonl")

const lastLineBytes = (file: string) =>
  Effect.promise(async () => {
    const text = await Bun.file(file).text()
    const last = text.trimEnd().split("\n").at(-1) ?? ""
    return Buffer.byteLength(last, "utf8") + 1
  })

describe("incremental transcript scaling", () => {
  it.instance(
    "prepare p95 for a matching Bash trigger stays flat from 50 to 2000 messages",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const small = yield* sessions.create({})
        const large = yield* sessions.create({})
        yield* seed(small.id, SMALL)
        yield* seed(large.id, LARGE)
        const hook = yield* SettingsHook.Service
        const trigger = (sessionID: SessionID) => hook.trigger(bash, { sessionID })

        // Warm the per-session cursor: the first trigger rewrites the whole file.
        yield* trigger(small.id)
        yield* trigger(large.id)
        // Warm the process (JIT, service dispatch) outside the measured samples so
        // the first measured session is not penalized relative to the second.
        for (let i = 0; i < 5; i++) {
          yield* trigger(small.id)
          yield* trigger(large.id)
        }
        resetTranscriptStats()

        const measure = (sessionID: SessionID) =>
          Effect.gen(function* () {
            const samples: number[] = []
            prepareObserver.current = (event, durationMs) => {
              if (event === "PreToolUse") samples.push(durationMs)
            }
            yield* Effect.addFinalizer(() => Effect.sync(() => (prepareObserver.current = undefined)))
            for (let i = 0; i < TRIGGERS; i++) yield* trigger(sessionID)
            return samples
          })

        const smallSamples = yield* measure(small.id)
        const largeSamples = yield* measure(large.id)
        // No message changed between triggers, so the settled prefix needs no write.
        expect(__transcriptStats.writes).toBe(0)

        const smallP95 = percentile(smallSamples, 0.95)
        const largeP95 = percentile(largeSamples, 0.95)
        console.log(
          `[perf-1018] prepare p95: ${SMALL}msgs=${smallP95.toFixed(3)}ms ${LARGE}msgs=${largeP95.toFixed(3)}ms ratio=${(
            largeP95 / Math.max(smallP95, 0.0001)
          ).toFixed(2)} (n=${TRIGGERS} each)`,
        )
        expect(largeP95 / Math.max(smallP95, 0.0001)).toBeLessThanOrEqual(1.5)
        expect(largeP95).toBeLessThanOrEqual(10)

        HookTranscript.clearCursor(small.id)
        HookTranscript.clearCursor(large.id)
      }),
    { init: writeHooks },
  )

  it.instance(
    "an append writes only the new rows, and an invalidation rewrites once then resumes",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const ids = yield* seed(session.id, SMALL)
        const hook = yield* SettingsHook.Service
        const trigger = (sessionID: SessionID) => hook.trigger(bash, { sessionID })
        yield* trigger(session.id)

        // One new user message: the incremental write is its JSONL row, not the file.
        const next = MessageID.ascending()
        yield* sessions.updateMessage({
          id: next,
          sessionID: session.id,
          role: "user",
          time: { created: 1000 + SMALL },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: next,
          type: "text",
          text: "appended",
        })
        resetTranscriptStats()
        yield* trigger(session.id)
        const expected = yield* lastLineBytes(transcriptFile(session.id))
        expect(__transcriptStats.fullRewrites).toBe(0)
        expect(__transcriptStats.writtenBytes).toBeGreaterThan(0)
        expect(__transcriptStats.writtenBytes).toBeLessThanOrEqual(expected * 2 + 1024)

        // Deleting a settled row invalidates the prefix: one full rewrite, then
        // the following append is incremental again.
        const removed = ids[1]
        yield* sessions.removeMessage({ sessionID: session.id, messageID: removed })
        resetTranscriptStats()
        yield* trigger(session.id)
        expect(__transcriptStats.fullRewrites).toBe(1)
        expect(__transcriptStats.lastRewriteReason).toBe("count_mismatch")

        const after = MessageID.ascending()
        yield* sessions.updateMessage({
          id: after,
          sessionID: session.id,
          role: "user",
          time: { created: 1000 + SMALL + 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
        })
        resetTranscriptStats()
        yield* trigger(session.id)
        const bounded = yield* lastLineBytes(transcriptFile(session.id))
        expect(__transcriptStats.fullRewrites).toBe(0)
        expect(__transcriptStats.writtenBytes).toBeLessThanOrEqual(bounded * 2 + 1024)

        HookTranscript.clearCursor(session.id)
      }),
    { init: writeHooks },
  )

  it.instance(
    "matcher regexes are compiled once, not per trigger",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        yield* seed(session.id, SMALL)
        const hook = yield* SettingsHook.Service
        // Build the settings index (compiles the matcher) before resetting counters.
        yield* hook.trigger(bash, { sessionID: session.id })
        resetMatcherStats()
        yield* hook.trigger(bash, { sessionID: session.id })
        expect(__matcherStats.regexCompiles).toBe(0)
        for (let i = 0; i < NO_MATCH_TRIGGERS; i++) {
          yield* hook.trigger(read, { sessionID: session.id })
        }
        expect(__matcherStats.regexCompiles).toBe(0)
        HookTranscript.clearCursor(session.id)
      }),
    { init: writeHooks },
  )
})
