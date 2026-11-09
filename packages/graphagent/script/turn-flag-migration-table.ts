#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates the PR7 flag migration table for Issue #1019 (H1).
 *
 * The table must describe the tree *before* the PR7 refactor, where the turn
 * flags still exist as mutable `let` bindings. Any later revision can be
 * inspected through git, so the table stays reproducible after the refactor.
 *
 * Usage:
 *   bun run script/turn-flag-migration-table.ts                 # print to stdout (rev defaults to HEAD)
 *   bun run script/turn-flag-migration-table.ts --rev <git-rev>  # reproduce from a pre-refactor commit
 *   bun run script/turn-flag-migration-table.ts --rev <git-rev> --write src/session/turn/turn-state-migration.md
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const FILES = ["src/session/turn/loop.ts", "src/session/turn/stop.ts", "src/session/turn/settle.ts"]

interface FlagRow {
  readonly name: string
  readonly meaning: string
  readonly target: string
  readonly test: string
}

/** Design mapping for every mutable flag in the pre-PR7 loop. */
const ROWS: readonly FlagRow[] = [
  {
    name: "structured",
    meaning: "Structured-output result for the current model step",
    target: "`TurnState.structured` (set/cleared by `State`; consumed by `settleAttempt`)",
    test: "`structured missing -> structured_missing outcome`；`State.setStructured/clearStructured`",
  },
  {
    name: "step",
    meaning: "Model-step counter for the loop invocation",
    target: "`TurnState.step` via `State.incrementStep`",
    test: "`State.incrementStep starts at zero and advances`",
  },
  {
    name: "turnError",
    meaning: "Assistant error at the end of a turn; selects Stop vs StopFailure and blocks continuation",
    target: "`TurnState.error` (set by `State.afterAttempt`), `TurnOutcome.error/cancelled/...`",
    test: "`error outcome`, `cancelled outcome`, `content-filter outcome`, `structured missing -> structured_missing outcome`, `a turn error blocks Stop continuation`",
  },
  {
    name: "stopHookBlocked",
    meaning: "`stop_hook_active` anti-loop signal carried into the next Stop hook",
    target: "`TurnState.stop.active` via `State.continueFromStopBlock`",
    test: "`Stop block within the cap continues`",
  },
  {
    name: "stopContinuationCount",
    meaning: "Consecutive Stop-block continuations without intervening tool work",
    target: "`TurnState.stop.continuations` via `State.continueFromStopBlock`",
    test: "`Stop block within the cap continues`, `Stop block at the cap exits`, `injected cap is respected`",
  },
  {
    name: "forceContinue",
    meaning: "One-shot grant to skip the finished exit after a Stop block",
    target: "`TurnState.continuing` (one-shot, consumed by `Transition.Step`)",
    test: "`a granted continuation produces one Step and is cleared`, `Stop block within the cap continues`",
  },
  {
    name: "turnStopped",
    meaning: "Previous processor outcome was break (finished or blocked)",
    target: "`TurnState.stopped` via `State.afterAttempt` / `State.markStopped` / `State.beginStep`",
    test: "`a stopped turn is a completion candidate even without a finish reason`",
  },
  {
    name: "agentInputBlocked",
    meaning: "Agent mailbox input is frozen for this turn",
    target: '`TurnState.agentInput = "blocked"` via `State.blockAgentInput`; extra continuation checks in `decide`',
    test: "`blocked agent input runs Stop hooks but cannot continue`, `blocked agent input never continues`",
  },
  {
    name: "agentBoundaryApproved",
    meaning: "A Stop exit found queued input and allowed one more boundary crossing",
    target: '`TurnState.agentInput = "boundary_approved"` via `State.continueFromQueuedInput`',
    test: "`queued input continues only after an authoritative check`, `shouldFreezeAgentInput allows boundary_approved`",
  },
  {
    name: "consecutiveAutoCompactions",
    meaning: "Consecutive automatic compactions; the 4th is refused",
    target: "`TurnState.compactions` via `State.recordAutoCompaction` / `State.resetAutoCompactions`",
    test: "`first automatic compaction is allowed`, `fourth automatic compaction is refused`",
  },
  {
    name: "stopHookContinuationCap",
    meaning: "Injected upper bound for Stop-block continuations (`SettingsHook.stopHookBlockCap()`)",
    target: "`TurnState.stop.cap`, injected once through `State.initial({ stopCap })`",
    test: "`injected cap is respected`",
  },
]

