import { expect, test } from "bun:test"
import { Effect, PubSub, Ref, Stream } from "effect"
import { fileURLToPath } from "node:url"

// The production AppRuntime singleton must not reuse a fixture's noopBootstrap
// through the process-wide layer memoMap. Run both original probes in a fresh
// process so they still exercise production initialization without manual init.
test("Goal production wiring in an isolated process", async () => {
  const fixture = fileURLToPath(new URL("./bootstrap-wiring.fixture.ts", import.meta.url))
  const proc = Bun.spawn([process.execPath, "test", "--timeout", "20000", fixture], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  // Drain both streams immediately so diagnostic output cannot block exit.
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.all([proc.exited, stdout, stderr]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill()
          reject(new Error("Goal production wiring child exceeded its 50 second process bound"))
        }, 50_000)
      }),
    ])
    const [code, out, err] = result
    expect({ code, output: out + err }).toEqual({ code: 0, output: expect.stringContaining("2 pass") })
    expect(out + err).toContain("0 fail")
  } finally {
    clearTimeout(timer)
    proc.kill()
    await proc.exited
    await Promise.all([stdout, stderr])
  }
}, 55_000)

// Scheduler-level contract used by GoalLoop's idle subscription and
// EventV2Bridge: startImmediately runs the forked stream through its PubSub
// subscription before returning, so the first publish cannot race startup.
// Without the option the subscription is scheduled later and this publish is
// lost.
test("startImmediately installs the PubSub subscription before the first publish", async () => {
  const seen = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<number>()
        const count = yield* Ref.make(0)
        yield* Stream.fromPubSub(pubsub).pipe(
          Stream.take(1),
          Stream.runForEach(() => Ref.update(count, (value) => value + 1)),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* PubSub.publish(pubsub, 1)
        yield* Effect.yieldNow
        return yield* Ref.get(count)
      }),
    ),
  )
  expect(seen).toBe(1)
})
