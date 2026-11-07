import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Auth } from "../../src/auth"

async function isolated(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auth-atomic-"))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function authLayer(dir: string, fs = FSUtil.defaultLayer) {
  const platform = Layer.mergeAll(fs, Global.layerWith({ data: dir, state: dir }))
  return Auth.layer.pipe(Layer.provide(EffectFlock.layer.pipe(Layer.provide(platform))), Layer.provide(platform))
}

test("concurrent sets preserve providers and restrictive permissions", () =>
  isolated(async (dir) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* Effect.all(
          Array.from({ length: 8 }, (_, i) => auth.set(`fixture-${i}`, { type: "api", key: "synthetic" })),
          {
            concurrency: "unbounded",
          },
        )
        expect(Object.keys(yield* auth.all())).toHaveLength(8)
      }).pipe(Effect.provide(authLayer(dir))),
    )
    if (process.platform !== "win32") expect((await stat(path.join(dir, "auth.json"))).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  }))

test("concurrent remove and set do not resurrect revoked credentials", () =>
  isolated(async (dir) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("revoked", { type: "api", key: "synthetic" })
        yield* Effect.all([auth.remove("revoked"), auth.set("new-provider", { type: "api", key: "synthetic" })], {
          concurrency: "unbounded",
        })
        const data = yield* auth.all()
        expect(data.revoked).toBeUndefined()
        expect(data["new-provider"]).toBeDefined()
      }).pipe(Effect.provide(authLayer(dir))),
    )
  }))

test("interruption before rename leaves valid previous JSON and cleans temporary files", () =>
  isolated(async (dir) => {
    const original = { previous: { type: "api", key: "synthetic" } }
    await writeFile(path.join(dir, "auth.json"), JSON.stringify(original), { mode: 0o600 })
    await Effect.runPromise(
      Effect.gen(function* () {
        const written = yield* Deferred.make<void>()
        const pausedFS = Layer.effect(
          FSUtil.Service,
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            return FSUtil.Service.of({
              ...fs,
              writeFileString: (file, contents, options) =>
                fs
                  .writeFileString(file, contents, options)
                  .pipe(
                    Effect.tap(() =>
                      file.endsWith(".tmp")
                        ? Deferred.succeed(written, undefined).pipe(Effect.andThen(Effect.never))
                        : Effect.void,
                    ),
                  ),
            })
          }),
        ).pipe(Layer.provide(FSUtil.defaultLayer))
        const fiber = yield* Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("new", { type: "api", key: "synthetic" })
        }).pipe(Effect.provide(authLayer(dir, pausedFS)), Effect.forkScoped)
        yield* Deferred.await(written)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.scoped),
    )
    expect(JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8"))).toEqual(original)
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  }))

test("malformed persisted JSON is not replaced by a mutation", () =>
  isolated(async (dir) => {
    await writeFile(path.join(dir, "auth.json"), "{invalid", { mode: 0o600 })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return yield* auth.set("new", { type: "api", key: "synthetic" })
      }).pipe(Effect.provide(authLayer(dir)), Effect.exit),
    )
    expect(exit._tag).toBe("Failure")
    expect(await readFile(path.join(dir, "auth.json"), "utf8")).toBe("{invalid")
  }))

test("mutation preserves filesystem defects", () =>
  isolated(async (dir) => {
    const defect = new Error("synthetic filesystem defect")
    const brokenFS = Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return FSUtil.Service.of({ ...fs, readJson: () => Effect.die(defect) })
      }),
    ).pipe(Layer.provide(FSUtil.defaultLayer))
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("new", { type: "api", key: "synthetic" })
      }).pipe(Effect.provide(authLayer(dir, brokenFS)), Effect.exit),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
    expect((await readdir(dir)).includes("auth.json")).toBe(false)
  }))

test("environment override retains existing read and mutation behavior", () =>
  isolated(async (dir) => {
    const previous = process.env.GRAPHAGENT_AUTH_CONTENT
    process.env.GRAPHAGENT_AUTH_CONTENT = JSON.stringify({ fromEnv: { type: "api", key: "synthetic" } })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          expect((yield* auth.all()).fromEnv).toBeDefined()
          yield* auth.set("new/", { type: "api", key: "synthetic" })
          expect((yield* auth.all()).new).toBeUndefined()
        }).pipe(Effect.provide(authLayer(dir))),
      )
      const persisted = JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8"))
      expect(persisted.fromEnv).toBeDefined()
      expect(persisted.new).toBeDefined()
      expect(persisted["new/"]).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.GRAPHAGENT_AUTH_CONTENT
      else process.env.GRAPHAGENT_AUTH_CONTENT = previous
    }
  }))

test(
  "separate processes preserve updates to the same credential file",
  () =>
    isolated(async (dir) => {
      const children = ["a", "b"].map((provider) =>
        Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "auth-writer.ts"), provider], {
          env: {
            ...process.env,
            GRAPHAGENT_AUTH_CONTENT: "",
            XDG_DATA_HOME: path.join(dir, "data"),
            XDG_STATE_HOME: path.join(dir, "state"),
            XDG_CONFIG_HOME: path.join(dir, "config"),
            XDG_CACHE_HOME: path.join(dir, "cache"),
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      try {
        for (const child of children) expect(await child.exited).toBe(0)
        const data = JSON.parse(await readFile(path.join(dir, "data", "opencode", "auth.json"), "utf8"))
        expect(Object.keys(data)).toHaveLength(16)
      } finally {
        for (const child of children) child.kill()
        await Promise.all(children.map((child) => child.exited))
      }
    }),
  30000,
)
