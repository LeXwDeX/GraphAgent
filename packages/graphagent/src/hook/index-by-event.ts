// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * D1 PR3: the settings chain pre-grouped by event with compiled matchers.
 *
 * `Settings` already keys hooks by event; what this index adds is compiling
 * each group's matcher once per settings generation instead of once per
 * trigger. Settings objects are immutable per InstanceState generation (a
 * reload replaces the whole object), so object identity is a safe cache key.
 * Session-scoped hooks are planned per trigger and instead share the
 * `(matcher, event)` compile cache in `match.ts`.
 */
import { compileMatcher, type CompiledMatcher } from "./match"
import { VALID_HOOK_EVENTS, type HookEvent, type HookMatcher, type Settings } from "./types"

export interface CompiledGroup {
  /** The settings-chain group, unchanged: origin metadata and hooks stay as loaded. */
  readonly group: HookMatcher
  /** Matcher predicate bound to this group's event. */
  readonly test: CompiledMatcher
}

export type HookIndex = ReadonlyMap<HookEvent, readonly CompiledGroup[]>

const EMPTY: readonly CompiledGroup[] = []
const cache = new WeakMap<Settings, HookIndex>()

const isHookEvent = (event: string): event is HookEvent => VALID_HOOK_EVENTS.has(event)

/** Build a fresh index for one settings snapshot. Exported for targeted tests. */
export function build(settings: Settings): HookIndex {
  const index = new Map<HookEvent, CompiledGroup[]>()
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    // The loader filters unknown keys, but a caller-constructed Settings object
    // may still carry one; skip it rather than guess an event type.
    if (!isHookEvent(event) || !groups) continue
    index.set(
      event,
      groups.map((group) => ({ group, test: compileMatcher(group.matcher, event) })),
    )
  }
  return index
}

/** The cached index for a settings snapshot; the first trigger after a reload builds it. */
export function of(settings: Settings): HookIndex {
  const hit = cache.get(settings)
  if (hit) return hit
  const built = build(settings)
  cache.set(settings, built)
  return built
}

/** Compiled groups for one event; an unconfigured event yields a shared empty list. */
export function groups(index: HookIndex, event: HookEvent): readonly CompiledGroup[] {
  return index.get(event) ?? EMPTY
}

export * as HookIndexByEvent from "./index-by-event"
