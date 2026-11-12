// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { s5Latency } from "./s5-latency"

// Runner for `script/perf/engine-wall.ts --latency` (Issue #1021). It is named
// `*.probe.ts` on purpose: `bun test` only discovers `*.test.ts`, so the CI run
// never picks it up; the script starts it with an explicit path. Run alone, it
// prints the report to stderr, e.g.
//   PERF_DB_PATH=/tmp/s5.sqlite bun test ./test/perf/s5-latency.probe.ts
// `PERF_LATENCY_OUT` names the file the script reads the report from.
const { scenario, report } = s5Latency()
const it = testEffect(scenario.layer)

describe("S5 latency record", () => {
  it.instance(
    "records event-loop delay and interactive TTFT while S5 runs",
    () =>
      Effect.gen(function* () {
        yield* scenario.run
        const result = report()

        // The values have no threshold. These checks only keep the record from
        // being vacuous: both measured passes were watched, the event loop was
        // sampled, and the probed pass produced probes.
        expect(result.passes.map((pass) => pass.label)).toEqual(["S5 first", "S5 second"])
        for (const pass of result.passes) {
          expect(pass.eventLoop.samples).toBeGreaterThan(0)
          if (pass.probed) expect(pass.probes.length).toBeGreaterThan(0)
          else expect(pass.probes).toEqual([])
        }

        const json = `${JSON.stringify(result, null, 2)}\n`
        const output = process.env.PERF_LATENCY_OUT
        if (output) yield* Effect.promise(() => Bun.write(output, json))
        else process.stderr.write(json)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
