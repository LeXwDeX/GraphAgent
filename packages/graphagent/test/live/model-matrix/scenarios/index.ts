// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Scenario } from "../types"
import { BASH_SCENARIOS } from "./bash"
import { GLOB_SCENARIOS } from "./glob"
import { GREP_SCENARIOS } from "./grep"
import { READ_SCENARIOS } from "./read"

/** Every scenario, in the order of the report. */
export const SCENARIOS: readonly Scenario[] = [
  ...READ_SCENARIOS,
  ...GLOB_SCENARIOS,
  ...GREP_SCENARIOS,
  ...BASH_SCENARIOS,
]
