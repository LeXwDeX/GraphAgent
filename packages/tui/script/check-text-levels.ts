// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Ratchet on text levels in the TUI panels (#1672, `AGENTS.md` 13.6). A panel names the role a piece of text plays and
 * gets its color and weight from `src/ui/text.ts` (`textFg(theme, "secondary")`, `textAttributes("title")`); a color or
 * a weight written straight in the panel is a level the table does not know about. This scan counts, under `src/panel/`:
 *
 *   - a level color written straight after `fg` or `color`: `fg={theme.primary}`, `color={theme.textMuted}`, ...;
 *   - a weight written straight: `TextAttributes.BOLD`.
 *
 * The scan reads the TypeScript AST, so comments and strings never count.
 *
 * It is a coarse ratchet on purpose. Status colors (`success`, `warning`, `error`, `statusRunning`), the selection
 * background, the warning border, backgrounds and the brand `primary` of a link are states and not levels (13.6), so
 * they are not counted and stay as they are; the weight a selected row adds to its main text is selection state too, and
 * the few status rows that are bold stay in the baseline. What the count does catch is a new level color or a new bold
 * written in a panel, which is what the ratchet is for.
 *
 * `text-levels-baseline.txt` holds the count allowed today. A tree above it fails and lists every occurrence; a tree
 * below it passes and asks for the baseline to be lowered, so the number only goes down.
 *
 * From `packages/tui`:
 *
 *   bun script/check-text-levels.ts                    compare the tree with the baseline
 *   bun script/check-text-levels.ts --update-baseline  lower the baseline to the current count (refuses to raise it)
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const TUI_DIR = path.join(import.meta.dir, "..")
const DEFAULT_ROOT = path.join(TUI_DIR, "src")

/** Directories under the source root that the ratchet scans. */
export const TEXT_LEVEL_DIRS: readonly string[] = ["panel"]

/** Attributes whose value is a foreground color. */
const COLOR_NAMES = new Set(["fg", "color"])

/** The theme tokens the six levels are drawn in (13.6); anything else is a state or a brand color. */
const LEVEL_TOKENS = new Set(["primary", "text", "textMuted", "textDim"])

export const TEXT_LEVELS_BASELINE_PATH = path.join(import.meta.dir, "text-levels-baseline.txt")

export interface TextLevelLiteral {
  /** File relative to the source root, POSIX separators. */
  file: string
  line: number
  /** The attribute or the weight as written, on one line. */
  text: string
}

export interface TextLevelScanOptions {
  root?: string
  /** Directories under the root to scan, POSIX separators. */
  dirs?: readonly string[]
}

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

/** `theme.primary` and `TextAttributes.BOLD`, and nothing else. */
function levelToken(name: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(name)) return undefined
  if (name.name.text !== "BOLD") return undefined
  return name.expression.getText().endsWith("TextAttributes") ? "TextAttributes.BOLD" : undefined
}

function colorToken(name: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(name)) return undefined
  if (!ts.isIdentifier(name.expression) || name.expression.text !== "theme") return undefined
  return LEVEL_TOKENS.has(name.name.text) ? name.name.text : undefined
}

/** Every level color or weight written straight in a panel, in file order. */
export function collectTextLevelLiterals(options: TextLevelScanOptions = {}): TextLevelLiteral[] {
  const root = options.root ?? DEFAULT_ROOT
  const dirs = options.dirs ?? TEXT_LEVEL_DIRS
  const found: TextLevelLiteral[] = []

  const entries = dirs.flatMap((dir) => [...new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: root })].map(toPosix))

  for (const entry of entries.sort()) {
    const file = path.join(root, entry)
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    const record = (node: ts.Node, text: string) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      found.push({ file: entry, line, text })
    }

    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && COLOR_NAMES.has(node.name.text)) {
        const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined
        const token = value && colorToken(value)
        if (token) record(node, `${node.name.text}={theme.${token}}`)
      } else if (ts.isPropertyAccessExpression(node) && levelToken(node) === "TextAttributes.BOLD") {
        record(node, "TextAttributes.BOLD")
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return found
}

