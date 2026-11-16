// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { EventManifest } from "@graphagent/schema/event-manifest"

/**
 * The source tree and event definitions the hook contract is checked against
 * (`binding-table.test.ts`, `context-doc.test.ts`).
 */

export const PACKAGES = path.resolve(import.meta.dir, "../../..")

const SOURCE_ROOTS = ["graphagent/src", "core/src"]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) && !/\.(test|d)\.ts$/.test(entry) ? [full] : []
  })
}

/** Every non-test source file of the runtime and core packages, by path relative to `packages/`. */
export const sources: ReadonlyMap<string, string> = new Map(
  SOURCE_ROOTS.flatMap((root) => sourceFiles(path.join(PACKAGES, root))).map((file) => [
    path.relative(PACKAGES, file),
    readFileSync(file, "utf8"),
  ]),
)

const sourceText = [...sources.values()].join("\n")

/** The type of every event definition in the manifest. */
export const eventTypes: ReadonlySet<string> = new Set(
  [...EventManifest.Definitions].map((definition) => definition.type),
)

/** The tokens a text wraps in backticks. */
export function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
}

const NOT_EVENTS = new Set(["fs.watch"])

/**
 * The code names `text` mentions that no longer exist: a file path that is not
 * on disk, a lower-case dotted event type that no definition has, or a symbol
 * (a dotted name, or one with an upper-case letter or an underscore) whose last
 * segment appears nowhere in the sources. A lower-case dotted name also passes
 * when the sources spell it as a string, as they do for inbox source ids.
 * `allowed` lists names that are valid without being events, such as lifecycle
 * values.
 */
export function unknownNames(text: string, allowed: Iterable<string> = []): string[] {
  const extra = new Set(allowed)
  const missing: string[] = []
  for (const token of backticked(text)) {
    if (/^[\w./-]+\.(ts|tsx|md)$/.test(token) && token.includes("/")) {
      const found = ["", "graphagent/src", "graphagent"].some((base) => existsSync(path.join(PACKAGES, base, token)))
      if (!found) missing.push(`${token} (file)`)
      continue
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(token)) continue
    if (/^[a-z]+(\.[a-z_]+)+$/.test(token)) {
      // An event type, a value `allowed` lists, or an identifier the sources spell as a string (an inbox source id).
      const known =
        NOT_EVENTS.has(token) || extra.has(token) || eventTypes.has(token) || sourceText.includes(`"${token}"`)
      if (!known) missing.push(`${token} (event)`)
      continue
    }
    if (!token.includes(".") && !/[A-Z_]/.test(token)) continue
    const name = token.split(".").at(-1) ?? token
    if (!new RegExp(`\\b${name}\\b`).test(sourceText)) missing.push(`${token} (symbol)`)
  }
  return missing
}
