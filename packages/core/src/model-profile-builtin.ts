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
 * A rule is added with the Issue that migrates the reader that needs it.
 */
export const BUILTIN_RULES: ReadonlyArray<BuiltinRule> = [
  {
    // The gpt- family edits through apply_patch; gpt-4 and the open-weight gpt-oss keep edit and write.
    name: "edit-tools-apply-patch",
    source: "296a1a5d0:packages/graphagent/src/tool/editing-tools.ts:6",
    match(input) {
      const id = input.apiID.toLowerCase()
      return id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4")
    },
    set: () => ({ editTools: "apply_patch" }),
  },
]
