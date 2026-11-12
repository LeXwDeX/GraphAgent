// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Static checks over the TUI source text (`packages/tui/src`). Every check reads
 * the TypeScript AST, so comments never count unless a check says otherwise.
 *
 * - `checkTuiText`: no CJK in string literals or JSX text outside the message tables.
 * - `checkTuiBrand`: no upstream product words in string literals; exceptions are listed with a reason.
 * - `checkTuiRetired`: no remnants of retired features (raw text, comments included).
 * - `collectTuiEnglish` and `english-text-baseline.txt`: a ratchet on English literals that bypass `t()`;
 *   the literals present today are listed, new ones fail, and listed ones that disappear must be deleted.
 *
 * From `packages/tui`:
 *
 *   bun script/check-tui-text.ts                    run every check
 *   bun script/check-tui-text.ts --update-baseline  drop baseline entries that no longer match (refuses to add any)
 *   bun script/check-tui-text.ts --write-baseline   rewrite the baseline from the current tree (creation only)
 */

import { readFileSync, writeFileSync } from "node:fs"
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
// English literals that bypass t()
// ---------------------------------------------------------------------------

/**
 * Where English text becomes visible, and the rule that finds it:
 *
 * - `jsx-text`: JSX text, and string literals used directly as a JSX child
 *   (`{"Copy"}`, `{ok ? "Done" : "Failed"}`).
 * - `jsx-attr`: a visible JSX attribute (`title`, `placeholder`, ...) set to a literal.
 * - `prop`: a visible object property (`title:`, `label:`, ...) set to a literal; this is
 *   how keymap command titles and list rows carry their text.
 * - `toast`: the `text` property of the object passed to `toast.show(...)`.
 *
 * Only literals that contain an English word (three or more ASCII letters) count.
 * Identifiers, record keys, URLs, command ids and calls such as `t("key")` sit in other
 * positions and are never looked at.
 */
export type EnglishKind = "jsx-text" | "jsx-attr" | "prop" | "toast"

const ENGLISH_KINDS: readonly EnglishKind[] = ["jsx-text", "jsx-attr", "prop", "toast"]
const ENGLISH_WORD = /[A-Za-z]{3,}/
/** Attribute and property names whose literal values are shown to the user. */
const VISIBLE_NAMES = new Set(["title", "bottomTitle", "label", "placeholder", "hint", "footer", "subtitle", "body"])

export interface EnglishLiteral {
  file: string
  line: number
  kind: EnglishKind
  text: string
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/** Literals whose value reaches the screen unchanged: the expression itself, conditional branches, fallbacks. */
function visibleLiterals(node: ts.Node): Array<{ node: ts.Node; text: string }> {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ node, text: node.text }]
  if (ts.isTemplateExpression(node)) {
    // Static skeleton of the template; substitutions become `${}`.
    return [{ node, text: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${}") }]
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return visibleLiterals(node.expression)
  }
  if (ts.isConditionalExpression(node)) return [...visibleLiterals(node.whenTrue), ...visibleLiterals(node.whenFalse)]
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return visibleLiterals(node.right)
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return [...visibleLiterals(node.left), ...visibleLiterals(node.right)]
    }
  }
  return []
}

function propertyName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

/** `toast.show({ ... })` and `x.toast.show({ ... })`. */
function isToastShowArgument(object: ts.ObjectLiteralExpression) {
  const call = object.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(object)) return false
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "show") return false
  const target = callee.expression
  return (
    (ts.isIdentifier(target) && target.text === "toast") ||
    (ts.isPropertyAccessExpression(target) && target.name.text === "toast")
  )
}

