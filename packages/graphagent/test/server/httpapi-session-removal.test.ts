// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * Issue #1558: `DELETE /session/{id}` while the session streams. The run must be stopped through the abort path
 * (the provider sees its request dropped) before the rows go, and the run's tail must leave no error behind.
 *
 * The server side logs through a recorder merged into the served layer, so the ERROR lines of the request fibers
 * are visible. The only errors a deleted run may leave are the abort path's own: `MessageAbortedError` on the event
 * stream and the `process` / `Aborted` log line, which Esc produces the same way.
 */

const logLines: Array<{ level: string; text: string }> = []
const recorder = Logger.layer([
  Logger.make((entry) => {
    logLines.push({ level: entry.logLevel, text: JSON.stringify(entry.message) })
  }),
])

// The test's own InstanceStore seeds children and removes sessions the way another process would.
const it = testEffect(
  Layer.mergeAll(httpApiLayer.pipe(Layer.provideMerge(recorder)), LayerNode.buildLayer(InstanceStore.node)),
)
const headers = { "content-type": "application/json" }

afterEach(async () => {
  logLines.length = 0
  await disposeAllInstances()
  await resetDatabase()
})

const call = (directory: string, url: string, init: { method: string; body?: unknown }) =>
  requestInDirectory(url, directory, {
    method: init.method,
    ...(init.body === undefined ? {} : { headers, body: JSON.stringify(init.body) }),
  })

const createSession = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* call(directory, "/session", {
      method: "POST",
      body: { title: "removal", agent: "build", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
    })
    expect(response.status).toBe(200)
    const created = yield* response.json
    if (!created || typeof created !== "object" || !("id" in created) || typeof created.id !== "string")
      throw new Error("session response has no id")
    return created.id
  })

type Seen = { readonly type: string; readonly error?: string; readonly mentions: (text: string) => boolean }

const nameOf = (error: unknown) =>
  error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : undefined

/** What the global event stream carried for one session, in order. */
const watchSession = (sessionID: string) =>
  Effect.gen(function* () {
    const seen: Seen[] = []
    const handler = (event: GlobalEvent) => {
      const properties = event.payload?.properties
      const text = JSON.stringify(properties ?? {})
      if (!text.includes(sessionID)) return
      const error =
        properties && typeof properties === "object" && "error" in properties ? nameOf(properties.error) : undefined
      seen.push({
        type: event.payload.type,
        ...(error === undefined ? {} : { error }),
        mentions: (needle) => text.includes(needle),
      })
    }
    GlobalBus.on("event", handler)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", handler)))
    return seen
  })

/** A session whose run is streaming: the provider has sent `partial output` and then stalls. */
const streamingSession = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
  const sessionID = yield* createSession(directory)
  const seen = yield* watchSession(sessionID)
  yield* llm.push(reply().text("partial output").hang())
  const accepted = yield* call(directory, `/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "hello" }],
    },
  })
  expect(accepted.status).toBe(204)
  yield* llm.wait(1)
  yield* pollWithTimeout(
    Effect.sync(() => (seen.some((event) => event.mentions("partial output")) ? (true as const) : undefined)),
    "the stream never started",
    "10 seconds",
  )
  return { llm, directory, sessionID, seen }
})

/** Removes the session through a Session service of its own: no cancel, as another process or a late cancel would. */
const removeBehindTheRun = (directory: string, sessionID: string) =>
  InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      SessionNs.Service.use((svc) => svc.remove(SessionID.make(sessionID))).pipe(
        Effect.provide(SessionNs.defaultLayer),
      ),
    ),
  )

const seedChildSession = (directory: string, parentID: string) =>
  InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      SessionNs.Service.use((svc) => svc.create({ parentID: SessionID.make(parentID), title: "child" })).pipe(
        Effect.provide(SessionNs.defaultLayer),
      ),
    ),
  )

const expectOnlyAbortErrors = (seen: readonly Seen[]) => {
  expect(seen.filter((event) => event.type === "session.error" && event.error !== "MessageAbortedError")).toEqual([])
  expect(logLines.filter((line) => line.level === "Error" && !line.text.includes('"error":"Aborted"'))).toEqual([])
}

const withLlm = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(TestLLMServer.layer))

describe("DELETE /session/{id} while the session streams", () => {
  it.live("stops the run through the abort path and nothing follows session.deleted", () =>
    withLlm(
      Effect.gen(function* () {
        const { llm, directory, sessionID, seen } = yield* streamingSession
        const deleted = yield* call(directory, `/session/${sessionID}`, { method: "DELETE" })
        expect(deleted.status).toBe(200)
        expect(yield* deleted.json).toBe(true)
        yield* awaitWithTimeout(llm.waitAbort(1), "the provider never saw the request dropped", "5 seconds")

        // A run that kept writing would still be publishing; give it room to.
        yield* Effect.sleep("500 millis")
        expect(seen.filter((event) => event.type === "session.deleted")).toHaveLength(1)
        expect(seen.at(-1)?.type).toBe("session.deleted")
        expectOnlyAbortErrors(seen)
        expect((yield* call(directory, `/session/${sessionID}`, { method: "GET" })).status).toBe(404)
      }),
    ),
  )

  it.live("removes a session with a child along with its run", () =>
    withLlm(
      Effect.gen(function* () {
        const { llm, directory, sessionID, seen } = yield* streamingSession
        const child = yield* seedChildSession(directory, sessionID)
        const childSeen = yield* watchSession(child.id)
        const deleted = yield* call(directory, `/session/${sessionID}`, { method: "DELETE" })
        expect(deleted.status).toBe(200)
        yield* awaitWithTimeout(llm.waitAbort(1), "the provider never saw the request dropped", "5 seconds")

        yield* Effect.sleep("500 millis")
        expect(seen.at(-1)?.type).toBe("session.deleted")
        expect(childSeen.at(-1)?.type).toBe("session.deleted")
        expectOnlyAbortErrors([...seen, ...childSeen])
        expect((yield* call(directory, `/session/${child.id}`, { method: "GET" })).status).toBe(404)
      }),
    ),
  )

  it.live("a run whose session was deleted behind it ends without an error report", () =>
    withLlm(
      Effect.gen(function* () {
        const { llm, directory, sessionID, seen } = yield* streamingSession
        // No cancel before the removal: the run is still in flight when its rows vanish. Its tail is the aborted
        // turn's last write meeting a session that no longer exists.
        yield* removeBehindTheRun(directory, sessionID)
        const aborted = yield* call(directory, `/session/${sessionID}/abort`, { method: "POST" })
        expect(aborted.status).toBe(200)
        yield* awaitWithTimeout(llm.waitAbort(1), "the provider never saw the request dropped", "5 seconds")

        yield* Effect.sleep("500 millis")
        expect(logLines.filter((line) => line.text.includes("prompt_async failed"))).toEqual([])
        expectOnlyAbortErrors(seen)
      }),
    ),
  )
})
