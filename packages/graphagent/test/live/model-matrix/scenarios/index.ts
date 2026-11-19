// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Scenario } from "../types"
import { BASH_SCENARIOS } from "./bash"
import { COMPACTION_SCENARIOS } from "./compaction"
import { FILE_SCENARIOS } from "./files"
import { GLOB_SCENARIOS } from "./glob"
import { GREP_SCENARIOS } from "./grep"
import { READ_SCENARIOS } from "./read"
import { SKILL_SCENARIOS } from "./skill"
import { TASK_SCENARIOS } from "./task"
import { TODO_SCENARIOS } from "./todo"

/** Every scenario, in the order of the report. */
export const SCENARIOS: readonly Scenario[] = [
  ...READ_SCENARIOS,
  ...GLOB_SCENARIOS,
  ...GREP_SCENARIOS,
  ...BASH_SCENARIOS,
  ...FILE_SCENARIOS,
  ...TODO_SCENARIOS,
  ...TASK_SCENARIOS,
  ...SKILL_SCENARIOS,
  ...COMPACTION_SCENARIOS,
]
