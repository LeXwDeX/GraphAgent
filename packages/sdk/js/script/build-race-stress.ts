#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Regression harness for the #475 openapi.json ownership race: two full
// `bun ./script/build.ts` processes are started simultaneously in this
// checkout, repeated for a bounded number of rounds. The invariant under
// test is that overlapping SDK builds never observe each other's cleanup —
// before the per-run-artifact repair, exactly one loser per round died at
// build.ts's final `rm openapi.json` with ENOENT.
//
// Run from packages/sdk/js: bun ./script/build-race-stress.ts
// SDK_BUILD_RACE_ROUNDS bounds the rounds (default 5).
import { fileURLToPath } from "url"
import { mkdirSync } from "fs"

const rounds = Number(process.env.SDK_BUILD_RACE_ROUNDS ?? 5)
if (!Number.isInteger(rounds) || rounds < 1) {
  console.error(`SDK_BUILD_RACE_ROUNDS must be a positive integer, got: ${rounds}`)
  process.exit(2)
}

const dir = fileURLToPath(new URL("..", import.meta.url))
const logsDir = fileURLToPath(new URL("../.build-race-logs", import.meta.url))
mkdirSync(logsDir, { recursive: true })

const enoentSignature = /[Nn]o such file or directory/
let failures = 0

for (let round = 1; round <= rounds; round++) {
  const procs = [0, 1].map(() =>
    Bun.spawn(["bun", "./script/build.ts"], {
      cwd: dir,
      stdout: "inherit",
      stderr: "pipe",
    }),
  )
  const results = await Promise.all(
    procs.map(async (proc, slot) => {
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      await Bun.write(`${logsDir}/r${round}-b${slot}.err`, stderr)
      return { slot, exitCode, stderr }
    }),
  )
  for (const { slot, exitCode, stderr } of results) {
    if (exitCode !== 0 || enoentSignature.test(stderr)) {
      failures++
      console.error(`FAIL round ${round} build ${slot}: exit=${exitCode} enoent=${enoentSignature.test(stderr)}`)
    }
  }
  console.log(`round ${round}/${rounds} done (failures so far: ${failures})`)
}

if (failures > 0) {
  console.error(`build-race-stress FAILED: ${failures} failing run(s) across ${rounds} rounds; stderr logs in ${logsDir}`)
  process.exit(1)
}
console.log(`build-race-stress OK: ${rounds * 2} simultaneous builds, no ownership-race failures`)
