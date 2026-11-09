/**
 * Matcher targets, tool-name translation, and permission-mode mapping.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import path from "path"
import * as Log from "@/util/log"
import { isRecord } from "./types"
import type { HookEvent, HookPayload, TriggerContext } from "./types"
import { patchFilePaths } from "./file-changes"

const log = Log.create({ service: "hook.settings" })

/**
 * Map fork agent.name to CC `permission_mode` envelope value.
 *
 * fork 没有 CC 那种 permission_mode 全局枚举（default / acceptEdits / bypassPermissions / plan）。
 * 用 agent name 替代：plan agent 等价于 plan mode，其余 primary agent 等价于 default mode。
 * acceptEdits / bypassPermissions 在 fork 中无对应概念 — 不输出，避免给用户 hook 脚本造假信号。
 */
export function agentToPermissionMode(agentName: string | undefined): "plan" | "default" {
  return agentName === "plan" ? "plan" : "default"
}
// ── Matcher ─────────────────────────────────────────────────────

export type CompiledMatcher = (target: string) => boolean

/**
 * D1 PR3: `(event, matcher)` -> compiled predicate. Settings chains are rebuilt
 * whole on reload, and session-scoped hooks are re-planned per trigger, so the
 * same matcher strings are evaluated many times; compiling the RegExp once per
 * distinct pair keeps the trigger path allocation-free. The bound is a safety
 * valve for dynamically generated session hooks, not an expected size.
 */
const matcherCache = new Map<string, CompiledMatcher>()
const MATCHER_CACHE_LIMIT = 1024

/** Test-only counters; not part of the hook's public surface. */
export const __matcherStats = {
  regexCompiles: 0,
  cacheHits: 0,
  get cacheSize() {
    return matcherCache.size
  },
}

export function resetMatcherStats() {
  __matcherStats.regexCompiles = 0
  __matcherStats.cacheHits = 0
}

const alwaysTrue: CompiledMatcher = () => true

function compileRegex(matcher: string, event: HookEvent | undefined): CompiledMatcher {
  const key = `${event ?? "*"}\0${matcher}`
  const cached = matcherCache.get(key)
  if (cached) {
    __matcherStats.cacheHits++
    return cached
  }
  __matcherStats.regexCompiles++
  let regex: RegExp | undefined
  try {
    regex = new RegExp(matcher)
  } catch {
    log.warn("invalid regex in hook matcher", { matcher })
  }
  const compiled: CompiledMatcher = regex ? (target) => regex.test(target) : () => false
  if (matcherCache.size >= MATCHER_CACHE_LIMIT) {
    const oldest = matcherCache.keys().next()
    if (!oldest.done) matcherCache.delete(oldest.value)
  }
  matcherCache.set(key, compiled)
  return compiled
}

/**
 * Compile a CC matcher pattern into a predicate. Literal and pipe-list matchers
 * never construct a RegExp; only the regex fallback is cached by
 * `(matcher, event)`.
 */
export function compileMatcher(matcher: string | undefined, event?: HookEvent): CompiledMatcher {
  if (!matcher || matcher === "*") return alwaysTrue
  if (event === "FileChanged" || event === "StopFailure") {
    if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
      const allowed = new Set(matcher.split("|"))
      return (target) => allowed.has(target)
    }
  } else if (/^[A-Za-z0-9_\-,| ]+$/.test(matcher)) {
    const allowed = new Set(matcher.split(/[|,]/).map((part) => part.trim()))
    return (target) => allowed.has(target)
  }
  return compileRegex(matcher, event)
}

/**
 * Match a string (typically tool name) against a CC matcher pattern.
 * Supports: exact, pipe list, regex, wildcard "*"/empty.
 *
 * For non-tool events (Stop, PreCompact, etc.) callers pass empty target;
 * matcher should usually be undefined/"*" in those configs.
 */
export function matches(matcher: string | undefined, target: string, event?: HookEvent): boolean {
  return compileMatcher(matcher, event)(target)
}
/**
 * Decide which target string to feed the matcher for a given event (Claude
 * Code matcher table). Tool-bound events match `tool_name`; lifecycle events
 * match their event-specific field. `undefined` means the event has no matcher
 * support here, so any matcher is ignored and every group runs (CC behavior).
 */
export function canonicalToolName(payload: HookPayload, ctx: TriggerContext): string | undefined {
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
    case "PermissionDenied":
      return ctx.canonicalToolName ?? claudeTools.get(payload.toolName.toLowerCase())?.name
    default:
      return undefined
  }
}

export function matcherTargets(payload: HookPayload, ctx: TriggerContext): string[] | undefined {
  const target = matcherTarget(payload, ctx)
  if (target === undefined) return undefined
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
    case "PermissionDenied":
      // The official name is primary; the native id keeps existing native matchers working.
      return [
        ...new Set([target, payload.toolName, ...(claudeTools.get(payload.toolName.toLowerCase())?.aliases ?? [])]),
      ]
    default:
      return [target]
  }
}