interface FlagOccurrence {
  readonly file: string
  declaration?: number
  readonly uses: number[]
}

function parseArgs(argv: string[]) {
  const args = { rev: "HEAD", write: undefined as string | undefined }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--rev") args.rev = argv[++index] ?? "HEAD"
    else if (argv[index] === "--write") args.write = argv[++index]
  }
  return args
}

function gitRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim()
}

function readAtRevision(root: string, rev: string, file: string) {
  const repoPath = path.relative(root, path.join(PACKAGE_ROOT, file)).replaceAll(path.sep, "/")
  try {
    return execFileSync("git", ["show", `${rev}:${repoPath}`], { cwd: root, encoding: "utf8" })
  } catch {
    throw new Error(`cannot read ${repoPath} at revision ${rev}`)
  }
}

function findOccurrences(file: string, source: ts.SourceFile, names: readonly string[]) {
  const occurrences = new Map<string, FlagOccurrence>(names.map((name) => [name, { file, uses: [] }]))
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const entry = occurrences.get(node.name.text)
      if (entry && node.parent.flags & ts.NodeFlags.Let) {
        entry.declaration = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      }
    }
    if (ts.isIdentifier(node)) {
      const entry = occurrences.get(node.text)
      const isDeclarationName = ts.isVariableDeclaration(node.parent) && node.parent.name === node
      if (entry && !isDeclarationName) {
        entry.uses.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return occurrences
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = gitRoot()
  const perFlag = new Map<string, FlagOccurrence[]>()
  for (const flag of ROWS) perFlag.set(flag.name, [])
  for (const file of FILES) {
    const text = readAtRevision(root, args.rev, file)
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const occurrences = findOccurrences(
      file,
      source,
      ROWS.map((row) => row.name),
    )
    for (const [name, occurrence] of occurrences) perFlag.get(name)?.push(occurrence)
  }

  const lines: string[] = [
    "# Turn flag migration table (Issue #1019, PR7)",
    "",
    `Generated by \`script/turn-flag-migration-table.ts\` from \`${args.rev}\`, the tree before PR7 turned the loop flags into \`TurnState\`.`,
    `Regenerate: \`cd packages/graphagent && bun run script/turn-flag-migration-table.ts --rev ${args.rev} --write src/session/turn/turn-state-migration.md && bunx prettier --write src/session/turn/turn-state-migration.md\`.`,
    "",
    "| 旧变量（声明） | 使用行 | 含义 | 目标 | 对应单测（test/session/turn/decide.test.ts） |",
    "| --- | --- | --- | --- | --- |",
  ]

  for (const row of ROWS) {
    const occurrences = (perFlag.get(row.name) ?? []).filter(
      (occurrence) => occurrence.declaration !== undefined || occurrence.uses.length > 0,
    )
    if (occurrences.length === 0) {
      lines.push(`| \`${row.name}\` | (not present at ${args.rev}) | ${row.meaning} | ${row.target} | ${row.test} |`)
      continue
    }
    const declarations = occurrences
      .filter((occurrence) => occurrence.declaration !== undefined)
      .map((occurrence) => `${path.basename(occurrence.file)}:${occurrence.declaration}`)
      .join(", ")
    const uses = occurrences
      .map((occurrence) => {
        const unique = [...new Set(occurrence.uses)].sort((a, b) => a - b)
        return unique.length > 0 ? `${path.basename(occurrence.file)}: ${unique.join(", ")}` : undefined
      })
      .filter((value): value is string => value !== undefined)
      .join("; ")
    lines.push(
      `| \`${row.name}\`（${declarations || "parameter"}) | ${uses || "—"} | ${row.meaning} | ${row.target} | ${row.test} |`,
    )
  }
  lines.push("")

  const output = lines.join("\n")
  if (args.write) {
    writeFileSync(path.resolve(PACKAGE_ROOT, args.write), output)
    console.log(`wrote ${args.write} from ${args.rev}`)
  } else {
    console.log(output)
  }
  return 0
}

process.exit(main())
