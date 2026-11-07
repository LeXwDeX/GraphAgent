import { afterAll, describe, expect, test } from "bun:test"
import { Flag } from "@graphagent/core/flag/flag"
import path from "path"
import type { CachedApp } from "./backend"

// The exercise harness re-points the process env at its isolated DB/XDG roots
// at import time. Import it lazily under dedicated preserved paths, then
// restore everything so this file never leaks those overrides into the rest of
// the bun test process (single shared process).
const exerciseDb = path.join(process.env.TMPDIR ?? "/tmp", `opencode-teardown-regression-${process.pid}.db`)
const exerciseGlobal = path.join(process.env.TMPDIR ?? "/tmp", `opencode-teardown-regression-${process.pid}`)
const envKeys = [
  "GRAPHAGENT_DB",
  "GRAPHAGENT_HTTPAPI_EXERCISE_DB",
  "GRAPHAGENT_HTTPAPI_EXERCISE_GLOBAL",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const
const savedEnv: Record<string, string | undefined> = {}
const savedFlagDb = Flag.GRAPHAGENT_DB

for (const key of envKeys) {
  savedEnv[key] = process.env[key]
}

process.env.GRAPHAGENT_HTTPAPI_EXERCISE_DB = exerciseDb
process.env.GRAPHAGENT_HTTPAPI_EXERCISE_GLOBAL = exerciseGlobal

const { createExitBackstop, exitBackstop, runMainWithHardExit, teardown } = await import("./teardown")
const { appCache } = await import("./backend")

Flag.GRAPHAGENT_DB = savedFlagDb
for (const key of envKeys) {
  const value = savedEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterAll(async () => {
  exitBackstop.disarm()
  const fs = await import("fs/promises")
  await fs.rm(exerciseDb, { force: true }).catch(() => undefined)
  await fs.rm(exerciseGlobal, { recursive: true, force: true }).catch(() => undefined)
})

describe("httpapi-exercise main teardown (#472 regression)", () => {
  test(
    "teardown completes when an app dispose never settles",
    async () => {
      const poison = {
        dispose: () => new Promise<void>(() => {}),
        request: () => {
          throw new Error("poison app must never serve a request")
        },
      } satisfies CachedApp
      appCache["poison:poison"] = poison
      try {
        const outcome = await Promise.race([
          teardown({}).then(() => "done" as const),
          Bun.sleep(15_000).then(() => "hung" as const),
        ])
        expect(outcome).toBe("done")
      } finally {
        delete appCache["poison:poison"]
      }
    },
    { timeout: 20_000 },
  )

  test("armed backstop forces exit when settlement stalls", async () => {
    const exits: number[] = []
    const backstop = createExitBackstop((code) => exits.push(code), 100)
    backstop.arm()
    await Bun.sleep(300)
    expect(exits).toEqual([1])
  })

  test("disarm cancels the forced exit", async () => {
    const exits: number[] = []
    const backstop = createExitBackstop((code) => exits.push(code), 100)
    backstop.arm()
    backstop.disarm()
    await Bun.sleep(200)
    expect(exits).toEqual([])
  })

  test("runMainWithHardExit exits 0 when the main fiber settles", async () => {
    const exits: number[] = []
    runMainWithHardExit(Promise.resolve("settled"), (code) => exits.push(code))
    await Bun.sleep(50)
    expect(exits).toEqual([0])
  })

  test("runMainWithHardExit exits 1 when the main fiber rejects", async () => {
    const exits: number[] = []
    runMainWithHardExit(Promise.reject(new Error("boom")), (code) => exits.push(code))
    await Bun.sleep(50)
    expect(exits).toEqual([1])
  })
})
