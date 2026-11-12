// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Shell } from "@graphagent/core/shell"
import { BackgroundJob } from "@/background/job"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { SessionCancellation } from "@/session/cancellation"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)
const withJobs = testEffect(Layer.mergeAll(httpApiLayer, BackgroundJob.layer, LayerNode.buildLayer(InstanceStore.node)))
const headers = { "content-type": "application/json" }

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function request(directory: string, url: string, body?: unknown) {
  return requestInDirectory(url, directory, {
    method: "POST",
    ...(body === undefined ? {} : { headers, body: JSON.stringify(body) }),
  })
}

function createSession(directory: string) {
  return Effect.gen(function* () {
    const response = yield* request(directory, "/session", {
      title: "abort move regression",
      agent: "build",
      permission: [{ permission: "bash", pattern: "*", action: "allow" }],
    })
    expect(response.status).toBe(200)
    const session = yield* response.json
    if (!session || typeof session !== "object" || !("id" in session) || typeof session.id !== "string")
      throw new Error("session response has no id")
    return session.id
  })
}

function fixture() {
  return Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true, config: testProviderConfig("http://127.0.0.1:1") })
    const a = path.join(root, "a")
    const b = path.join(root, "b")
    yield* Effect.promise(() => Promise.all([mkdir(a), mkdir(b)]))
    const sessionID = yield* createSession(a)
    return { root, a, b, sessionID }
  })
}

function move(sessionID: string, from: string, to: string) {
  return Effect.gen(function* () {
    const response = yield* request(from, "/experimental/control-plane/move-session", {
      sessionID,
      destination: { directory: to },
    })
    expect({ status: response.status, body: yield* response.text }).toMatchObject({ status: 204 })
  })
}

function abort(sessionID: string, directory: string) {
  return Effect.gen(function* () {
    const response = yield* request(directory, `/session/${sessionID}/abort`)
    expect(response.status).toBe(200)
    expect(yield* response.json).toBe(true)
  })
}

function idleEvents(sessionID: string) {
  const directories: string[] = []
  const handler = (event: GlobalEvent) => {
    if (event.directory && event.payload?.type === "session.idle" && event.payload.properties?.sessionID === sessionID)
      directories.push(event.directory)
  }
  GlobalBus.on("event", handler)
  return { directories, close: () => GlobalBus.off("event", handler) }
}

function spawnShell(directory: string, sessionID: string, pidFile: string) {
  return Effect.gen(function* () {
    const script = `${pidFile}.cjs`
    yield* Effect.promise(() =>
      writeFile(
        script,
        'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)',
      ),
    )
    const shell = Shell.preferred()
    const prefix = shell && Shell.ps(shell) ? "& " : ""
    // Clean up the probe even if an assertion fails before session cancellation.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          const pid = Number(readFileSync(pidFile, "utf8"))
          if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL")
        } catch {}
      }),
    )
    return yield* request(directory, `/session/${sessionID}/shell`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      command: `${prefix}"${process.execPath}" "${script}" "${pidFile}"`,
    }).pipe(Effect.forkChild)
  })
}

function waitForShell(pidFile: string) {
  return pollWithTimeout(
    Effect.promise(async () => {
      try {
        const pid = Number(await readFile(pidFile, "utf8"))
        return Number.isInteger(pid) && pid > 0 ? pid : undefined
      } catch {
        return undefined
      }
    }),
    "shell did not start",
    "10 seconds",
  )
}

function startShell(directory: string, sessionID: string, pidFile: string) {
  return Effect.gen(function* () {
    const fiber = yield* spawnShell(directory, sessionID, pidFile)
    yield* waitForShell(pidFile)
    return fiber
  })
}

