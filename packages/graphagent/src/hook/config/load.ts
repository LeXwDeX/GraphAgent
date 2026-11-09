/**
 * hooks.json chain reading and merge-time validation.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import path from "path"
import { existsSync, readFileSync } from "fs"
import * as Log from "@/util/log"
import { HookCommandSchema } from "../schema"
import type { HookCommand, HookEvent, HookMatcher, Settings } from "../types"
import { isRecord, VALID_HOOK_EVENTS } from "../types"

const log = Log.create({ service: "hook.settings" })

// ── Settings loader (hooks.json chain) ──────────────────────────

export function isHookEvent(value: string): value is HookEvent {
  return VALID_HOOK_EVENTS.has(value)
}

// Exported for unit testing only; not part of the public surface.
export function readJSON(filepath: string): Settings | null {
  return readJSONFile(filepath).settings ?? null
}

/** A missing file is an empty layer; a file that exists but cannot be parsed is invalid. */
export function readJSONFile(filepath: string): { settings?: Settings; invalid?: true } {
  if (!existsSync(filepath)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(filepath, "utf8"))
    // hooks.json uses top-level event keys. A legacy {"hooks": {...}} wrapper is
    // rejected: Claude's settings.json is converted by /import-claude-hooks, which
    // writes top-level event keys, so no loader compatibility is needed.
    const obj = isRecord(parsed) ? parsed : undefined
    if (obj && isRecord(obj.hooks))
      log.warn('hooks.json must use top-level event keys; the "hooks" wrapper is ignored', { path: filepath })
    const rawHooks = obj && isRecord(obj.hooks) ? undefined : obj

    const hooks: Settings["hooks"] = {}
    const sourceDir = path.dirname(filepath)
    if (rawHooks) {
      for (const [key, value] of Object.entries(rawHooks)) {
        if (!isHookEvent(key)) {
          // A PascalCase key is event-shaped: an unsupported Claude Code event
          // or a typo. Settings keys are camelCase and are not diagnosed here.
          if (/^[A-Z][A-Za-z0-9]*$/.test(key)) log.warn("unknown hook event skipped", { path: filepath, event: key })
          continue
        }
        if (!Array.isArray(value)) {
          log.warn("invalid hook event configuration", { path: filepath, event: key })
          continue
        }
        const groups: HookMatcher[] = []
        for (const group of value) {
          if (
            !group ||
            typeof group !== "object" ||
            !Array.isArray(group.hooks) ||
            (group.matcher !== undefined && typeof group.matcher !== "string")
          ) {
            log.warn("invalid hook matcher skipped", { path: filepath, event: key })
            continue
          }
          const commands: HookCommand[] = []
          for (const candidate of group.hooks) {
            const parsed = HookCommandSchema.safeParse(candidate)
            if (!parsed.success) {
              log.warn("invalid hook command skipped", { path: filepath, event: key, error: parsed.error.message })
              continue
            }
            commands.push({ ...parsed.data, __sourceDir: sourceDir })
          }
          if (commands.length) groups.push({ matcher: group.matcher, hooks: commands })
        }
        hooks[key] = groups
      }
    }
    log.info("loaded hook settings", {
      path: filepath,
      events: Object.keys(hooks),
    })
    const disableAllHooks = typeof obj?.disableAllHooks === "boolean" ? obj.disableAllHooks : undefined
    const allowedHttpHookUrls = Array.isArray(obj?.allowedHttpHookUrls)
      ? obj.allowedHttpHookUrls.filter((value): value is string => typeof value === "string")
      : undefined
    const httpHookAllowedEnvVars = Array.isArray(obj?.httpHookAllowedEnvVars)
      ? obj.httpHookAllowedEnvVars.filter((value): value is string => typeof value === "string")
      : undefined
    return {
      settings: {
        hooks,
        ...(disableAllHooks !== undefined ? { disableAllHooks } : {}),
        ...(allowedHttpHookUrls !== undefined ? { allowedHttpHookUrls } : {}),
        ...(httpHookAllowedEnvVars !== undefined ? { httpHookAllowedEnvVars } : {}),
      },
    }
  } catch (err) {
    log.error("failed to parse hooks.json", { path: filepath, error: String(err) })
    return { invalid: true }
  }
}
/** Diagnose fields that have no effect for the selected handler type. */
export function detectUnsupportedFields(
  hooks: Settings["hooks"],
): Array<{ field: string; value: unknown; eventName: string }> {
  const unsupported: Array<{ field: string; value: unknown; eventName: string }> = []
  for (const [eventName, matchers] of Object.entries(hooks ?? {})) {
    for (const matcher of matchers ?? []) {
      for (const entry of matcher.hooks) {
        if (entry.shell !== undefined && entry.type !== "command")
          unsupported.push({ field: "shell", value: entry.shell, eventName })
        if (entry.allowedEnvVars !== undefined && entry.type !== "http")
          unsupported.push({ field: "allowedEnvVars", value: entry.allowedEnvVars, eventName })
      }
    }
  }
  return unsupported
}

/**
 * Events whose async completion never reaches a rewake. SessionEnd has no later
 * turn and StopFailure discards its output and exit code. Marking these
 * `background` would tell the agent to wait for a callback the code guarantees
 * will never arrive.
 */
const NO_REWAKE_EVENTS = new Set<HookEvent>(["SessionEnd", "StopFailure"])

export function canRewake(event: HookEvent): boolean {
  return !NO_REWAKE_EVENTS.has(event)
}

export function warnUnsupportedFields(hooks: Settings["hooks"], sourceDir: string): void {
  const unsupported = detectUnsupportedFields(hooks)
  if (unsupported.length > 0) {
    log.warn("hook settings contains fields ignored by this handler type", {
      sourceDir,
      unsupported,
    })
  }
}
