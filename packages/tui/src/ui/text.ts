// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Text levels (#1672, spec #1669 item 6, `AGENTS.md` 13.6): the one place that says what each of the six levels of text
 * is drawn with. A terminal tells levels apart by color and weight alone, and a piece of text belongs to a level by the
 * role it plays, so a panel names the role (`textFg(theme, "secondary")`) and never picks a token or a weight to express
 * one. A change to a level is a change to the table below and moves every panel with it.
 *
 * Selection, hover and warnings are states and not levels (13.6): the status colors and the selection background are
 * used as they are (`theme.success`, `theme.warning`, `theme.backgroundSelected`), and the few styles a selected row
 * adds to its levels are named at the end of this file so that no panel spells them out either.
 *
 * Pure: it reads the theme it is given and imports nothing from the TUI but the `Theme` type, so any layer may use it.
 */

import { TextAttributes, type RGBA } from "@opentui/core"
import type { Theme } from "../theme"

/** The six levels, T1 the heaviest and T6 the least. */
export type TextLevel = "T1" | "T2" | "T3" | "T4" | "T5" | "T6"

/** The theme tokens the levels are drawn in. */
export type TextLevelToken = "primary" | "text" | "textMuted" | "textDim"

/** What a level is drawn with: its theme token, and whether it is bold. */
export const TEXT_LEVELS: Readonly<Record<TextLevel, { readonly token: TextLevelToken; readonly bold: boolean }>> = {
  T1: { token: "primary", bold: true },
  T2: { token: "primary", bold: false },
  T3: { token: "text", bold: false },
  T4: { token: "textMuted", bold: false },
  // T5 and T6 share `textDim`: one is the hint row and the footnotes, the other what cannot be used.
  T5: { token: "textDim", bold: false },
  T6: { token: "textDim", bold: false },
}

/**
 * The roles a panel names, and the level each one is. A role is chosen by what the text is for:
 * - `title`: the title of a panel or a region (T1).
 * - `group`: the heading of a group of rows (T2).
 * - `body`: body text, the main text of a row (T3).
 * - `secondary`: what a row says at its right (a time, a state), the note line, an empty state, a placeholder (T4).
 * - `hint`: the hint row, descriptions of keys, the dim footnote at the end of a row (T5).
 * - `disabled`: what cannot be used (T6).
 */
export const TEXT_ROLES = {
  title: "T1",
  group: "T2",
  body: "T3",
  secondary: "T4",
  hint: "T5",
  disabled: "T6",
} as const satisfies Record<string, TextLevel>

export type TextRole = keyof typeof TEXT_ROLES

/** The foreground of a role. */
export function textFg(theme: Theme, role: TextRole): RGBA {
  return theme[TEXT_LEVELS[TEXT_ROLES[role]].token]
}

/** The weight of a role: `TextAttributes.BOLD` for a bold level, nothing for the rest. */
export function textAttributes(role: TextRole): number | undefined {
  return TEXT_LEVELS[TEXT_ROLES[role]].bold ? TextAttributes.BOLD : undefined
}

/** A role as one style object, for the `style` of a span. */
export function textStyle(theme: Theme, role: TextRole): { fg: RGBA; attributes?: number } {
  const attributes = textAttributes(role)
  return attributes === undefined ? { fg: textFg(theme, role) } : { fg: textFg(theme, role), attributes }
}

/**
 * The foreground of a panel's title. A warning panel (`tone="warning"`, 6.2) draws it in the warning color, the one
 * variant a level has (13.6).
 */
export function titleFg(theme: Theme, tone: "default" | "warning" = "default"): RGBA {
  return tone === "warning" ? theme.warning : textFg(theme, "title")
}

// ---------------------------------------------------------------------------
// What a selected row adds to its levels
// ---------------------------------------------------------------------------

/**
 * The foreground of the selection mark of a row (`›` for the selected row, `●` for the current value) and of the value
 * of a selected setting: the brand color the selected row of a list or a setting is allowed (7, item 2). A row that is
 * neither selected nor current draws a blank in the dim level.
 */
export function selectedFg(theme: Theme, marked = true): RGBA {
  return marked ? theme.primary : textFg(theme, "hint")
}

/** The weight of the main text of a row: bold while the row is selected. Selection state, not a level. */
export function selectedAttributes(selected: boolean): number | undefined {
  return selected ? TextAttributes.BOLD : undefined
}

/** The color of the cursor in an input of a panel (the brand color, as the composer's). */
export function cursorFg(theme: Theme): RGBA {
  return theme.primary
}
