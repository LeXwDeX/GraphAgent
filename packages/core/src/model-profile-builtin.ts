// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { BuiltinRule } from "./model-profile"

/**
 * Built-in profile rules, the last source before the defaults.
 *
 * - Rules run in declaration order. When `match(input)` is true, `set(input)` only fills the fields that
 *   no earlier source (config, an existing entry, a catalog alias, an earlier rule) has declared; the fields
 *   it fills record `builtin:<name>` in `ModelProfile.sources`.
 * - `source` is required: a documentation link, or `<commit>:<file>:<line>` of the code the rule replaces.
 * - `name` is unique across the table.
 * - `match` must tolerate a missing `npm`, `releaseDate` and `vendor`.
 *
 * The table starts empty; the readers that need a rule add it with the Issue that migrates them.
 */
export const BUILTIN_RULES: ReadonlyArray<BuiltinRule> = []
