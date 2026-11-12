// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { monitorEventLoopDelay } from "node:perf_hooks"
import { Effect, Fiber, Stream } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { pollWithTimeout } from "../lib/effect"
import { settle } from "../lib/engine-probe"
import { s5Scenario, type S5Around } from "./scenarios/s5"

// Latency record for the S5 load (Issue #1021): event-loop delay and the
// end-to-end time to first token of an interactive turn. Record only, no
// thresholds: the count gate owns correctness, and wall-clock numbers are only
// meaningful on the self-hosted Linux machine. `script/perf/engine-wall.ts
// --latency` runs this module and aggregates the reports; it is not part of any
// pipeline (the runner file is not named `*.test.ts`, so a blanket `bun test`
// never discovers it).
//
// The numbers come from two instruments wrapped around the load window of each
// measured pass (the `around` hook of `s5Scenario`): from the first workflow
// creation until every workflow and background task has finished. Setup and the
// settling waits are idle by construction and would dilute the percentiles.
//
// Event-loop delay: `monitorEventLoopDelay` at 1 ms resolution. Bun records the
// lateness of each timer tick beyond the resolution (an idle loop reads about
// 0.1 ms), Node would add the resolution to every sample; read the numbers as
// "how late a due timer ran". A saturated loop ticks rarely, so `samples` is
// part of the reading.
//
// Interactive TTFT: probes submit a prompt on a fresh top-level session (lane
// "interactive": no parent) while the S5 load runs. The clock starts right before
// `SessionPrompt.prompt` (admission includes writing the user message) and stops
// when the first `message.part.delta` text event of that turn reaches a
// subscriber on the event bus, which is where the server's own stream to clients
// reads it. The provider is scripted and answers at once, so the number is
// engine and event-loop overhead under load, not model latency. Probes arrive on
// a fixed schedule, not after the previous one finished: a probe that waited for
// the last answer would stop sampling exactly when the system is slow.
//
// Probes are ordinary turns, so they are part of the load they measure. Only
// one measured pass runs them; the other pass is the clean event-loop reading.

