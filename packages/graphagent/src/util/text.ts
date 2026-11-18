// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The first `max` UTF-16 code units of `text`. A cut that would fall between the
 * two halves of a surrogate pair takes one fewer, so the result is never
 * malformed text (a lone half is replaced with U+FFFD on its way to a provider).
 */
export function headChars(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  const high = text.charCodeAt(max - 1)
  const low = text.charCodeAt(max)
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
  return text.slice(0, splitsPair ? max - 1 : max)
}
