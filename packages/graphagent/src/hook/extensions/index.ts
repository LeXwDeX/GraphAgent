/**
 * [FORK:hook-ext] Fork hook extensions — assembles ForkHooks implementation
 *
 * This module is the single entry point for all fork-specific hook processing.
 * It exports `buildForkHooks` which creates a ForkHooks instance that plugs
 * into the engine trigger() via the beforeRunEntry/afterRunEntry callbacks.
 *
 * Architecture:
 * - types.ts defines the ForkHooks interface (optional callbacks)
 * - This module implements those callbacks using extension modules
 * - The Effect layer in service.ts calls buildForkHooks() at construction
 *
 * Adding new extensions:
 * 1. Create a new file in this directory (e.g., rate-limiter.ts)
 * 2. Plug into beforeRunEntry or afterRunEntry below
 * 3. Update FORK_POINTS.md with the new bridge point
 */

import type { ForkHooks, HookCommand, HookEvent } from "../types"
import type { SessionHooks } from "../session-hooks"
import { evaluate as evaluateCondition } from "./condition-filter"

export { watchSettings, type HotReloadHandle } from "./hot-reload"
export { evaluate as evaluateCondition } from "./condition-filter"

/**
 * Build the ForkHooks implementation.
 *
 * @param deps - Dependencies needed by extensions
 * @returns ForkHooks instance to plug into the engine trigger()
 */
export function buildForkHooks(_deps: { sessionHooks: SessionHooks.Interface }): ForkHooks {
  return {
    /**
     * Pre-dispatch filter — evaluates `if` conditions on hook entries.
     * Return false to skip the entry, true to proceed.
     */
    beforeRunEntry(
      entry: HookCommand,
      envelope: Record<string, unknown>,
      event: HookEvent,
      tool?: { canonicalToolName?: string },
    ): boolean {
      return evaluateCondition(entry, envelope, event, tool)
    },

    /**
     * Post-dispatch observation extension point. The ForkHooks.afterRunEntry
     * interface and its engine trigger call site are intentionally kept
     * (future extensions — metrics, rate-limiting, etc. — can plug behavior
     * back in here), but the previous post-tool-batch tracker was removed: its
     * per-session `batches` Map grew unbounded and had no consumer. Currently a
     * no-op; never modifies the result.
     */
    afterRunEntry: () => {},
  }
}
