/**
 * Handler identity, event eligibility, and matcher group selection.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import { createHash } from "crypto"
import { commandText, expandCommand, httpUrl } from "../exec/command"
import { compileMatcher, type CompiledMatcher } from "../match"
import type { HookCommand, HookEvent, HookMatcher, HookPayload } from "../types"

/**
 * Identity of a handler for per-trigger dedup: only fully equivalent handlers
 * run once (CC behavior). Every configured field except loader metadata takes
 * part (headers, env allowlists, options, timeout), plus the expanded command
 * or URL. Scoped skill/agent registrations add their origin separately.
 */
export function handlerKey(entry: HookCommand, origin?: string): string {
  const target =
    entry.type === "command"
      ? expandCommand(entry)
      : entry.type === "http"
        ? httpUrl(entry)
        : entry.type === "mcp_tool"
          ? `${entry.server}/${entry.tool}`
          : commandText(entry)
  // Loader metadata never distinguishes handlers: the same hook declared in two
  // layers (different `__source`, or a future plugin `__sourceDir`) must dedup.
  const { __sourceDir: _sourceDir, __source: _source, ...identity } = entry
  return JSON.stringify([origin ?? "settings", target, identity], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

/** Stable progress/cancellation identity: the handler digest only, never its command or headers. */
export function hookIDFor(entry: HookCommand, origin?: string): string {
  return createHash("sha256").update(handlerKey(entry, origin)).digest("hex")
}

/** Per-event handler availability from the 2026-10-16 Claude Code hooks reference. */
const ALL_HANDLER_TYPES = new Set<HookCommand["type"]>(["command", "http", "mcp_tool", "prompt", "agent"])
const OBSERVATIONAL_HANDLER_TYPES = new Set<HookCommand["type"]>(["command", "http", "mcp_tool"])
function supportsHandler(event: HookEvent, type: HookCommand["type"]): boolean {
  if (event === "Setup") return type === "command"
  if (event === "SessionStart") return type === "command" || type === "mcp_tool"
  if (event === "PermissionRequest") return type !== "agent"
  if (
    [
      "UserPromptSubmit",
      "UserPromptExpansion",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "Stop",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
    ].includes(event)
  )
    return ALL_HANDLER_TYPES.has(type)
  return OBSERVATIONAL_HANDLER_TYPES.has(type)
}

/** A group runs when the event exposes no matcher targets or one target matches its compiled matcher. */
export function groupMatches(test: CompiledMatcher, targets: readonly string[] | undefined): boolean {
  return targets === undefined || targets.some((target) => test(target))
}

/** Compile a session-scoped group's matcher; the settings chain uses `index-by-event`. */
export function compileGroup(group: Pick<HookMatcher, "matcher">, event: HookEvent): CompiledMatcher {
  return compileMatcher(group.matcher, event)
}

/** Handler type support plus the startup event surface that excludes MCP handlers. */
export function entryEligible(payload: HookPayload, entry: HookCommand): boolean {
  if (!supportsHandler(payload.event, entry.type)) return false
  if (
    entry.type === "mcp_tool" &&
    (payload.event === "Setup" ||
      (payload.event === "SessionStart" && ["startup", "resume", "fork"].includes(payload.source)))
  )
    return false
  return true
}
