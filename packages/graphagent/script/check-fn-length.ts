#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Function-length gate for Issue #1019 (H1).
 *
 * Limits:
 *   - src/session/turn/**   <= 150 lines per named function
 *   - src/session/**        <= 300 lines per named function (turn/ uses the stricter limit)
 *
 * Length is measured on the function node itself (`end - start + 1` source lines),
 * including its signature and closing brace.
 *
 * Historical violations at the time this gate was introduced are recorded in
 * script/fn-length-baseline.json. A baseline entry only pardons the recorded
 * length: growing past it, or any function missing from the baseline, fails.
 *
 * Policy: ratchet, no NEW or GROW. The remaining baseline entries are registered
 * debt that only ever shrinks: lower an entry when its function gets shorter,
 * delete it when the function drops under its limit. A baseline diff may only
 * lower or remove numbers; never raise one or add an entry to get a change in.
 * CI runs this gate as `bun run check:fn-length` (root package.json).
 *
 * --write-baseline rewrites the baseline from the current lengths, growth
 * included. Use it only to lower entries after a shrink, and read the diff first.
 *
 * Usage:
 *   bun run script/check-fn-length.ts
 *   bun run script/check-fn-length.ts --write-baseline
 *   bun run script/check-fn-length.ts --all          # list every named function
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const SOURCE_ROOT = path.join(PACKAGE_ROOT, "src/session")
const BASELINE_FILE = path.join(import.meta.dir, "fn-length-baseline.json")
const TURN_LIMIT = 150
const SESSION_LIMIT = 300

interface MeasuredFunction {
  readonly file: string
  readonly name: string
  readonly line: number
  readonly lines: number
  readonly limit: number
}

interface Baseline {
  readonly version: 1
  readonly functions: Record<string, number>
}

function parseArgs(argv: string[]) {
  return {
    writeBaseline: argv.includes("--write-baseline"),
    all: argv.includes("--all"),
  }
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(full)
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) return []
    return [full]
  })
}

function limitFor(file: string) {
  const relative = path.relative(PACKAGE_ROOT, file).replaceAll(path.sep, "/")
  return relative.startsWith("src/session/turn/") ? TURN_LIMIT : SESSION_LIMIT
}

function nameOf(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText(source)
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name.getText(source)
  }
  if (ts.isConstructorDeclaration(node)) return "constructor"
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return undefined

  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(source)
  if (ts.isCallExpression(parent)) {
    const grandparent = parent.parent
    // const fn = Effect.fn("Trace.name")(function* () { ... })
    if (ts.isVariableDeclaration(grandparent) && ts.isIdentifier(grandparent.name)) return grandparent.name.text
    // Effect.fn("Trace.name")(function* () { ... })
    if (ts.isCallExpression(parent.expression)) {
      const traceName = parent.expression.arguments[0]
      if (traceName && ts.isStringLiteral(traceName)) return traceName.text
    }
  }
  return undefined
}

function measure(file: string): MeasuredFunction[] {
  const text = readFileSync(file, "utf8")
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const relative = path.relative(PACKAGE_ROOT, file).replaceAll(path.sep, "/")
  const limit = limitFor(file)
  const found: MeasuredFunction[] = []

  const visit = (node: ts.Node) => {
    const name = nameOf(node, source)
    if (name !== undefined) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line
      found.push({ file: relative, name, line: start + 1, lines: end - start + 1, limit })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function keyOf(fn: Pick<MeasuredFunction, "file" | "name">) {
  return `${fn.file}#${fn.name}`
}

function readBaseline(): Baseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return { version: 1, functions: {} }
    if (!("version" in parsed) || parsed.version !== 1) return { version: 1, functions: {} }
    if (!("functions" in parsed) || typeof parsed.functions !== "object" || parsed.functions === null) {
      return { version: 1, functions: {} }
    }
    const functions: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.functions)) {
      if (typeof value === "number") functions[key] = value
    }
    return { version: 1, functions }
  } catch {
    return { version: 1, functions: {} }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const functions = collectSourceFiles(SOURCE_ROOT)
    .flatMap(measure)
    .sort((a, b) => b.lines - a.lines)
  const overLimit = functions.filter((fn) => fn.lines > fn.limit)
  const baseline = readBaseline()

  if (args.writeBaseline) {
    const entries = overLimit
      .map((fn): [string, number] => [keyOf(fn), fn.lines])
      .sort(([a], [b]) => a.localeCompare(b))
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ version: 1, functions: Object.fromEntries(entries) }, null, 2)}\n`)
    console.log(`fn-length: baseline written with ${overLimit.length} historical violation(s) -> ${BASELINE_FILE}`)
    for (const fn of overLimit) console.log(`  BASE ${fn.file}:${fn.line} ${fn.name} ${fn.lines} > ${fn.limit}`)
    return 0
  }

  const failures: string[] = []
  const historical: MeasuredFunction[] = []
  for (const fn of overLimit) {
    const recorded = baseline.functions[keyOf(fn)]
    if (recorded === undefined) failures.push(`NEW  ${fn.file}:${fn.line} ${fn.name} ${fn.lines} > ${fn.limit}`)
    else if (fn.lines > recorded)
      failures.push(`GROW ${fn.file}:${fn.line} ${fn.name} ${fn.lines} > baseline ${recorded} (limit ${fn.limit})`)
    else historical.push(fn)
  }
  const stale = Object.keys(baseline.functions).filter(
    (key) => !overLimit.some((fn) => keyOf(fn) === key && baseline.functions[key] === fn.lines),
  )

  console.log(
    `fn-length: ${functions.length} named functions in src/session (turn <= ${TURN_LIMIT}, session <= ${SESSION_LIMIT})`,
  )
  for (const fn of historical) console.log(`  BASE ${fn.file}:${fn.line} ${fn.name} ${fn.lines} > ${fn.limit}`)
  for (const failure of failures) console.log(`  ${failure}`)
  if (stale.length > 0) console.log(`  STALE baseline entries (function shrank or moved): ${stale.join(", ")}`)
  if (args.all) for (const fn of functions) console.log(`  ${fn.file}:${fn.line} ${fn.name} ${fn.lines}`)

  if (failures.length > 0) {
    console.error(`fn-length: ${failures.length} new or grown violation(s)`)
    return 1
  }
  console.log(`fn-length: OK (${historical.length} baseline violation(s) tolerated)`)
  return 0
}

process.exit(main())