export function collectTuiEnglish(options: TextCheckOptions = {}): EnglishLiteral[] {
  const literals: EnglishLiteral[] = []

  for (const source of sources(options)) {
    const record = (kind: EnglishKind, node: ts.Node, text: string) => {
      const normalized = collapse(text)
      if (!ENGLISH_WORD.test(normalized)) return
      literals.push({ file: source.file, line: lineOf(source.sourceFile, node), kind, text: normalized })
    }

    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        record("jsx-text", node, node.text)
      } else if (
        ts.isJsxExpression(node) &&
        node.expression &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
      ) {
        for (const literal of visibleLiterals(node.expression)) record("jsx-text", literal.node, literal.text)
      } else if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        VISIBLE_NAMES.has(node.name.getText(source.sourceFile))
      ) {
        const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
        if (value) for (const literal of visibleLiterals(value)) record("jsx-attr", literal.node, literal.text)
      } else if (ts.isPropertyAssignment(node)) {
        const name = propertyName(node.name)
        if (name && VISIBLE_NAMES.has(name)) {
          for (const literal of visibleLiterals(node.initializer)) record("prop", literal.node, literal.text)
        } else if (name === "text" && isToastShowArgument(node.parent)) {
          for (const literal of visibleLiterals(node.initializer)) record("toast", literal.node, literal.text)
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(source.sourceFile)
  }

  return literals
}

/** One baseline row: the same literal in the same file and position kind, with its occurrence count. */
export interface EnglishEntry {
  file: string
  kind: EnglishKind
  text: string
  count: number
  /** Where the literal sits now; only present on entries built from the source tree. */
  lines?: number[]
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function entryOrder(left: EnglishEntry, right: EnglishEntry) {
  return (
    compareStrings(left.file, right.file) ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.text, right.text)
  )
}

function entryKey(entry: EnglishEntry) {
  return JSON.stringify([entry.file, entry.kind, entry.text])
}

/** Group literals into baseline rows. Line numbers are kept for messages but never persisted. */
export function summarizeEnglish(literals: readonly EnglishLiteral[]): EnglishEntry[] {
  const entries = new Map<string, EnglishEntry>()

  for (const literal of literals) {
    const key = JSON.stringify([literal.file, literal.kind, literal.text])
    const entry = entries.get(key)
    if (entry) {
      entry.count += 1
      entry.lines!.push(literal.line)
    } else {
      entries.set(key, { file: literal.file, kind: literal.kind, text: literal.text, count: 1, lines: [literal.line] })
    }
  }

  return [...entries.values()].sort(entryOrder)
}

export interface EnglishComparison {
  /** Literals in the tree beyond what the baseline allows. */
  added: EnglishEntry[]
  /** Baseline rows (or occurrences) that no longer exist in the tree; delete them. */
  stale: EnglishEntry[]
}

export function compareEnglishBaseline(
  current: readonly EnglishEntry[],
  baseline: readonly EnglishEntry[],
): EnglishComparison {
  const allowed = new Map(baseline.map((entry) => [entryKey(entry), entry.count]))
  const seen = new Set<string>()
  const added: EnglishEntry[] = []
  const stale: EnglishEntry[] = []
  const bare = (entry: EnglishEntry, count: number): EnglishEntry => ({
    file: entry.file,
    kind: entry.kind,
    text: entry.text,
    count,
  })

  for (const entry of current) {
    seen.add(entryKey(entry))
    const permitted = allowed.get(entryKey(entry)) ?? 0
    if (entry.count > permitted) added.push({ ...entry, count: entry.count - permitted })
    else if (entry.count < permitted) stale.push(bare(entry, permitted - entry.count))
  }
  for (const entry of baseline) {
    if (!seen.has(entryKey(entry))) stale.push(bare(entry, entry.count))
  }

  return { added: added.sort(entryOrder), stale: stale.sort(entryOrder) }
}

export function formatEnglishEntry(entry: EnglishEntry) {
  const where = entry.lines?.length ? `:${entry.lines.join(",")}` : ""
  return `${entry.file}${where} [${entry.kind}] ${JSON.stringify(entry.text)}${entry.count > 1 ? ` x${entry.count}` : ""}`
}

