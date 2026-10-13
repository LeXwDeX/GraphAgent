/**
 * Settings-based hooks with Claude Code-compatible envelopes and explicit runtime support.
 *
 * Reads hooks from a dedicated hooks.json chain (later layers concat-append on
 * top of earlier ones, mirroring Claude Code's merge semantics — hooks
 * accumulate, they do not replace):
 *
 *   1. ~/.config/opencode/hooks.json            (global, hot-reloaded)
 *   2. <project>/.opencode/hooks.json           (project, hot-reloaded)
 *   3. <worktree>/.opencode/hooks.json          (worktree, hot-reloaded, when ≠ project)
 *
 * `.claude/` directories are NOT read for hooks (complete cut); a leftover
 * `hooks` field in OpenCode-owned settings.json files triggers a one-time
 * deprecation warning pointing at /import-claude-hooks (hooks there are ignored).
 *
 * Supports the Claude Code hook event surface at the protocol/schema layer.
 *
 * Hook entry types:
 *   - { type: "command", command: "<shell>", timeout?: <seconds> }
 *   - { type: "mcp",     command: "mcp__<server>__<tool>", timeout?: <seconds> }
 *   - { type: "http",    url: "<url>", command?: "<legacy-url>", timeout?: <seconds> }
 *   - { type: "prompt",  prompt: "<llm-system-prompt>", command?: "<legacy-prompt>", timeout?: <seconds> }
 *   - { type: "agent",   prompt: "<llm-task-prompt>", command?: "<legacy-prompt>", timeout?: <seconds> }
 *
 * stdin JSON envelope per Claude Code spec:
 *   { hook_event_name, session_id, transcript_path, cwd, ...event-specific }
 *
 * stdout control JSON (any subset):
 *   { continue, stopReason, suppressOutput, systemMessage,
 *     decision: "approve"|"block", reason,
 *     hookSpecificOutput: { hookEventName, permissionDecision,
 *                            permissionDecisionReason, additionalContext,
 *                            updatedInput } }
 *
 * Exit code semantics (CC spec):
 *   0  → allow, parse stdout
 *   2  → block, stderr → reason
 *   *  → log warning, do NOT abort main flow (mirrors fork commit 0f3017f33a)
 */
import path from "path"
import os from "os"
import { existsSync, readFileSync } from "fs"
import { spawn } from "child_process"
import { createHash } from "crypto"
import { Effect, Layer, Context, Option, Scope, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { HookCommandSchema, HookOutputSchema } from "./schema"
import { generateObject, generateText, type ModelMessage } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { buildAgentTools } from "./agent-tools"
import { SessionHooks } from "./session-hooks"
import type { SessionHookEntry } from "./session-hooks"
import { SessionID } from "@/session/schema"
import { HookRewake } from "./rewake"
import { EffectBridge } from "@/effect/bridge"
import { buildForkHooks, watchSettings } from "./extensions" // [FORK:hook-ext]
import { isTrusted, trustFilePath } from "./workspace-trust" // [FORK:hook-ext] WP-6B

const log = Log.create({ service: "hook.settings" })

// ── Hook protocol types ────────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "PermissionDenied"
  | "Setup"
  | "Stop"
  | "StopFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "SessionStart"
  | "SessionEnd"
  | "TaskCreated"
  | "TaskCompleted"
  | "Elicitation"
  | "ElicitationResult"
  | "ConfigChange"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "InstructionsLoaded"
  | "CwdChanged"
  | "FileChanged"

// Runtime set of valid hook event names (for filtering non-event keys in hooks.json)
export const VALID_HOOK_EVENTS = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
])

export interface HookCommand {
  /**
   * Hook execution kind. All 5 types fully implemented:
   * - `command`: shell command via stdin/stdout JSON envelope
   * - `mcp`: invoke MCP tool via `mcp__<server>__<tool>` prefix
   * - `http`: POST envelope to URL, parse JSON body
   * - `prompt`: LLM call with structured output (HookJSONOutput schema)
   * - `agent`: autonomous agent loop with bash/read_file/list_dir/grep tools
   */
  type: "command" | "mcp" | "http" | "prompt" | "agent"
  command?: string
  /** Claude Code `type:"http"` endpoint. Legacy configs may still use `command`. */
  url?: string
  /** Claude Code `type:"prompt" | "agent"` prompt. Legacy configs may still use `command`. */
  prompt?: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  timeout?: number
  statusMessage?: string
  once?: boolean
  /**
   * Explicit interpreter for command hooks. When omitted, preserve the platform
   * default (/bin/sh on POSIX, cmd.exe on Windows). The interpreter must be installed.
   */
  shell?: "bash" | "powershell"
  /** Command-only naming adapter. Omitted or opencode preserves native tool ids and arguments. */
  inputFormat?: "opencode" | "claude-code"
  /**
   * Conditional gate, evaluated by `extensions/condition-filter.ts` in
   * `ForkHooks.beforeRunEntry` BEFORE each matched entry runs (returning false
   * skips the entry). Syntax:
   *   - `ToolName(pattern)` — e.g. `Bash(npm install *)`, `Edit(*.ts)`; the tool
   *     name is matched case-insensitively and the pattern against the tool's
   *     primary argument with Claude Code permission-rule semantics (Bash→each
   *     subcommand, `*` spans anything; Edit/Write/Read→gitignore-like path
   *     matching relative to the project root).
   *   - `*`, empty, or undefined — always matches (no filtering).
   * For NON-tool events (UserPromptSubmit, Stop, SessionStart, …) the condition
   * is ignored and always matches (CC behavior). A malformed condition (not
   * `ToolName(...)`) also fails open to true.
   */
  if?: string
  /**
   * Async execution flag. When true, the hook is forked into a background fiber
   * scoped to the SettingsHook service; its output never participates in the
   * current trigger's TriggerResult (no permissionDecision, blocked, etc. — the
   * decision point has already passed by the time it completes). Background
   * fibers die with the process; there is no durable persistence across crashes.
   * Pair with `asyncRewake` to deliver the result back to the agent.
   */
  async?: boolean
  /**
   * Companion to `async`: when an async hook completes with rewake-worthy output
   * (exit code 2 stderr, `systemMessage`, `decision:"block"` reason, or
   * `additionalContext`), a synthetic steer prompt wrapping the output in a
   * `<system-reminder>` is admitted to the originating session, re-waking the agent.
   * Without `async`, this field is inert (the hook runs synchronously as usual).
   * Rewake is suppressed for `SessionEnd` and when no `sessionID` is available.
   */
  asyncRewake?: boolean
  /**
   * Fork superset (CC has no equivalent). When present, each entry is exported into the hook
   * subprocess env as `CLAUDE_PLUGIN_OPTION_<KEY>=JSON.stringify(value)`.
   */
  options?: Record<string, unknown>
  /**
   * Runtime metadata injected by `loadChain` — absolute directory of the settings file that
   * declared this hook. Drives `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`. The `__` prefix
   * keeps it out of any future schema-validation pass.
   */
  __sourceDir?: string
}

interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

export interface Settings {
  hooks?: Partial<Record<HookEvent, HookMatcher[]>>
  /**
   * Opt-in enforcement of the workspace-trust gate (WP-6B). When `true` (any
   * layer in the chain), `SettingsHook.trigger` silently skips ALL hooks for a
   * working directory that is not on the trust list, unless `allowUntrusted` is
   * also set. Read from the top-level `requireTrust` key of a hooks.json. Also
   * enabled by env `OPENCODE_HOOKS_REQUIRE_TRUST=1`. Default false → zero gate.
   */
  requireTrust?: boolean
  /**
   * Escape hatch for the workspace-trust gate. Only honored from the GLOBAL
   * hooks.json layer (`~/.config/opencode/hooks.json`): project / worktree
   * hooks.json files are controlled by the (potentially untrusted) repository
   * itself, so letting them declare `allowUntrusted: true` would let a
   * malicious repo bypass the very gate meant to contain it. `readChain`
   * strips the field from non-global layers with a log.warn.
   */
  allowUntrusted?: boolean
}

/**
 * Read-only render DTO for the dynamic Active Hooks system-prompt block.
 * One entry per individual hook command across the merged chain, tagged with
 * the layer it came from. Produced by `summarizeChain` and surfaced via
 * `SettingsHook.list()` — never re-reads files (reads from hot-reloaded state).
 */
export interface HookSummary {
  event: HookEvent
  scope: "global" | "project" | "worktree"
  type: HookCommand["type"]
  descriptor: string
  matcher?: string
}

export interface HookJSONOutput {
  continue?: boolean
  stopReason?: string
  /**
   * Schema-accepted no-op (WP-5C). Fork does not render hook stdout to UI by
   * default — `suppressOutput=true` is fork's default behavior, and
   * `suppressOutput=false` would require new fork capability ("show hook
   * stdout in UI") whose value is reverse to its cost. Field reserved for CC
   * schema compatibility only; no runtime processing.
   */
  suppressOutput?: boolean
  systemMessage?: string
  decision?: "approve" | "block"
  reason?: string
  hookSpecificOutput?: HookSpecificOutput
}

// ── Async rewake (hook-async-rewake) ───────────────────────────
// Sentinel prefix for rewake prompts. UserPromptSubmit hook processing skips
// prompts whose text starts with this prefix, preventing hook → rewake → hook
// loops. The prefix must match the opening of buildRewakePrompt exactly.
export const HOOK_REWAKE_SENTINEL = "<system-reminder>\nAsync hook completed"

function buildRewakePrompt(entry: HookCommand, event: HookEvent, content: string): string {
  const cmd = descriptorFor(entry)
  return `${HOOK_REWAKE_SENTINEL} (command: ${cmd}, event: ${event}):\n${content}\n</system-reminder>`
}

/**
 * hookSpecificOutput discriminated union — Claude Code 1:1.
 * 仅 5 个事件有 union 分支；Stop / SubagentStop / PreCompact / SessionEnd
 * 在 CC types/hooks.ts:50-166 中无对应 case，仅消费顶层字段（continue/decision/reason 等）。
 *
 * 所有字段保持 optional 以便解析端宽松降级。`hookEventName` 用作 discriminator。
 * 最后一个 fallback 分支让消费端 cast 时不会因为 hookEventName 未列出（或拼错）而报错。
 */
export type HookSpecificOutput =
  | {
      hookEventName: "PreToolUse"
      permissionDecision?: "allow" | "deny" | "ask"
      permissionDecisionReason?: string
      updatedInput?: Record<string, unknown>
      additionalContext?: string
    }
  | {
      hookEventName: "UserPromptSubmit"
      additionalContext?: string
    }
  | {
      hookEventName: "SessionStart"
      additionalContext?: string
      initialUserMessage?: string
      watchPaths?: string[]
    }
  | {
      hookEventName: "PostToolUse"
      additionalContext?: string
      updatedMCPToolOutput?: unknown
    }
  | {
      hookEventName: "PostToolUseFailure"
      additionalContext?: string
    }
  | {
      hookEventName: "PermissionRequest"
      permissionDecision?: "allow" | "deny" | "ask"
      permissionDecisionReason?: string
      additionalContext?: string
    }
  | {
      hookEventName: "PermissionDenied"
      additionalContext?: string
    }
  | {
      hookEventName: "Notification"
      additionalContext?: string
    }
  | {
      hookEventName: "Setup" | "SubagentStart"
      additionalContext?: string
    }
  | {
      hookEventName: "PostCompact"
      additionalContext?: string
      displayMessage?: string
      compactSummary?: string
      customSummary?: string
    }
  | {
      /**
       * Fallback — accept future / unknown event names without crashing the parser.
       * NO index signature here: an `[key: string]: unknown` would poison every other
       * branch's narrowed property types into `unknown`.
       */
      hookEventName?: string
    }

