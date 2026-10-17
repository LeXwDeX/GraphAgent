import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HookTranscript } from "@/hook/transcript"
import { HookLifecycle } from "@/hook/lifecycle"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(HookLifecycle.layer)

it.instance("session and directory environment files are separate layers that merge in order", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const root = path.join(directory, "layers")
    const session = yield* HookTranscript.environmentFile("one", root)
    const defaulted = yield* HookTranscript.environmentFile("one", root, "session")
    const overlay = yield* HookTranscript.environmentFile("one", root, "directory")
    expect(defaulted).toBe(session)
    expect(overlay).not.toBe(session)
    yield* Effect.promise(async () => {
      await fs.writeFile(
        session,
        "export STARTUP_VALUE='startup'\nexport SHADOWED='session'\nexport KEEP_UNSET='session'\n",
      )
      await fs.writeFile(overlay, "export OVERLAY_VALUE='overlay'\nexport SHADOWED='overlay'\nunset KEEP_UNSET\n")
    })
    const base = { ...process.env, KEEP_UNSET: undefined }
    const merged = yield* HookTranscript.environment("one", root, base)
    expect(merged).toMatchObject({ STARTUP_VALUE: "startup", OVERLAY_VALUE: "overlay", SHADOWED: "overlay" })
    expect(Object.hasOwn(merged, "KEEP_UNSET")).toBe(false)
  }),
)

it.instance("clearing the directory layer keeps startup exports and refreshes the cache signature", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const root = path.join(directory, "clear")
    const session = yield* HookTranscript.environmentFile("one", root)
    const overlay = yield* HookTranscript.environmentFile("one", root, "directory")
    yield* Effect.promise(async () => {
      await fs.writeFile(session, "export STARTUP_VALUE='startup'\nexport SHADOWED='session'\n")
      await fs.writeFile(overlay, "export OVERLAY_VALUE='overlay'\nexport SHADOWED='overlay'\nunset STARTUP_UNSET\n")
    })
    const base = { ...process.env, STARTUP_UNSET: "inherited" }
    const before = yield* HookTranscript.environment("one", root, base)
    expect(before).toMatchObject({ STARTUP_VALUE: "startup", OVERLAY_VALUE: "overlay", SHADOWED: "overlay" })
    expect(Object.hasOwn(before, "STARTUP_UNSET")).toBe(true)
    yield* HookTranscript.clearEnvironment("one", "directory", root)
    const after = yield* HookTranscript.environment("one", root, base)
    expect(after.STARTUP_VALUE).toBe("startup")
    expect(after.SHADOWED).toBe("session")
    expect(after.OVERLAY_VALUE).toBeUndefined()
    expect(Object.hasOwn(after, "STARTUP_UNSET")).toBe(false)
    expect(yield* Effect.promise(() => fs.readFile(session, "utf8"))).toContain("STARTUP_VALUE")
    yield* HookTranscript.clearEnvironment("one", "all", root)
    expect(yield* HookTranscript.environment("one", root, base)).toEqual({})
  }),
)

it.instance("a startup unset survives until the session layer is cleared", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const root = path.join(directory, "unset")
    const session = yield* HookTranscript.environmentFile("one", root)
    yield* Effect.promise(() => fs.writeFile(session, "unset STARTUP_UNSET\n"))
    const base = { ...process.env, STARTUP_UNSET: "inherited" }
    const delta = yield* HookTranscript.environment("one", root, base)
    expect(Object.hasOwn(delta, "STARTUP_UNSET")).toBe(true)
    expect(delta.STARTUP_UNSET).toBeUndefined()
    yield* HookTranscript.clearEnvironment("one", "directory", root)
    expect(Object.hasOwn(yield* HookTranscript.environment("one", root, base), "STARTUP_UNSET")).toBe(true)
  }),
)
