// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "@graphagent/sdk"

/**
 * The five token counts a session recorded, added up (#1475): the figure `unpriced` weighs the session's cost against.
 * A session that recorded no tokens, or one that is not loaded, has none.
 */
export function sessionTokenTotal(tokens: Session["tokens"] | undefined): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