/** Per-event payload — discriminated union, TS narrows automatically. */
export type HookPayload =
  | {
      event: "PreToolUse"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
    }
  | {
      event: "PostToolUse"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      toolResponse: unknown
    }
  | {
      event: "PostToolUseFailure"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      error: string
      isInterrupt?: boolean
    }
  | {
      event: "PermissionRequest"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      permissionSuggestions?: string[]
    }
  | {
      event: "PermissionDenied"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      reason: string
    }
  | { event: "Notification"; message: string; title?: string; notificationType?: string }
  | { event: "UserPromptSubmit"; prompt: string }
  | { event: "Stop"; stopHookActive: boolean; lastAssistantMessage?: string }
  | { event: "StopFailure"; stopHookActive: boolean; error: string; lastAssistantMessage?: string }
  | { event: "SubagentStart"; agentID: string; agentType: string }
  | {
      event: "SubagentStop"
      stopHookActive: boolean
      agentID?: string
      agentTranscriptPath?: string
      agentType?: string
      lastAssistantMessage?: string
    }
  | {
      event: "PreCompact"
      trigger: "manual" | "auto"
      customInstructions?: string
    }
  | {
      event: "PostCompact"
      trigger?: "manual" | "auto"
      compactSummary?: string
      customInstructions?: string
    }
  | {
      event: "SessionStart"
      source: "startup" | "resume" | "clear" | "compact"
      model?: string
      agentType?: string
    }
  | {
      event: "SessionEnd"
      reason: "clear" | "delete" | "logout" | "prompt_input_exit" | "other"
    }
  | { event: "Setup"; trigger: string }
  | { event: "TaskCreated"; taskID?: string; taskTitle?: string; taskDescription?: string }
  | { event: "TaskCompleted"; taskID?: string; taskTitle?: string; result?: unknown }
  | { event: "Elicitation"; prompt?: string; schema?: unknown }
  | { event: "ElicitationResult"; result?: unknown; cancelled?: boolean }
  | { event: "ConfigChange"; configPath?: string; changes?: unknown }
  | { event: "WorktreeCreate"; path?: string; branch?: string }
  | { event: "WorktreeRemove"; path?: string; branch?: string }
  | { event: "InstructionsLoaded"; path?: string; content?: string }
  | { event: "CwdChanged"; oldCwd?: string; newCwd?: string }
  | { event: "FileChanged"; path?: string; changeType?: string }

// Intentional CC-envelope differences (hooks-api-fidelity): these fields are
// accepted for schema compatibility but deliberately not populated beyond what
// is documented here, and are NOT bugs:
//   - `transcript_path`: always "" — this fork has no transcript-file export, so
//     there is no path to surface (callers pass transcriptPath: "").
//   - `permission_mode`: only "plan" | "default" via agentToPermissionMode;
//     acceptEdits / bypassPermissions have no fork equivalent and are omitted
//     rather than fabricated.
//   - SessionStart `source` covers only "startup" here; resume/clear/compact have
//     no distinct entry points in this fork (see openspec hooks-api-fidelity 2.1).
//   - matcher matching is case-INsensitive here (CC is case-sensitive). A matcher
//     like `Write` also matches a `write` tool call. Documented deviation, not a bug.
export interface TriggerContext {
  sessionID: string
  /** Absolute path to a transcript file. Intentionally always "" in this fork — no transcript export exists. */
  transcriptPath: string
  /** CC envelope: "plan" | "default"（fork 通过 agentToPermissionMode 映射 agent name 得出）。其他模式（acceptEdits/bypassPermissions）fork 暂不支持。 */
  permissionMode?: string
  /** CC envelope: subagent ID（仅 SubagentStop / 子 agent 上下文有值）*/
  agentID?: string
  /** CC envelope: subagent type 名称 */
  agentType?: string
  /**
   * Mark this trigger as running in a sub-agent context (parentID set on the
   * underlying session). When true, an incoming `event: "Stop"` payload is
   * routed to **SubagentStop**-registered session hooks instead of Stop ones,
   * matching CC's lifecycle semantics. Only affects the SessionHookStore lookup;
   * the on-disk settings chain is still indexed by `payload.event` verbatim
   * (callers like task.ts already explicitly fire SubagentStop, so settings-side
   * routing was already correct before WP-5D).
   */
  isSubAgent?: boolean
}

// `TriggerResult` and `landSystemMessages` live in `./trigger-result` (a
// cycle-free leaf). Re-exported here so existing `SettingsHook.*` /
// `import { type TriggerResult } from "@/hook/settings"` call sites keep
// working. See trigger-result.ts for the cycle rationale.
import type { TriggerResult } from "./trigger-result"
export type { TriggerResult } from "./trigger-result"
export { landSystemMessages } from "./trigger-result"

/**
 * Hard cap on how many times a blocked Stop / SubagentStop hook may drive another
 * model turn. Guards against a misbehaving hook that ignores `stop_hook_active`
 * (which would otherwise loop forever burning tokens). Shared by the main agent
 * Stop path (prompt.ts) and the SubagentStop path (task.ts).
 */
export const MAX_STOP_CONTINUATIONS = 5

// ── [FORK:hook-ext] Extension callback interface ────────────────
//
// All fork-specific hook processing plugs in here. settings.ts calls
// these at well-defined points; implementations live in hook/extensions/
// and are wired in the Effect layer.
//
// INVARIANT: Every field is optional. When undefined, behavior is
// identical to upstream. This ensures forward-compat — if upstream
// adds new hook features, they flow through without touching extensions.
export interface ForkHooks {
  /**
   * Called BEFORE runEntry() for each matched hook entry.
   * Return false to skip this entry (e.g., `if` condition not met).
   * Return true (or undefined) to proceed.
   *
   * INTENT: Centralized pre-dispatch filtering for condition-filter,
   * future rate-limiting, logging, etc.
   */
  readonly beforeRunEntry?: (entry: HookCommand, envelope: Record<string, unknown>, event: HookEvent) => boolean

  /**
   * Called AFTER runEntry() for each executed hook entry.
   * Receives the handler result. Used for post-dispatch tracking
   * (batch counting, metrics, etc.).
   *
   * INTENT: Centralized post-dispatch observation. Never modifies
   * the result — that's the trigger reducer's job.
   */
  readonly afterRunEntry?: (
    entry: HookCommand,
    envelope: Record<string, unknown>,
    event: HookEvent,
    result: { json?: HookJSONOutput; exitBlock?: string },
  ) => void
}

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

/**
 * Per-plugin data directory layout (CC plugin contract):
 *   <Global.Path.data>/hooks/<parentBasename>-<basename>-<sha256(sourceDir).slice(0,6)>
 *
 * Hash suffix disambiguates two plugins whose paths happen to share the same
 * `<parent>/<basename>` tail (e.g. installed under different roots).
 */
function computeDataDir(sourceDir: string): string {
  const hash = createHash("sha256").update(sourceDir).digest("hex").slice(0, 6)
  const parent = path.basename(path.dirname(sourceDir))
  const base = path.basename(sourceDir)
  return path.join(Global.Path.data, "hooks", `${parent}-${base}-${hash}`)
}

/**
 * Expand CC-compatible template variables in `entry.command`.
 *
 *   ${CLAUDE_PLUGIN_ROOT}  → entry.__sourceDir
 *   ${CLAUDE_PLUGIN_DATA}  → computeDataDir(entry.__sourceDir)
 *   ${user_config.<key>}   → entry.options?.[key] (string passthrough; non-string → JSON.stringify)
 *
 * Unknown / unresolvable templates are left verbatim so the shell's own env
 * expansion (or the user's escape strategy) still has a chance to handle them.
 * Read-only: never mutates `entry`.
 */
function expandCommand(entry: HookCommand): string {
  return commandText(entry).replace(/\$\{([^}]+)\}/g, (full, key) => {
    if (key === "CLAUDE_PLUGIN_ROOT" && entry.__sourceDir) return entry.__sourceDir
    if (key === "CLAUDE_PLUGIN_DATA" && entry.__sourceDir) return computeDataDir(entry.__sourceDir)
    if (key.startsWith("user_config.")) {
      const optKey = key.slice("user_config.".length)
      const v = entry.options?.[optKey]
      if (v !== undefined) return typeof v === "string" ? v : JSON.stringify(v)
    }
    return full
  })
}

function commandText(entry: HookCommand): string {
  return entry.command ?? ""
}

function httpUrl(entry: HookCommand): string {
  return entry.url ?? entry.command ?? ""
}

function httpHeaders(entry: HookCommand): Record<string, string> {
  if (entry.allowedEnvVars === undefined) return entry.headers ?? {}
  const allowed = new Set(entry.allowedEnvVars ?? [])
  return Object.fromEntries(
    Object.entries(entry.headers ?? {}).map(([name, value]) => [
      name,
      value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
        const key = braced ?? bare
        return allowed.has(key) ? (process.env[key] ?? "") : ""
      }),
    ]),
  )
}

function promptText(entry: HookCommand): string {
  return entry.prompt ?? entry.command ?? ""
}

/**
 * Short human-readable description of a hook entry for the Active Hooks block.
 * All types are uniformly truncated to 60 chars: command → command text,
 * http → URL, mcp → tool name, prompt/agent → first line of the prompt/goal.
 */
function descriptorFor(entry: HookCommand): string {
  switch (entry.type) {
    case "command":
      return commandText(entry).slice(0, 60)
    case "http":
      return httpUrl(entry).slice(0, 60)
    case "mcp":
      return commandText(entry).slice(0, 60)
    case "prompt":
    case "agent":
      return promptText(entry).split("\n")[0].slice(0, 60)
    default:
      return commandText(entry).slice(0, 60)
  }
}

// ── Matcher ─────────────────────────────────────────────────────

/**
 * Match a string (typically tool name) against a CC matcher pattern.
 * Supports: exact, pipe list, regex, wildcard "*"/empty.
 *
 * For non-tool events (Stop, PreCompact, etc.) callers pass empty target;
 * matcher should usually be undefined/"*" in those configs.
 */
function matches(matcher: string | undefined, target: string): boolean {
  if (!matcher || matcher === "*") return true
  const normalized = target.toLowerCase()

  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher
        .split("|")
        .map((p) => p.trim().toLowerCase())
        .includes(normalized)
    }
    return normalized === matcher.toLowerCase()
  }

  try {
    return new RegExp(matcher, "i").test(target)
  } catch {
    log.warn("invalid regex in hook matcher", { matcher })
    return false
  }
}

// ── Settings loader (hooks.json chain) ──────────────────────────

// Exported for unit testing only; not part of the public surface.
export function readJSON(filepath: string): Settings | null {
  if (!existsSync(filepath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filepath, "utf8"))
    // hooks.json uses top-level event keys; a legacy {"hooks": {...}} wrapper is
    // tolerated (D1 graceful degradation). The wrapper wins when present.
    const obj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
    const rawHooks =
      obj && obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks)
        ? (obj.hooks as Record<string, unknown>)
        : obj

    const hooks: Settings["hooks"] = {}
    const sourceDir = path.dirname(filepath)
    if (rawHooks) {
      for (const [key, value] of Object.entries(rawHooks)) {
        if (!VALID_HOOK_EVENTS.has(key)) continue
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
        hooks[key as HookEvent] = groups
      }
    }
    log.info("loaded hook settings", {
      path: filepath,
      events: Object.keys(hooks),
    })
    // Top-level `requireTrust` (WP-6B enforcement opt-in) and `allowUntrusted`
    // (per-layer gate escape hatch) — booleans on the hooks.json root, not
    // under `hooks`. Propagated through mergeSettings so any layer turning
    // either on enables it chain-wide.
    const requireTrust = typeof obj?.requireTrust === "boolean" ? obj.requireTrust : undefined
    const allowUntrusted = typeof obj?.allowUntrusted === "boolean" ? obj.allowUntrusted : undefined
    return {
      hooks,
      ...(requireTrust !== undefined ? { requireTrust } : {}),
      ...(allowUntrusted !== undefined ? { allowUntrusted } : {}),
    }
  } catch (err) {
    log.error("failed to parse hooks.json", { path: filepath, error: String(err) })
    return null
  }
}

