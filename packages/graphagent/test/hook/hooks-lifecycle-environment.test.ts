import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HookTranscript } from "@/hook/transcript"
import { HookLifecycle } from "@/hook/lifecycle"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
const it = testEffect(HookLifecycle.layer)
it.instance("exported environment is session isolated, cached and refreshed without global mutation", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const root = path.join(directory, "env")
    const file = yield* HookTranscript.environmentFile("one", root).pipe(Effect.orDie)
    const count = path.join(directory, "count")
    yield* Effect.promise(() =>
      fs.writeFile(file, `printf x >> '${count}'\nexport GRAPHAGENT_HOOK_TEST_VALUE='value with spaces'\n`),
    )
    const one = yield* HookTranscript.environment("one", root).pipe(Effect.orDie)
    expect(one.GRAPHAGENT_HOOK_TEST_VALUE).toBe("value with spaces")
    expect((yield* HookTranscript.environment("one", root).pipe(Effect.orDie)).GRAPHAGENT_HOOK_TEST_VALUE).toBe(
      "value with spaces",
    )
    expect(yield* Effect.promise(() => fs.readFile(count, "utf8"))).toBe("x")
    expect(
      (yield* HookTranscript.environment("two", root).pipe(Effect.orDie)).GRAPHAGENT_HOOK_TEST_VALUE,
    ).toBeUndefined()
    expect(process.env.GRAPHAGENT_HOOK_TEST_VALUE).toBeUndefined()
    yield* Effect.promise(() => fs.writeFile(file, "export GRAPHAGENT_HOOK_TEST_VALUE='updated'\n"))
    expect((yield* HookTranscript.environment("one", root).pipe(Effect.orDie)).GRAPHAGENT_HOOK_TEST_VALUE).toBe(
      "updated",
    )
  }),
)

it.instance("empty session exports preserve plugin PATH and explicit exports/unsets affect only their session", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const root = path.join(directory, "delta-env")
    const empty = yield* HookTranscript.environment("empty", root).pipe(Effect.orDie)
    expect(empty).toEqual({})
    expect(HookTranscript.applyEnvironment({ PATH: "/plugin/bin", KEEP: "plugin" }, empty)).toEqual({
      PATH: "/plugin/bin",
      KEEP: "plugin",
    })
    const file = yield* HookTranscript.environmentFile("changed", root).pipe(Effect.orDie)
    yield* Effect.promise(() =>
      fs.writeFile(file, "export PATH='/session/bin'\nunset HOME\nunset PLUGIN_ONLY\nexport SESSION_ONLY='yes'\n"),
    )
    const delta = yield* HookTranscript.environment("changed", root, { ...process.env, PLUGIN_ONLY: "plugin" }).pipe(
      Effect.orDie,
    )
    expect(delta.PATH).toBe("/session/bin")
    expect(Object.hasOwn(delta, "HOME")).toBe(true)
    expect(delta.HOME).toBeUndefined()
    expect(Object.hasOwn(delta, "PLUGIN_ONLY")).toBe(true)
    expect(delta.PLUGIN_ONLY).toBeUndefined()
    expect(
      HookTranscript.applyEnvironment(
        { PATH: "/plugin/bin", HOME: "/parent", KEEP: "plugin", PLUGIN_ONLY: "plugin" },
        delta,
      ),
    ).toEqual({
      PATH: "/session/bin",
      KEEP: "plugin",
      SESSION_ONLY: "yes",
    })
    expect(yield* HookTranscript.environment("empty", root).pipe(Effect.orDie)).toEqual({})
  }),
)
