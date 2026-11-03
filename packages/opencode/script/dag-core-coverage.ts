import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type CoverageRecord = {
  lines: { found: number; hit: number }
  functions: { found: number; hit: number }
}

export type CoverageThreshold = {
  file: string
  lines: number
  functions: number
}

export function parseLcov(input: string) {
  return input
    .split("end_of_record")
    .map((record) => record.trim().split(/\r?\n/))
    .reduce((report, lines) => {
      const file = field(lines, "SF")
      if (!file) return report
      report.set(file, {
        lines: {
          found: Number(field(lines, "LF") ?? 0),
          hit: Number(field(lines, "LH") ?? 0),
        },
        functions: {
          found: Number(field(lines, "FNF") ?? 0),
          hit: Number(field(lines, "FNH") ?? 0),
        },
      })
      return report
    }, new Map<string, CoverageRecord>())
}

export function assertCoverage(report: ReadonlyMap<string, CoverageRecord>, thresholds: readonly CoverageThreshold[]) {
  const failures = thresholds.flatMap((threshold) => {
    const record = report.get(threshold.file)
    if (!record) return [`${threshold.file}: missing from LCOV report`]
    const lines = percentage(record.lines)
    const functions = percentage(record.functions)
    return [
      ...(lines < threshold.lines
        ? [`${threshold.file}: lines ${lines.toFixed(2)}% < ${threshold.lines.toFixed(2)}%`]
        : []),
      ...(functions < threshold.functions
        ? [`${threshold.file}: functions ${functions.toFixed(2)}% < ${threshold.functions.toFixed(2)}%`]
        : []),
    ]
  })
  if (failures.length > 0) throw new Error(`DAG core coverage gate failed:\n${failures.join("\n")}`)
}

export async function runDagCoreCoverageGate() {
  const root = path.resolve(import.meta.dir, "../../..")
  const output = await mkdtemp(path.join(os.tmpdir(), "opencode-dag-core-coverage-"))
  try {
    yieldMessage("Core state machine, store, and transition seams")
    await runCoverageSuite({
      cwd: path.join(root, "packages/core"),
      output: path.join(output, "core"),
      tests: [
        "test/dag-core.test.ts",
        "test/dag-replan-dependency-closure.test.ts",
        "test/dag-capture-presence.test.ts",
        "test/dag-worktree-history-projection.test.ts",
        "test/dag-messages.test.ts",
        "test/dag-store-wake.test.ts",
        "test/dag-node-cancelled-projection.test.ts",
        "test/dag-store-summaries.test.ts",
        "test/dag-store-checkpoint-control.test.ts",
        "test/dag-projector-drift.test.ts",
      ],
      thresholds: [
        { file: "src/dag/core/graph.ts", lines: 70, functions: 60 },
        { file: "src/dag/core/replan.ts", lines: 90, functions: 95 },
        { file: "src/dag/core/scheduling.ts", lines: 92, functions: 80 },
        { file: "src/dag/core/transitions.ts", lines: 94, functions: 75 },
        { file: "src/dag/core/types.ts", lines: 92, functions: 85 },
        { file: "src/dag/store.ts", lines: 75, functions: 65 },
      ],
    })

    yieldMessage("OpenCode DAG public API and runtime seams")
    await runCoverageSuite({
      cwd: path.join(root, "packages/opencode"),
      output: path.join(output, "opencode"),
      tests: ["test/dag"],
      thresholds: [
        { file: "../core/src/dag/projector.ts", lines: 98, functions: 95 },
        { file: "../core/src/dag/store.ts", lines: 85, functions: 80 },
        { file: "src/dag/dag.ts", lines: 98, functions: 95 },
        { file: "src/dag/runtime/loop.ts", lines: 90, functions: 88 },
        { file: "src/dag/runtime/recovery.ts", lines: 95, functions: 75 },
        { file: "src/dag/runtime/spawn.ts", lines: 90, functions: 70 },
        { file: "src/dag/runtime/summary-publisher.ts", lines: 95, functions: 90 },
        { file: "src/tool/workflow.ts", lines: 88, functions: 75 },
      ],
    })

    yieldMessage("Schema manifest and generated SDK contract")
    await run(["bun", "test", "test/event-manifest.test.ts", "--only-failures"], path.join(root, "packages/schema"))
    await run(["bun", "run", "check:generated"], path.join(root, "packages/sdk/js"))

    yieldMessage("TUI projection and inspector seams")
    await runCoverageSuite({
      cwd: path.join(root, "packages/tui"),
      output: path.join(output, "tui"),
      tests: [
        "test/cli/cmd/tui/sync-dag.test.tsx",
        "test/feature-plugins/dag-inspector.test.tsx",
        "test/feature-plugins/dag-inspector-utils.test.ts",
      ],
      thresholds: [
        { file: "src/feature-plugins/system/dag-inspector-utils.ts", lines: 98, functions: 95 },
        { file: "src/feature-plugins/system/dag-inspector.tsx", lines: 90, functions: 88 },
      ],
    })
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}

function field(lines: readonly string[], key: string) {
  const prefix = `${key}:`
  const line = lines.find((item) => item.startsWith(prefix))
  return line?.slice(prefix.length)
}

function percentage(value: { found: number; hit: number }) {
  if (value.found === 0) return 100
  return (value.hit / value.found) * 100
}

async function runCoverageSuite(input: {
  cwd: string
  output: string
  tests: string[]
  thresholds: CoverageThreshold[]
}) {
  await run(
    [
      "bun",
      "test",
      ...input.tests,
      "--only-failures",
      "--timeout=30000",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${input.output}`,
    ],
    input.cwd,
  )
  assertCoverage(parseLcov(await Bun.file(path.join(input.output, "lcov.info")).text()), input.thresholds)
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`)
}

function yieldMessage(message: string) {
  console.log(`\n[DAG core gate] ${message}`)
}

if (import.meta.main) {
  await runDagCoreCoverageGate()
  console.log("\n[DAG core gate] all critical behavior and coverage floors passed")
}