describe("HTTP session abort across workspace moves", () => {
  withJobs.live(
    "stops an idle moved session's background job in its old workspace",
    () =>
      Effect.gen(function* () {
        const { a, b, sessionID } = yield* fixture()
        const otherID = yield* createSession(a)
        const controlID = yield* createSession(a)
        const instances = yield* InstanceStore.Service
        const jobs = yield* BackgroundJob.Service
        const started = yield* Deferred.make<void>()
        let stopped = 0
        const job = yield* instances.provide(
          { directory: a },
          jobs.start({
            type: "test",
            metadata: { sessionID: sessionID },
            run: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => stopped++)),
            ),
          }),
        )
        const unrelated = yield* instances.provide(
          { directory: a },
          jobs.start({ type: "test", metadata: { sessionID: otherID }, run: Effect.never }),
        )
        const control = yield* instances.provide(
          { directory: a },
          jobs.start({ type: "test", metadata: { sessionID: controlID }, run: Effect.never }),
        )
        yield* awaitWithTimeout(Deferred.await(started), "background job did not start", "10 seconds")
        yield* abort(controlID, a)
        expect((yield* instances.provide({ directory: a }, jobs.get(control.id)))?.status).toBe("cancelled")
        expect((yield* instances.provide({ directory: a }, jobs.get(job.id)))?.status).toBe("running")
        yield* move(sessionID, a, b)
        yield* abort(sessionID, b)
        expect((yield* instances.provide({ directory: a }, jobs.get(unrelated.id)))?.status).toBe("running")
        expect((yield* instances.provide({ directory: a }, jobs.get(job.id)))?.status).toBe("cancelled")
        expect(stopped).toBe(1)

        const later = yield* instances.provide(
          { directory: b },
          jobs.start({ type: "test", metadata: { sessionID: sessionID }, run: Effect.never }),
        )
        yield* abort(sessionID, b)
        expect((yield* instances.provide({ directory: b }, jobs.get(later.id)))?.status).toBe("cancelled")
        expect(stopped).toBe(1)
      }),
    60_000,
  )

  for (const location of ["old", "new"] as const)
    withJobs.live(
      `preserves a replacement background job after capturing the ${location} workspace`,
      () =>
        Effect.gen(function* () {
          const { a, b, sessionID } = yield* fixture()
          const instances = yield* InstanceStore.Service
          const jobs = yield* BackgroundJob.Service
          const id = "reused-background-job"
          const inOld = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            instances.provide({ directory: location === "old" ? a : b }, effect)
          yield* inOld(jobs.start({ id, type: "test", metadata: { sessionID: sessionID }, run: Effect.never }))
          yield* move(sessionID, a, b)

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const captured = Deferred.makeUnsafe<void>()
          const owner = SessionCancellation.request(sessionID)
          const unregister = owner.register(() => {
            Deferred.doneUnsafe(captured, Effect.void)
            return Effect.void
          })
          owner.release()
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              unregister?.()
              yield* Deferred.succeed(release, undefined)
            }),
          )
          const admission = yield* SessionCancellation.admissions
            .run(sessionID, (commit) =>
              commit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
            )
            .pipe(Effect.exit, Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(entered), "admission did not enter")
          const stopping = yield* abort(sessionID, b).pipe(Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(captured), "abort did not capture its owners")
          yield* inOld(jobs.cancel(id))
          yield* inOld(jobs.start({ id, type: "test", metadata: { sessionID: sessionID }, run: Effect.never }))
          yield* Deferred.succeed(release, undefined)
          yield* awaitWithTimeout(Fiber.await(admission), "admission did not finish")
          yield* awaitWithTimeout(Fiber.join(stopping), "abort did not finish", "5 seconds")
          expect((yield* inOld(jobs.get(id)))?.status).toBe("running")
        }),
      60_000,
    )

  withJobs.live(
    "releases a disposed background owner and preserves a replacement generation",
    () =>
      Effect.gen(function* () {
        const { a, sessionID } = yield* fixture()
        const instances = yield* InstanceStore.Service
        const jobs = yield* BackgroundJob.Service
        const stopped = yield* Deferred.make<void>()
        const id = "reloaded-background-job"
        const inOld = <A, E, R>(effect: Effect.Effect<A, E, R>) => instances.provide({ directory: a }, effect)
        yield* inOld(
          jobs.start({
            id,
            type: "test",
            metadata: { sessionID: sessionID },
            run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
          }),
        )
        const abort = SessionCancellation.begin(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
        expect(abort.owners).toHaveLength(1)
        yield* instances.disposeDirectory(a)
        yield* awaitWithTimeout(Deferred.await(stopped), "disposed background job was not interrupted")
        const afterDispose = SessionCancellation.begin(sessionID)
        expect(afterDispose.owners).toHaveLength(0)
        afterDispose.finish()

        yield* inOld(jobs.start({ id, type: "test", metadata: { sessionID: sessionID }, run: Effect.never }))
        yield* Effect.all(abort.owners)
        expect((yield* inOld(jobs.get(id)))?.status).toBe("running")
      }),
    60_000,
  )

  it.live(
    "stops the previous workspace runner and only its owner publishes idle",
    () =>
      Effect.gen(function* () {
        const { root, a, b, sessionID } = yield* fixture()
        const events = idleEvents(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(events.close))
        const shell = yield* startShell(a, sessionID, path.join(root, "shell.pid"))
        yield* move(sessionID, a, b)
        yield* abort(sessionID, b)
        yield* awaitWithTimeout(Fiber.await(shell), "owner's shell request did not finish", "5 seconds")
        yield* pollWithTimeout(
          Effect.sync(() => (events.directories.includes(a) ? true : undefined)),
          "owner did not publish idle",
          "5 seconds",
        )
        expect(events.directories).not.toContain(b)
      }),
    60_000,
  )

  it.live(
    "without a move, stops the runner and publishes idle",
    () =>
      Effect.gen(function* () {
        const { root, a, sessionID } = yield* fixture()
        const events = idleEvents(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(events.close))
        const shell = yield* startShell(a, sessionID, path.join(root, "shell.pid"))
        yield* abort(sessionID, a)
        yield* awaitWithTimeout(Fiber.await(shell), "shell request did not finish", "5 seconds")
        yield* pollWithTimeout(
          Effect.sync(() => (events.directories.includes(a) ? true : undefined)),
          "owner did not publish idle",
          "5 seconds",
        )
      }),
    60_000,
  )

  it.live(
    "a moved session with no runner does not publish idle",
    () =>
      Effect.gen(function* () {
        const { a, b, sessionID } = yield* fixture()
        const events = idleEvents(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(events.close))
        yield* move(sessionID, a, b)
        yield* abort(sessionID, b)
        expect(events.directories).toEqual([])
      }),
    60_000,
  )

  it.live(
    "aborting another session does not stop the original runner",
    () =>
      Effect.gen(function* () {
        const { root, a, sessionID } = yield* fixture()
        const otherID = yield* createSession(a)
        const events = idleEvents(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(events.close))
        const shell = yield* startShell(a, sessionID, path.join(root, "shell.pid"))
        yield* abort(otherID, a)
        expect(Option.isNone(yield* Fiber.await(shell).pipe(Effect.timeoutOption("100 millis")))).toBe(true)
        expect(events.directories).toEqual([])
        yield* abort(sessionID, a)
        yield* awaitWithTimeout(Fiber.await(shell), "original shell request did not finish", "5 seconds")
        yield* pollWithTimeout(
          Effect.sync(() => (events.directories.includes(a) ? true : undefined)),
          "original owner did not publish idle",
          "5 seconds",
        )
      }),
    60_000,
  )

  it.live(
    "a move back to the original workspace stops its runner",
    () =>
      Effect.gen(function* () {
        const { root, a, b, sessionID } = yield* fixture()
        const events = idleEvents(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(events.close))
        const shell = yield* startShell(a, sessionID, path.join(root, "shell.pid"))
        yield* move(sessionID, a, b)
        yield* move(sessionID, b, a)
        yield* abort(sessionID, a)
        yield* awaitWithTimeout(Fiber.await(shell), "owner's shell request did not finish", "5 seconds")
        yield* pollWithTimeout(
          Effect.sync(() => (events.directories.includes(a) ? true : undefined)),
          "owner did not publish idle",
          "5 seconds",
        )
        expect(events.directories).not.toContain(b)
      }),
    60_000,
  )

  it.live(
    "stops runners owned by both workspaces",
    () =>
      Effect.gen(function* () {
        const { root, a, b, sessionID } = yield* fixture()
        const events = idleEvents(sessionID)
        yield* Effect.addFinalizer(() => Effect.sync(events.close))
        const first = yield* startShell(a, sessionID, path.join(root, "shell-a.pid"))
        yield* move(sessionID, a, b)
        const second = yield* startShell(b, sessionID, path.join(root, "shell-b.pid"))
        yield* abort(sessionID, b)
        yield* awaitWithTimeout(Fiber.await(second), "new owner's shell did not finish", "5 seconds")
        yield* awaitWithTimeout(Fiber.await(first), "old owner's shell did not finish", "5 seconds")
        expect(events.directories).toContain(a)
        expect(events.directories).toContain(b)
      }),
    60_000,
  )

  it.live(
    "preserves a later shell and pending input while an abort is settling",
    () =>
      Effect.gen(function* () {
        const { root, a, b, sessionID } = yield* fixture()
        const shell = yield* startShell(a, sessionID, path.join(root, "old.pid"))
        yield* move(sessionID, a, b)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const owner = SessionCancellation.request(sessionID)
        const unregister = owner.register(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        owner.release()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            unregister?.()
            yield* Deferred.succeed(release, undefined)
          }),
        )
        const stopping = yield* abort(sessionID, b).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "abort did not reach its owner snapshot", "5 seconds")
        const pending = { messageID: "later-message", phase: "pending" }
        const updated = yield* requestInDirectory(`/session/${sessionID}`, b, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { hookPendingInput: pending } }),
        })
        expect(updated.status).toBe(200)
        const later = yield* spawnShell(b, sessionID, path.join(root, "later.pid"))
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Fiber.join(stopping), "abort did not return", "5 seconds")
        yield* awaitWithTimeout(Fiber.await(shell), "original shell did not finish", "5 seconds")
        yield* waitForShell(path.join(root, "later.pid"))
        expect(Option.isNone(yield* Fiber.await(later).pipe(Effect.timeoutOption("100 millis")))).toBe(true)
        const response = yield* requestInDirectory(`/session/${sessionID}`, b)
        expect(response.status).toBe(200)
        expect(yield* response.json).toMatchObject({ metadata: { hookPendingInput: pending } })
        yield* abort(sessionID, b)
        yield* awaitWithTimeout(Fiber.await(later), "later shell did not finish", "5 seconds")
      }),
    60_000,
  )

  it.live(
    "bounds a slow owner without releasing the next runner early",
    () =>
      Effect.gen(function* () {
        const { root, a, sessionID } = yield* fixture()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const owner = SessionCancellation.request(sessionID)
        const unregister = owner.register(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.uninterruptible),
        )
        owner.release()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            unregister?.()
            yield* Deferred.succeed(release, undefined)
          }),
        )
        const stopping = yield* request(a, `/session/${sessionID}/abort`).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "abort did not reach its owner snapshot", "5 seconds")
        const later = yield* spawnShell(a, sessionID, path.join(root, "later.pid"))
        const stopped = yield* awaitWithTimeout(
          Fiber.join(stopping),
          "abort did not return after owner timeout",
          "5 seconds",
        )
        expect(stopped.status).toBe(200)
        expect(yield* stopped.json).toBe(true)
        expect(Option.isNone(yield* Fiber.await(later).pipe(Effect.timeoutOption("100 millis")))).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* waitForShell(path.join(root, "later.pid"))
        yield* abort(sessionID, a)
        yield* awaitWithTimeout(Fiber.await(later), "later shell did not finish", "5 seconds")
      }),
    60_000,
  )

  it.live(
    "preserves pending input committed while an older admission is draining",
    () =>
      Effect.gen(function* () {
        const { a, sessionID } = yield* fixture()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const captured = Deferred.makeUnsafe<void>()
        const owner = SessionCancellation.request(sessionID)
        const unregister = owner.register(() => {
          Deferred.doneUnsafe(captured, Effect.void)
          return Effect.void
        })
        owner.release()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            unregister?.()
            yield* Deferred.succeed(release, undefined)
          }),
        )
        const admission = yield* SessionCancellation.admissions
          .run(sessionID, (commit) =>
            commit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          )
          .pipe(Effect.exit, Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "older admission did not enter its commit")
        const stopping = yield* abort(sessionID, a).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(captured), "abort did not capture its owners")
        const pending = { messageID: "committed-after-abort", phase: "pending" }
        const update = yield* requestInDirectory(`/session/${sessionID}`, a, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { hookPendingInput: pending } }),
        })
        expect(update.status).toBe(200)
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Fiber.await(admission), "older admission did not finish")
        yield* awaitWithTimeout(Fiber.join(stopping), "abort did not finish", "5 seconds")
        const response = yield* requestInDirectory(`/session/${sessionID}`, a)
        expect(yield* response.json).toMatchObject({ metadata: { hookPendingInput: pending } })
      }),
    60_000,
  )
})
