// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost display (#1475). Pure functions shared by the CLI, the TUI and the usage
 * endpoint's clients, so one amount reads the same everywhere. Display only:
 * nothing here blocks or limits anything.
 */

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const fractions = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

/** Below this a positive cost would round to four zeros, so it is shown as "less than". */
const SMALLEST_SHOWN = 0.0001
/** From here on cents are enough. */
const CENT = 0.01

/**
 * A cost in dollars. A real cost never reads as zero: a low-priced model's
 * session often costs a fraction of a cent, and `$0.00` could not be told from
 * "no price".
 *
 * - zero, negative (float drift after a refund) and non-finite: `$0.00`
 * - above zero and under 0.0001: `<$0.0001`
 * - under 0.01: four decimals (`$0.0027`)
 * - otherwise two decimals with grouping (`$1,234.50`)
 */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return dollars.format(0)
  if (cost < SMALLEST_SHOWN) return `<${fractions.format(SMALLEST_SHOWN)}`
  if (cost < CENT) return fractions.format(cost)
  return dollars.format(cost)
}

/**
 * Whether a session ran with no price: it recorded tokens but its cost is zero.
 * The same test as `UNPRICED_SQL` (`session/usage.ts`) applies to a row; it
 * reads the recorded usage only, never the model's price card.
 */
export function unpriced(cost: number, tokenTotal: number): boolean {
  return cost === 0 && tokenTotal > 0
}

/**
 * A cost with the part that has no price spelled out. With nothing unknown it
 * is `formatCost`; with an unknown part it is the word alone when nothing else
 * has a cost (a non-positive or non-finite sum counts as nothing), and the
 * known amount followed by `+ <word>` otherwise. The caller passes the word so
 * each surface says it in the user's language.
 */
export function costLabel(cost: number, unknown: boolean, unknownWord: string): string {
  if (!unknown) return formatCost(cost)
  return Number.isFinite(cost) && cost > 0 ? `${formatCost(cost)} + ${unknownWord}` : unknownWord
}