/**
 * Concat-merge hook matchers across layers. Later layers append after earlier
 * ones (matches CC's merge semantics — does NOT replace by matcher key).
 */
// Exported for unit testing only; not part of the public surface.
export function mergeSettings(layers: Settings[]): Settings {
  const out: Settings = { hooks: {} }
  for (const layer of layers) {
    if (!layer.hooks) continue
    for (const [event, matchers] of Object.entries(layer.hooks)) {
      const ev = event as HookEvent
      const acc = (out.hooks![ev] ??= [])
      acc.push(...(matchers ?? []))
    }
  }
  // requireTrust is chain-wide: any layer opting in enables enforcement.
  // allowUntrusted merges the same way here, but readChain strips it from
  // non-global layers before merge — only the global layer's opt-out survives.
  if (layers.some((l) => l.requireTrust === true)) out.requireTrust = true
  if (layers.some((l) => l.allowUntrusted === true)) out.allowUntrusted = true
  return out
}

/**
 * Resolve the OpenCode global config directory. Uses the explicit override
 * when provided (tests), otherwise falls back to `Global.Path.config` with a
 * `~/.config/opencode` default. Shared by chainCandidates and loadChain so
 * the fallback logic exists in exactly one place.
 */
function resolveGlobalConfig(globalConfig?: string): string {
  if (globalConfig) return globalConfig
  try {
    return Global.Path.config
  } catch {
    return path.join(os.homedir(), ".config", "opencode")
  }
}

/**
 * Build the hooks.json candidate file list with scope tags. Shared by
 * loadChain (merge) and summarizeChain (scope-tagged summaries) so adding or
 * removing a path layer updates both consumers without a second edit.
 */
function chainCandidates(
  directory: string,
  worktree: string,
  globalConfig?: string,
): Array<{ scope: "global" | "project" | "worktree"; file: string }> {
  const opencodeGlobal = resolveGlobalConfig(globalConfig)
  const candidates: Array<{ scope: "global" | "project" | "worktree"; file: string }> = [
    { scope: "global", file: path.join(opencodeGlobal, "hooks.json") },
    { scope: "project", file: path.join(directory, ".opencode", "hooks.json") },
  ]
  if (worktree && worktree !== directory) {
    candidates.push({ scope: "worktree", file: path.join(worktree, ".opencode", "hooks.json") })
  }
  return candidates
}

/**
 * Single-pass chain load: reads each hooks.json file EXACTLY ONCE and produces
 * both the merged Settings and the scope-tagged HookSummary[] from the same
 * parse. Eliminates the transient-inconsistency window where `loadChain` and
 * `summarizeChain` re-read the same file independently (a file changing between
 * the two reads could yield settings and summary that disagree). `loadChain`
 * and `summarizeChain` are now thin shells over this.
 *
 * `warnUnsupportedFields` runs per-file inside this pass (same as the old
 * `loadChain`), so both shells surface the same warnings.
 */
function readChain(
  directory: string,
  worktree: string,
  globalConfig?: string,
): { settings: Settings; summaries: HookSummary[] } {
  const layers: Settings[] = []
  const summaries: HookSummary[] = []
  for (const { scope, file } of chainCandidates(directory, worktree, globalConfig)) {
    const data = readJSON(file)
    if (!data) continue
    // Trust-gate escape (`allowUntrusted`) is only honored from the global
    // layer. Project / worktree hooks.json are authored by the repository the
    // gate is meant to contain — honoring their opt-out would let an untrusted
    // repo bypass a globally-enforced `requireTrust` by declaring
    // `allowUntrusted: true` in its own .opencode/hooks.json.
    if (scope !== "global" && data.allowUntrusted !== undefined) {
      log.warn("allowUntrusted ignored: only the global hooks.json layer may opt out of the trust gate", {
        file,
        scope,
      })
      data.allowUntrusted = undefined
    }
    warnUnsupportedFields(data.hooks, path.dirname(file))
    layers.push(data)
    if (!data.hooks) continue
    for (const [event, matchers] of Object.entries(data.hooks)) {
      for (const m of matchers ?? []) {
        for (const h of m.hooks ?? []) {
          summaries.push({
            event: event as HookEvent,
            scope,
            type: h.type,
            descriptor: descriptorFor(h),
            ...(m.matcher && m.matcher !== "*" ? { matcher: m.matcher } : {}),
          })
        }
      }
    }
  }
  return { settings: mergeSettings(layers), summaries }
}

/**
 * Produce scope-tagged summaries of the merged hooks chain — one entry per
 * individual hook command, tagged with the layer (global/project/worktree) it
 * came from. Ordering matches loadChain: global first, then project, then
 * worktree. Used by `SettingsHook.list()` so the Active Hooks block reflects
 * live, hot-reloaded state without re-reading files on every call.
 *
 * Exported for unit testing only; not part of the public surface.
 */
export function summarizeChain(directory: string, worktree: string, globalConfig?: string): HookSummary[] {
  return readChain(directory, worktree, globalConfig).summaries
}

// Exported for unit testing only; not part of the public surface.
// `globalConfig` overrides the resolved OpenCode global config dir so tests can
// point it at an isolated temp dir instead of the real ~/.config/opencode.
export function loadChain(directory: string, worktree: string, globalConfig?: string): Settings {
  return loadChainWithSummaries(directory, worktree, globalConfig).settings
}

/**
 * Single-call variant returning both the merged settings and the scope-tagged
 * summaries from ONE pass over the chain files. The SettingsHook layer (initial
 * state + hot-reload callback) uses this instead of calling `loadChain` and
 * `summarizeChain` back-to-back, which would read every hooks.json twice and
 * reopen the transient-inconsistency window `readChain` exists to close.
 */
export function loadChainWithSummaries(
  directory: string,
  worktree: string,
  globalConfig?: string,
): { settings: Settings; summaries: HookSummary[] } {
  const chain = readChain(directory, worktree, globalConfig)

  // Deprecation scan: warn once per OpenCode-owned settings.json that still
  // carries a `hooks` field (D4). Hooks there are NOT loaded — the warning is
  // the only signal. `.claude/` files are never scanned (silent ignore per spec).
  // Lives outside readChain because it reads settings.json (not hooks.json) and
  // is irrelevant to the summary.
  const opencodeGlobal = resolveGlobalConfig(globalConfig)
  for (const fp of deprecatedSettingsPaths(opencodeGlobal, directory, worktree)) {
    warnDeprecatedHooksField(fp)
  }

  return chain
}

/**
 * Tracks OpenCode-owned `settings.json` files whose deprecated `hooks` field has
 * already been flagged. loadChain's deprecation scan warns once per file so a
 * hot-reload (which re-runs loadChain) does not re-warn the same file. The fork's
 * logger is a noop shim, so Set membership is the only observable signal — used
 * by __hasWarnedDeprecated for tests. `.claude/` files are never scanned (silent
 * ignore per spec); only OpenCode-owned settings.json paths are.
 */
const warnedDeprecatedHooks = new Set<string>()

/**
 * OpenCode-owned settings.json paths that previously carried a `hooks` field.
 * `.claude/` is deliberately excluded (silent ignore). Used by the deprecation
 * scan so users who had hooks in settings.json learn they moved to hooks.json.
 */
function deprecatedSettingsPaths(opencodeGlobal: string, directory: string, worktree: string): string[] {
  const paths = [
    path.join(opencodeGlobal, "settings.json"),
    path.join(directory, ".opencode", "settings.json"),
    path.join(directory, ".opencode", "settings.local.json"),
  ]
  if (worktree && worktree !== directory) {
    paths.push(
      path.join(worktree, ".opencode", "settings.json"),
      path.join(worktree, ".opencode", "settings.local.json"),
    )
  }
  return paths
}

/**
 * True when the JSON object at filepath has a non-empty `hooks` field. Parse or
 * missing-file errors return false silently (unreadable deprecated files are not
 * worth warning about). The value is checked for truthiness so an explicit
 * `"hooks": {}` / `"hooks": null` does not trigger a noisy false alarm.
 */
function hasHooksField(filepath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filepath, "utf8"))
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "hooks" in parsed &&
      Boolean((parsed as { hooks?: unknown }).hooks)
    )
  } catch {
    return false
  }
}

/**
 * One-time-per-file deprecation warning for a `hooks` field left in an old
 * settings.json. Tracked via warnedDeprecatedHooks so hot-reload (which re-runs
 * loadChain) does not re-warn. The logger is a noop shim in this fork, so Set
 * membership is the observable signal consumed by __hasWarnedDeprecated.
 */
function warnDeprecatedHooksField(filepath: string): void {
  if (warnedDeprecatedHooks.has(filepath) || !existsSync(filepath)) return
  if (!hasHooksField(filepath)) return
  log.warn(
    `hooks field found in ${filepath} — hooks are now loaded from hooks.json. Run /import-claude-hooks to migrate.`,
  )
  warnedDeprecatedHooks.add(filepath)
}

/**
 * @internal Test-only: whether a settings.json path was flagged as carrying a
 * deprecated `hooks` field during loadChain's deprecation scan.
 */
export function __hasWarnedDeprecated(filepath: string): boolean {
  return warnedDeprecatedHooks.has(filepath)
}

/**
 * @internal Test-only: reset the deprecation tracking so each test starts from a
 * clean warning state.
 */
