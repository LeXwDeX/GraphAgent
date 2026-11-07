import { describe, expect } from "bun:test"
import { Clock, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript, toolCallScript } from "../lib/fake-provider"
import { reset, settle, snapshot, type Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig } from "./harness"
import { makeFakeShell } from "../lib/fake-shell"

// S6: a two-minute bash command that emits one line every 200 virtual
// milliseconds. The shell is scripted, so the scenario costs no wall-clock
// time; the engine work is real: every preview updates the tool part and the
// session engine persists it.
const CHUNKS = 600
const INTERVAL_MS = 200

const shell = makeFakeShell({ chunks: CHUNKS, intervalMs: INTERVAL_MS })

let conversation = 0
const fake = makeFakeProvider({
  title: "S6",
  script: (input) => {
    const step = conversation
    conversation += 1
    if (step === 0)
      return toolCallScript(input, {
        id: "call-bash-1",
        name: "bash",
        input: { command: "sleep 120", timeout: 130_000 },
      })
    return textScript("done")
  },
})

const it = testEffect(makePerfLayer(fake, { shell: shell.layer }))

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

describe("S6 long shell command", () => {
  it.instance(
    "a two-minute command is deterministic while previews stream",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service

        const runScenario = (title: string) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({ title })
            const clock = yield* TestClock.make()
            const spawnedBefore = shell.spawns()
            reset()
            fake.reset()
            conversation = 0
            let done = false
            const turn = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "run the long command" }],
              })
              .pipe(
                Effect.ensuring(Effect.sync(() => (done = true))),
                Effect.provideService(Clock.Clock, clock),
                Effect.forkChild,
              )

            // The scripted request, permission checks and the shell parser run
            // real I/O; wait for the process to spawn before advancing virtual
            // time, otherwise the shell registers its timers after the clock
            // already passed them.
            for (let i = 0; i < 5000 && shell.spawns() === spawnedBefore; i++) yield* Effect.sleep("1 millis")
            expect(shell.spawns()).toBe(spawnedBefore + 1)

            // Virtual time advances in shell intervals. Some persistence work is
            // real, so allow plenty of steps; the loop stops as soon as the turn
            // completes. Extra steps never change engine counts.
            // oxlint-disable-next-line no-unmodified-loop-condition -- the forked turn flips `done`
            for (let step = 0; step < 2000 && !done; step++) {
              yield* clock.adjust(`${INTERVAL_MS} millis`)
              yield* Effect.sleep("1 millis")
            }
            expect(done).toBe(true)
            yield* Fiber.join(turn)
            yield* settle({ activity: fake.activity })
            return snapshot()
          })

        // Warm the shared services first: the first turn pays one-time engine
        // setup (config, project caches, snapshot bootstrap) that does not
        // belong to the measured per-turn cost.
        yield* runScenario("S6 warmup")

        const first = yield* runScenario("S6 first")
        expect(first["events.durable"]).toBeGreaterThanOrEqual(CHUNKS)
        expect(first["sql.write"]).toBeGreaterThan(0)
        expect(first.commits).toBeGreaterThan(0)
        expect(first["json.encodeBytes"]).toBeGreaterThan(0)

        // The same scripted turn in a second session must produce identical
        // engine counts. Timestamped payload bytes are the only tolerated
        // difference, exactly like S1.
        const second = yield* runScenario("S6 second")
        expect(withoutBytes(second)).toEqual(withoutBytes(first))
        expect(Math.abs(second["json.encodeBytes"] - first["json.encodeBytes"])).toBeLessThanOrEqual(64)
      }),
    { git: true, config: perfConfig },
    { timeout: 60_000 },
  )
})
