// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import path from "node:path"
import {
  BASELINE_FILE,
  CANDIDATE_FILE,
  DEFAULT_SCENARIO,
  median,
  parseBaseline,
  parseRun,
  summarize,
  toBaseline,
  WARN_RATIO,
  type Machine,
  type PtyBaseline,
  type PtyRun,
} from "./pty-report"
import { tmpdir } from "../fixture/fixture"

const mac: Machine = { platform: "darwin", arch: "arm64", cpu: "Apple M4 Pro", cpuCount: 14 }
const linux: Machine = { platform: "linux", arch: "x64", cpu: "Cloud CPU", cpuCount: 8 }

function run(elapsedMs: number | null, machine: Machine = mac, extra: Partial<PtyRun> = {}): PtyRun {
  return { scenario: DEFAULT_SCENARIO, elapsedMs, commit: "abcdef0123456789", bun: "1.4.4", machine, ...extra }
}

function baseline(elapsedMs = 2000, machine: Machine = mac, scenario = DEFAULT_SCENARIO): PtyBaseline {
  return {
    ...run(elapsedMs, machine, { scenario }),
    schemaVersion: 1,
    elapsedMs,
    samples: [elapsedMs - 20, elapsedMs, elapsedMs + 30],
    generatedAt: "2026-11-16T00:00:00.000Z",
  }
}

test("a run report is read out of whatever surrounds it, and output without one is a failed run", () => {
  const printed = `$ bun test/perf/pty.ts\n${JSON.stringify(run(2210.5))}\nerror: script exited\n`
  expect(parseRun(printed)).toMatchObject({ scenario: DEFAULT_SCENARIO, elapsedMs: 2210.5, machine: mac })
  expect(parseRun(JSON.stringify({ elapsedMs: null, outputTail: "boom" }))).toMatchObject({
    elapsedMs: null,
    outputTail: "boom",
  })
  for (const garbage of ["", "no json here", "{ not json }", "[1, 2]", `{"elapsedMs":"fast"}`]) {
    expect(parseRun(garbage).elapsedMs).toBeNull()
  }
})

test("the median of an even count is the mean of the middle two", () => {
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 3, 2])).toBe(2.5)
  expect(median([7])).toBe(7)
})

test("the ratio is the median of the runs over the baseline, and it warns only above the limit", () => {
  const within = summarize([run(2900), run(3000), run(9000)], baseline(2000))
  expect(within.rows).toEqual([
    expect.objectContaining({
      scenario: DEFAULT_SCENARIO,
      baselineMs: 2000,
      currentMs: 3000,
      ratio: 1.5,
      status: "ok",
    }),
  ])
  expect(within.warnings).toEqual([])

  const slower = summarize([run(3090), run(3100), run(3110)], baseline(2000))
  expect(slower.rows[0]).toMatchObject({ currentMs: 3100, ratio: 1.55, status: "slower" })
  expect(slower.warnings).toEqual([`${DEFAULT_SCENARIO}: 1.55x the baseline (3100 ms against 2000 ms)`])

  // The limit is a parameter, and the default is the one the nightly documents.
  expect(WARN_RATIO).toBe(1.5)
  expect(summarize([run(2400)], baseline(2000), { warnRatio: 1.1 }).rows[0].status).toBe("slower")
})

test("the table has one row with the baseline, the current median, the ratio and the status", () => {
  const { markdown } = summarize([run(2100), run(2200), run(2300)], baseline(2000))
  expect(markdown).toContain(
    [
      "| scenario | baseline (ms) | current (ms) | ratio | status |",
      "| --- | ---: | ---: | ---: | --- |",
      "| boot-to-prompt | 2000 | 2200 | 1.10x | ok |",
    ].join("\n"),
  )
  expect(markdown).toContain("- boot-to-prompt: median of 3 of 3 runs, min 2100, max 2300 ms")
  expect(markdown).toContain("- current: abcdef0, darwin arm64, Apple M4 Pro (14 cores), bun 1.4.4")
  expect(markdown).toContain("- baseline: median of 3 runs, abcdef0, darwin arm64, Apple M4 Pro (14 cores), bun 1.4.4")
  expect(markdown).toContain("never blocks a PR")
})

test("a run that never reached the input box is reported, and the median uses the ones that did", () => {
  const some = summarize([run(2100), run(null), run(2300)], baseline(2000))
  expect(some.rows[0]).toMatchObject({ currentMs: 2200, failed: 1, status: "ok" })
  expect(some.warnings).toEqual([`${DEFAULT_SCENARIO}: 1 of 3 runs did not reach the input box`])

  const none = summarize(
    [run(null, mac, { outputTail: "error: Script not found\n##vso[task.complete result=Failed;]x" }), run(null)],
    baseline(2000),
  )
  expect(none.rows[0]).toMatchObject({ currentMs: undefined, ratio: undefined, status: "failed" })
  expect(none.warnings).toEqual([`${DEFAULT_SCENARIO}: none of 2 runs reached the input box`])
  expect(none.markdown).toContain("| boot-to-prompt | 2000 | n/a | n/a | failed |")
  expect(none.markdown).toContain("error: Script not found")
  // The tail reaches the build log, where a line that starts with `##vso[` would be a logging command.
  expect(none.markdown).not.toContain("##vso")
  expect(none.markdown).toContain("# #vso[task.complete result=Failed;]x")
})