/** Same fake model as scenarios/s5.ts. */
const model = { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") }
const promptModel = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

/** The warm-up pass is named like this in scenarios/s5.ts; it is not measured. */
const WARMUP = "S5 warmup"
/** The pass that also runs interactive probes. */
const PROBED = "S5 second"
const RESOLUTION_MS = 1
/** Time between two probe submissions. */
const PERIOD_MS = 150
/** Sessions prepared per probed pass; at the period above this covers a 6 s window. */
const MAX_PROBES = 40

export interface EventLoopStats {
  /** Timer ticks recorded; zero would make the percentiles vacuous. */
  readonly samples: number
  readonly mean: number
  readonly p50: number
  readonly p99: number
  readonly max: number
}

export interface Probe {
  /** When the schedule meant to submit, in ms since the load window opened. */
  readonly due: number
  /** When `prompt` was called; later than `due` by the event loop's timer lateness. */
  readonly at: number
  /** Submission to first text delta, in ms. */
  readonly ttft: number
}

export interface LatencyPass {
  readonly label: string
  /** Whether interactive probes ran in this pass. */
  readonly probed: boolean
  /** Length of the load window in ms. */
  readonly windowMs: number
  readonly eventLoop: EventLoopStats
  /** In schedule order. */
  readonly probes: ReadonlyArray<Probe>
}

export interface LatencyReport {
  readonly scenario: "S5"
  readonly database: string
  readonly resolutionMs: number
  readonly probePeriodMs: number
  readonly passes: ReadonlyArray<LatencyPass>
}

const NS_PER_MS = 1e6

function eventLoopStats(histogram: ReturnType<typeof monitorEventLoopDelay>): EventLoopStats {
  const empty = histogram.count === 0
  return {
    samples: histogram.count,
    mean: empty ? 0 : histogram.mean / NS_PER_MS,
    p50: empty ? 0 : histogram.percentile(50) / NS_PER_MS,
    p99: empty ? 0 : histogram.percentile(99) / NS_PER_MS,
    max: empty ? 0 : histogram.max / NS_PER_MS,
  }
}

/**
 * Prepare the probes of one pass: their sessions and the delta watcher. The
 * sessions exist before the window opens (a user types into a session that is
 * already there, and creating them inside the window would add load of its own).
 * `start` begins the fixed submission schedule at `begin`; `stop` ends it, lets
 * every probe in flight finish and returns them.
 */
const prepareProbes = (label: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const events = yield* EventV2Bridge.Service

    const ids: SessionID[] = []
    for (let index = 0; index < MAX_PROBES; index += 1) {
      ids.push((yield* sessions.create({ title: `${label} probe ${index}`, model })).id)
    }
    const watching = new Set<string>(ids)

    // Subscribed (startImmediately) before the first probe, so no delta can be
    // published ahead of the watcher.
    const firstDelta = new Map<string, number>()
    const watcher = yield* Stream.runForEach(events.subscribe(MessageV2.Event.PartDelta), (event) =>
      Effect.sync(() => {
        const sessionID: string = event.data.sessionID
        if (event.data.field !== "text" || !watching.has(sessionID) || firstDelta.has(sessionID)) return
        firstDelta.set(sessionID, performance.now())
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }))

    // One unmeasured turn on a spare session, so the first probe does not pay for
    // code paths the S5 passes never touch (a top-level session's first turn), and
    // its tail work is done before the window opens.
    const spare = yield* sessions.create({ title: `${label} probe warm-up`, model })
    yield* prompt.prompt({
      sessionID: spare.id,
      agent: "build",
      model: promptModel,
      parts: [{ type: "text", text: "interactive probe warm-up" }],
    })
    yield* settle({ quietMs: 100 })

    const probes: Probe[] = []
    const inFlight: Fiber.Fiber<void, unknown>[] = []
    const probe = (index: number, begin: number, due: number) =>
      Effect.gen(function* () {
        const sessionID = ids[index]
        const submitted = performance.now()
        yield* prompt.prompt({
          sessionID,
          agent: "build",
          model: promptModel,
          parts: [{ type: "text", text: `interactive probe ${index}` }],
        })
        // The turn is over, so its delta was published long ago; the watcher only
        // needs a scheduler turn to have seen it.
        const first = yield* pollWithTimeout(
          Effect.sync(() => firstDelta.get(sessionID)),
          `S5 latency: probe ${index} produced no text delta`,
        )
        probes.push({ due: due - begin, at: submitted - begin, ttft: first - submitted })
      })

    let schedule: Fiber.Fiber<void> | undefined
    return {
      start: (begin: number) =>
        Effect.gen(function* () {
          // A random phase keeps the schedule from locking onto periodic engine
          // work (the loop's own sweeps) across runs.
          const phase = Math.random() * PERIOD_MS
          schedule = yield* Effect.gen(function* () {
            for (let index = 0; index < ids.length; index += 1) {
              const due = begin + phase + index * PERIOD_MS
              yield* Effect.sleep(Math.max(0, due - performance.now()))
              inFlight.push(yield* probe(index, begin, due).pipe(Effect.forkScoped))
            }
          }).pipe(Effect.forkScoped)
        }),
      stop: Effect.gen(function* () {
        if (schedule) yield* Fiber.interrupt(schedule)
        yield* Effect.forEach(inFlight, Fiber.join, { discard: true })
        yield* Fiber.interrupt(watcher)
        return probes.toSorted((left, right) => left.due - right.due)
      }),
    }
  })

/** Instrument one pass: monitor the event loop and, for the probed pass, run the probes. */
const measure = <A, E, R>(label: string, load: Effect.Effect<A, E, R>, passes: LatencyPass[]) =>
  Effect.gen(function* () {
    if (label === WARMUP) return yield* load
    const probed = label === PROBED
    const probes = probed ? yield* prepareProbes(label) : undefined
    const monitor = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
    const started = performance.now()
    monitor.enable()
    if (probes) yield* probes.start(started)
    const result = yield* load.pipe(Effect.ensuring(Effect.sync(() => void monitor.disable())))
    const windowMs = performance.now() - started
    // Probes in flight at the end finish after the window; they were submitted
    // inside it, so they count.
    const found = probes ? yield* probes.stop : []
    passes.push({ label, probed, windowMs, eventLoop: eventLoopStats(monitor), probes: found })
    return result
  })

/** S5 with the latency instruments attached; `report()` is valid after `scenario.run`. */
export function s5Latency() {
  const passes: LatencyPass[] = []
  const around: S5Around = (label, load) => measure(label, load, passes)
  return {
    scenario: s5Scenario({ around }),
    report: (): LatencyReport => ({
      scenario: "S5",
      database: process.env.PERF_DB_PATH ? "file (WAL, synchronous=NORMAL)" : "memory",
      resolutionMs: RESOLUTION_MS,
      probePeriodMs: PERIOD_MS,
      passes,
    }),
  }
}
