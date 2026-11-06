import path from "path"

const REPO_ROOT = path.join(import.meta.dir, "..")
const PRIVATE_PATTERNS_ENV = "PRIVATE_HOST_PATTERNS"
const PRIVATE_PATTERNS_UNSET = "$(PRIVATE_HOST_PATTERNS)"
const ALLOW_MARKER = new RegExp(String.raw`check-private-hosts:\s*allow\s+\S`)
const PUBLIC_LOCK_HOSTS = new Set(["registry.npmjs.org"])
const PKG_PR_NEW_PREFIX = "https://pkg.pr.new/@solidjs/start@"
// Temporary: A1 (#885) deletes packages/web. Remove this exclusion with it.
const TEMPORARY_EXCLUDED_PREFIX = "packages/web/"

export type Rule = 1 | 2 | 3
export type Violation = { file: string; line: number; rule: Rule }
export type ScanResult = { violations: Violation[]; allowed: number; rule3Skipped: boolean }

type PatternSet = { patterns: RegExp[]; skipped: boolean }

export function parsePatterns(value: string | undefined): PatternSet {
  const raw = value?.trim()
  if (!raw || raw === PRIVATE_PATTERNS_UNSET) return { patterns: [], skipped: true }
  const patterns = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      try {
        return new RegExp(item)
      } catch {
        throw new Error(`PRIVATE_HOST_PATTERNS entry ${index + 1} is not a valid regular expression`)
      }
    })
  return { patterns, skipped: patterns.length === 0 }
}

export function isPrivateIPv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return false
  const [a, b, c, d] = match.slice(1).map(Number)
  if (a === undefined || b === undefined || c === undefined || d === undefined) return false
  if ([a, b, c, d].some((octet) => octet > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function isPrivateHostname(value: string): boolean {
  return /(?<![\w.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:local|internal|lan)(?![\w.-])/i.test(
    value,
  )
}

const HOSTNAME = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:local|internal|lan)\b`
const URL_PRIVATE_HOST = new RegExp(String.raw`(?:https?|wss?|ftp|ssh|tcp|udp)://(?:[^\s"'/@]+@)?${HOSTNAME}`, "i")
const KEY_PRIVATE_HOST = new RegExp(
  String.raw`\b(?:host|hostname|host_name|domain|domain_name|baseURL|baseUrl|base_url|url|server|endpoint|address|addr|origin|proxy|dns|mdns|bind)\b\s*[:=]\s*["']?${HOSTNAME}`,
  "i",
)

function hasPrivateIPv4(line: string): boolean {
  for (const match of line.matchAll(/(?<![\w.-])\d{1,3}(?:\.\d{1,3}){3}(?![\w-]|\.\d)/g)) {
    if (isPrivateIPv4(match[0])) return true
  }
  return false
}

function hasContextualPrivateHostname(line: string): boolean {
  return URL_PRIVATE_HOST.test(line) || KEY_PRIVATE_HOST.test(line)
}

function lockUrls(line: string): string[] {
  return [...line.matchAll(/https:\/\/[^\s"']+/g)].map((match) => match[0].replace(/[),;\]]+$/, ""))
}

function isAllowedLockUrl(value: string): boolean {
  if (value.startsWith(PKG_PR_NEW_PREFIX)) return true
  try {
    return PUBLIC_LOCK_HOSTS.has(new URL(value).host)
  } catch {
    return false
  }
}

export function scanText(file: string, text: string, patterns: RegExp[]): { violations: Violation[]; allowed: number } {
  const violations: Violation[] = []
  const isLock = path.basename(file) === "bun.lock"
  let allowed = 0
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (ALLOW_MARKER.test(line)) {
      allowed += 1
      continue
    }
    const lineNumber = index + 1
    if (isLock && lockUrls(line).some((url) => !isAllowedLockUrl(url))) {
      violations.push({ file, line: lineNumber, rule: 1 })
    }
    if (hasPrivateIPv4(line) || hasContextualPrivateHostname(line)) {
      violations.push({ file, line: lineNumber, rule: 2 })
    }
    if (
      patterns.some((pattern) => {
        pattern.lastIndex = 0
        return pattern.test(line)
      })
    ) {
      violations.push({ file, line: lineNumber, rule: 3 })
    }
  }
  return { violations, allowed }
}

export function formatResult(result: ScanResult): string {
  const lines = result.violations.map((violation) => `${violation.file}:${violation.line} rule ${violation.rule}`)
  lines.push(`check-private-hosts: ${result.violations.length} violation(s), ${result.allowed} allowed line(s)`)
  if (result.rule3Skipped) lines.push("check-private-hosts: rule 3 skipped (PRIVATE_HOST_PATTERNS is empty)")
  return lines.join("\n")
}

function gitBytes(args: string[]): Uint8Array {
  const result = Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, ...args], stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`)
  return new Uint8Array(result.stdout)
}

function gitPaths(args: string[]): string[] {
  return new TextDecoder().decode(gitBytes(args)).split("\0").filter(Boolean)
}

export function trackedFiles(): string[] {
  return gitPaths(["ls-files", "-z"])
}

export function stagedFiles(): string[] {
  return gitPaths(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
}

function relativePath(file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file)
  return path.relative(REPO_ROOT, absolute)
}

function displayPath(file: string): string {
  const relative = relativePath(file)
  return relative.startsWith("..") ? file : relative
}

function isTemporarilyExcluded(file: string): boolean {
  const relative = relativePath(file)
  return relative === "packages/web" || relative.startsWith(TEMPORARY_EXCLUDED_PREFIX)
}

async function readWorktreeText(file: string): Promise<string | undefined> {
  const absolute = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file)
  try {
    const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer())
    if (bytes.includes(0)) return undefined
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

function readStagedText(file: string): string | undefined {
  const bytes = gitBytes(["show", `:${file}`])
  if (bytes.includes(0)) return undefined
  return new TextDecoder().decode(bytes)
}

export async function run(options: { staged: boolean; files?: string[]; patterns?: string }): Promise<ScanResult> {
  const patternSet: PatternSet = options.staged ? { patterns: [], skipped: true } : parsePatterns(options.patterns)
  const files = options.files?.length ? options.files : options.staged ? stagedFiles() : trackedFiles()
  const result: ScanResult = { violations: [], allowed: 0, rule3Skipped: patternSet.skipped }
  for (const file of files) {
    if (isTemporarilyExcluded(file)) continue
    const text = options.staged ? readStagedText(file) : await readWorktreeText(file)
    if (text === undefined) continue
    const scanned = scanText(displayPath(file), text, patternSet.patterns)
    result.violations.push(...scanned.violations)
    result.allowed += scanned.allowed
  }
  return result
}

function parseArgs(argv: string[]): { staged: boolean; files: string[] } {
  let staged = false
  const files: string[] = []
  for (const arg of argv) {
    if (arg === "--staged") staged = true
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`)
    else files.push(arg)
  }
  return { staged, files }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = await run({ ...args, patterns: process.env[PRIVATE_PATTERNS_ENV] })
    const output = formatResult(result)
    if (result.violations.length) {
      console.error(output)
      process.exitCode = 1
    } else {
      console.log(output)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}