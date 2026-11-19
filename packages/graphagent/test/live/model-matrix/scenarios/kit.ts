// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** Script builders and fixture generators shared by the scenario files. */

import type { Needle } from "../judge"
import type { Reply, Script } from "../types"

/** A turn that calls one tool. */
export const call = (name: string, input: Record<string, unknown>): Reply => ({ calls: [{ name, input }] })

/** A turn that says something and stops. */
export const say = (text: string): Reply => ({ text })

/** The default script of a scenario: its tool once, then the answer. */
export const once = (name: string, input: Record<string, unknown>, answer: string): Script => ({
  replies: [call(name, input), say(answer)],
})

/** `length` characters of plain text, made by repeating `unit`. Large fixtures are generated, not committed. */
export function filler(length: number, unit = "lorem ipsum dolor sit amet "): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
}

/** `count` numbered items as one text, a line each, closed by a newline. */
export function lines(count: number, line: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => line(index + 1)).join("\n") + "\n"
}

export const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * What the receipt of every write tool says (#1451): the lines the change landed on, and whether the language
 * server checked it (`checked: clean`, or `not checked: LSP disabled` on a host that runs without one).
 */
export const WRITE_RECEIPT: readonly Needle[] = [/Lines \d+-\d+(, \d+-\d+)* changed\./, /checked: /]

/** The `contract` of a script that writes with these tools: a completed call of each shows the write receipt. */
export const receiptContract = (...tools: readonly string[]): NonNullable<Script["contract"]> =>
  tools.map((tool) => ({ tool, includes: WRITE_RECEIPT }))

/** A patch for `apply_patch`: the file sections between the envelope lines. */
export const patch = (...sections: readonly string[]): string =>
  ["*** Begin Patch", ...sections, "*** End Patch"].join("\n")

/** An `Add File` section; every line of the new file follows a `+`. */
export const addFile = (file: string, ...text: readonly string[]): string =>
  [`*** Add File: ${file}`, ...text.map((line) => `+${line}`)].join("\n")

/** An `Update File` section of one hunk: the `drop` lines are replaced by the `add` lines, found after the `at` line if one is given. */
export const updateFile = (
  file: string,
  hunk: { readonly at?: string; readonly drop: readonly string[]; readonly add: readonly string[] },
): string =>
  [
    `*** Update File: ${file}`,
    hunk.at === undefined ? "@@" : `@@ ${hunk.at}`,
    ...hunk.drop.map((line) => `-${line}`),
    ...hunk.add.map((line) => `+${line}`),
  ].join("\n")
