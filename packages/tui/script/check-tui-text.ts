// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Static checks over the TUI source text (`packages/tui/src`). Every check reads
 * the TypeScript AST, so comments never count unless a check says otherwise.
 *
 * - `checkTuiText`: no CJK in string literals or JSX text outside the message tables.
 * - `checkTuiBrand`: no upstream product words in string literals; exceptions are listed with a reason.
 * - `checkTuiRetired`: no remnants of retired features (raw text, comments included).
 *
 * From `packages/tui`: `bun script/check-tui-text.ts` runs every check.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const TUI_DIR = path.join(import.meta.dir, "..")
const DEFAULT_ROOT = path.join(TUI_DIR, "src")
/** Message tables are the only place where translated text may live. */
const DEFAULT_EXCLUDES = ["i18n/"]

export interface TextViolation {
  /** File relative to the source root, POSIX separators. */
  file: string
  line: number
  text: string
}

export interface TextCheckOptions {
  root?: string
  /** Relative prefixes to skip, POSIX separators. */
  exclude?: readonly string[]
}

interface Source {
  file: string
  sourceFile: ts.SourceFile
  raw: string
}

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/** Source files under the root in a stable order, minus the excluded prefixes. */
function sources(options: TextCheckOptions, defaultExcludes: readonly string[] = DEFAULT_EXCLUDES): Source[] {
  const root = options.root ?? DEFAULT_ROOT
  const excludes = options.exclude ?? defaultExcludes
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  const result: Source[] = []

  for (const entry of [...glob.scanSync({ cwd: root })].map(toPosix).sort()) {
    if (excludes.some((prefix) => entry.startsWith(prefix))) continue
    const file = path.join(root, entry)
    const raw = readFileSync(file, "utf8")
    result.push({ file: entry, sourceFile: ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true), raw })
  }

  return result
}

/** Visit every string literal, template part and JSX text node. */
function forEachText(sourceFile: ts.SourceFile, callback: (node: ts.Node, text: string) => void) {
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      callback(node, node.text)
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      callback(node, node.text)
    } else if (ts.isJsxText(node)) {
      const text = node.text.trim()
      if (text) callback(node, text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

export function formatViolations(violations: readonly TextViolation[]) {
  return violations.map((violation) => `${violation.file}:${violation.line} ${violation.text}`)
}

// ---------------------------------------------------------------------------
// CJK outside the message tables
// ---------------------------------------------------------------------------

const CJK = /[㐀-䶿一-鿿豈-﫿]/

/**
 * Find CJK text in string literals, template literals and JSX text outside the
 * message tables. Comments are not AST nodes and are ignored by design.
 */
export function checkTuiText(options: TextCheckOptions = {}): TextViolation[] {
  const violations: TextViolation[] = []

  for (const source of sources(options)) {
    forEachText(source.sourceFile, (node, text) => {
      if (CJK.test(text)) violations.push({ file: source.file, line: lineOf(source.sourceFile, node), text })
    })
  }

  return violations
}

// ---------------------------------------------------------------------------
// Upstream product words
// ---------------------------------------------------------------------------

/** `opencode` is the upstream product; `anomalyco` is the upstream GitHub organization. */
export const BRAND_PATTERN = /opencode|anomalyco/i

export interface BrandAllowance {
  /** File relative to the source root, POSIX separators. */
  file: string
  /** Case-insensitive fragment of the allowed literal; the rest of the literal must be brand free. */
  contains: string
  /** Why this literal has to keep the upstream word. */
  reason: string
}

/**
 * Closed list of literals that may keep an upstream word. Anything that is user
 * visible or names this product belongs to `APP_NAME` / `APP_TITLE` or `t()`.
 */
export const BRAND_ALLOWLIST: readonly BrandAllowance[] = [
  {
    file: "parsers-config.ts",
    contains: "anomalyco",
    reason:
      "Download locations of the Vue and Clojure tree-sitter grammars; third-party release assets, not product copy.",
  },
]

export interface BrandCheckOptions extends TextCheckOptions {
  allow?: readonly BrandAllowance[]
}

export interface BrandCheckResult {
  violations: TextViolation[]
  /** Allowances that matched nothing; stale entries must be deleted. */
  unused: BrandAllowance[]
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Find upstream product words in string literals, template literals and JSX text. */
export function checkTuiBrand(options: BrandCheckOptions = {}): BrandCheckResult {
  const allow = options.allow ?? BRAND_ALLOWLIST
  const used = new Set<BrandAllowance>()
  const violations: TextViolation[] = []

  for (const source of sources(options)) {
    forEachText(source.sourceFile, (node, text) => {
      if (!BRAND_PATTERN.test(text)) return
      const allowance = allow.find((entry) => {
        if (entry.file !== source.file) return false
        const rest = text.replace(new RegExp(escapePattern(entry.contains), "gi"), "")
        return rest.length < text.length && !BRAND_PATTERN.test(rest)
      })
      if (allowance) {
        used.add(allowance)
        return
      }
      violations.push({ file: source.file, line: lineOf(source.sourceFile, node), text })
    })
  }

  return { violations, unused: allow.filter((entry) => !used.has(entry)) }
}

// ---------------------------------------------------------------------------
// Retired features
// ---------------------------------------------------------------------------

/** Same pattern as the retired-feature grep in `AGENTS.md` section 11. */
const RETIRED_PATTERN =
  /gitlab|opencode-go|go_upsell|console_org|console_state|DialogConsoleOrg|isConsoleManagedProvider|opencode\.ai\/zen|\bZen\b/i
/** Files deleted together with the retired features; globs relative to the source root. */
const RETIRED_FILES = ["util/provider-origin.*", "component/bg-pulse*"]

export interface RetiredCheckResult {
  matches: TextViolation[]
  /** Retired files that exist again. */
  files: string[]
}

/** Raw-text scan, comments included, so a leftover mention fails like the documented grep. */
export function checkTuiRetired(options: TextCheckOptions = {}): RetiredCheckResult {
  const root = options.root ?? DEFAULT_ROOT
  const matches: TextViolation[] = []

  for (const source of sources(options, [])) {
    source.raw.split("\n").forEach((line, index) => {
      if (RETIRED_PATTERN.test(line)) matches.push({ file: source.file, line: index + 1, text: line.trim() })
    })
  }

  const files = RETIRED_FILES.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root })].map(toPosix))
  return { matches, files: files.sort() }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function main() {
  const failures: string[] = []
  const section = (title: string, lines: readonly string[]) => {
    if (lines.length === 0) return
    failures.push(`${title}\n${lines.map((line) => `  ${line}`).join("\n")}`)
  }

  section("CJK text outside the message tables:", formatViolations(checkTuiText()))

  const brand = checkTuiBrand()
  section("Upstream product words in string literals:", formatViolations(brand.violations))
  section(
    "Unused entries in BRAND_ALLOWLIST (delete them):",
    brand.unused.map((entry) => `${entry.file} ${entry.contains}`),
  )

  const retired = checkTuiRetired()
  section("Retired feature remnants:", [
    ...formatViolations(retired.matches),
    ...retired.files.map((file) => `${file} (file)`),
  ])

  if (failures.length > 0) {
    console.error(failures.join("\n\n"))
    process.exit(1)
  }
  console.log("TUI text checks passed")
}

if (import.meta.main) main()
