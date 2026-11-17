// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// CLI message tables, one file per command domain so the CLI copy does not
// crowd the TUI tables. Both aggregates are spread into `zh-CN.ts` and `en.ts`,
// so the key-set, placeholder and brand-word tests cover them unchanged.

import { agentEn, agentZhCN } from "./agent"
import { commonEn, commonZhCN } from "./common"
import { mcpEn, mcpZhCN } from "./mcp"
import { providersEn, providersZhCN } from "./providers"
import { runEn, runZhCN } from "./run"
import { sessionEn, sessionZhCN } from "./session"
import { statsEn, statsZhCN } from "./stats"
import { uninstallEn, uninstallZhCN } from "./uninstall"

export const cliZhCN = {
  ...commonZhCN,
  ...runZhCN,
  ...mcpZhCN,
  ...providersZhCN,
  ...agentZhCN,
  ...uninstallZhCN,
  ...sessionZhCN,
  ...statsZhCN,
} as const

export const cliEn: Record<keyof typeof cliZhCN, string> = {
  ...commonEn,
  ...runEn,
  ...mcpEn,
  ...providersEn,
  ...agentEn,
  ...uninstallEn,
  ...sessionEn,
  ...statsEn,
}
