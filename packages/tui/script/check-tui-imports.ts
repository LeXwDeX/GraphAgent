// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "node:path"

const TUI_DIR = path.join(import.meta.dir, "..")
const DEFAULT_ROOT = path.join(TUI_DIR, "src")

export interface ImportViolation {
  file: string
  line: number
  specifier: string
  reason: string
  /** Resolved import target relative to the source root without extension, for local imports. */
  target?: string
}

export interface Exemption {
  /** File relative to the source root, POSIX separators. */
  file: string
  /** Imported target relative to the source root without extension. */
  target: string
  /** Owning F Issue; removed when that Issue migrates the import. */
  issue: string
}

export interface CheckOptions {
  root?: string
  exemptions?: readonly Exemption[]
}

/**
 * Existing violations. Every entry names the F Issue that removes it; the list must
 * be empty when the F series is complete. `findStaleExemptions` fails an entry whose
 * import is gone, so an entry is deleted together with the import it covered.
 */
export const EXEMPTIONS: readonly Exemption[] = [
  { file: "context/local.tsx", target: "ui/toast", issue: "F3 (#1020): toast moves to the footer" },
  {
    file: "component/prompt/move.tsx",
    target: "routes/home/session-destination",
    issue: "F5 (#1033): session navigation",
  },
]

interface Rule {
  groups?: readonly string[]
  modules?: readonly string[]
}

/**
 * Dependency direction table from `packages/tui/AGENTS.md` section 3.
 * A directory may import lower layers; the listed targets are forbidden.
 */
const RULES: Record<string, Rule> = {
  ui: { groups: ["context", "shell", "panel", "ask", "commands", "routes"] },
  dag: {
    groups: ["context", "ui", "shell", "panel", "ask", "commands", "routes", "component", "session", "attention"],
    modules: ["solid-js", "@opentui/solid"],
  },
  pr: {
    groups: ["context", "ui", "shell", "panel", "ask", "commands", "routes", "component", "session", "attention"],
    modules: ["solid-js", "@opentui/solid"],
  },
  theme: {
    groups: ["context", "ui", "shell", "panel", "ask", "commands", "routes", "component", "session", "attention"],
  },
  i18n: {
    groups: ["context", "ui", "shell", "panel", "ask", "commands", "routes", "component", "session", "attention"],
  },
  context: { groups: ["ui", "shell", "panel", "ask", "commands", "routes"] },
  shell: { groups: ["routes"] },
  panel: { groups: ["routes"] },
  ask: { groups: ["routes"] },
  commands: { groups: ["routes"] },
  session: { groups: ["routes"] },
  attention: { groups: ["routes"] },
  component: { groups: ["routes"] },
}

/** Directories where display components and pure functions must not call the SDK. */
const NO_SDK_CALL = new Set(["ui", "shell", "dag", "pr"])

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
]

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

function stripExtension(value: string) {
  return value.replace(/\.(?:tsx?|jsx?|mts|cts)$/, "").replace(/\/index$/, "")
}

function sourceGroup(relative: string) {
  const withoutExtension = stripExtension(relative)
  const [first] = withoutExtension.split("/")
  return withoutExtension.includes("/") ? first! : "root"
}

/** Explicitly allowed cross-layer imports that follow the AGENTS.md exceptions. */
function allowedImport(group: string, target: string) {
  // `ui/` may read theme tokens (precedent: `ui/toast.tsx` uses `useTheme`).
  if (group === "ui" && (target === "context/theme" || target.startsWith("context/theme/"))) return true
  return false
}

async function loadExports() {
  const exports: Record<string, string> = {}
  try {
    const pkg = await Bun.file(path.join(TUI_DIR, "package.json")).json()
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const target = typeof value === "string" ? value : (value as { import?: string; default?: string })?.import
      if (typeof target === "string") exports[key] = target
    }
  } catch {
    // The package manifest is optional for synthetic roots used by tests.
  }
  return exports
}

function resolveSpecifier(root: string, fromFile: string, specifier: string, exports: Record<string, string>) {
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier)
  }
  if (specifier === "@graphagent/tui" || specifier.startsWith("@graphagent/tui/")) {
    const target = exports[specifier]
    if (target) return path.resolve(TUI_DIR, target)
    const rest = specifier.slice("@graphagent/tui".length).replace(/^\//, "")
    return path.join(root, rest || "index.tsx")
  }
  return undefined
}

function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function collectImports(source: string) {
  const imports: Array<{ specifier: string; line: number }> = []
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      const specifier = match[1]
      if (!specifier) continue
      const line = source.slice(0, match.index).split("\n").length
      imports.push({ specifier, line })
    }
  }
  return imports
}

export async function checkTuiImports(options: CheckOptions = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const exemptions = options.exemptions ?? EXEMPTIONS
  const exports = await loadExports()
  const violations: ImportViolation[] = []
  const glob = new Bun.Glob("**/*.{ts,tsx}")

  for (const entry of glob.scanSync({ cwd: root })) {
    const file = path.join(root, entry)
    const relative = toPosix(path.relative(root, file))
    const group = sourceGroup(relative)
    const rule = RULES[group]
    const source = await Bun.file(file).text()

    if (NO_SDK_CALL.has(group) && /\bsdk\.client\b/.test(source)) {
      violations.push({
        file: relative,
        line: source.slice(0, source.search(/\bsdk\.client\b/)).split("\n").length,
        specifier: "sdk.client",
        reason: `${group}/ may not call the SDK outside event handlers`,
      })
    }

    if (!rule) continue

    for (const { specifier, line } of collectImports(source)) {
      if (rule.modules?.includes(specifier)) {
        violations.push({ file: relative, line, specifier, reason: `${group}/ may not import ${specifier}` })
        continue
      }

      const target = resolveSpecifier(root, file, specifier, exports)
      if (!target || !within(root, target)) continue
      const targetRelative = stripExtension(toPosix(path.relative(root, target)))
      const targetGroup = sourceGroup(targetRelative)

      if (!rule.groups?.includes(targetGroup)) continue
      if (allowedImport(group, targetRelative)) continue
      if (exemptions.some((entry) => entry.file === relative && entry.target === targetRelative)) continue

      violations.push({
        file: relative,
        line,
        specifier,
        reason: `${group}/ may not import ${targetGroup}/ (${targetRelative})`,
        target: targetRelative,
      })
    }
  }

  return violations
}

/**
 * Exemptions that no longer cover a real violation: the file is gone, it stopped
 * importing the target, or the rules now allow the import. The entry belongs to the
 * import it covered, so it has to be deleted together with it.
 */
export async function findStaleExemptions(options: CheckOptions = {}) {
  const exemptions = options.exemptions ?? EXEMPTIONS
  const violations = await checkTuiImports({ ...options, exemptions: [] })
  return exemptions.filter(
    (entry) => !violations.some((violation) => violation.file === entry.file && violation.target === entry.target),
  )
}

export function formatViolations(violations: readonly ImportViolation[]) {
  return violations.map(
    (violation) => `${violation.file}:${violation.line} ${violation.reason} [${violation.specifier}]`,
  )
}

export function formatStaleExemptions(stale: readonly Exemption[]) {
  return stale.map((entry) => `${entry.file} stale exemption for ${entry.target} [${entry.issue}]`)
}

if (import.meta.main) {
  const violations = await checkTuiImports()
  const stale = await findStaleExemptions()
  if (violations.length > 0 || stale.length > 0) {
    console.error([...formatViolations(violations), ...formatStaleExemptions(stale)].join("\n"))
    process.exit(1)
  }
  console.log("TUI import direction check passed")
}