export function __resetDeprecatedWarnings(): void {
  warnedDeprecatedHooks.clear()
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
 * Warn about fields supplied to a handler type that cannot use them.
 */
export function warnUnsupportedFields(hooks: Settings["hooks"], sourceDir: string): void {
  const unsupported = detectUnsupportedFields(hooks)
  if (unsupported.length > 0) {
    log.warn("hook settings contains fields ignored by this handler type", {
      sourceDir,
      unsupported,
    })
  }
}

// ── Shell command runner ────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000 // CC default

// #500: after the child exits (or the spawn timeout SIGTERMs it), stdio EOF is
// given this grace before the whole process group is SIGKILLed; DRAIN_MS is
// the post-kill window for final buffered output before resolving partial.
const KILL_GRACE_MS = 2_000
const DRAIN_MS = 500

function execShell(
  entry: HookCommand,
  stdinJSON: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "" })
      return
    }
    const timeoutMs = entry.timeout ? entry.timeout * 1000 : DEFAULT_TIMEOUT_MS
    const shell =
      entry.shell === "powershell"
        ? process.platform === "win32"
          ? "powershell.exe"
          : "pwsh"
        : entry.shell === "bash"
          ? process.platform === "win32"
            ? "bash.exe"
            : "/bin/bash"
          : process.platform === "win32"
            ? true
            : "/bin/sh"
    const expandedCommand = expandCommand(entry)

    const command = commandText(entry)
    log.debug("hook spawn", { command: command.slice(0, 200), cwd, timeoutMs })

    // WP-6C: plugin-directory liveness pre-check.
    // When __sourceDir is stamped but the directory has since been GC'd
    // (plugin uninstalled, repo cleaned, etc.) the expanded command would
    // either fail at exec time with exit-127 or — worse — silently run a
    // partial template. Treat the missing dir as "plugin no longer available"
    // and silent-allow rather than letting the shell turn it into a misleading
    // exit-2 deny. spawnError stays undefined so the trigger reducer keeps
    // the same allow path it already uses for spawnError-set entries.
    if (entry.__sourceDir && !existsSync(entry.__sourceDir)) {
      log.warn("hook plugin sourceDir missing — silent allow", {
        command,
        sourceDir: entry.__sourceDir,
      })
      resolve({ exitCode: 0, stdout: "", stderr: "" })
      return
    }

    const extraEnv: Record<string, string> = { CLAUDE_PROJECT_DIR: cwd }
    if (entry.__sourceDir) {
      extraEnv.CLAUDE_PLUGIN_ROOT = entry.__sourceDir
      extraEnv.CLAUDE_PLUGIN_DATA = computeDataDir(entry.__sourceDir)
    }
    if (entry.options) {
      for (const [k, v] of Object.entries(entry.options)) {
        const key = "CLAUDE_PLUGIN_OPTION_" + k.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()
        extraEnv[key] = JSON.stringify(v)
      }
    }

    // POSIX: run the child as a process-group leader so a hung grandchild
    // holding the stdio pipes can be signaled as a group (#500). Windows
    // relies on `taskkill /T` tree kill instead.
    const child = spawn(expandedCommand, [], {
      cwd,
      shell,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => (stdout += d))
    child.stderr.on("data", (d: string) => (stderr += d))

    // EPIPE on stdin must not crash the host process (fork commit 0f3017f33a)
    child.stdin.on("error", (err) => {
      log.warn("hook stdin error", { command, error: err.message })
    })

    try {
      child.stdin.write(stdinJSON + "\n", "utf8")
      child.stdin.end()
    } catch (err) {
      log.warn("hook stdin write failed", { command, error: String(err) })
    }

    // #500: `close` only fires after BOTH exit and stdio EOF; a grandchild
    // that inherits the pipes and outlives the shell blocks EOF forever, so
    // the old `close` waiter never resolved. Exit and stream EOF are now
    // awaited as independent conditions, with a process-group SIGKILL as the
    // fallback that guarantees resolution.
    let exitCode: number | null = null
    let timedOut = false
    let settled = false
    const timers = new Set<NodeJS.Timeout>()
    const arm = (fire: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!settled) fire()
      }, ms)
      timers.add(timer)
    }
    const exited = new Promise<void>((resolveExit) => {
      child.on("exit", (code) => {
        exitCode = code
        resolveExit()
      })
    })
    // `end` alone is not enough: on spawn failure the streams can close or
    // error without ever reaching EOF.
    const streamSettled = (stream: NodeJS.ReadableStream) =>
      new Promise<void>((resolveStream) => {
        stream.on("end", resolveStream)
        stream.on("close", resolveStream)
        stream.on("error", resolveStream)
      })
    const streamsDone = Promise.all([streamSettled(child.stdout), streamSettled(child.stderr)])
    const finish = (spawnError?: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", afterKill)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      child.stdout.destroy()
      child.stderr.destroy()
      log.debug("hook close", {
        command: command.slice(0, 80),
        exitCode,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
      })
      const code = timedOut || signal.aborted ? null : exitCode
      resolve(
        spawnError === undefined ? { exitCode: code, stdout, stderr } : { exitCode: code, stdout, stderr, spawnError },
      )
    }

    child.on("error", (err) => {
      log.error("hook command failed to spawn", { command, error: err.message })
      finish(err.message)
    })

    let killSent = false
    const killGroup = () => {
      if (killSent || child.pid === undefined) return
      killSent = true
      void Process.killGroupPid(child.pid, "SIGKILL").catch((err) => {
        log.warn("hook process-group kill failed", { command, error: String(err) })
      })
    }
    const afterKill = () => {
      killGroup()
      const drained = new Promise<void>((resolveDrain) => arm(resolveDrain, DRAIN_MS))
      void Promise.all([exited, Promise.race([streamsDone, drained])]).then(() => finish())
    }

    signal.addEventListener("abort", afterKill, { once: true })
    if (signal.aborted) afterKill()

    void Promise.all([exited, streamsDone]).then(() => finish())

    // Child exited but pipes are still open (grandchild holds them): kill the
    // group after the EOF grace, then resolve with whatever was captured.
    void exited.then(() => arm(afterKill, KILL_GRACE_MS))

    // Child ignored the spawn-timeout SIGTERM and never exited: kill the group
    // at the absolute deadline, wait for the reap, then resolve.
    arm(() => {
      timedOut = true
      if (child.pid !== undefined)
        void Process.killGroupPid(child.pid, "SIGTERM").catch((error) => {
          log.warn("hook process-group termination failed", { error: String(error) })
        })
      arm(afterKill, KILL_GRACE_MS)
    }, timeoutMs)
  })
}

function parseStdout(stdout: string, command: string): HookJSONOutput | undefined {
  const trimmed = stdout.trim()
  if (!trimmed || !trimmed.startsWith("{")) {
    if (trimmed) log.info("hook returned plain text", { command, output: trimmed.slice(0, 200) })
    return undefined
  }
  try {
    const parsed = HookOutputSchema.safeParse(JSON.parse(trimmed))
    if (!parsed.success) {
      log.warn("hook returned invalid output shape", { command, error: parsed.error.message })
      return undefined
    }
    return parsed.data as HookJSONOutput
  } catch {
    log.warn("hook returned invalid JSON", { command, output: trimmed.slice(0, 200) })
    return undefined
  }
}

// ── Payload → stdin envelope ────────────────────────────────────

function buildStdinEnvelope(payload: HookPayload, ctx: TriggerContext, cwd: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    hook_event_name: payload.event,
    session_id: ctx.sessionID,
    transcript_path: ctx.transcriptPath,
    cwd,
  }
  // Explicit ctx.permissionMode wins; otherwise derive from agentType so callers only pass agent.
  const permissionMode = ctx.permissionMode ?? (ctx.agentType ? agentToPermissionMode(ctx.agentType) : undefined)
  if (permissionMode) base.permission_mode = permissionMode
  if (ctx.agentID !== undefined) base.agent_id = ctx.agentID
  if (ctx.agentType !== undefined) base.agent_type = ctx.agentType
  switch (payload.event) {
    case "PreToolUse":
      return {
        ...base,
        ...(payload.toolUseID !== undefined ? { tool_use_id: payload.toolUseID } : {}),
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
      }
    case "PostToolUse":
      return {
        ...base,
        ...(payload.toolUseID !== undefined ? { tool_use_id: payload.toolUseID } : {}),
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        tool_response: payload.toolResponse,
      }
    case "PostToolUseFailure":
      return {
        ...base,
        ...(payload.toolUseID !== undefined ? { tool_use_id: payload.toolUseID } : {}),
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        error: payload.error,
        ...(payload.isInterrupt !== undefined ? { is_interrupt: payload.isInterrupt } : {}),
      }
    case "PermissionRequest":
      return {
        ...base,
        ...(payload.toolUseID !== undefined ? { tool_use_id: payload.toolUseID } : {}),
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        ...(payload.permissionSuggestions !== undefined
          ? { permission_suggestions: payload.permissionSuggestions }
          : {}),
      }
    case "PermissionDenied":
      return {
        ...base,
        ...(payload.toolUseID !== undefined ? { tool_use_id: payload.toolUseID } : {}),
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        reason: payload.reason,
      }
    case "Notification":
      return {
        ...base,
        message: payload.message,
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.notificationType !== undefined ? { notification_type: payload.notificationType } : {}),
      }
    case "UserPromptSubmit":
      return { ...base, prompt: payload.prompt }
    case "Stop":
      return {
        ...base,
        stop_hook_active: payload.stopHookActive,
        ...(payload.lastAssistantMessage !== undefined ? { last_assistant_message: payload.lastAssistantMessage } : {}),
      }
    case "StopFailure":
      return {
        ...base,
        stop_hook_active: payload.stopHookActive,
        error: payload.error,
        ...(payload.lastAssistantMessage !== undefined ? { last_assistant_message: payload.lastAssistantMessage } : {}),
      }
    case "SubagentStart":
      return { ...base, agent_id: payload.agentID, agent_type: payload.agentType }
    case "SubagentStop":
      return {
        ...base,
        stop_hook_active: payload.stopHookActive,
        ...(payload.agentID !== undefined ? { agent_id: payload.agentID } : {}),
        ...(payload.agentTranscriptPath !== undefined ? { agent_transcript_path: payload.agentTranscriptPath } : {}),
        ...(payload.agentType !== undefined ? { agent_type: payload.agentType } : {}),
        ...(payload.lastAssistantMessage !== undefined ? { last_assistant_message: payload.lastAssistantMessage } : {}),
      }
    case "PreCompact":
      return {
        ...base,
        trigger: payload.trigger,
        custom_instructions: payload.customInstructions ?? "",
      }
    case "PostCompact":
      return {
        ...base,
        ...(payload.trigger !== undefined ? { trigger: payload.trigger } : {}),
        ...(payload.compactSummary !== undefined ? { compact_summary: payload.compactSummary } : {}),
        ...(payload.customInstructions !== undefined ? { custom_instructions: payload.customInstructions } : {}),
      }
    case "SessionStart":
      return {
        ...base,
        source: payload.source,
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.agentType !== undefined ? { agent_type: payload.agentType } : {}),
      }
    case "SessionEnd":
      return { ...base, reason: payload.reason }
    case "Setup":
      return { ...base, trigger: payload.trigger }
    case "TaskCreated":
      return {
        ...base,
        ...(payload.taskID !== undefined ? { task_id: payload.taskID } : {}),
        ...(payload.taskTitle !== undefined ? { task_title: payload.taskTitle } : {}),
        ...(payload.taskDescription !== undefined ? { task_description: payload.taskDescription } : {}),
      }
    case "TaskCompleted":
      return {
        ...base,
        ...(payload.taskID !== undefined ? { task_id: payload.taskID } : {}),
        ...(payload.taskTitle !== undefined ? { task_title: payload.taskTitle } : {}),
        ...(payload.result !== undefined ? { result: payload.result } : {}),
      }
    case "Elicitation":
      return {
        ...base,
        ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
        ...(payload.schema !== undefined ? { schema: payload.schema } : {}),
      }
    case "ElicitationResult":
      return {
        ...base,
        ...(payload.result !== undefined ? { result: payload.result } : {}),
        ...(payload.cancelled !== undefined ? { cancelled: payload.cancelled } : {}),
      }
    case "ConfigChange":
      return {
        ...base,
        ...(payload.configPath !== undefined ? { config_path: payload.configPath } : {}),
        ...(payload.changes !== undefined ? { changes: payload.changes } : {}),
      }
    case "WorktreeCreate":
    case "WorktreeRemove":
      return {
        ...base,
        ...(payload.path !== undefined ? { path: payload.path } : {}),
        ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
      }
    case "InstructionsLoaded":
      return {
        ...base,
        ...(payload.path !== undefined ? { path: payload.path } : {}),
        ...(payload.content !== undefined ? { content: payload.content } : {}),
      }
    case "CwdChanged":
      return {
        ...base,
        ...(payload.oldCwd !== undefined ? { old_cwd: payload.oldCwd } : {}),
        ...(payload.newCwd !== undefined ? { new_cwd: payload.newCwd } : {}),
      }
    case "FileChanged":
      return {
        ...base,
        ...(payload.path !== undefined ? { path: payload.path } : {}),
        ...(payload.changeType !== undefined ? { change_type: payload.changeType } : {}),
      }
  }
}

