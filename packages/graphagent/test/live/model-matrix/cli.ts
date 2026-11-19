// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the command-line scripts of the matrix (`run.ts`, `case.ts`) share: where this checkout is, a flag reader,
 * and the result type of a parse.
 *
 * The scripts write results, transcripts and cases made from real sessions, and refuse a destination inside the
 * checkout so that none of it can be committed by accident.
 */

import fs from "node:fs/promises"
import path from "node:path"

/** The checkout this script is in: `packages/graphagent/test/live/model-matrix` is five levels below it. */
export const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..")

/** Whether `target` is the checkout's directory or below it. */
export function insideRepo(target: string, repoRoot: string = REPO_ROOT): boolean {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Whether `target` lands in the checkout once the links on its way are followed: the lexical check, then the same
 * check on the real paths, so a link that leads into the checkout is caught as well.
 */
export async function resolvesIntoRepo(target: string, repoRoot: string = REPO_ROOT): Promise<boolean> {
  return insideRepo(target, repoRoot) || insideRepo(await realPathOf(target), await realPathOf(repoRoot))
}

/** The real path of `target`, which need not exist yet: its deepest existing ancestor resolved, the rest appended. */
export async function realPathOf(target: string): Promise<string> {
  const rest: string[] = []
  let at = path.resolve(target)
  for (;;) {
    const real = await fs.realpath(at).catch(() => undefined)
    if (real !== undefined) return path.join(real, ...rest)
    const parent = path.dirname(at)
    if (parent === at) return path.resolve(target)
    rest.unshift(path.basename(at))
    at = parent
  }
}

/** The value of a parse, or the reason it failed, in words. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

export const failed = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error })

/**
 * The values given for each flag, in order, for `--flag value` and `--flag=value` alike. A flag that is not in
 * `flags` and a flag without a value are errors; whether a flag may repeat is for the caller to say.
 */
export function readFlags(argv: readonly string[], flags: readonly string[]): Parsed<Record<string, string[]>> {
  const given: Record<string, string[]> = Object.fromEntries(flags.map((flag) => [flag, []]))
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    const equals = arg.indexOf("=")
    const flag = equals > 0 ? arg.slice(0, equals) : arg
    const values = Object.hasOwn(given, flag) ? given[flag] : undefined
    if (!values) return failed(`unknown argument ${arg}`)
    const value = equals > 0 ? arg.slice(equals + 1) : argv[++index]
    if (!value) return failed(`${flag} needs a value`)
    values.push(value)
  }
  return { ok: true, value: given }
}