export function formatTextLevelLiteral(literal: TextLevelLiteral) {
  return `${literal.file}:${literal.line} ${literal.text}`
}

// Plain text on purpose: a formatter leaves it alone, and git merges it line by line.
const BASELINE_HEADER = [
  "# Text levels the ratchet allows (script/check-text-levels.ts): level colors written straight after fg or color,",
  "# and TextAttributes.BOLD, in src/panel/.",
  "# The number only goes down: name the role instead (textFg / textAttributes in src/ui/text.ts), then run",
  "# `bun script/check-text-levels.ts --update-baseline`.",
]

/** Canonical file text: the header, then the allowed count. */
export function formatTextLevelsBaseline(count: number) {
  return [...BASELINE_HEADER, String(count), ""].join("\n")
}

export function parseTextLevelsBaseline(raw: string) {
  const rows = raw.split("\n").filter((line) => line !== "" && !line.startsWith("#"))
  const count = Number(rows[0])
  if (rows.length !== 1 || !Number.isInteger(count) || count < 0)
    throw new Error("text levels baseline: expected one count")
  return count
}

export function readTextLevelsBaseline(file = TEXT_LEVELS_BASELINE_PATH) {
  return parseTextLevelsBaseline(readFileSync(file, "utf8"))
}

export interface TextLevelsComparison {
  /** Literals in the tree. */
  count: number
  /** Literals the baseline allows. */
  baseline: number
  /** Literals beyond the baseline; the check fails when there are any. */
  over: number
  /** Literals the baseline allows that the tree no longer has; the baseline can come down by this many. */
  slack: number
}

export function compareTextLevelsBaseline(count: number, baseline: number): TextLevelsComparison {
  return { count, baseline, over: Math.max(0, count - baseline), slack: Math.max(0, baseline - count) }
}

export interface TextLevelsBaselineUpdate {
  written: boolean
  /** Literals beyond the baseline; when there are any nothing is written. */
  over: number
}

/** Shrink-only update: write the current count as the baseline unless that would raise it. */
export function updateTextLevelsBaseline(count: number, file = TEXT_LEVELS_BASELINE_PATH): TextLevelsBaselineUpdate {
  const { over } = compareTextLevelsBaseline(count, readTextLevelsBaseline(file))
  if (over > 0) return { written: false, over }
  writeFileSync(file, formatTextLevelsBaseline(count))
  return { written: true, over }
}

/** What the failure says, ending with the locations of every literal in the tree. */
export function formatTextLevelsFailure(comparison: TextLevelsComparison, literals: readonly TextLevelLiteral[]) {
  return [
    `TUI text levels: ${comparison.count} found, the baseline allows ${comparison.baseline}.`,
    "Name the role instead (textFg / textAttributes / textStyle in src/ui/text.ts) and leave status colors, the",
    "selection background and the brand primary of a link alone; the baseline only goes down. Every literal in the tree:",
    ...literals.map((literal) => `  ${formatTextLevelLiteral(literal)}`),
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function main(argv: readonly string[]) {
  const literals = collectTextLevelLiterals()
  const comparison = compareTextLevelsBaseline(literals.length, readTextLevelsBaseline())

  if (comparison.over > 0) {
    console.error(formatTextLevelsFailure(comparison, literals))
    process.exit(1)
  }

  if (argv.includes("--update-baseline")) {
    updateTextLevelsBaseline(comparison.count)
    console.log(`Text level baseline is now ${comparison.count} (was ${comparison.baseline})`)
  } else if (comparison.slack > 0) {
    console.log(
      `TUI text levels: ${comparison.count}, the baseline allows ${comparison.baseline}; lower it: bun script/check-text-levels.ts --update-baseline`,
    )
  } else {
    console.log(`TUI text level check passed (${comparison.count})`)
  }
}

if (import.meta.main) main(process.argv.slice(2))