export const ENGLISH_BASELINE_PATH = path.join(import.meta.dir, "english-text-baseline.txt")

// Plain text on purpose: a formatter leaves it alone, and git merges it line by line.
const BASELINE_HEADER = [
  "# English literals that bypass t() (ratchet baseline); the rules are documented in script/check-tui-text.ts.",
  "# Entries may only be removed: move the text to the message tables, then run `bun script/check-tui-text.ts --update-baseline`.",
  "# Columns, tab separated: file, kind, text, and the occurrence count when it is more than one.",
]

/** Canonical file text: one entry per line, sorted, no line numbers. */
export function formatEnglishBaseline(entries: readonly EnglishEntry[]) {
  const rows = [...entries]
    .sort(entryOrder)
    .map((entry) => [entry.file, entry.kind, entry.text, ...(entry.count > 1 ? [String(entry.count)] : [])].join("\t"))
  return [...BASELINE_HEADER, ...rows, ""].join("\n")
}

function isEnglishKind(value: unknown): value is EnglishKind {
  return ENGLISH_KINDS.some((kind) => kind === value)
}

export function parseEnglishBaseline(raw: string): EnglishEntry[] {
  const entries: EnglishEntry[] = []

  raw.split("\n").forEach((line, index) => {
    if (line === "" || line.startsWith("#")) return
    const [file, kind, text, count = "1", ...extra] = line.split("\t")
    const parsed = Number(count)
    if (!file || !text || !isEnglishKind(kind) || extra.length > 0 || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`english baseline: line ${index + 1} is malformed`)
    }
    entries.push({ file, kind, text, count: parsed })
  })

  return entries
}

export function readEnglishBaseline(file = ENGLISH_BASELINE_PATH): EnglishEntry[] {
  return parseEnglishBaseline(readFileSync(file, "utf8"))
}

/** Rewrite the baseline from the tree unconditionally. Only for creating it; growth needs sign-off. */
export function writeEnglishBaseline(current: readonly EnglishEntry[], file = ENGLISH_BASELINE_PATH) {
  writeFileSync(file, formatEnglishBaseline(current))
}

export interface BaselineUpdate {
  written: boolean
  /** Literals the baseline does not allow; when any exist nothing is written. */
  added: EnglishEntry[]
  /** Baseline rows (or occurrences) dropped by the rewrite. */
  removed: EnglishEntry[]
}

/** Shrink-only update: rewrite the baseline from the tree unless that would add or raise an entry. */
export function updateEnglishBaseline(current: readonly EnglishEntry[], file = ENGLISH_BASELINE_PATH): BaselineUpdate {
  const { added, stale } = compareEnglishBaseline(current, readEnglishBaseline(file))
  if (added.length > 0) return { written: false, added, removed: stale }
  writeEnglishBaseline(current, file)
  return { written: true, added, removed: stale }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function main(argv: readonly string[]) {
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

  const current = summarizeEnglish(collectTuiEnglish())
  if (argv.includes("--write-baseline")) {
    writeEnglishBaseline(current)
    console.log(`Wrote ${current.length} English baseline entries`)
  } else if (argv.includes("--update-baseline")) {
    const update = updateEnglishBaseline(current)
    section("English literals that bypass t() (use the message tables):", update.added.map(formatEnglishEntry))
    if (update.written)
      console.log(`English baseline now has ${current.length} entries (${update.removed.length} removed)`)
  } else {
    const comparison = compareEnglishBaseline(current, readEnglishBaseline())
    section("English literals that bypass t() (use the message tables):", comparison.added.map(formatEnglishEntry))
    section("Stale English baseline entries (run --update-baseline):", comparison.stale.map(formatEnglishEntry))
  }

  if (failures.length > 0) {
    console.error(failures.join("\n\n"))
    process.exit(1)
  }
  console.log("TUI text checks passed")
}

if (import.meta.main) main(process.argv.slice(2))
