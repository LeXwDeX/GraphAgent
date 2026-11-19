// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** Script builders and fixture generators shared by the scenario files. */

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