/**
 * Decide which target string to feed the matcher for a given event (Claude
 * Code matcher table). Tool-bound events match `tool_name`; lifecycle events
 * match their event-specific field. `undefined` means the event has no matcher
 * support here, so any matcher is ignored and every group runs (CC behavior).
 */
function matcherTarget(payload: HookPayload): string | undefined {
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
    case "PermissionDenied":
      return payload.toolName
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
    default:
      return undefined
  }
}

/**
 * Tool events report fresh feedback per call (e.g. a PostToolUse validator
 * repeating the same lint error), so their additionalContext is deduplicated
 * only within one trigger. Every other event keeps per-session dedup: its
 * context (SessionStart, Stop, …) stays in history after the first injection.
 */
const PER_TRIGGER_DEDUP_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"])

/**
 * Identity of a handler for per-trigger dedup: only fully equivalent handlers
 * run once (CC behavior). Every configured field takes part (headers, env
 * allowlists, options, timeout, `__sourceDir` for plugin/skill copies), plus the
 * expanded command or URL, so handlers that would execute differently all run.
 */
function handlerKey(entry: HookCommand): string {
  const target =
    entry.type === "command" ? expandCommand(entry) : entry.type === "http" ? httpUrl(entry) : commandText(entry)
  return JSON.stringify([target, entry], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

// ── Effect service ──────────────────────────────────────────────

interface StopRewakeChain {
  count: number
}

interface State {
  settings: Settings
  cwd: string
  /**
   * Deduplicated additionalContext strings, bucketed per sessionID. Each
   * session sees every distinct context once; a second session is NOT
   * starved by what the first already saw. The bucket for a session is
   * evicted on SessionEnd (see trigger) so the map does not grow unboundedly
   * across the process lifetime. Headless / no-session triggers collapse to
   * the "" bucket, preserving the prior global-dedup behavior for those.
   */
  seen: Map<string, Set<string>>
  once: Map<string, WeakSet<HookCommand>>
  stopRewakeChains: Map<string, StopRewakeChain>
  /**
   * Scope-tagged summaries of the currently-effective hooks, computed by
   * `summarizeChain` alongside `settings` (same closure, same hot-reload
   * watcher). `list()` reads this without touching files.
   */
  hooksList: HookSummary[]
}

export interface Interface {
  readonly trigger: (payload: HookPayload, ctx: TriggerContext) => Effect.Effect<TriggerResult>
  /**
   * Read-only view of the currently-effective hooks (merged global + project +
   * worktree chain), one entry per hook command tagged with its source layer.
   * Backed by the same hot-reloaded state `trigger` consults — never re-reads
   * files. Empty when no hooks.json layer defines any hook.
   */
  readonly list: () => Effect.Effect<ReadonlyArray<HookSummary>>
  /**
   * Invalidate the pending Stop/SubagentStop/StopFailure rewake chain for a
   * session. SessionPrompt.cancel calls this so a user abort is not overridden
   * by a callback that completes afterwards and rewakes a fresh turn. Optional
   * so partial test mocks stay valid; the real layer always provides it.
   */
  readonly invalidateStopRewakeChain?: (sessionID: SessionID | string) => Effect.Effect<void>
  /**
   * Re-validate a stop-chain token captured at Stop-trigger time. Returns
   * false when the chain has since been invalidated or replaced (session
   * cancel, newer user prompt, SessionEnd, instance dispose). Admission and
   * the run path re-check with this, because invalidation can land after the
   * callback's own completion check. Optional so partial test mocks stay
   * valid; the real layer always provides it.
   */
  readonly validateStopRewakeChain?: (sessionID: SessionID | string, token: unknown) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SettingsHook") {}

// ── HookHandler abstraction (WP-4A) ─────────────────────────────
//
// Each handler owns one HookCommand.type. They return the same
// { json, exitBlock } envelope the trigger aggregator already consumes
// (no semantic shift vs. the prior inlined branches in runEntry).
//
// Handlers do NOT carry CC-protocol aggregation state (dedup, permissionDecision,
// systemMessages) — that stays in trigger's reducer block. inHook is propagated
// to every handler so future agent/http handlers can implement re-entry guards.
//
// mcpSvc dependency: the registry is built inside the layer's Effect.gen
// closure (not at module top-level, not per-trigger). This keeps mcpSvc as
// a captured closure variable instead of a per-call deps parameter — handlers
// stay pure functions of (entry, envelope, cwd, inHook). The table is a
// const inside the layer scope, so future http/prompt/agent handlers can
// register here once they exist.
interface HookHandler<E extends HookCommand = HookCommand> {
  readonly type: E["type"]
  readonly run: (
    entry: E,
    envelope: Record<string, unknown>,
    cwd: string,
    inHook: boolean,
  ) => Effect.Effect<{ json?: HookJSONOutput; exitBlock?: string; rawStdout?: string; exitCode?: number | null }>
}

const claudeTools = new Map<string, { name: string; fields: readonly (readonly [string, string])[] }>([
  ["bash", { name: "Bash", fields: [] }],
  ["grep", { name: "Grep", fields: [["include", "glob"]] }],
  ["glob", { name: "Glob", fields: [] }],
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

function translateClaudeInput(toolName: string, input: object, toClaude: boolean) {
  const fields = claudeTools.get(toolName.toLowerCase())?.fields
  const result: Record<string, unknown> = { ...input }
  for (const [native, claude] of fields ?? []) {
    if (toClaude) {
      if (result[claude] == null && result[native] !== undefined) result[claude] = result[native]
    } else if (Object.hasOwn(result, claude)) {
      result[native] = result[claude]
      delete result[claude]
    }
  }
  return result
}

const commandHandler: HookHandler = {
  type: "command",
  run: Effect.fn("SettingsHook.handler.command")(function* (entry, envelope, cwd, _inHook) {
    // Translate at this entry's command boundary, never the shared native envelope.
    const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : ""
    const claudeTool = entry.inputFormat === "claude-code" ? claudeTools.get(toolName.toLowerCase()) : undefined
    const stdinJSON = JSON.stringify(
      claudeTool
        ? {
            ...envelope,
            tool_name: claudeTool.name,
            tool_input:
              typeof envelope.tool_input === "object" &&
              envelope.tool_input !== null &&
              !Array.isArray(envelope.tool_input)
                ? translateClaudeInput(toolName, envelope.tool_input, true)
                : envelope.tool_input,
          }
        : envelope,
    )
    const { exitCode, stdout, stderr, spawnError } = yield* Effect.promise((signal) =>
      execShell(entry, stdinJSON, cwd, signal),
    )

    if (spawnError) {
      return { json: undefined, exitBlock: undefined }
    }

    // Exit-code 2: block + stderr-as-reason (CC contract)
    if (exitCode === 2) {
      const reason = stderr.trim() || "Hook blocked execution"
      return { exitBlock: reason, exitCode }
    }

    // Other non-zero exits: log and continue (do not abort main flow)
    if (exitCode === null) {
      log.warn("hook command timed out / killed (non-blocking)", {
        command: commandText(entry),
        timeoutMs: entry.timeout ? entry.timeout * 1000 : DEFAULT_TIMEOUT_MS,
      })
    }
    if (exitCode !== 0 && exitCode !== null) {
      log.warn("hook command exited non-zero (non-blocking)", {
        command: commandText(entry),
        exitCode,
        stderr: stderr.trim().slice(0, 200),
      })
    }

    // exit-0 plain-text stdout (non-JSON) is surfaced via rawStdout so the
    // trigger aggregator can inject it as additionalContext for
    // UserPromptSubmit / SessionStart (CC protocol). JSON stdout still parses
    // normally via parseStdout; rawStdout is only consumed when json is null.
    if (exitCode !== 0) return { exitCode }
    const json = parseStdout(stdout, commandText(entry))
    const hso = json?.hookSpecificOutput
    if (claudeTool && envelope.hook_event_name === "PreToolUse" && hso && "updatedInput" in hso && hso.updatedInput)
      hso.updatedInput = translateClaudeInput(toolName, hso.updatedInput, false)
    return { json, rawStdout: stdout, exitCode }
  }),
}

const mcpHandler: HookHandler = {
  type: "mcp",
  run: Effect.fn("SettingsHook.handler.mcp")(function* (entry, envelope, _cwd, _inHook) {
    const mcpSvc = Option.getOrUndefined(yield* Effect.serviceOption(MCP.Service))
    if (!mcpSvc) {
      log.warn("mcp hook skipped: MCP service not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const timeoutMs = entry.timeout ? entry.timeout * 1000 : DEFAULT_TIMEOUT_MS
    const exit = yield* invokeMcpHook(mcpSvc, commandText(entry), envelope).pipe(Effect.timeout(timeoutMs), Effect.exit)
    if (exit._tag === "Failure") {
      log.warn("mcp hook timed out or failed (non-blocking)", {
        command: commandText(entry),
        error: String(exit.cause),
      })
      return { json: undefined, exitBlock: undefined }
    }
    return { json: exit.value, exitBlock: undefined }
  }),
}

/**
 * `type: "http"` handler. Per CC protocol, `entry.command` is the endpoint URL;
 * the envelope is POSTed as JSON with `entry.headers` applied verbatim (auth
 * tokens etc.). 2xx → body parsed via the same parseStdout path as command
 * stdout. Non-2xx → synthetic `exitBlock` so the trigger aggregator surfaces it
 * as a block. Network errors / timeouts → log.warn + silent allow, mirroring
 * commandHandler's spawnError behavior (hooks must never crash the host).
 *
 * Factory takes the resolved HttpClient so the HookHandler.run signature stays
 * `R = never` (the WP-4A interface contract). Captures `http` in closure scope —
 * registered once per layer construction inside the layer's Effect.gen block.
 */
const httpHandler: HookHandler = {
  type: "http",
  run: Effect.fn("SettingsHook.handler.http")(function* (entry, envelope, _cwd, _inHook) {
    const http = Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient))
    if (!http) {
      log.warn("http hook skipped: HttpClient not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const httpRead = withTransientReadRetry(http)
    const timeoutMs = entry.timeout ? entry.timeout * 1000 : DEFAULT_TIMEOUT_MS

    const url = httpUrl(entry)
    const exit = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(httpHeaders(entry)),
      HttpClientRequest.bodyJson(envelope),
      Effect.flatMap((req) => httpRead.execute(req)),
      Effect.flatMap((res) =>
        Effect.gen(function* () {
          const text = yield* res.text
          return { status: res.status, text }
        }),
      ),
      Effect.timeout(timeoutMs),
      Effect.exit,
    )

    if (exit._tag === "Failure") {
      log.warn("http hook request failed (non-blocking)", {
        command: url,
        error: String(exit.cause),
      })
      return { json: undefined, exitBlock: undefined }
    }

    const { status, text } = exit.value
    if (status < 200 || status >= 300) {
      return { json: undefined, exitBlock: `http hook returned status ${status}` }
    }

    return { json: parseStdout(text, url), exitBlock: undefined }
  }),
}

/**
 * `type: "prompt"` handler — single-turn LLM call (CC v1 protocol).
 *
 * `entry.command` is interpreted as the system prompt template; the stdin envelope
 * (already shaped by buildStdinEnvelope) is JSON-stringified into the user message.
 * The model returns structured output matching HookOutputSchema (loose flat
 * shape; see definition near HookJSONOutput).
 *
 * Failure policy is **silent allow** — mirrors httpHandler's network-error path:
 *   - OpenAI OAuth provider: not supported in v1 (no API key for generateObject).
 *     log.warn + return undefined json. v2 may switch to small-fast model w/ OAuth path.
 *   - generateObject reject (auth missing, rate-limit, schema mismatch, …): log.warn +
 *     return undefined json. Hooks must never crash or block the host on infra errors.
 *
 * MUST use `Effect.tryPromise + Effect.exit` (not `Effect.promise`): the latter
 * turns a reject into a defect, which would propagate as a die and violate the
 * non-blocking hook contract. The agent.ts:397 pattern is intentionally NOT copied
 * here for that exact reason.
 */
const promptHandler: HookHandler = {
  type: "prompt",
  run: Effect.fn("SettingsHook.handler.prompt")(function* (entry, envelope, _cwd, _inHook) {
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const auth = Option.getOrUndefined(yield* Effect.serviceOption(Auth.Service))
    if (!provider || !auth) {
      log.warn("prompt hook skipped: Provider/Auth not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const exit = yield* Effect.gen(function* () {
      const prompt = promptText(entry)
      const m = yield* provider.defaultModel()
      const resolved = yield* provider.getModel(m.providerID, m.modelID)
      const language = yield* provider.getLanguage(resolved)

      const authInfo = yield* auth.get(m.providerID).pipe(Effect.orDie)
      if (m.providerID === "openai" && authInfo?.type === "oauth") {
        log.warn("prompt hook: OpenAI OAuth provider not supported in v1", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }

      const params = {
        temperature: 0.3,
        model: language,
        messages: [
          { role: "system", content: prompt } as ModelMessage,
          { role: "user", content: JSON.stringify(envelope) } as ModelMessage,
        ],
        schema: HookOutputSchema,
      } satisfies Parameters<typeof generateObject>[0]

      // issue #286 — the header doc promises `timeout` for every hook type,
      // but promptHandler was the only executor never applying it. Honor it
      // with the same idiom as command/mcp/http; on expiry the TimeoutException
      // is captured by Effect.exit below and degrades to the non-blocking warn.
      const timeoutMs = entry.timeout ? entry.timeout * 1000 : DEFAULT_TIMEOUT_MS

      const llmExit = yield* Effect.tryPromise({
        try: (abortSignal) => generateObject({ ...params, abortSignal }).then((r) => r.object),
        catch: (e) => e,
      }).pipe(Effect.timeout(timeoutMs), Effect.exit)

      if (llmExit._tag === "Failure") {
        log.warn("prompt hook failed (non-blocking)", { error: String(llmExit.cause) })
        return { json: undefined, exitBlock: undefined }
      }
      return { json: llmExit.value as HookJSONOutput, exitBlock: undefined }
    }).pipe(Effect.exit)

    if (exit._tag === "Failure") {
      log.warn("prompt hook setup failed (non-blocking)", { error: String(exit.cause) })
      return { json: undefined, exitBlock: undefined }
    }
    return exit.value
  }),
}

/**
 * `type: "agent"` handler — multi-turn LLM with a tool palette (CC v1 protocol).
 *
 * `entry.command` is the system prompt; the stdin envelope is JSON-stringified
 * into the user message. The model is given 5 read-only tools from `agent-tools.ts`
 * (read_file / list_dir / grep / bash / synthetic_output) and runs up to
 * MAX_AGENT_TURNS turns. The hook decision is emitted by calling synthetic_output;
 * the loop polls the captured slot after each turn.
 *
 * Failure policy is **silent allow** — same contract as makePromptHandler. Three
 * distinct failure log strings differentiate setup defects (provider/auth/getLanguage),
 * timeout/abort, and generateText reject so operators can grep them apart.
 *
 * Structure mirrors WP-4C-fix's prompt handler (outer Effect.exit on the setup
 * gen) plus an inner tryPromise+exit on the loop Promise so AbortError and
 * generateText rejects don't escape as defects.
 */
const agentHandler: HookHandler = {
  type: "agent",
  run: Effect.fn("SettingsHook.handler.agent")(function* (entry, envelope, cwd, _inHook) {
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const auth = Option.getOrUndefined(yield* Effect.serviceOption(Auth.Service))
    const spawner = Option.getOrUndefined(yield* Effect.serviceOption(ChildProcessSpawner))
    const fs = Option.getOrUndefined(yield* Effect.serviceOption(FSUtil.Service))
    if (!provider || !auth || !spawner || !fs) {
      log.warn("agent hook skipped: Provider/Auth/Spawner/FS not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const exit = yield* Effect.gen(function* () {
      const prompt = promptText(entry)
      const m = yield* provider.defaultModel()
      const resolved = yield* provider.getModel(m.providerID, m.modelID)
      const language = yield* provider.getLanguage(resolved)
      const authInfo = yield* auth.get(m.providerID).pipe(Effect.orDie)

      if (m.providerID === "openai" && authInfo?.type === "oauth") {
        log.warn("agent hook: OpenAI OAuth provider not supported in v1", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }

      const captured: { value: HookJSONOutput | null } = { value: null }
      const timeoutMs = entry.timeout ? entry.timeout * 1000 : DEFAULT_AGENT_TIMEOUT_MS

      const loopExit = yield* Effect.tryPromise({
        try: async (signal) => {
          const tools = buildAgentTools({ spawner, fs, signal, cwd, captured })
          const messages: ModelMessage[] = [
            { role: "system", content: prompt },
            { role: "user", content: JSON.stringify(envelope) },
          ]
          for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
            signal.throwIfAborted()
            const result = await generateText({
              model: language,
              messages,
              tools,
              toolChoice: "auto",
              abortSignal: signal,
              maxOutputTokens: 4096,
              allowSystemInMessages: true,
            } as any)
            if (captured.value) return captured.value
            messages.push(...result.response.messages)
            if (
              result.finishReason === "stop" ||
              result.finishReason === "length" ||
              result.finishReason === "content-filter"
            )
              break
            if (result.toolCalls.length === 0) break
          }
          return null
        },
        catch: (e) => e,
      }).pipe(Effect.timeout(timeoutMs), Effect.exit)

      if (loopExit._tag === "Failure") {
        const cause = String(loopExit.cause)
        const isAbort = cause.includes("AbortError") || cause.includes("aborted")
        if (isAbort) {
          log.warn("agent hook timeout / aborted (non-blocking)", {
            error: cause,
            command: prompt.slice(0, 80),
            hint: "deep-investigation hooks must also raise entry.timeout — the 60s default aborts well before MAX_AGENT_TURNS (200) is reached",
          })
        } else {
          log.warn("agent hook generateText failed (non-blocking)", {
            error: cause,
            command: prompt.slice(0, 80),
          })
        }
        return { json: undefined, exitBlock: undefined }
      }

      if (!loopExit.value) {
        log.warn("agent hook reached max turns or no synthetic_output (non-blocking)", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }
      return { json: loopExit.value, exitBlock: undefined }
    }).pipe(Effect.exit)

    if (exit._tag === "Failure") {
      log.warn("agent hook setup failed (non-blocking)", { error: String(exit.cause) })
      return { json: undefined, exitBlock: undefined }
    }
    return exit.value
  }),
}

// WP-4D-2 constants. MAX_AGENT_TURNS pinned at 200 by user m0021 — gives the LLM
// enough headroom for deep-investigation hooks before the loop bails. Default
// timeout matches DEFAULT_TIMEOUT_MS (60s) used by command/http handlers.
// Note: the 60s default entry.timeout will abort most deep investigations far
// below 200 turns — to actually exploit the full turn budget, raise entry.timeout
// on the hook (the turn budget itself is not per-hook configurable).
const MAX_AGENT_TURNS = 200
const DEFAULT_AGENT_TIMEOUT_MS = 60_000

// Per-session additionalContext dedup bucket cap. A normal session never
// approaches this; the bound exists for the headless "" bucket (sessionID=""),
// which is shared across every prompt of a long-lived headless process and
// would otherwise accumulate without limit. Eviction is insertion-order-oldest
// (Set iterates in insertion order), so the least-recently-injected context is
// dropped first — acceptable since re-injection only matters within a session.
const MAX_SEEN_PER_BUCKET = 1000

/**
 * Add `text` to the per-session dedup bucket; returns true when newly added
 * (the caller then injects it into additionalContexts). Caps the bucket at
 * MAX_SEEN_PER_BUCKET by evicting the oldest entry — see the constant comment
 * for why the headless "" bucket needs this.
 */
const addSeen = (seen: Map<string, Set<string>>, sessionID: string, text: string): boolean => {
  const bucket = seen.get(sessionID) ?? new Set<string>()
  if (bucket.has(text)) return false
  bucket.add(text)
  if (bucket.size > MAX_SEEN_PER_BUCKET) {
    const oldest = bucket.values().next().value
    if (oldest !== undefined) bucket.delete(oldest)
  }
  seen.set(sessionID, bucket)
  return true
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessionHooks = yield* SessionHooks.Service
    const handlerContext = Context.pick(
      MCP.Service,
      Provider.Service,
      Auth.Service,
      FSUtil.Service,
      ChildProcessSpawner,
      HttpClient.HttpClient,
    )(yield* Effect.context<never>())

    const state = yield* InstanceState.make(
      Effect.fn("SettingsHook.state")(function* (instCtx) {
        const chain = loadChainWithSummaries(instCtx.directory, instCtx.worktree)
        const stateObj = {
          settings: chain.settings,
          hooksList: chain.summaries,
          cwd: instCtx.directory,
          seen: new Map<string, Set<string>>(),
          once: new Map<string, WeakSet<HookCommand>>(),
          stopRewakeChains: new Map<string, StopRewakeChain>(),
        } satisfies State

        // [FORK:hook-ext] Hot-reload settings files at runtime. The watcher
        // re-runs loadChain on a settings.json change and mutates
        // stateObj.settings in place. trigger reads s.settings via
        // InstanceState.get on every call, and the cache returns the SAME
        // state object, so the mutation is visible without invalidating the
        // cache. The finalizer closes the watcher when the instance scope is
        // disposed (same scope-based cleanup discipline as GoalLoop.state).
        //
        // The reload Effect computes both merged settings and scope-tagged
        // summaries in one pass; lastSummaries carries the summaries into the
        // onReload callback (watchSettings only threads Settings through).
        let lastSummaries: HookSummary[] = stateObj.hooksList
        // Bridge back into the instance-scoped Effect context from the plain-JS
        // onReload callback, so the ConfigChange hook event can fire.
        const bridge = yield* EffectBridge.make()
        const handle = watchSettings(
          instCtx.directory,
          instCtx.worktree,
          () =>
            Effect.sync(() => {
              const reloaded = loadChainWithSummaries(instCtx.directory, instCtx.worktree)
              lastSummaries = reloaded.summaries
              return reloaded.settings
            }),
          (newSettings, changedFile) => {
            stateObj.settings = newSettings
            stateObj.hooksList = lastSummaries
            // SettingsHook: ConfigChange — a watched hooks.json layer reloaded.
            // Fire-and-forget; hook failures never break the reload.
            bridge.fork(
              trigger({ event: "ConfigChange", configPath: changedFile }, { sessionID: "", transcriptPath: "" }).pipe(
                Effect.ignore,
              ),
            )
          },
          Global.Path.config,
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            handle.close()
            stateObj.stopRewakeChains.clear()
          }),
        )

        return stateObj
      }),
    )

    // Handlers resolve their deps lazily at trigger time from the ambient context.
    // This keeps the layer lightweight (only SessionHooks needed at
    // construction), following the Todo pattern exactly.
    const handlers: Record<string, HookHandler> = {
      command: commandHandler,
      mcp: mcpHandler,
      http: httpHandler,
      prompt: promptHandler,
      agent: agentHandler,
    }

    // [FORK:hook-ext] Assemble fork middleware — wired from hook/extensions/index.ts
    // When undefined, trigger() behaves identically to upstream.
    const forkHooks: ForkHooks | undefined = buildForkHooks ? buildForkHooks({ sessionHooks }) : undefined

    /**
     * Execute a single hook entry. Never throws. Returns the parsed JSON
     * output + a synthetic blocking signal for exit-code-2 protocol.
     */
    const runEntry = Effect.fn("SettingsHook.runEntry")(function* (
      entry: HookCommand,
      envelope: Record<string, unknown>,
      cwd: string,
      inHook: boolean,
    ) {
      using _ = log.time("runEntry", { type: entry.type, command: commandText(entry).slice(0, 80) })
      const handler = handlers[entry.type]
      if (!handler) {
        // Defensive fallback: handlers table is exhaustive over the schema's 5 types
        // (command/mcp/http/prompt/agent). This guards against future schema additions
        // that miss handler registration. Currently dead-code by construction.
        log.warn("hook type not registered (defensive fallback)", { type: entry.type, command: commandText(entry) })
        return {
          json: undefined as HookJSONOutput | undefined,
          exitBlock: `hook type "${entry.type}" not yet implemented` as string | undefined,
          rawStdout: undefined as string | undefined,
          exitCode: undefined as number | null | undefined,
        }
      }
      const result = yield* handler
        .run(entry as never, envelope, cwd, inHook)
        .pipe(Effect.updateContext((current: Context.Context<never>) => Context.merge(handlerContext, current)))
      const hso = result.json?.hookSpecificOutput
      if (hso) {
        for (const field of [
          "initialUserMessage",
          "watchPaths",
          "updatedMCPToolOutput",
          "displayMessage",
          "compactSummary",
          "customSummary",
        ] as const) {
          if (field in hso) log.warn("hook output field is not supported", { event: envelope.hook_event_name, field })
        }
      }
      return result
    })

    // Background scope for async hooks. Lives as long as the SettingsHook service
    // instance; closed via finalizer when the instance is disposed.
    const bgScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(bgScope, Exit.void))

    /**
     * Async hook completion handler. Computes rewake-worthiness from the result
     * and, when `asyncRewake` is set, admits a steer prompt to the originating
     * session via the opencode Session.Service (ambient in the session runtime).
     * Best-effort — all errors swallowed to honor the "never crash host" contract.
     */
    const onAsyncComplete = Effect.fnUntraced(function* (
      entry: HookCommand,
      event: HookEvent,
      sessionID: string | undefined,
      hookRewake: HookRewake.Interface | undefined,
      state: State,
      stopChain: StopRewakeChain | undefined,
      result: {
        json?: HookJSONOutput | undefined
        exitBlock?: string | undefined
        rawStdout?: string | undefined
        exitCode?: number | null | undefined
      },
    ) {
      if (!entry.asyncRewake) {
        log.debug("async hook completed (no rewake)", { command: commandText(entry).slice(0, 80) })
        return
      }
      if (event === "SessionEnd") return
      if (!sessionID) {
        log.warn("async hook rewake skipped: no sessionID", { command: commandText(entry).slice(0, 80) })
        return
      }
      if (!hookRewake) {
        log.warn("async hook rewake skipped: HookRewake.Service unavailable", {
          command: commandText(entry).slice(0, 80),
        })
        return
      }

      const parts: string[] = []
      if (result.exitBlock) parts.push(result.exitBlock)
      if (result.json?.systemMessage) parts.push(result.json.systemMessage)
      if (result.json?.decision === "block" && result.json.reason) parts.push(result.json.reason)
      const hso = result.json?.hookSpecificOutput
      if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string") {
        parts.push(hso.additionalContext)
      }
      // exit-0 plain-text stdout is rewake-worthy for the same two events that
      // inject it synchronously (P1a async parity).
      if (
        !result.json &&
        result.exitCode === 0 &&
        result.rawStdout &&
        (event === "UserPromptSubmit" || event === "SessionStart")
      ) {
        const text = result.rawStdout.trim()
        if (text && !text.startsWith("{")) parts.push(text)
      }
      if (parts.length === 0) {
        log.debug("async hook completed: nothing rewake-worthy", { command: commandText(entry).slice(0, 80) })
        return
      }

      if (stopChain) {
        // A newer non-hook prompt, SessionEnd, or session cancel invalidates
        // pending Stop callbacks.
        if (state.stopRewakeChains.get(sessionID) !== stopChain) {
          log.debug("async Stop callback discarded: chain invalidated", { sessionID, event })
          return
        }
        if (stopChain.count >= MAX_STOP_CONTINUATIONS) {
          log.warn("async Stop hook continuation limit reached", { sessionID, limit: MAX_STOP_CONTINUATIONS })
          return
        }
        // Reserve before yielding so concurrent completions share the same bound.
        stopChain.count++
      }

      const text = buildRewakePrompt(entry, event, parts.join("\n"))
      // The token rides along so SessionPrompt can re-check validity at the
      // real admission point — cancel can invalidate after this completion
      // check but before the rewake lands.
      yield* hookRewake.rewake({ sessionID: SessionID.make(sessionID), text, stopChain }).pipe(
        Effect.catchDefect((defect) => {
          log.warn("async hook rewake defect swallowed", {
            command: commandText(entry).slice(0, 80),
            error: String(defect),
          })
          return Effect.void
        }),
      )
    })

    const trigger = Effect.fn("SettingsHook.trigger")(function* (payload: HookPayload, ctx: TriggerContext) {
      using _ = log.time("trigger", { event: payload.event, sessionID: ctx.sessionID })
      const s = yield* InstanceState.get(state)
      const result: TriggerResult = { additionalContexts: [], systemMessages: [] }

      // Hook rewake prompts skip UserPromptSubmit in SessionPrompt. Every other
      // prompt (including a Goal continuation) begins a new automatic hook chain.
      if (payload.event === "UserPromptSubmit" && ctx.sessionID) s.stopRewakeChains.delete(ctx.sessionID)
      if (payload.event === "SessionEnd" && ctx.sessionID) s.stopRewakeChains.delete(ctx.sessionID)
      let stopChain: StopRewakeChain | undefined
      if (
        (payload.event === "Stop" || payload.event === "StopFailure" || payload.event === "SubagentStop") &&
        ctx.sessionID
      ) {
        stopChain = s.stopRewakeChains.get(ctx.sessionID) ?? { count: 0 }
        s.stopRewakeChains.set(ctx.sessionID, stopChain)
        if (stopChain.count > 0) payload = { ...payload, stopHookActive: true }
      }

      // ── SessionEnd lifecycle cleanup (F2) ──────────────────────
      // Evict this session's additionalContext dedup bucket AND its dynamic
      // session-hook store. Both are keyed by sessionID and have no other
      // eviction path, so without this the process accumulates one bucket +
      // one hook list per historical session for its entire lifetime.
      // SessionHooks.clear was previously defined but never invoked — this is
      // the single call site that fixes that leak.
      //
      // Runs BEFORE the WP-6A short-circuit below: a session that registered
      // no SessionEnd hook (the common case) must still have its state freed,
      // and placing it after the matcher loop would skip cleanup whenever the
      // short-circuit fires. Clearing first is safe — a SessionEnd hook that
      // returns additionalContext just repopulates a bucket for an ending
      // session, which is harmless.
      if (payload.event === "SessionEnd" && ctx.sessionID) {
        s.seen.delete(ctx.sessionID)
        s.once.delete(ctx.sessionID)
        // NOTE: sessionHooks.clear is deferred to after hook execution
        // (before each return point below) — clearing here would remove
        // session-registered SessionEnd hooks before the matcher can see them.
      }

      // ── WP-6A: O(1) short-circuit ─────────────────────────────
      // Skip the entire matcher pipeline (envelope build, target derivation,
      // session merge allocation, matcher regex) when neither the on-disk
      // settings chain nor the session store has any entry for this event.
      // s.settings is already cached on the InstanceState, so the file-side
      // probe is a property access. The session probe is O(1) (Map.get +
      // .some over the session's own array, typically empty).
      const sessionEvent: HookEvent = ctx.isSubAgent && payload.event === "Stop" ? "SubagentStop" : payload.event
      const hasFile = (s.settings.hooks?.[payload.event]?.length ?? 0) > 0
      const hasSession = ctx.sessionID
        ? yield* sessionHooks.hasForEvent(SessionID.make(ctx.sessionID), sessionEvent)
        : false
      if (!hasFile && !hasSession) {
        log.info("trigger short-circuit", { event: payload.event, reason: "no_matchers", hasFile, hasSession })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* sessionHooks.clear(SessionID.make(ctx.sessionID))
          s.seen.delete(ctx.sessionID)
          s.once.delete(ctx.sessionID)
        }
        return result
      }

      // ── WP-6B workspace-trust gate ──────────────────────────────
      // OPT-IN enforcement: enabled only when any chain layer sets `requireTrust`
      // OR env OPENCODE_HOOKS_REQUIRE_TRUST=1. When enabled and the working
      // directory is not on the persisted trust list, ALL hooks are silently
      // skipped (log.warn pointing at the trust file + cwd, empty TriggerResult).
      // A layer may declare `allowUntrusted: true` to opt out of the gate. NEVER
      // deny / throw — a trust gate that throws becomes a denial vector. Default
      // (enforcement off) is byte-for-byte the prior behavior (zero gate).
      const requireTrust = s.settings.requireTrust === true || process.env.OPENCODE_HOOKS_REQUIRE_TRUST === "1"
      if (requireTrust && !isTrusted(s.cwd) && s.settings.allowUntrusted !== true) {
        log.warn("hooks skipped: workspace not trusted", {
          cwd: s.cwd,
          trustFile: trustFilePath(),
        })
        // Still free this session's hook bucket on SessionEnd — the trust gate
        // is the one early-return path that would otherwise skip the deferred
        // SessionHooks.clear (mirrors the short-circuit / empty-matcher / end
        // return points), leaving an untrusted session's registered hooks
        // leaked in memory for the process lifetime.
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* sessionHooks.clear(SessionID.make(ctx.sessionID))
          s.seen.delete(ctx.sessionID)
          s.once.delete(ctx.sessionID)
        }
        return result
      }

      // ── Session-scoped hook resolution (WP-5D) ────────────────
      // Sub-agent stop semantics: if the caller marks this trigger as
      // running inside a sub-agent and fires `Stop`, look up SubagentStop
      // session hooks. Settings-file lookup still uses payload.event verbatim
      // (the on-disk chain is already correctly addressed by callers).
      const sessionEntries = ctx.sessionID
        ? yield* sessionHooks.list(SessionID.make(ctx.sessionID), sessionEvent)
        : ([] as readonly SessionHookEntry[])

      const fileMatchers = s.settings.hooks?.[payload.event] ?? []
      // Tag matchers with their origin so once-cleanup can remove session ones
      // after execution. The settings chain matchers carry no _sessionEntry.
      type RunMatcher = HookMatcher & { _sessionEntry?: SessionHookEntry }
      const matchers: RunMatcher[] = [
        ...fileMatchers.map((m) => m as RunMatcher),
        ...sessionEntries.map(
          (e) =>
            ({
              matcher: e.matcher,
              hooks: e.hooks as HookCommand[],
              _sessionEntry: e,
            }) satisfies RunMatcher,
        ),
      ]
      if (!matchers.length) {
        log.info("trigger short-circuit", { event: payload.event, reason: "empty_matchers" })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* sessionHooks.clear(SessionID.make(ctx.sessionID))
          s.seen.delete(ctx.sessionID)
          s.once.delete(ctx.sessionID)
        }
        return result
      }

      const target = matcherTarget(payload)
      const envelope = buildStdinEnvelope(payload, ctx, s.cwd)
      // Identical handlers matched by several groups/layers run once per trigger.
      const ran = new Set<string>()
      // additionalContext dedup: only within this trigger for tool events,
      // per session otherwise (see PER_TRIGGER_DEDUP_EVENTS).
      const local = new Set<string>()
      const addContext = (text: string) => {
        if (local.has(text)) return
        local.add(text)
        if (!PER_TRIGGER_DEDUP_EVENTS.has(payload.event) && !addSeen(s.seen, ctx.sessionID, text)) return
        result.additionalContexts.push(text)
      }

      for (const group of matchers) {
        if (target !== undefined && !matches(group.matcher, target)) continue

        let claimed = false
        for (const entry of group.hooks) {
          // Forward-compat: skip truly unknown types so future schema additions don't crash
          // older handlers. Known types (command/mcp/http/prompt/agent) all flow into runEntry.
          if (
            entry.type !== "command" &&
            entry.type !== "mcp" &&
            entry.type !== "http" &&
            entry.type !== "prompt" &&
            entry.type !== "agent"
          )
            continue

          // [FORK:hook-ext] Pre-dispatch filter — skip entry if condition not met
          if (forkHooks?.beforeRunEntry && !forkHooks.beforeRunEntry(entry, envelope, payload.event)) continue

          const key = handlerKey(entry)
          if (ran.has(key)) continue

          const onceBucket = s.once.get(ctx.sessionID) ?? new WeakSet<HookCommand>()
          if (entry.once && onceBucket.has(entry)) continue

          if (group._sessionEntry?.once && ctx.sessionID && !claimed) {
            if (!(yield* sessionHooks.claim(SessionID.make(ctx.sessionID), group._sessionEntry.id))) break
            claimed = true
          }
          if (entry.once) {
            onceBucket.add(entry)
            s.once.set(ctx.sessionID, onceBucket)
          }
          ran.add(key)
          if (entry.statusMessage) log.info("hook status", { event: payload.event, message: entry.statusMessage })

          // ── Async fork (hook-async-rewake) ──────────────────────
          // async:true entries are forked into the background and do NOT
          // participate in the current TriggerResult aggregation. Their output
          // (when asyncRewake:true) is delivered back via onAsyncComplete →
          // Session.rewake once the background fiber settles.
          if (entry.async) {
            const hookRewake = Option.getOrUndefined(yield* Effect.serviceOption(HookRewake.Service))
            const capturedEvent = payload.event
            const capturedSessionID = ctx.sessionID
            yield* runEntry(entry, envelope, s.cwd, false).pipe(
              Effect.catchDefect((defect) => {
                log.warn("async hook entry defect swallowed (host protected)", {
                  event: capturedEvent,
                  command: commandText(entry),
                  error: String(defect),
                })
                return Effect.succeed({
                  json: undefined as HookJSONOutput | undefined,
                  exitBlock: undefined as string | undefined,
                  rawStdout: undefined as string | undefined,
                  exitCode: undefined as number | null | undefined,
                })
              }),
              Effect.flatMap((r) =>
                onAsyncComplete(entry, capturedEvent, capturedSessionID, hookRewake, s, stopChain, r),
              ),
              Effect.catchDefect((defect) => {
                log.warn("async hook completion defect swallowed", {
                  command: commandText(entry),
                  error: String(defect),
                })
                return Effect.void
              }),
              Effect.forkIn(bgScope),
            )
            continue
          }

          // "Never crash host" contract: a hook handler can throw an unrecoverable
          // defect (null deref, OOM, native assert). Effect.catch at the tool-layer
          // call sites only catches typed Failures, so a defect would propagate and
          // kill the session. Catch defects here at the single entry-execution point
          // (covers all handler types: command/mcp/http/prompt/agent) → silent allow,
          // log, and continue to the next entry.
          const { json, exitBlock, rawStdout, exitCode } = yield* runEntry(entry, envelope, s.cwd, false).pipe(
            Effect.catchDefect((defect) => {
              log.warn("hook entry defect swallowed (host protected)", {
                event: payload.event,
                command: commandText(entry),
                error: String(defect),
              })
              return Effect.succeed({
                json: undefined,
                exitBlock: undefined,
                rawStdout: undefined,
                exitCode: undefined,
              })
            }),
          )

          // [FORK:hook-ext] Post-dispatch observation — never modifies result
          forkHooks?.afterRunEntry?.(entry, envelope, payload.event, { json, exitBlock })

          // Exit-code-2 block beats stdout decision
          if (exitBlock) {
            result.blocked = { reason: exitBlock, command: commandText(entry) }
          }

          if (!json) {
            // P1a: exit-0 plain-text stdout → additionalContext for the two
            // events CC injects it for (UserPromptSubmit / SessionStart). JSON
            // stdout was already parsed above (json defined → this branch
            // skipped); only non-JSON exit-0 output reaches here. Runs through
            // the same per-session dedup bucket as hookSpecificOutput.
            if (
              rawStdout &&
              exitCode === 0 &&
              (payload.event === "UserPromptSubmit" || payload.event === "SessionStart")
            ) {
              const text = rawStdout.trim()
              if (text && !text.startsWith("{")) addContext(text)
            }
            continue
          }

          if (json.decision === "block" && !result.blocked) {
            result.blocked = { reason: json.reason ?? "Blocked by hook", command: commandText(entry) }
          }

          if (json.continue === false) {
            result.preventContinuation = true
            if (json.stopReason && !result.stopReason) result.stopReason = json.stopReason
          }

          if (json.systemMessage) result.systemMessages.push(json.systemMessage)

          const hso = json.hookSpecificOutput
          // Property-based narrowing — works across union variants without depending on
          // hookEventName tag (which the fallback variant may also accept).
          if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string") {
            // Per-session dedup (F2) applies to non-tool events; the bucket is
            // keyed by TriggerContext.sessionID (see addContext).
            addContext(hso.additionalContext)
          }
          if (hso && "permissionDecision" in hso && hso.permissionDecision) {
            const incoming = hso.permissionDecision
            const current = result.permissionDecision
            // Most-restrictive-wins: deny > ask > allow. A later hook cannot
            // relax an earlier hook's deny (Claude Code permission semantics).
            const moreRestrictive =
              current === undefined || incoming === "deny" || (incoming === "ask" && current === "allow")
            if (moreRestrictive) {
              result.permissionDecision = incoming
              result.permissionDecisionReason =
                "permissionDecisionReason" in hso ? hso.permissionDecisionReason : undefined
            }
          }
          if (hso && "updatedInput" in hso && hso.updatedInput) {
            result.updatedInput = hso.updatedInput
          }

          // CC contract: continue=false short-circuits remaining hooks in this
          // matcher (and below, in subsequent matchers). Aggregation for the
          // current entry's json has already happened above — break only after.
          if (result.preventContinuation) break
        }
        if (result.preventContinuation) break
      }

      if (payload.event === "SessionEnd" && ctx.sessionID) {
        yield* sessionHooks.clear(SessionID.make(ctx.sessionID))
        s.seen.delete(ctx.sessionID)
        s.once.delete(ctx.sessionID)
      }
      return result
    })

    const list = Effect.fn("SettingsHook.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooksList
    })

    // A pending Stop/SubagentStop/StopFailure rewake chain dies with the
    // user's cancel intent. `stopRewakeChains` holds one chain object per
    // session while callbacks are in flight; identity comparison is monotonic
    // across abort/prompt cycles: after invalidation, a later Stop trigger
    // creates a new chain object, so an old token cannot match that chain.
    const invalidateStopRewakeChain = Effect.fn("SettingsHook.invalidateStopRewakeChain")(function* (
      sessionID: SessionID | string,
    ) {
      const s = yield* InstanceState.get(state)
      const deleted = s.stopRewakeChains.delete(sessionID)
      if (deleted) log.info("stop rewake chain invalidated", { sessionID })
    })

    const validateStopRewakeChain = Effect.fn("SettingsHook.validateStopRewakeChain")(function* (
      sessionID: SessionID | string,
      token: unknown,
    ) {
      const s = yield* InstanceState.get(state)
      return s.stopRewakeChains.get(sessionID) === token
    })

    return Service.of({ trigger, list, invalidateStopRewakeChain, validateStopRewakeChain })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionHooks.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
  ),
)

