// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Enforces the two-rule license model:
 *
 *   - files listed in LICENSE-UPSTREAM.txt are inherited from upstream
 *     opencode and stay under MIT (no per-file header);
 *   - every other source file written for this fork is Apache-2.0 and carries
 *     the two-line SPDX header.
 *
 * The check reads only Git-tracked files and LICENSE-UPSTREAM.txt, so it works
 * in a shallow CI checkout. The list itself is generated from history by
 * script/generate-license-upstream.ts, which CI never runs.
 */
import { existsSync } from "node:fs"
import path from "node:path"
import { comparePaths } from "./generate-license-upstream"

export type LicenseIssue = {
  code: string
  path?: string
  message: string
}

export const APACHE_LICENSE_FILE = "LICENSE-APACHE"
export const UPSTREAM_LIST_FILE = "LICENSE-UPSTREAM.txt"
export const APACHE_COPYRIGHT = "SPDX-FileCopyrightText: 2026 LeXwDeX"
export const APACHE_IDENTIFIER = "SPDX-License-Identifier: Apache-2.0"
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".go"] as const
export const REQUIRED_LICENSE_FILES = ["LICENSE", APACHE_LICENSE_FILE, "NOTICE", "config_assistant/LICENSE"] as const

// The checker must not reintroduce the forbidden license name it looks for.
const FORBIDDEN_LICENSE = ["a", "g", "p", "l"].join("")
const FORBIDDEN_LICENSE_FAMILY = ["a", "f", "f", "e", "r", "o"].join("")
const FORBIDDEN_LICENSE_PATTERN = new RegExp(`${FORBIDDEN_LICENSE}|${FORBIDDEN_LICENSE_FAMILY}`, "i")

/** Error code for a tracked file that still references the retired license. */
export const FORBIDDEN_LICENSE_CODE = `${FORBIDDEN_LICENSE}-reference`

/** Text that NOTICE must contain; checked by key phrase, not exact copy. */
export const NOTICE_REQUIRED_VALUES = [
  "Apache-2.0",
  "MIT",
  "Copyright (c) 2026 LeXwDeX",
  "Copyright (c) 2025 opencode",
  UPSTREAM_LIST_FILE,
  "Co-Authored-By: Claude",
  "human contributors",
  "AI tools",
  "authorship claim",
  "must not include AI attribution",
  "人类贡献者",
  "不代表作者身份",
] as const

/** Text that CONTRIBUTING.md must contain for the author identity statement. */
export const CONTRIBUTING_REQUIRED_VALUES = [
  "Co-Authored-By: Claude",
  "human contributors",
  "AI tools",
  "authorship claim",
  "must not include AI attribution",
  "人类贡献者",
  "不代表作者身份",
] as const

export type LicenseCheckOptions = {
  /** Overrides the `git ls-files` lookup; used by fixtures. */
  trackedFiles?: readonly string[]
}

