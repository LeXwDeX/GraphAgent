// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Ratchet on layout literals in the TUI source (#1670). The horizontal padding and margin of the screen's regions come
 * from the tokens in `src/ui/layout.ts`; a number written straight after `paddingLeft`, `paddingRight`, `marginLeft` or
 * `marginRight` (`paddingLeft={2}`, `paddingLeft: 2`, `paddingRight={1 + shift}`) is counted here. The scan reads the
 * TypeScript AST, so comments and strings never count, and covers `shell/`, `routes/`, `panel/` and `component/`.
 *
 * `layout-literals-baseline.txt` holds the count allowed today. A tree above it fails and lists every literal; a tree
 * below it passes and asks for the baseline to be lowered, so the number only goes down.
 *
 * From `packages/tui`:
 *
 *   bun script/check-layout-literals.ts                    compare the tree with the baseline
 *   bun script/check-layout-literals.ts --update-baseline  lower the baseline to the current count (refuses to raise it)
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const TUI_DIR = path.join(import.meta.dir, "..")
const DEFAULT_ROOT = path.join(TUI_DIR, "src")

/** Directories under the source root that the ratchet scans. */
export const LAYOUT_DIRS: readonly string[] = ["shell", "routes", "panel", "component"]

/** Attribute and property names whose values lay out the horizontal edges of a box. */
const EDGE_NAMES = new Set(["paddingLeft", "paddingRight", "marginLeft", "marginRight"])

/** A value that starts with a number: `2`, `-1`, `1 + shift`. */
const STARTS_WITH_NUMBER = /^-?\s*\d/

export const LAYOUT_BASELINE_PATH = path.join(import.meta.dir, "layout-literals-baseline.txt")

export interface LayoutLiteral {
  /** File relative to the source root, POSIX separators. */
  file: string
  line: number
  /** The attribute or property as written, on one line. */
  text: string
}

export interface LayoutScanOptions {
  root?: string
  /** Directories under the root to scan, POSIX separators. */
  dirs?: readonly string[]
}

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

function edgeName(name: ts.Node) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

/** Every number written straight after an edge name, in file order. */
export function collectLayoutLiterals(options: LayoutScanOptions = {}): LayoutLiteral[] {
  const root = options.root ?? DEFAULT_ROOT
  const dirs = options.dirs ?? LAYOUT_DIRS
  const found: LayoutLiteral[] = []

  const entries = dirs.flatMap((dir) => [...new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: root })].map(toPosix))

  for (const entry of entries.sort()) {
    const file = path.join(root, entry)
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    const record = (node: ts.Node) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      found.push({ file: entry, line, text: node.getText(sourceFile).replace(/\s+/g, " ") })
    }

    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && EDGE_NAMES.has(node.name.text)) {
        const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined
        if (value && STARTS_WITH_NUMBER.test(value.getText(sourceFile))) record(node)
      } else if (ts.isPropertyAssignment(node)) {
        const name = edgeName(node.name)
        if (name && EDGE_NAMES.has(name) && STARTS_WITH_NUMBER.test(node.initializer.getText(sourceFile))) record(node)
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return found
}

export function formatLayoutLiteral(literal: LayoutLiteral) {
  return `${literal.file}:${literal.line} ${literal.text}`
}

// Plain text on purpose: a formatter leaves it alone, and git merges it line by line.
const BASELINE_HEADER = [
  "# Layout literals the ratchet allows (script/check-layout-literals.ts): numbers written straight after paddingLeft,",
  "# paddingRight, marginLeft and marginRight in shell/, routes/, panel/ and component/.",
  "# The number only goes down: use the tokens in src/ui/layout.ts, then run `bun script/check-layout-literals.ts --update-baseline`.",
]

/** Canonical file text: the header, then the allowed count. */
export function formatLayoutBaseline(count: number) {
  return [...BASELINE_HEADER, String(count), ""].join("\n")
}

export function parseLayoutBaseline(raw: string) {
  const rows = raw.split("\n").filter((line) => line !== "" && !line.startsWith("#"))
  const count = Number(rows[0])
  if (rows.length !== 1 || !Number.isInteger(count) || count < 0) throw new Error("layout baseline: expected one count")
  return count
}

export function readLayoutBaseline(file = LAYOUT_BASELINE_PATH) {
  return parseLayoutBaseline(readFileSync(file, "utf8"))
}

export interface LayoutComparison {
  /** Literals in the tree. */
  count: number
  /** Literals the baseline allows. */
  baseline: number
  /** Literals beyond the baseline; the check fails when there are any. */
  over: number
  /** Literals the baseline allows that the tree no longer has; the baseline can come down by this many. */
  slack: number
}

export function compareLayoutBaseline(count: number, baseline: number): LayoutComparison {
  return { count, baseline, over: Math.max(0, count - baseline), slack: Math.max(0, baseline - count) }
}

export interface LayoutBaselineUpdate {
  written: boolean
  /** Literals beyond the baseline; when there are any nothing is written. */
  over: number
}

/** Shrink-only update: write the current count as the baseline unless that would raise it. */
export function updateLayoutBaseline(count: number, file = LAYOUT_BASELINE_PATH): LayoutBaselineUpdate {
  const { over } = compareLayoutBaseline(count, readLayoutBaseline(file))
  if (over > 0) return { written: false, over }
  writeFileSync(file, formatLayoutBaseline(count))
  return { written: true, over }
}

/** What the failure says, ending with the locations of every literal in the tree. */
export function formatLayoutFailure(comparison: LayoutComparison, literals: readonly LayoutLiteral[]) {
  return [
    `TUI layout literals: ${comparison.count} found, the baseline allows ${comparison.baseline}.`,
    "Use the tokens in src/ui/layout.ts (GUTTER, ROW_INDENT, ...) instead of a number after paddingLeft, paddingRight,",
    "marginLeft and marginRight; the baseline only goes down. Every literal in the tree:",
    ...literals.map((literal) => `  ${formatLayoutLiteral(literal)}`),
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function main(argv: readonly string[]) {
  const literals = collectLayoutLiterals()
  const comparison = compareLayoutBaseline(literals.length, readLayoutBaseline())

  if (comparison.over > 0) {
    console.error(formatLayoutFailure(comparison, literals))
    process.exit(1)
  }

  if (argv.includes("--update-baseline")) {
    updateLayoutBaseline(comparison.count)
    console.log(`Layout literal baseline is now ${comparison.count} (was ${comparison.baseline})`)
  } else if (comparison.slack > 0) {
    console.log(
      `TUI layout literals: ${comparison.count}, the baseline allows ${comparison.baseline}; lower it: bun script/check-layout-literals.ts --update-baseline`,
    )
  } else {
    console.log(`TUI layout literal check passed (${comparison.count})`)
  }
}

if (import.meta.main) main(process.argv.slice(2))