test("without a baseline the table says so and nothing warns", () => {
  const { rows, warnings, markdown } = summarize([run(2100), run(2200)])
  expect(rows[0]).toMatchObject({ baselineMs: undefined, currentMs: 2150, ratio: undefined, status: "no baseline" })
  expect(warnings).toEqual([])
  expect(markdown).toContain("| boot-to-prompt | n/a | 2150 | n/a | no baseline |")
  expect(markdown).toContain(CANDIDATE_FILE)

  // A baseline for another scenario is no baseline for this one.
  expect(summarize([run(2100)], baseline(2000, mac, "other")).rows[0].status).toBe("no baseline")
})

test("a baseline from another platform shows the ratio but never warns", () => {
  const { rows, warnings, markdown } = summarize([run(8000, linux), run(8200, linux)], baseline(2000, mac))
  expect(rows[0]).toMatchObject({ ratio: 4.05, status: "other platform" })
  expect(warnings).toEqual([])
  expect(markdown).toContain("| boot-to-prompt | 2000 | 8100 | 4.05x | other platform |")
  expect(markdown).toContain(`commit \`${CANDIDATE_FILE}\``)
  // Same platform, other CPU model: still a verdict.
  expect(summarize([run(8000, { ...mac, cpu: "Apple M5" })], baseline(2000, mac)).rows[0].status).toBe("slower")
})

test("the finished runs make a baseline that reads back, and none finishing makes none", () => {
  const made = toBaseline([run(2100), run(null), run(2300), run(2200)], new Date("2026-11-16T12:00:00.000Z"))
  expect(made).toMatchObject({
    schemaVersion: 1,
    scenario: DEFAULT_SCENARIO,
    elapsedMs: 2200,
    samples: [2100, 2300, 2200],
    commit: "abcdef0123456789",
    generatedAt: "2026-11-16T12:00:00.000Z",
    machine: mac,
  })
  if (!made) throw new Error("the finished runs made no baseline")
  expect(parseBaseline(JSON.stringify(made))).toEqual(made)
  expect(toBaseline([run(null), run(null)])).toBeUndefined()
  // `pty.ts` reads `elapsedMs` of the same file through TUI_PTY_BASELINE.
  expect(JSON.parse(JSON.stringify(made)).elapsedMs).toBe(2200)
})

test("a baseline file without a timing is refused", () => {
  expect(() => parseBaseline("{}")).toThrow("elapsedMs")
  expect(() => parseBaseline(JSON.stringify({ elapsedMs: null }))).toThrow("elapsedMs")
  expect(() => parseBaseline("not json")).toThrow("elapsedMs")
})

test("the committed baseline is one the nightly can compare against", async () => {
  const committed = parseBaseline(await Bun.file(BASELINE_FILE).text())
  expect(committed.scenario).toBe(DEFAULT_SCENARIO)
  expect(committed.elapsedMs).toBeGreaterThan(0)
  expect(committed.samples.length).toBeGreaterThanOrEqual(3)
  expect(committed.machine?.platform).toBeTruthy()
  expect(committed.commit).toMatch(/^[0-9a-f]{40}$/)
  // It is what `pty.ts` reports, with the placeholder it waits for.
  expect(committed.expected).toBe("Ask anything")
})

test("CLI: exit 0 for a clean table, 3 with warnings, 2 for unusable input", async () => {
  await using directory = await tmpdir()
  const write = async (name: string, value: unknown) => {
    const file = path.join(directory.path, name)
    await Bun.write(file, typeof value === "string" ? value : JSON.stringify(value))
    return file
  }
  const script = path.join(import.meta.dir, "pty-report.ts")
  const baselineFile = await write("baseline.json", baseline(2000))
  const clean = await write("clean.json", run(2100))
  const slow = await write("slow.json", run(5000))
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  const summary = path.join(directory.path, "summary.md")
  const candidate = path.join(directory.path, CANDIDATE_FILE)
  const ok = cli(clean, `--baseline=${baselineFile}`, `--summary=${summary}`, `--write-baseline=${candidate}`)
  expect(ok.code).toBe(0)
  expect(ok.out).toContain("| boot-to-prompt | 2000 | 2100 | 1.05x | ok |")
  expect(await Bun.file(summary).text()).toBe(ok.out.replace(/\n$/, ""))
  expect(parseBaseline(await Bun.file(candidate).text())).toMatchObject({ elapsedMs: 2100, samples: [2100] })

  const slower = cli(slow, `--baseline=${baselineFile}`)
  expect(slower.code).toBe(3)
  expect(slower.out).toContain("| boot-to-prompt | 2000 | 5000 | 2.50x | slower |")
  expect(slower.err).toContain("warning: boot-to-prompt: 2.50x the baseline (5000 ms against 2000 ms)")
  // The limit can be moved from the command line.
  expect(cli(slow, `--baseline=${baselineFile}`, "--warn-ratio=3").code).toBe(0)

  // A run file that was never written is a failed run, not a crash.
  const missing = cli(path.join(directory.path, "run-9.json"), `--baseline=${baselineFile}`)
  expect(missing.code).toBe(3)
  expect(missing.out).toContain("| boot-to-prompt | 2000 | n/a | n/a | failed |")
  expect(missing.out).toContain("run-9.json was not written")

  expect(cli().code).toBe(2)
  expect(cli(clean, "--warn-ratio=1").code).toBe(2)
  expect(cli(clean, `--baseline=${await write("broken.json", "{}")}`).code).toBe(2)
  // No baseline file at all is a table without ratios.
  expect(cli(clean, `--baseline=${path.join(directory.path, "absent.json")}`).code).toBe(0)
})