function matcherTarget(payload: HookPayload, ctx: TriggerContext): string | undefined {
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
    case "PermissionDenied":
      return ctx.canonicalToolName ?? claudeTools.get(payload.toolName.toLowerCase())?.name ?? payload.toolName
    case "UserPromptExpansion":
      return payload.commandName
    case "PreModelSwitch":
    case "PostModelSwitch":
      return canonicalModelMatcherName(payload.toModel)
    case "ConfigChange":
      return payload.source ?? ""
    case "DirectoryAdded":
      return payload.source
    case "InstructionsLoaded":
      return payload.loadReason ?? ""
    case "StopFailure":
      return payload.error
    case "SessionStart":
      return payload.source
    case "SessionEnd":
      return payload.reason
    case "PreCompact":
    case "PostCompact":
      return payload.trigger ?? ""
    case "Notification":
      return payload.notificationType ?? ""
    case "SubagentStart":
    case "SubagentStop":
      return payload.agentType ?? ""
    case "Setup":
      return payload.trigger
    case "FileChanged":
      return payload.path ? path.basename(payload.path) : ""
    case "Elicitation":
    case "ElicitationResult":
      return payload.serverName ?? ""
    default:
      return undefined
  }
}

/**
 * Claude model aliases, dated IDs and provider-qualified IDs converge on the
 * same matcher name. Non-Claude/custom IDs have no trustworthy canonical name,
 * so the caller leaves the matcher unfiltered as the reference requires.
 */
function canonicalModelMatcherName(raw: string): string | undefined {
  const name = raw.replace(/\[1m\]$/i, "")
  const match = name.match(/(?:^|[./:@])claude-(opus|sonnet|haiku)-(\d+)(?:[.@-](\d+))?(?=$|[-./:@])/i)
  if (!match) return undefined
  const minor = match[3]
  // An 8-digit date (claude-sonnet-4-20250514) and the ".0" alias minor
  // (claude-sonnet-4.0) name the same undated model; keeping either would make
  // an exact canonical matcher silently miss the switch.
  const keepMinor = minor !== undefined && minor !== "0" && !/^\d{8}$/.test(minor)
  return `claude-${match[1].toLowerCase()}-${match[2]}${keepMinor ? `-${minor}` : ""}`
}
export const claudeTools = new Map<
  string,
  { name: string; aliases?: readonly string[]; fields: readonly (readonly [string, string])[] }
>([
  ["apply_patch", { name: "Edit", aliases: ["Write"], fields: [] }],
  ["patch", { name: "Edit", aliases: ["Write"], fields: [] }],
  ["multiedit", { name: "Edit", aliases: ["Write"], fields: [["filePath", "file_path"]] }],
  ["bash", { name: "Bash", fields: [] }],
  ["grep", { name: "Grep", fields: [["include", "glob"]] }],
  ["glob", { name: "Glob", fields: [] }],
  ["task", { name: "Agent", fields: [] }],
  ["webfetch", { name: "WebFetch", fields: [] }],
  ["websearch", { name: "WebSearch", fields: [] }],
  ["question", { name: "AskUserQuestion", fields: [] }],
  ["skill", { name: "Skill", fields: [] }],
  ["todowrite", { name: "TodoWrite", fields: [] }],
  ["workflow", { name: "Workflow", fields: [] }],
  ["read", { name: "Read", fields: [["filePath", "file_path"]] }],
  ["write", { name: "Write", fields: [["filePath", "file_path"]] }],
  [
    "edit",
    {
      name: "Edit",
      fields: [
        ["filePath", "file_path"],
        ["oldString", "old_string"],
        ["newString", "new_string"],
        ["replaceAll", "replace_all"],
      ],
    },
  ],
])

export function translateClaudeInput(toolName: string, input: object, toClaude: boolean, originalInput?: unknown) {
  const fields = claudeTools.get(toolName.toLowerCase())?.fields
  const result: Record<string, unknown> = { ...input }
  for (const [field, claude] of fields ?? []) {
    // Core/V2 file tools use path; legacy tools use filePath. Return rewrites
    // in the calling tool's native shape, inferred from its validated input.
    const original = toClaude ? input : originalInput
    const native =
      field === "filePath" &&
      isRecord(original) &&
      Object.hasOwn(original, "path") &&
      !Object.hasOwn(original, "filePath")
        ? "path"
        : field
    if (toClaude) {
      if (result[claude] == null && result[native] !== undefined) result[claude] = result[native]
    } else if (Object.hasOwn(result, claude)) {
      result[native] = result[claude]
      delete result[claude]
    }
  }
  if (toClaude && ["apply_patch", "patch", "multiedit"].includes(toolName.toLowerCase())) {
    const files = new Set(patchFilePaths(result.patchText ?? result.patch))
    if (typeof result.file_path === "string") files.add(result.file_path)
    if (Array.isArray(result.edits)) {
      for (const edit of result.edits) {
        if (!isRecord(edit)) continue
        const file = edit.file_path ?? edit.filePath ?? edit.path
        if (typeof file === "string") files.add(file)
      }
    }
    if (files.size) {
      result.file_paths = [...files]
      result.file_path ??= [...files][0]
    }
  }
  return result
}
