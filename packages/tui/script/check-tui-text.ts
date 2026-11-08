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

const CJK = /[㐀-䶿一-鿿豈-﫿]/

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function collect(sourceFile: ts.SourceFile, file: string, violations: TextViolation[]) {
  function record(node: ts.Node, text: string) {
    violations.push({ file, line: lineOf(sourceFile, node), text })
  }

  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CJK.test(node.text)) record(node, node.text)
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (CJK.test(node.text)) record(node, node.text)
    } else if (ts.isJsxText(node)) {
      const text = node.text.trim()
      if (text && CJK.test(text)) record(node, text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

/**
 * Find CJK text in string literals, template literals and JSX text outside the
 * message tables. Comments are not AST nodes and are ignored by design.
 */
export function checkTuiText(options: TextCheckOptions = {}): TextViolation[] {
  const root = options.root ?? DEFAULT_ROOT
  const excludes = options.exclude ?? DEFAULT_EXCLUDES
  const violations: TextViolation[] = []
  const glob = new Bun.Glob("**/*.{ts,tsx}")

  for (const entry of glob.scanSync({ cwd: root })) {
    const relative = toPosix(entry)
    if (excludes.some((prefix) => relative.startsWith(prefix))) continue
    const file = path.join(root, entry)
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    collect(source, relative, violations)
  }

  return violations
}

export function formatViolations(violations: readonly TextViolation[]) {
  return violations.map((violation) => `${violation.file}:${violation.line} ${violation.text}`)
}

if (import.meta.main) {
  const violations = checkTuiText()
  if (violations.length > 0) {
    console.error(formatViolations(violations).join("\n"))
    process.exit(1)
  }
  console.log("TUI hardcoded text check passed")
}
