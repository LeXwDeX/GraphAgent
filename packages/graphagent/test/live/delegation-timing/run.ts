// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-model evaluation of foreground/background delegation (Issue #1057, plan 6).
 *
 It is a script, not a test file: `bun test` never runs it, and it does not load the package's
 * test preload, which sandboxes XDG paths and clears standard provider credential variables
 * (`OPENAI_API_KEY`, ...) that the configured provider may reference. Run it from `packages/graphagent`:
 *
 *   GRAPHAGENT_LIVE_EVAL_CONFIG=<path to graphagent.json> bun run test/live/delegation-timing/run.ts
 *
 * Environment:
 *
 * - GRAPHAGENT_LIVE_EVAL_CONFIG       config to read the providers from (required)
 * - GRAPHAGENT_LIVE_EVAL_MODELS       comma-separated provider/model ids; default: every configured QWEN, GLM or
 *                                     DeepSeek model (other families are refused)
 * - GRAPHAGENT_LIVE_EVAL_ROUNDS       rounds per model (default 3)
 * - GRAPHAGENT_LIVE_EVAL_CONCURRENCY  scenarios in flight per host (default 4)
 * - GRAPHAGENT_LIVE_EVAL_STEPS        model steps per scenario (default 8)
 * - GRAPHAGENT_LIVE_EVAL_TIMEOUT_MS   per-turn timeout in milliseconds (default 360000)
 * - GRAPHAGENT_LIVE_EVAL_SCENARIOS    comma-separated scenario ids, for debugging
 * - GRAPHAGENT_LIVE_EVAL_OUT          output directory for the report, raw results and transcripts
 * - GRAPHAGENT_LIVE_EVAL_KEEP=1       keep the temporary homes and workspaces
 *
 * The Markdown result table is printed; raw results go to a temporary directory,
 * never into the repository. Each model family is judged on its own against the
 * gates of the Issue: no foreground violation, at least 5/6 background hits, and
 * at least 85% accuracy. The exit code is 0 only when every family passes.
 */

import { allPass, gates, rates } from "./classify"
import { evaluate, optionsFromEnv, stopAllHosts } from "./harness"

try {
  const result = await evaluate(optionsFromEnv(process.env), (line) => console.log(line))
  console.log(result.report)
  console.log(`raw results: ${result.outDir}`)
  const families = [...new Set(result.records.map((record) => record.family))]
  const failed = families.filter(
    (family) => !allPass(gates(rates(result.records.filter((record) => record.family === family)))),
  )
  if (failed.length > 0) console.log(`below the gates: ${failed.join(", ")}`)
  process.exitCode = failed.length > 0 ? 1 : 0
} finally {
  await stopAllHosts()
}
