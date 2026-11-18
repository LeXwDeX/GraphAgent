// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Model id branch gate for Issue #1463.
 *
 * What a model can do comes from its profile (`ProviderProfile.profileOf`; the built-in rules live in
 * `packages/core/src/model-profile-builtin.ts` and a configuration can override them), not from a substring of its
 * id: a substring test misses a capitalised id and falls back silently when a name list lags behind. The gate counts,
 * per file, the lines of `packages/graphagent/src` and `packages/llm/src` (`*.ts`, `*.tsx`, no `.d.ts`) that still
 * take a model id apart:
 *
 *   - search R: `api.id`, `model.id`, `modelID`, `apiID` or `mistralId` followed by `includes`, `startsWith`,
 *     `endsWith` or `match` (an optional `toLowerCase()` in between), or handed to a regular expression's `test` or
 *     `exec`;
 *   - search B: the same through a bare `id`, only in `LOCAL_ID_FILES`, where a local `id` is a model id.
 *
 * The search is textual: a line counts once however many branches it holds, and a comment that quotes one counts too.
 * script/model-id-branches-baseline.json records the count of every file that still has some. A file above its
 * baseline (a file the baseline does not list counts as 0) fails; a file below it only prints STALE.
 *
 * Policy: ratchet, no NEW or GROW. The baseline is registered debt that only ever shrinks: lower an entry when its
 * file gets fewer such lines, delete it when none is left. A baseline diff may only lower or remove numbers; never
 * raise one or add an entry to get a change in. CI runs this gate as `bun run check:model-id` (root package.json).
 *
 * --write-baseline rewrites the baseline from the measured counts, growth included. Use it only to lower entries
 * after a migration, and read the diff first.
 *
 * Usage:
 *   bun run check:model-id
 *   bun run check:model-id -- --write-baseline
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
const BASELINE_FILE = path.join(import.meta.dir, "model-id-branches-baseline.json")
const SOURCE_DIRS: ReadonlyArray<string> = ["packages/graphagent/src", "packages/llm/src"]

/** Files whose local `id` is a model id, so search B applies to them as well. */
export const LOCAL_ID_FILES: ReadonlyArray<string> = [
  "packages/graphagent/src/provider/transform.ts",
  "packages/graphagent/src/session/message-v2.ts",
  "packages/llm/src/providers/openai-options.ts",
]

const SEARCH_R =
  /(api\.id|model\.id|modelI[dD]|apiI[dD]|mistralId)(\.toLowerCase\(\))?\.(includes|startsWith|endsWith|match)\(|\.(test|exec)\((model\.api\.id|modelI[dD]|apiI[dD])[^)]*\)/
const SEARCH_B = /(^|[^.A-Za-z0-9_])id(\.toLowerCase\(\))?\.(includes|startsWith|endsWith|match)\(|\.(test|exec)\(id\)/

type Hit = { readonly line: number; readonly text: string }

/** The lines of `text` that take a model id apart. `file` is repository-relative with `/` separators. */
function hitsOf(file: string, text: string): Hit[] {
  const local = LOCAL_ID_FILES.includes(file)
  return text.split("\n").flatMap((line, index) => {
    if (SEARCH_R.test(line) || (local && SEARCH_B.test(line))) return [{ line: index + 1, text: line.trim() }]
    return []
  })
}

/** The number of lines of `text` that take a model id apart, for the file `file` (repository-relative). */
export function countModelIdBranches(file: string, text: string): number {
  return hitsOf(file, text).length
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full)
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) return []
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : []
  })
}

/** The hits of every file under `root` that has some, keyed by repository-relative path in path order. */
function measure(root: string): Map<string, Hit[]> {
  const measured = new Map<string, Hit[]>()
  for (const dir of SOURCE_DIRS) {
    for (const full of sourceFiles(path.join(root, dir))) {
      const file = path.relative(root, full).split(path.sep).join("/")
      const hits = hitsOf(file, readFileSync(full, "utf8"))
      if (hits.length > 0) measured.set(file, hits)
    }
  }
  return new Map([...measured].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function readBaseline(file: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return {}
    if (!("version" in parsed) || parsed.version !== 1) return {}
    if (!("files" in parsed) || typeof parsed.files !== "object" || parsed.files === null) return {}
    const files: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.files)) {
      if (typeof value === "number") files[key] = value
    }
    return files
  } catch {
    return {}
  }
}

export type RunOptions = {
  /** The repository root to scan. Defaults to this repository. */
  readonly root?: string
  /** The baseline file. Defaults to script/model-id-branches-baseline.json. */
  readonly baselineFile?: string
  readonly writeBaseline?: boolean
}

export type RunResult = {
  /** 0 when every file is at or under its baseline, 1 when one is above. */
  readonly code: number
  readonly output: string[]
}

/** Measures the source tree and compares it with the baseline, or rewrites the baseline. */
export function run(options: RunOptions = {}): RunResult {
  const root = options.root ?? REPO_ROOT
  const baselineFile = options.baselineFile ?? BASELINE_FILE
  const measured = measure(root)
  const total = [...measured.values()].reduce((sum, hits) => sum + hits.length, 0)

  if (options.writeBaseline) {
    const files = Object.fromEntries([...measured].map(([file, hits]) => [file, hits.length]))
    writeFileSync(baselineFile, `${JSON.stringify({ version: 1, files }, null, 2)}\n`)
    return {
      code: 0,
      output: [`model-id: baseline written with ${total} line(s) in ${measured.size} file(s) -> ${baselineFile}`],
    }
  }

  const baseline = readBaseline(baselineFile)
  const files = [...new Set([...measured.keys(), ...Object.keys(baseline)])].sort()
  const output = [`model-id: ${total} line(s) in ${measured.size} file(s) take a model id apart`]
  const stale: string[] = []
  let failed = 0
  for (const file of files) {
    const hits = measured.get(file) ?? []
    const allowed = baseline[file]
    if (hits.length > (allowed ?? 0)) {
      failed++
      output.push(
        allowed === undefined
          ? `  NEW ${file} ${hits.length} (not in the baseline)`
          : `  GROW ${file} ${hits.length} > baseline ${allowed}`,
      )
      for (const hit of hits) output.push(`    ${file}:${hit.line}  ${hit.text}`)
    } else if (allowed !== undefined && hits.length < allowed) {
      stale.push(`  STALE ${file} ${hits.length} < baseline ${allowed}`)
    }
  }
  output.push(...stale)
  if (stale.length > 0) output.push("model-id: lower the baseline with `bun run check:model-id -- --write-baseline`")

  if (failed > 0) {
    output.push(
      `model-id: ${failed} file(s) above the baseline; read the capability from the model profile (ProviderProfile.profileOf) or add a built-in rule in packages/core/src/model-profile-builtin.ts`,
    )
    return { code: 1, output }
  }
  output.push(`model-id: OK (${total} baseline line(s) tolerated)`)
  return { code: 0, output }
}

function main(argv: string[]): number {
  const unknown = argv.filter((arg) => arg !== "--" && arg !== "--write-baseline")
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`)
  const result = run({ writeBaseline: argv.includes("--write-baseline") })
  for (const line of result.output) (result.code === 0 ? console.log : console.error)(line)
  return result.code
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
