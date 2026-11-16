// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * `disableAllHooks`, applied by the layer that defines each hook.
 *
 * `mergeSettings` records two facts on the merged chain (`Settings.hooksDisabled`): the global
 * layer switched every hook off, or a project or local layer switched off the hooks the project
 * side defines. This module maps a hook to its side, so the trigger pipeline, the Active Hooks
 * list, the event probe and the static watch paths all read one rule.
 */
import type { CompiledGroup } from "../index-by-event"
import type { SessionHookEntry } from "../session-hooks"
import type { HookMatcher, HookSourceScope, Settings } from "../types"

/** Where a hook is defined: the global hooks file, or a file of the project's own. */
export type HookSide = "global" | "project"

/** Side of a hook loaded from a hooks file; one without a recorded layer counts as global. */
export function fileSide(scope: HookSourceScope | undefined): HookSide {
  return scope === "project" || scope === "local" ? "project" : "global"
}

/** Origin prefix of an inline `agent.<name>.hooks` registration: it names no defining file. */
const INLINE_AGENT_ORIGIN = "agent-config:"

/**
 * Side of a session hook. A scoped skill or agent hook belongs to the layer of the file that
 * defines it, which its loader records as `source`: `project` for a project-owned definition,
 * `user` or `builtin` otherwise. A hook whose defining file is unknown counts as global: one with
 * no source (a session-API registration), and an inline `agent-config:` registration, whatever
 * source its loader defaulted to.
 */
export function sessionSide(entry: Pick<SessionHookEntry, "source" | "origin">): HookSide {
  if (entry.origin?.startsWith(INLINE_AGENT_ORIGIN)) return "global"
  return entry.source === "project" ? "project" : "global"
}

/** True when `disableAllHooks` has switched off the hooks defined on `side`. */
export function sideDisabled(settings: Settings, side: HookSide): boolean {
  const off = settings.hooksDisabled
  return off !== undefined && (off.global || (side === "project" && off.project))
}

/** True when the global layer switched every hook off, whatever layer defines it. */
export function allDisabled(settings: Settings): boolean {
  return settings.hooksDisabled?.global === true
}

/** `group` without its switched-off hooks; undefined when none is left. */
function enabledPart(settings: Settings, group: HookMatcher): HookMatcher | undefined {
  const hooks = group.hooks.filter((hook) => !sideDisabled(settings, fileSide(hook.__source?.scope)))
  if (hooks.length === group.hooks.length) return group
  return hooks.length === 0 ? undefined : { ...group, hooks }
}

/** Hooks-file matcher groups minus the switched-off hooks; the input itself while nothing is off. */
export function enabledMatchers(settings: Settings, groups: readonly HookMatcher[]): readonly HookMatcher[] {
  if (settings.hooksDisabled === undefined) return groups
  return groups.flatMap((group) => {
    const part = enabledPart(settings, group)
    return part === undefined ? [] : [part]
  })
}

/** One event's compiled groups minus the switched-off hooks; a kept group retains its compiled matcher. */
export function enabledGroups(settings: Settings, groups: readonly CompiledGroup[]): readonly CompiledGroup[] {
  if (settings.hooksDisabled === undefined) return groups
  return groups.flatMap((compiled) => {
    const group = enabledPart(settings, compiled.group)
    if (group === undefined) return []
    return [group === compiled.group ? compiled : { group, test: compiled.test }]
  })
}

/** Session hooks minus the switched-off ones; the input itself while nothing is off. */
export function enabledSession<T extends Pick<SessionHookEntry, "source" | "origin">>(
  settings: Settings,
  entries: readonly T[],
): readonly T[] {
  if (settings.hooksDisabled === undefined) return entries
  return entries.filter((entry) => !sideDisabled(settings, sessionSide(entry)))
}