// ── type:"mcp" hook execution ───────────────────────────────────

/**
 * Resolve and invoke an MCP tool registered as a hook. Format follows the
 * Claude Code protocol:
 *   "mcp__<server>__<tool>"
 *
 * The fork's MCP service stores tools under `sanitize(server)_sanitize(tool)`
 * (see src/mcp/index.ts). We strip the leading `mcp__`, split on `__` for the
 * server/tool boundary, sanitize each side and rejoin with a single
 * underscore to look up the tool. This keeps the on-disk hook config in lock
 * step with Claude Code while staying compatible with the fork's internal
 * tool registry naming.
 *
 * Calls MCP.Service.tools() to get the tool registry and invokes the matching
 * tool with the hook envelope as `arguments`. Parses the first text content
 * item as JSON to obtain the standard hook control output.
 */
function invokeMcpHook(mcpSvc: MCP.Interface, command: string, envelope: Record<string, unknown>) {
  return Effect.gen(function* () {
    if (!command.startsWith("mcp__")) {
      log.warn("mcp hook command must start with mcp__", { command })
      return undefined
    }

    const tools = yield* mcpSvc.tools()
    // Convert CC-format "mcp__server__tool" to internal key "server_tool"
    // (sanitized, single underscore separator).
    const sanitizeIdent = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")
    const stripped = command.slice("mcp__".length)
    const sepIdx = stripped.indexOf("__")
    const internalKey =
      sepIdx === -1
        ? sanitizeIdent(stripped)
        : sanitizeIdent(stripped.slice(0, sepIdx)) + "_" + sanitizeIdent(stripped.slice(sepIdx + 2))
    const tool = tools[internalKey] ?? tools[command]
    if (!tool) {
      log.warn("mcp hook tool not found", {
        command,
        internalKey,
        available: Object.keys(tools).length,
      })
      return undefined
    }

    if (!tool.execute) {
      log.warn("mcp hook tool has no execute()", { command })
      return undefined
    }

    const result = yield* Effect.promise((signal) =>
      Promise.resolve(
        tool.execute!(
          envelope as never,
          {
            toolCallId: `hook-${Date.now()}`,
            messages: [],
            abortSignal: signal,
          } as never,
        ),
      ).catch((err) => {
        log.warn("mcp hook execution threw", { command, error: String(err) })
        return undefined
      }),
    )

    if (!result || typeof result !== "object" || !("content" in result)) return undefined

    const content = (result as { content: Array<{ type: string; text?: string }> }).content
    if (!Array.isArray(content)) return undefined
    const firstText = content.find((c) => c && c.type === "text" && typeof c.text === "string")?.text
    if (!firstText) return undefined

    return parseStdout(firstText, command)
  })
}

// Resolve module references after initialization; provider/plugin imports can
// otherwise encounter this module while their own node exports are in the TDZ.
export const node = {
  ...LayerNode.make(layer, [SessionHooks.node]),
  get dependencies() {
    return [
      SessionHooks.node,
      MCP.node,
      Provider.node,
      Auth.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      LayerNode.make(FetchHttpClient.layer, []),
    ]
  },
}

export * as SettingsHook from "./settings"