export async function checkLicense(root: string, options: LicenseCheckOptions = {}): Promise<LicenseIssue[]> {
  const tracked = [...(options.trackedFiles ?? (await gitTrackedFiles(root)))].sort(comparePaths)
  const trackedSet = new Set(tracked)
  const issues: LicenseIssue[] = []

  // 1. Required license texts.
  for (const file of REQUIRED_LICENSE_FILES) {
    if (!existsSync(path.join(root, file))) {
      issues.push({ code: "missing-license-file", path: file, message: `Required license file is missing: ${file}` })
    }
  }

  // 2. Upstream list structure and freshness.
  const listPath = path.join(root, UPSTREAM_LIST_FILE)
  const upstreamText = existsSync(listPath) ? await Bun.file(listPath).text() : undefined
  const upstream = new Set<string>()
  if (upstreamText === undefined) {
    issues.push({
      code: "missing-license-file",
      path: UPSTREAM_LIST_FILE,
      message: `Required license file is missing: ${UPSTREAM_LIST_FILE}`,
    })
  } else {
    const lines = upstreamText.split("\n")
    if (lines.at(-1) === "") lines.pop()
    if (lines.some((line) => line.length === 0)) {
      issues.push({ code: "upstream-list-unsorted", message: `${UPSTREAM_LIST_FILE} contains blank lines` })
    }
    const entries = lines.filter((line) => line.length > 0)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const entry of entries) {
      if (seen.has(entry)) duplicates.push(entry)
      seen.add(entry)
    }
    if (duplicates.length > 0) {
      issues.push({
        code: "upstream-list-duplicate",
        path: duplicates[0],
        message: `${UPSTREAM_LIST_FILE} contains duplicate entries: ${[...new Set(duplicates)].join(", ")}`,
      })
    }
    for (let index = 1; index < entries.length; index++) {
      if (comparePaths(entries[index - 1]!, entries[index]!) > 0) {
        issues.push({
          code: "upstream-list-unsorted",
          path: entries[index],
          message: `${UPSTREAM_LIST_FILE} is not sorted at: ${entries[index]}`,
        })
        break
      }
    }
    for (const entry of entries) {
      if (path.isAbsolute(entry) || entry.split("/").includes("..")) {
        issues.push({
          code: "stale-upstream-entry",
          path: entry,
          message: `Upstream list entry must be repository-relative: ${entry}`,
        })
        continue
      }
      upstream.add(entry)
      if (!trackedSet.has(entry)) {
        issues.push({
          code: "stale-upstream-entry",
          path: entry,
          message: `Upstream list entry is not a tracked file: ${entry}`,
        })
      }
    }
  }

  // 3. Per-file headers and retired-license references.
  for (const file of tracked) {
    const excluded = isExcludedPath(file)
    const absolute = path.join(root, file)
    if (!existsSync(absolute)) continue
    const bytes = await Bun.file(absolute).arrayBuffer()
    const data = new Uint8Array(bytes)
    const binary = data.some((byte) => byte === 0)
    if (binary) continue
    const text = new TextDecoder().decode(data)
    const header = text.split("\n", 12).join("\n")

    if (!excluded && isSourceFile(file)) {
      if (upstream.has(file)) {
        if (header.includes(APACHE_IDENTIFIER)) {
          issues.push({
            code: "wrong-header-on-upstream",
            path: file,
            message: `Upstream file carries an Apache header: ${file}`,
          })
        }
      } else if (!header.includes(APACHE_IDENTIFIER) || !header.includes(APACHE_COPYRIGHT)) {
        issues.push({
          code: "missing-apache-header",
          path: file,
          message: `Fork source file is missing the Apache SPDX header: ${file}`,
        })
      }
    }

    if (!file.startsWith(".github/releases/") && FORBIDDEN_LICENSE_PATTERN.test(text)) {
      issues.push({
        code: FORBIDDEN_LICENSE_CODE,
        path: file,
        message: `Tracked file references the retired license: ${file}`,
      })
    }
  }

  // 4. NOTICE and CONTRIBUTING author identity statement.
  issues.push(...(await missingValues(root, "NOTICE", NOTICE_REQUIRED_VALUES)))
  issues.push(...(await missingValues(root, "CONTRIBUTING.md", CONTRIBUTING_REQUIRED_VALUES)))

  // 5. package.json license fields derived from the file set.
  for (const packageFile of tracked.filter((file) => path.posix.basename(file) === "package.json")) {
    const directory = path.posix.dirname(packageFile) === "." ? "" : path.posix.dirname(packageFile)
    const expected = expectedPackageLicense(tracked, upstream, directory)
    const actual = await readPackageLicense(path.join(root, packageFile))
    if (actual !== expected) {
      issues.push({
        code: "package-license-mismatch",
        path: packageFile,
        message: `${packageFile} license is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
      })
    }
  }

  return issues
}

export function isExcludedPath(file: string) {
  return (
    file.startsWith("third_party/") ||
    file.startsWith("patches/") ||
    /(^|\/)LICENSE[^/]*$/.test(file) ||
    file === "bun.lock" ||
    file.endsWith(".patch")
  )
}

export function isSourceFile(file: string) {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))
}

export function expectedPackageLicense(tracked: readonly string[], upstream: ReadonlySet<string>, directory: string) {
  const files = tracked.filter((file) => (directory === "" ? true : file.startsWith(`${directory}/`)))
  const relevant = files.filter((file) => !isExcludedPath(file))
  const hasUpstream = relevant.some((file) => upstream.has(file))
  const hasFork = relevant.some((file) => !upstream.has(file))
  if (hasUpstream && hasFork) return "Apache-2.0 AND MIT"
  if (hasFork) return "Apache-2.0"
  return "MIT"
}

async function missingValues(root: string, file: string, values: readonly string[]): Promise<LicenseIssue[]> {
  const pathname = path.join(root, file)
  if (!existsSync(pathname)) {
    return [{ code: "missing-license-file", path: file, message: `Required file is missing: ${file}` }]
  }
  const text = await Bun.file(pathname).text()
  return values
    .filter((value) => !text.includes(value))
    .map((value) => ({
      code: "notice-missing-value",
      path: file,
      message: `${file} does not contain required statement: ${value}`,
    }))
}

async function readPackageLicense(file: string): Promise<string | undefined> {
  try {
    const value: unknown = await Bun.file(file).json()
    if (!isRecord(value)) return undefined
    return typeof value.license === "string" ? value.license : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function gitTrackedFiles(root: string) {
  const result = Bun.spawnSync({ cmd: ["git", "ls-files", "-z"], cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${result.stderr.toString()}`)
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0)
}

if (import.meta.main) {
  const root = path.join(import.meta.dir, "..")
  const issues = await checkLicense(root)
  if (issues.length > 0) {
    console.error(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"))
    process.exit(1)
  }
  console.log("License check passed")
}
