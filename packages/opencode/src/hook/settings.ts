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
 *   { hook_event_name, session_id, prompt_id, transcript_path, cwd,
 *     scratchpad_dir, permission_mode, agent_id?, agent_type?, effort?,
 *     ...event-specific }
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
import { existsSync, readFileSync, lstatSync, statSync, writeFileSync } from "fs"
import { spawn } from "child_process"
import { createHash } from "crypto"
import { Effect, Layer, Context, Option, Scope, Exit, Fiber, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  HookCommandSchema,
  HookOutputSchema,
  HookSpecificOutputSchema,
  HookEvaluatorOutputSchema,
  type HookEvaluatorOutput,
  type PermissionUpdate,
} from "./schema"
import { generateObject, generateText, type ModelMessage } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { mcpHookOptions } from "@/mcp/elicitation-binding"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { buildAgentTools } from "./agent-tools"
import { SessionHooks, type ScopedHooksInput } from "./session-hooks"
import type { SessionHookEntry } from "./session-hooks"
import { HookNotification } from "./notifications"
import { SessionID } from "@/session/schema"
import { HookRewake } from "./rewake"
import { HookConfigChange } from "./config-change"
import { HookFileWatch } from "./file-watch"
import { EffectBridge } from "@/effect/bridge"
import { buildForkHooks, watchSettings } from "./extensions" // [FORK:hook-ext]
import { hasWorktreeLayer } from "./worktree-layer"
import { HookTranscript } from "./transcript"
import { claudeToolResponse } from "./tool-output"
import { patchFilePaths } from "./file-changes"

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
  | "UserPromptExpansion"
  | "PostToolBatch"
  | "TeammateIdle"
  | "DirectoryAdded"
  | "PreModelSwitch"
  | "PostModelSwitch"
  | "MessageDisplay"

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
  "UserPromptExpansion",
  "PostToolBatch",
  "TeammateIdle",
  "DirectoryAdded",
  "PreModelSwitch",
  "PostModelSwitch",
  "MessageDisplay",
])

export interface HookCommand {
  /**
   * Hook execution kind. `mcp` remains a local legacy alias for `mcp_tool`.
   * - `command`: shell command via stdin/stdout JSON envelope
   * - `mcp`: invoke MCP tool via `mcp__<server>__<tool>` prefix
   * - `http`: POST envelope to URL, parse JSON body
   * - `prompt`: LLM call with structured output (HookJSONOutput schema)
   * - `agent`: autonomous agent loop with bash/read_file/list_dir/grep tools
   */
  type: "command" | "mcp_tool" | "mcp" | "http" | "prompt" | "agent"
  command?: string
  args?: string[]
  server?: string
  tool?: string
  input?: Record<string, unknown>
  /** Claude Code `type:"http"` endpoint. Legacy configs may still use `command`. */
  url?: string
  /** Claude Code `type:"prompt" | "agent"` prompt. Legacy configs may still use `command`. */
  prompt?: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  timeout?: number
  onFailure?: "continue" | "block"
  continueOnBlock?: boolean
  model?: string
  statusMessage?: string
  once?: boolean
  /**
   * Explicit interpreter for command hooks. When omitted, preserve the platform
   * default (/bin/sh on POSIX, platform shell on Windows).
   */
  shell?: "bash" | "powershell"
  /** Per-handler compatibility adapter. Omitted or opencode preserves the native envelope. */
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
   * A tool condition on a non-tool event does not match. A malformed condition
   * (not `ToolName(...)`) also does not match.
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
   * Implies background execution. When the hook completes with rewake-worthy output
   * (exit code 2 stderr, `systemMessage`, `decision:"block"` reason, or
   * `additionalContext`), a synthetic steer prompt wrapping the output in a
   * `<system-reminder>` is admitted to the originating session, re-waking the agent.
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

const isAsync = (entry: HookCommand) => entry.async === true || entry.asyncRewake === true

interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

export interface Settings {
  hooks?: Partial<Record<HookEvent, HookMatcher[]>>
  /** Optional local settings guard for HTTP hook destinations. Empty denies all. */
  allowedHttpHookUrls?: string[]
  /** Optional global ceiling for environment interpolation in HTTP headers. */
  httpHookAllowedEnvVars?: string[]
  /**
   * Temporarily switches every hook off, including session-scoped skill and agent hooks. The
   * value left after layer precedence applies decides (global, then project, then worktree), so
   * a project can override a user-level `true` with `false` (reference 714).
   */
  disableAllHooks?: boolean
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
  /** Background watcher whose exit-2 result wakes the originating session. */
  asyncRewake?: boolean
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
  terminalSequence?: string
  watchPaths?: string[]
  decision?: "approve" | "block"
  reason?: string
  hookSpecificOutput?: HookSpecificOutput
}

// ── Async rewake (hook-async-rewake) ───────────────────────────
// Sentinel prefix for rewake prompts. UserPromptSubmit hook processing skips
// prompts whose text starts with this prefix, preventing hook → rewake → hook
// loops. The prefix must match the opening of buildRewakePrompt exactly.
export const HOOK_REWAKE_SENTINEL = "<system-reminder>\nAsync hook completed"

const CONTEXT_LIMIT = 10_000
const CONTEXT_PREVIEW_LIMIT = 2_000
/**
 * Claude bounds hook-provided context at 10,000 characters and escapes reminder
 * tags so hook output cannot close the host envelope. Over-limit text is kept
 * whole in `spillDir` when available; what reaches the model is its path plus a
 * 2,000-character preview. Without a writable directory the value is truncated
 * in place so the cap still holds.
 */
export function sanitizeHookContext(text: string, spillDir?: string): string {
  const escaped = text
    .replaceAll("<system-reminder>", "&lt;system-reminder>")
    .replaceAll("</system-reminder>", "&lt;/system-reminder>")
  if (escaped.length <= CONTEXT_LIMIT) return escaped
  if (spillDir) {
    const file = path.join(spillDir, `context-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`)
    try {
      writeFileSync(file, text, { mode: 0o600 })
      return `Full context saved to ${file}\n\n${escaped.slice(0, CONTEXT_PREVIEW_LIMIT)}`
    } catch {
      // An unwritable scratchpad must not fail the hook; fall back to truncation.
    }
  }
  return `${escaped.slice(0, CONTEXT_LIMIT)}\n[truncated at ${CONTEXT_LIMIT} characters]`
}

const SHOW_STDERR_EVENTS = new Set<HookEvent>([
  "SessionStart",
  "SessionEnd",
  "CwdChanged",
  "FileChanged",
  "PostCompact",
  "SubagentStart",
  "PostModelSwitch",
])

function buildRewakePrompt(entry: HookCommand, event: HookEvent, content: string, spillDir?: string): string {
  const cmd = descriptorFor(entry)
  return `${HOOK_REWAKE_SENTINEL} (command: ${cmd}, event: ${event}):\n${sanitizeHookContext(content, spillDir)}\n</system-reminder>`
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
      permissionDecision?: "allow" | "deny" | "ask" | "defer"
      permissionDecisionReason?: string
      updatedInput?: Record<string, unknown>
      additionalContext?: string
    }
  | {
      hookEventName: "UserPromptSubmit"
      additionalContext?: string
      sessionTitle?: string
      suppressOriginalPrompt?: boolean
    }
  | {
      hookEventName: "SessionStart"
      additionalContext?: string
      initialUserMessage?: string
      watchPaths?: string[]
      sessionTitle?: string
      reloadSkills?: boolean
    }
  | {
      hookEventName: "PostToolUse"
      additionalContext?: string
      updatedToolOutput?: unknown
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
      decision?: import("./trigger-result").TriggerResult["permissionRequestDecision"]
      additionalContext?: string
    }
  | {
      hookEventName: "Elicitation" | "ElicitationResult"
      action?: "accept" | "decline" | "cancel"
      content?: Record<string, unknown>
    }
  | {
      hookEventName: "PermissionDenied"
      additionalContext?: string
      retry?: boolean
    }
  | { hookEventName: "MessageDisplay"; displayContent?: string }
  | { hookEventName: "WorktreeCreate"; worktreePath?: string }
  | {
      hookEventName: "PreModelSwitch"
      permissionDecision?: "allow" | "deny" | "ask"
      permissionDecisionReason?: string
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
      /** Full builtin result for opt-in response adapters; absent from native envelopes. */
      toolOutput?: unknown
      durationMs?: number
    }
  | {
      event: "PostToolUseFailure"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      error: string
      isInterrupt?: boolean
      durationMs?: number
    }
  | {
      event: "PermissionRequest"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      permissionSuggestions?: PermissionUpdate[]
    }
  | {
      event: "PermissionDenied"
      toolUseID?: string
      toolName: string
      toolInput: Record<string, unknown>
      reason: string
    }
  | { event: "Notification"; message: string; title?: string; notificationType?: string }
  | { event: "UserPromptSubmit"; prompt: string; sessionTitle?: string }
  | {
      event: "Stop"
      stopHookActive: boolean
      lastAssistantMessage?: string
      backgroundTasks?: readonly Record<string, unknown>[]
      sessionCrons?: readonly Record<string, unknown>[]
    }
  | {
      event: "StopFailure"
      stopHookActive: boolean
      error: string
      errorDetails?: string
      lastAssistantMessage?: string
    }
  | { event: "SubagentStart"; agentID: string; agentType: string }
  | {
      event: "SubagentStop"
      stopHookActive: boolean
      agentID?: string
      agentTranscriptPath?: string
      agentType?: string
      lastAssistantMessage?: string
      backgroundTasks?: readonly Record<string, unknown>[]
      sessionCrons?: readonly Record<string, unknown>[]
    }
  | {
      event: "PreCompact"
      trigger: "manual" | "auto"
      customInstructions?: string | null
    }
  | {
      event: "PostCompact"
      trigger?: "manual" | "auto"
      compactSummary?: string
      customInstructions?: string | null
    }
  | {
      event: "SessionStart"
      source: "startup" | "resume" | "clear" | "compact" | "fork"
      model?: string
      agentType?: string
      sessionTitle?: string
      contextTokens?: number
      secondsSinceLastResponse?: number
      promptCacheLikelyExpired?: boolean
      estimatedCacheWriteUsd?: number
    }
  | {
      event: "SessionEnd"
      reason: "clear" | "delete" | "logout" | "prompt_input_exit" | "resume" | "other"
    }
  | { event: "Setup"; trigger: string }
  | { event: "TaskCreated"; taskID?: string; taskTitle?: string; taskDescription?: string; source?: "task_update" }
  | { event: "TaskCompleted"; taskID?: string; taskTitle?: string; result?: unknown; source?: "task_update" }
  | {
      event: "Elicitation"
      serverName?: string
      message?: string
      mode?: "form" | "url"
      url?: string
      elicitationID?: string
      requestedSchema?: unknown
      prompt?: string
      schema?: unknown
    }
  | {
      event: "ElicitationResult"
      serverName?: string
      action?: "accept" | "decline" | "cancel"
      content?: Record<string, unknown>
      mode?: "form" | "url"
      elicitationID?: string
      result?: unknown
      cancelled?: boolean
    }
  | {
      event: "ConfigChange"
      source?: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills"
      configPath?: string
      changes?: unknown
    }
  | { event: "WorktreeCreate"; name?: string; path?: string; branch?: string }
  | { event: "WorktreeRemove"; worktreePath?: string; path?: string; branch?: string }
  | {
      event: "InstructionsLoaded"
      path?: string
      content?: string
      memoryType?: "User" | "Project" | "Local" | "Managed"
      loadReason?: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact"
      globs?: string[]
      triggerFilePath?: string
      parentFilePath?: string
    }
  | { event: "CwdChanged"; oldCwd?: string; newCwd?: string }
  | { event: "FileChanged"; path?: string; changeType?: string }
  | {
      event: "UserPromptExpansion"
      commandName: string
      prompt: string
      expansionType?: "slash_command" | "mcp_prompt"
      commandArgs?: string
      commandSource?: string
    }
  | {
      event: "PostToolBatch"
      toolCalls: { toolName: string; toolInput: Record<string, unknown>; toolUseID?: string; toolResponse: unknown }[]
    }
  | { event: "TeammateIdle"; teammateID?: string; teammateName?: string }
  | { event: "DirectoryAdded"; directory: string; source: string }
  | {
      event: "PreModelSwitch" | "PostModelSwitch"
      fromModel: string
      toModel: string
      requestedModel?: string | null
      source?: string
      contextTokens?: number
      promptCacheWarm?: boolean
      cacheTtl?: "5m" | "1h"
      estimatedCacheWriteUsd?: number
      pricing?: "configured" | "catalog" | "default"
    }
  | { event: "MessageDisplay"; turnID: string; messageID: string; index: number; final: boolean; delta: string }

// Callers provide truthful session/transcript identifiers. Tool-event cwd follows
// a Bash call's workdir; all other events use the current instance directory.
export interface TriggerContext {
  sessionID: string
  /** Absolute path to the live JSONL transcript exported by the lifecycle owner. */
  transcriptPath: string
  /** Temporary file sourced after SessionStart to load hook-defined environment. */
  environmentFile?: string
  /** Session-scoped variables exported by SessionStart for later local commands and Bash tools. */
  environment?: Record<string, string | undefined>
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
  /**
   * Official (Claude-style) name of the tool, supplied by the runtime that owns the
   * real binding (for example `mcp__server__tool` or `Agent`). Never derive it from
   * a native id by splitting. Matchers, `if` conditions and claude-code envelopes use
   * it when present and still accept the native name.
   */
  canonicalToolName?: string
  /** Real MCP server binding of the tool in this trigger; surfaced as `mcp_server`. */
  mcpServer?: { name: string; source: string }
  /**
   * CC envelope `prompt_id`: the user prompt currently being processed. The fork
   * reports the persisted user message id (stable per prompt, absent before the
   * first input). `buildStdinEnvelope` omits the field when unset.
   */
  promptID?: string
  /**
   * CC envelope `effort`: the effort level in effect for this trigger. Only the
   * five CC levels are meaningful; producers derive it from the model variant
   * (see `hook/prompt-identity.ts`). Emitted only for tool-use-context events.
   */
  effort?: HookEffort
  /** CC envelope `scratchpad_dir`: per-session scratch directory, created lazily by `trigger`. */
  scratchpadDir?: string
}

/** CC's effort levels (the `level` reported inside the `effort` envelope object). */
export type HookEffort = "low" | "medium" | "high" | "xhigh" | "max"

// `TriggerResult` and `landSystemMessages` live in `./trigger-result` (a
// cycle-free leaf). Re-exported here so existing `SettingsHook.*` /
// `import { type TriggerResult } from "@/hook/settings"` call sites keep
// working. See trigger-result.ts for the cycle rationale.
import { landSystemMessages, type TriggerResult } from "./trigger-result"
export type { TriggerResult } from "./trigger-result"
export { landSystemMessages } from "./trigger-result"

/**
 * Hard cap on how many times a blocked Stop / SubagentStop hook may drive another
 * model turn. Guards against a misbehaving hook that ignores `stop_hook_active`
 * (which would otherwise loop forever burning tokens). Shared by the main agent
 * Stop path (prompt.ts) and the SubagentStop path (task.ts).
 */
export const MAX_STOP_CONTINUATIONS = 8

/**
 * Claude Code's `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` override for the cap above.
 * Only a positive integer is accepted; anything else (including unset) keeps
 * the documented default of 8.
 */
export function stopHookBlockCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  if (raw === undefined) return MAX_STOP_CONTINUATIONS
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : MAX_STOP_CONTINUATIONS
}

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
  readonly beforeRunEntry?: (
    entry: HookCommand,
    envelope: Record<string, unknown>,
    event: HookEvent,
    tool?: { canonicalToolName?: string },
  ) => boolean

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
function expandTemplate(
  entry: HookCommand,
  text: string,
  execForm: boolean,
  options: { cwd?: string; powershell?: boolean } = {},
): string {
  return text.replace(/\$\{([^}]+)\}/g, (full, key) => {
    // PowerShell resolves exported variables after parsing, so a path with spaces
    // or quotes stays one value. Rewrite to its `${env:NAME}` form (reference 4176).
    if (
      options.powershell &&
      !execForm &&
      (key === "CLAUDE_PROJECT_DIR" || key === "CLAUDE_PLUGIN_ROOT" || key === "CLAUDE_PLUGIN_DATA")
    )
      return "${env:" + key + "}"
    if (key === "CLAUDE_PROJECT_DIR" && execForm && options.cwd !== undefined) return options.cwd
    if (key === "CLAUDE_PLUGIN_ROOT" && entry.__sourceDir) return entry.__sourceDir
    if (key === "CLAUDE_PLUGIN_DATA" && entry.__sourceDir) return computeDataDir(entry.__sourceDir)
    if (execForm && key.startsWith("user_config.")) {
      const optKey = key.slice("user_config.".length)
      const v = entry.options?.[optKey]
      if (v !== undefined) return typeof v === "string" ? v : JSON.stringify(v)
    }
    return full
  })
}

/** Exported for unit testing: placeholder expansion exactly as the spawn path applies it. */
export function expandHookCommand(entry: HookCommand, options: { cwd?: string; powershell?: boolean } = {}): string {
  return expandCommand(entry, options)
}

function expandCommand(entry: HookCommand, options: { cwd?: string; powershell?: boolean } = {}): string {
  return expandTemplate(entry, commandText(entry), entry.args !== undefined, options)
}

export interface ShellProbe {
  readonly platform: NodeJS.Platform
  readonly env: Record<string, string | undefined>
  readonly exists: (file: string) => boolean
}

export interface ResolvedShell {
  readonly kind: "sh" | "bash" | "powershell"
  readonly file: string
}

const defaultShellProbe = (): ShellProbe => ({ platform: process.platform, env: process.env, exists: existsSync })

/**
 * Resolve the interpreter for a shell-form command hook. Windows defaults to Git Bash
 * when it is actually installed and falls back to PowerShell otherwise (reference 460/471).
 * Exported for unit testing; the probe lets tests describe a Windows host.
 */
export function resolveHookShell(
  entry: Pick<HookCommand, "shell">,
  probe: ShellProbe = defaultShellProbe(),
): ResolvedShell {
  const windows = probe.platform === "win32"
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const join = windows ? path.win32.join : path.join
  const pathDirs = (probe.env.PATH ?? probe.env.Path ?? "").split(windows ? ";" : ":").filter(Boolean)
  const findOnPath = (names: string[]) => {
    for (const dir of pathDirs) for (const name of names) if (probe.exists(join(dir, name))) return join(dir, name)
    return undefined
  }
  const powershell = (): ResolvedShell => {
    if (!windows) return { kind: "powershell", file: "pwsh" }
    return { kind: "powershell", file: findOnPath(["pwsh.exe"]) ?? "powershell.exe" }
  }
  const gitBash = (): string | undefined => {
    if (!windows) return undefined
    const roots = [probe.env.ProgramFiles, probe.env["ProgramFiles(x86)"], probe.env.ProgramW6432].filter(
      (value): value is string => !!value,
    )
    const candidates = [
      probe.env.CLAUDE_CODE_GIT_BASH_PATH,
      ...roots.map((root) => join(root, "Git", "bin", "bash.exe")),
      probe.env.LOCALAPPDATA ? join(probe.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : undefined,
    ]
    for (const candidate of candidates) if (candidate && probe.exists(candidate)) return candidate
    const git = findOnPath(["git.exe"])
    if (git) {
      const base = path.win32.dirname(path.win32.dirname(git))
      for (const candidate of [join(base, "bin", "bash.exe"), join(path.win32.dirname(base), "bin", "bash.exe")])
        if (probe.exists(candidate)) return candidate
    }
    return undefined
  }
  if (entry.shell === "powershell") return powershell()
  if (!windows) return entry.shell === "bash" ? { kind: "bash", file: "/bin/bash" } : { kind: "sh", file: "/bin/sh" }
  const bash = gitBash()
  if (bash) return { kind: "bash", file: bash }
  // An explicit bash request keeps its PATH lookup; the default has no usable bash at all.
  return entry.shell === "bash" ? { kind: "bash", file: "bash.exe" } : powershell()
}

function commandText(entry: HookCommand): string {
  return entry.command ?? ""
}

function httpUrl(entry: HookCommand): string {
  return entry.url ?? entry.command ?? ""
}

function httpHeaders(entry: HookCommand): Record<string, string> {
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

function httpHookUrlAllowed(url: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true
  return allowed.some((pattern) => {
    const regex = `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
    try {
      return new RegExp(regex).test(url)
    } catch {
      return false
    }
  })
}

function promptText(entry: HookCommand): string {
  return entry.prompt ?? entry.command ?? ""
}

/**
 * `$ARGUMENTS` becomes the hook input JSON and `\$` is a literal dollar sign. Without an
 * unescaped placeholder the input is appended (reference 599, 3908).
 */
function evaluatorPrompt(entry: HookCommand, envelope: Record<string, unknown>): string {
  const template = promptText(entry)
  const input = JSON.stringify(envelope)
  let placed = false
  const text = template.replace(/\\\$|\$ARGUMENTS/g, (match) => {
    if (match === "\\$") return "$"
    placed = true
    return input
  })
  return placed ? text : `${text}\n\n${input}`
}

/**
 * An explicit model is used as configured. Otherwise the evaluator uses the small
 * model the host picks for background work, then the default model.
 */
const evaluatorModel = Effect.fnUntraced(function* (provider: Provider.Interface, entry: HookCommand) {
  const fallback = yield* provider.defaultModel()
  if (entry.model)
    return Provider.parseModel(entry.model.includes("/") ? entry.model : `${fallback.providerID}/${entry.model}`)
  const small = yield* Effect.suspend(() => provider.getSmallModel(fallback.providerID)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  return small ? { providerID: small.providerID, modelID: small.id } : fallback
})

function evaluatorDecision(
  entry: HookCommand,
  event: HookEvent,
  answer: HookEvaluatorOutput,
): HookJSONOutput | undefined {
  if (answer.ok) return undefined
  if (!answer.reason) return undefined
  if (event === "PermissionRequest" || event === "PermissionDenied") return undefined
  if ((event === "Stop" || event === "SubagentStop") && entry.type === "prompt" && answer.impossible) return undefined
  const continueOnBlock = entry.type === "agent" || entry.continueOnBlock === true
  if (event === "PreToolUse")
    return {
      ...(continueOnBlock ? {} : { continue: false, stopReason: answer.reason, systemMessage: answer.reason }),
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: answer.reason,
      },
    }
  if (event === "PostToolUse" || event === "TeammateIdle")
    return continueOnBlock
      ? { hookSpecificOutput: { hookEventName: event, additionalContext: answer.reason } }
      : { continue: false, stopReason: answer.reason, systemMessage: answer.reason }
  if (event === "PostToolUseFailure")
    return { hookSpecificOutput: { hookEventName: event, additionalContext: answer.reason } }
  // The reference returns this reason as a tool error: the todo write is refused
  // with the reason as feedback, while the turn keeps running (no continue:false).
  // systemMessage keeps the human-visible notification from the previous behavior.
  if (event === "TaskCreated" || event === "TaskCompleted")
    return { decision: "block", reason: answer.reason, systemMessage: answer.reason }
  return { decision: "block", reason: answer.reason, systemMessage: answer.reason }
}

function mcpInput(entry: HookCommand, envelope: HookEnvelope): Record<string, unknown> {
  const read = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object" ? Object.entries(value).find(([key]) => key === part)?.[1] : undefined,
        envelope,
      )
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        const found = read(key)
        return found === undefined || found === null ? "" : typeof found === "string" ? found : JSON.stringify(found)
      })
    if (Array.isArray(value)) return value.map(substitute)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, substitute(nested)]))
    return value
  }
  const input = substitute(entry.input ?? {})
  return input && typeof input === "object" && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {}
}

/**
 * Short human-readable description of a hook entry for the Active Hooks block.
 * All types are uniformly truncated to 60 chars: command → command text,
 * http → URL, mcp → tool name, prompt/agent → first line of the prompt/goal.
 */
// Only recognisable script arguments supply the display name; code passed to
// `-e` or a version string must not be mistaken for a file.
const SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".rb",
  ".go",
  ".rs",
  ".php",
  ".pl",
  ".lua",
])

function scriptName(entry: HookCommand): string | undefined {
  return (entry.args ?? [])
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => path.basename(arg))
    .find((name) => SCRIPT_EXTENSIONS.has(path.extname(name).toLowerCase()))
}

function descriptorFor(entry: HookCommand): string {
  switch (entry.type) {
    case "command": {
      // `bun /path/watch.ts` should not read as just `bun` in Active Hooks.
      const name = scriptName(entry)
      return `${commandText(entry)}${name ? ` ${name}` : ""}`.slice(0, 60)
    }
    case "http":
      return httpUrl(entry).slice(0, 60)
    case "mcp":
      return commandText(entry).slice(0, 60)
    case "mcp_tool":
      return `${entry.server}/${entry.tool}`.slice(0, 60)
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
function matches(matcher: string | undefined, target: string, event?: HookEvent): boolean {
  if (!matcher || matcher === "*") return true
  if (event === "FileChanged" || event === "StopFailure") {
    if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(target)
  } else if (/^[A-Za-z0-9_\-,| ]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((part) => part.trim())
      .includes(target)
  }

  try {
    return new RegExp(matcher).test(target)
  } catch {
    log.warn("invalid regex in hook matcher", { matcher })
    return false
  }
}

// ── Settings loader (hooks.json chain) ──────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isHookEvent(value: string): value is HookEvent {
  return VALID_HOOK_EVENTS.has(value)
}

// Exported for unit testing only; not part of the public surface.
export function readJSON(filepath: string): Settings | null {
  return readJSONFile(filepath).settings ?? null
}

/** A missing file is an empty layer; a file that exists but cannot be parsed is invalid. */
function readJSONFile(filepath: string): { settings?: Settings; invalid?: true } {
  if (!existsSync(filepath)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(filepath, "utf8"))
    // hooks.json uses top-level event keys; a legacy {"hooks": {...}} wrapper is
    // tolerated (D1 graceful degradation). The wrapper wins when present.
    const obj = isRecord(parsed) ? parsed : undefined
    const rawHooks = obj && isRecord(obj.hooks) ? obj.hooks : obj

    const hooks: Settings["hooks"] = {}
    const sourceDir = path.dirname(filepath)
    if (rawHooks) {
      for (const [key, value] of Object.entries(rawHooks)) {
        if (!isHookEvent(key)) continue
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
      if (!isHookEvent(event)) continue
      const acc = (out.hooks![event] ??= [])
      acc.push(...(matchers ?? []))
    }
  }
  for (const layer of layers) if (layer.disableAllHooks !== undefined) out.disableAllHooks = layer.disableAllHooks
  if (layers.some((l) => l.allowedHttpHookUrls !== undefined))
    out.allowedHttpHookUrls = [...new Set(layers.flatMap((l) => l.allowedHttpHookUrls ?? []))]
  if (layers.some((l) => l.httpHookAllowedEnvVars !== undefined))
    out.httpHookAllowedEnvVars = [...new Set(layers.flatMap((l) => l.httpHookAllowedEnvVars ?? []))]
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
  if (hasWorktreeLayer(directory, worktree)) {
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
): { settings: Settings; summaries: HookSummary[]; invalid: string[] } {
  const layers: Settings[] = []
  const summaries: HookSummary[] = []
  const invalid: string[] = []
  for (const { scope, file } of chainCandidates(directory, worktree, globalConfig)) {
    const read = readJSONFile(file)
    if (read.invalid) invalid.push(file)
    const data = read.settings
    if (!data) continue
    warnUnsupportedFields(data.hooks, path.dirname(file))
    layers.push(data)
    if (!data.hooks) continue
    for (const [event, matchers] of Object.entries(data.hooks)) {
      if (!isHookEvent(event)) continue
      for (const m of matchers ?? []) {
        for (const h of m.hooks ?? []) {
          summaries.push({
            event,
            scope,
            type: h.type,
            descriptor: inactiveEventWarning(event)
              ? `${descriptorFor(h)} [${inactiveEventWarning(event)}]`
              : descriptorFor(h),
            ...(m.matcher && m.matcher !== "*" ? { matcher: m.matcher } : {}),
            ...(h.type === "command" && h.asyncRewake === true ? { asyncRewake: true } : {}),
          })
        }
      }
    }
  }
  return { settings: mergeSettings(layers), summaries, invalid }
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
): { settings: Settings; summaries: HookSummary[]; invalid: string[] } {
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
  if (hasWorktreeLayer(directory, worktree)) {
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
    const parsed: unknown = JSON.parse(readFileSync(filepath, "utf8"))
    return isRecord(parsed) && Boolean(parsed.hooks)
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

/**
 * @internal Test-only: the hooks.json layer candidates for a project, so tests
 * can assert which files the chain would read without writing to them.
 */
export { chainCandidates as __chainCandidates }

/**
 * @internal Test-only: the deprecated settings.json paths scanned for a stale
 * `hooks` field, exported for the same reason as `__chainCandidates`.
 */
export { deprecatedSettingsPaths as __deprecatedSettingsPaths }

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
const INACTIVE_EVENTS = new Set<HookEvent>(["PermissionDenied", "TeammateIdle"])

function inactiveEventWarning(event: HookEvent): string | undefined {
  return INACTIVE_EVENTS.has(event) ? "inactive: this build has no event trigger" : undefined
}

export function warnUnsupportedFields(hooks: Settings["hooks"], sourceDir: string): void {
  for (const event of Object.keys(hooks ?? {})) {
    if (isHookEvent(event) && inactiveEventWarning(event))
      log.warn("hook event has no trigger in this build", { sourceDir, event })
  }
  const unsupported = detectUnsupportedFields(hooks)
  if (unsupported.length > 0) {
    log.warn("hook settings contains fields ignored by this handler type", {
      sourceDir,
      unsupported,
    })
  }
}

// ── Shell command runner ────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600_000
function timeoutFor(entry: HookCommand, event: HookEvent): number {
  if (entry.timeout !== undefined) return entry.timeout * 1000
  if (entry.type === "prompt") return 30_000
  if (entry.type === "agent") return 60_000
  if (event === "SessionEnd") {
    const override = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS)
    return Number.isFinite(override) && override > 0 ? override : 1_500
  }
  if (event === "MessageDisplay") return 10_000
  if (["UserPromptSubmit", "PreModelSwitch", "PostModelSwitch"].includes(event)) return 30_000
  return DEFAULT_TIMEOUT_MS
}

// #500: after the child exits (or the spawn timeout SIGTERMs it), stdio EOF is
// given this grace before the whole process group is SIGKILLed; DRAIN_MS is
// the post-kill window for final buffered output before resolving partial.
const KILL_GRACE_MS = 2_000
const DRAIN_MS = 500

/**
 * A deleted working directory must not disable hooks for the rest of the
 * session: the reference falls back to the session-start directory, the
 * project root, home, then temp. The instance directory (`cwd`) is already
 * the first candidate; the stable worktree root survives its deletion.
 */
function resolveHookCwd(candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // Missing or unreadable: try the next fallback.
    }
  }
  return os.tmpdir()
}

function execShell(
  entry: HookCommand,
  stdinJSON: string,
  cwd: string,
  signal: AbortSignal,
  event: HookEvent,
  environmentFile?: string,
  environment?: Record<string, string | undefined>,
  effort?: HookEffort,
  /** Stable project root; `cwd` above stays the working directory of the child. */
  projectDir?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; spawnError?: string; suspect?: boolean }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "" })
      return
    }
    // CLAUDE_PROJECT_DIR names the project, not the (possibly nested) working
    // directory, so both the exported variable and its placeholder use it.
    const hookProjectDir = projectDir ?? cwd
    const timeoutMs = timeoutFor(entry, event)
    const shell = resolveHookShell(entry)
    const expandedCommand = expandCommand(entry, { cwd: hookProjectDir, powershell: shell.kind === "powershell" })

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

    const extraEnv: Record<string, string> = { CLAUDE_PROJECT_DIR: hookProjectDir }
    if (effort) extraEnv.CLAUDE_EFFORT = effort
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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...environment,
      ...extraEnv,
      ...(environmentFile &&
      ["SessionStart", "Setup", "CwdChanged", "FileChanged"].includes(event) &&
      shell.kind !== "powershell"
        ? { CLAUDE_ENV_FILE: environmentFile }
        : {}),
    }
    // SessionStart may unset an inherited variable. Spawner APIs can stringify
    // undefined, so remove it explicitly before creating the child.
    for (const [name, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[name]
    const child = spawn(
      expandedCommand,
      entry.args?.map((arg) => expandTemplate(entry, arg, true, { cwd: hookProjectDir })) ?? [],
      {
        cwd,
        shell: entry.args === undefined ? shell.file : false,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    )

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
    let streamsClosed = false
    let suspect = false
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
    const streamsDone = Promise.all([streamSettled(child.stdout), streamSettled(child.stderr)]).then(() => {
      streamsClosed = true
    })
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
      resolve({
        exitCode: code,
        stdout,
        stderr,
        ...(spawnError === undefined ? {} : { spawnError }),
        ...(suspect ? { suspect: true } : {}),
      })
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
    // A synchronous hook whose own process exited but whose pipes stay open has a
    // grandchild still able to write; its capture cannot be trusted (reference 885).
    void exited.then(() =>
      arm(() => {
        if (!streamsClosed && !timedOut && !signal.aborted && !(entry.async || entry.asyncRewake)) suspect = true
        afterKill()
      }, KILL_GRACE_MS),
    )

    // Child ignored the spawn-timeout SIGTERM and never exited: kill the group
    // at the absolute deadline, wait for the reap, then resolve.
    if (!(entry.async && !entry.asyncRewake))
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

/** Claude's terminal output field accepts only BEL and OSC 0/1/2/9/99/777. */
function validTerminalSequence(value: string): boolean {
  if (!value) return false
  const sequence = /(?:\x07|\x1b\](?:0|1|2|9|99|777);[^\x07\x1b]*(?:\x07|\x1b\\))/gy
  let offset = 0
  while (offset < value.length) {
    sequence.lastIndex = offset
    const match = sequence.exec(value)
    if (!match) return false
    offset = sequence.lastIndex
  }
  return true
}

function resolveWorktreeHookPath(raw: string, cwd: string): { path?: string; error?: string } {
  if (path.isAbsolute(raw) && raw.split(/[\\/]/).some((segment) => segment === "." || segment === ".."))
    return { error: "Worktree hook returned an absolute path containing . or .." }
  const resolved = path.resolve(cwd, raw)
  try {
    if (!statSync(resolved).isDirectory()) return { error: `Worktree hook path is not a directory: ${resolved}` }
    if (resolved.startsWith(cwd + path.sep)) {
      let cursor = cwd
      for (const segment of path.relative(cwd, resolved).split(path.sep)) {
        cursor = path.join(cursor, segment)
        if (lstatSync(cursor).isSymbolicLink())
          return { error: `Worktree hook path uses a symlink below project root: ${cursor}` }
      }
    }
    return { path: resolved }
  } catch {
    return { error: `Worktree hook path does not exist: ${resolved}` }
  }
}

/** Outcome of reading synchronous hook output (reference 812-819). */
export type StdoutClass =
  { kind: "plain" } | { kind: "json"; value: HookJSONOutput } | { kind: "invalid"; message: string }

function tryParseJSON(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function validateOutput(value: unknown): StdoutClass {
  const parsed = HookOutputSchema.safeParse(value)
  return parsed.success
    ? { kind: "json", value: parsed.data as HookJSONOutput }
    : { kind: "invalid", message: parsed.error.message }
}

/**
 * Classify synchronous stdout. Only a whole-output JSON object is control output;
 * anything not starting with `{` or not ending with `}` is plain text (including a
 * truncated object). Several JSON lines are plain text unless one sets an output field.
 */
export function classifyStdout(stdout: string): StdoutClass {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { kind: "plain" }
  const whole = tryParseJSON(trimmed)
  if (whole.ok) return isRecord(whole.value) ? validateOutput(whole.value) : { kind: "plain" }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length >= 2 && lines[0]?.startsWith("{") && lines.at(-1)?.endsWith("}")) {
    const parsed = lines.map(tryParseJSON)
    if (parsed.every((line) => line.ok)) {
      const fields = new Set(Object.keys(HookOutputSchema.shape))
      const setsField = parsed.some(
        (line) => line.ok && isRecord(line.value) && Object.keys(line.value).some((key) => fields.has(key)),
      )
      return setsField
        ? { kind: "invalid", message: "multiple JSON lines include an output object" }
        : { kind: "plain" }
    }
  }
  return { kind: "invalid", message: "hook output is not valid JSON" }
}

/** HTTP bodies must be empty or one JSON object; any other 2xx body is a non-blocking failure. */
function classifyHttpBody(body: string): StdoutClass | { kind: "empty" } {
  const trimmed = body.trim()
  if (!trimmed) return { kind: "empty" }
  const parsed = tryParseJSON(trimmed)
  if (!parsed.ok || !isRecord(parsed.value)) return { kind: "invalid", message: "http body is not a JSON object" }
  return validateOutput(parsed.value)
}

/** Async commands may print logs before a standalone compact JSON response. */
function parseAsyncStdout(stdout: string, command: string): HookJSONOutput | undefined {
  const trimmed = stdout.trim()
  const lines = stdout.split(/\r?\n/).map((line) => line.trim())
  const candidates = [trimmed, ...lines.filter((line) => line.startsWith("{") && line !== trimmed).reverse()]
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue
    let raw: unknown
    try {
      raw = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!isRecord(raw)) continue
    // Claude drops malformed fields independently for async output. Keep the
    // valid siblings, including a valid nested additionalContext beside a bad
    // top-level field (or vice versa).
    const clean: Record<string, unknown> = {}
    for (const [name, schema] of Object.entries(HookOutputSchema.shape)) {
      if (!(name in raw)) continue
      if (name === "hookSpecificOutput" && isRecord(raw[name])) {
        const nested: Record<string, unknown> = {}
        for (const [field, fieldSchema] of Object.entries(HookSpecificOutputSchema.shape)) {
          if (field in raw[name] && fieldSchema.safeParse(raw[name][field]).success) nested[field] = raw[name][field]
        }
        clean[name] = nested
      } else if (schema.safeParse(raw[name]).success) clean[name] = raw[name]
    }
    const parsed = HookOutputSchema.safeParse(clean)
    if (parsed.success) return parsed.data as HookJSONOutput
  }
  if (lines.some((line) => line.startsWith("{"))) log.warn("async hook returned invalid JSON", { command })
  return undefined
}

// ── Payload → stdin envelope ────────────────────────────────────

// Envelope cwd for bash tool events: the call's `workdir` resolved against the instance
// directory (mirrors ShellTool's path.resolve(instanceDir, workdir), minus cygpath
// lookups). Any other event/tool, or a missing/blank/non-string workdir, keeps `cwd`.
function envelopeCwd(payload: HookPayload, cwd: string): string {
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
    case "PermissionDenied": {
      if (payload.toolName.toLowerCase() !== "bash") return cwd
      const input = payload.toolInput
      const workdir = input !== null && typeof input === "object" ? (input as { workdir?: unknown }).workdir : undefined
      if (typeof workdir !== "string" || workdir.length === 0) return cwd
      if (process.platform === "win32") return FSUtil.normalizePath(path.resolve(cwd, FSUtil.windowsPath(workdir)))
      return path.resolve(cwd, workdir)
    }
    default:
      return cwd
  }
}

type HookEnvelope = Record<string, unknown> & { hook_event_name: HookEvent }

/**
 * CC emits `effort` only for events that fire "within a tool-use context" and
 * only when the active model supports the effort parameter. The fork cannot ask
 * every provider whether effort is supported, so it reports the field exactly
 * when a variant is known (see `variantToEffort`) and the event is in that
 * context — the tool-event family plus the turn-terminating Stop events.
 */
const EFFORT_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SubagentStop",
])

function buildStdinEnvelope(payload: HookPayload, ctx: TriggerContext, cwd: string): HookEnvelope {
  // Provider/MCP auth notifications can occur before a user session exists.
  // An empty sentinel in the internal context is not a session identity.
  const sessionlessNotification = payload.event === "Notification" && !ctx.sessionID
  const base: HookEnvelope = {
    hook_event_name: payload.event,
    ...(!sessionlessNotification ? { session_id: ctx.sessionID, transcript_path: ctx.transcriptPath } : {}),
    cwd: envelopeCwd(payload, cwd),
  }
  // `prompt_id` and `scratchpad_dir` are session/prompt-scoped, so the same
  // sessionless-notification rule applies. Both are omitted rather than sent
  // as empty strings: "absent" is part of CC's contract.
  if (!sessionlessNotification && ctx.promptID) base.prompt_id = ctx.promptID
  if (!sessionlessNotification && ctx.scratchpadDir) base.scratchpad_dir = ctx.scratchpadDir
  if (ctx.effort && EFFORT_EVENTS.has(payload.event)) base.effort = { level: ctx.effort }
  // Explicit ctx.permissionMode wins; otherwise derive from agentType so callers only pass agent.
  const permissionMode = ctx.permissionMode ?? (ctx.agentType ? agentToPermissionMode(ctx.agentType) : undefined)
  if (permissionMode) base.permission_mode = permissionMode
  if (ctx.agentID !== undefined) base.agent_id = ctx.agentID
  if (ctx.agentType !== undefined) base.agent_type = ctx.agentType
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
    case "PermissionDenied":
      // Real provenance from the runtime's MCP binding; never reconstructed from the tool name.
      if (ctx.mcpServer) base.mcp_server = { name: ctx.mcpServer.name, source: ctx.mcpServer.source }
  }
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
        ...(payload.durationMs !== undefined ? { duration_ms: payload.durationMs } : {}),
      }
    case "PostToolUseFailure":
      return {
        ...base,
        ...(payload.toolUseID !== undefined ? { tool_use_id: payload.toolUseID } : {}),
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        error: payload.error,
        ...(payload.isInterrupt !== undefined ? { is_interrupt: payload.isInterrupt } : {}),
        ...(payload.durationMs !== undefined ? { duration_ms: payload.durationMs } : {}),
      }
    case "PermissionRequest":
      return {
        ...base,
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
      return {
        ...base,
        prompt: payload.prompt,
        ...(payload.sessionTitle !== undefined ? { session_title: payload.sessionTitle } : {}),
      }
    case "Stop":
      return {
        ...base,
        stop_hook_active: payload.stopHookActive,
        ...(payload.lastAssistantMessage !== undefined ? { last_assistant_message: payload.lastAssistantMessage } : {}),
        ...(payload.backgroundTasks !== undefined ? { background_tasks: payload.backgroundTasks } : {}),
        ...(payload.sessionCrons !== undefined ? { session_crons: payload.sessionCrons } : {}),
      }
    case "StopFailure":
      return {
        ...base,
        stop_hook_active: payload.stopHookActive,
        error: payload.error,
        ...(payload.errorDetails !== undefined ? { error_details: payload.errorDetails } : {}),
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
        ...(payload.backgroundTasks !== undefined ? { background_tasks: payload.backgroundTasks } : {}),
        ...(payload.sessionCrons !== undefined ? { session_crons: payload.sessionCrons } : {}),
      }
    case "PreCompact":
      return {
        ...base,
        trigger: payload.trigger,
        custom_instructions: payload.customInstructions ?? null,
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
        ...(payload.sessionTitle !== undefined ? { session_title: payload.sessionTitle } : {}),
        ...((payload.source === "resume" || payload.source === "fork") && payload.secondsSinceLastResponse !== undefined
          ? {
              seconds_since_last_response: payload.secondsSinceLastResponse,
              ...(payload.contextTokens !== undefined ? { context_tokens: payload.contextTokens } : {}),
              ...(payload.promptCacheLikelyExpired !== undefined
                ? { prompt_cache_likely_expired: payload.promptCacheLikelyExpired }
                : {}),
              ...(payload.estimatedCacheWriteUsd !== undefined
                ? { estimated_cache_write_usd: payload.estimatedCacheWriteUsd }
                : {}),
            }
          : {}),
      }
    case "SessionEnd":
      return { ...base, reason: payload.reason }
    case "Setup":
      return { ...base, trigger: payload.trigger }
    case "TaskCreated":
      return {
        ...base,
        ...(payload.taskID !== undefined ? { task_id: payload.taskID } : {}),
        ...(payload.taskTitle !== undefined ? { task_subject: payload.taskTitle, task_title: payload.taskTitle } : {}),
        ...(payload.taskDescription !== undefined ? { task_description: payload.taskDescription } : {}),
      }
    case "TaskCompleted":
      return {
        ...base,
        ...(payload.taskID !== undefined ? { task_id: payload.taskID } : {}),
        ...(payload.taskTitle !== undefined ? { task_subject: payload.taskTitle, task_title: payload.taskTitle } : {}),
        ...(payload.result !== undefined ? { result: payload.result } : {}),
      }
    case "Elicitation":
      return {
        ...base,
        ...(payload.serverName !== undefined ? { mcp_server_name: payload.serverName } : {}),
        ...((payload.message ?? payload.prompt) ? { message: payload.message ?? payload.prompt } : {}),
        ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
        ...(payload.url !== undefined ? { url: payload.url } : {}),
        ...(payload.elicitationID !== undefined ? { elicitation_id: payload.elicitationID } : {}),
        ...((payload.requestedSchema ?? payload.schema)
          ? { requested_schema: payload.requestedSchema ?? payload.schema }
          : {}),
      }
    case "ElicitationResult":
      return {
        ...base,
        ...(payload.serverName !== undefined ? { mcp_server_name: payload.serverName } : {}),
        ...(payload.action !== undefined ? { action: payload.action } : payload.cancelled ? { action: "cancel" } : {}),
        ...(payload.content !== undefined ? { content: payload.content } : {}),
        ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
        ...(payload.elicitationID !== undefined ? { elicitation_id: payload.elicitationID } : {}),
      }
    case "ConfigChange":
      return {
        ...base,
        ...(payload.source !== undefined ? { source: payload.source } : {}),
        // file_path is the official field; config_path stays for local consumers.
        ...(payload.configPath !== undefined ? { file_path: payload.configPath, config_path: payload.configPath } : {}),
        ...(payload.changes !== undefined ? { changes: payload.changes } : {}),
      }
    case "WorktreeCreate":
      return { ...base, ...(payload.name !== undefined ? { name: payload.name } : {}) }
    case "WorktreeRemove":
      return {
        ...base,
        ...((payload.worktreePath ?? payload.path) !== undefined
          ? { worktree_path: payload.worktreePath ?? payload.path }
          : {}),
      }
    case "InstructionsLoaded":
      return {
        ...base,
        ...(payload.path !== undefined ? { file_path: payload.path } : {}),
        ...(payload.memoryType !== undefined ? { memory_type: payload.memoryType } : {}),
        ...(payload.loadReason !== undefined ? { load_reason: payload.loadReason } : {}),
        ...(payload.globs !== undefined ? { globs: payload.globs } : {}),
        ...(payload.triggerFilePath !== undefined ? { trigger_file_path: payload.triggerFilePath } : {}),
        ...(payload.parentFilePath !== undefined ? { parent_file_path: payload.parentFilePath } : {}),
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
        ...(payload.path !== undefined ? { file_path: payload.path } : {}),
        ...(payload.changeType !== undefined
          ? { event: payload.changeType === "delete" ? "unlink" : payload.changeType }
          : {}),
        ...(payload.path !== undefined ? { path: payload.path } : {}),
        ...(payload.changeType !== undefined ? { change_type: payload.changeType } : {}),
      }
    case "UserPromptExpansion":
      return {
        ...base,
        command_name: payload.commandName,
        prompt: payload.prompt,
        ...(payload.expansionType !== undefined ? { expansion_type: payload.expansionType } : {}),
        ...(payload.commandArgs !== undefined ? { command_args: payload.commandArgs } : {}),
        ...(payload.commandSource !== undefined ? { command_source: payload.commandSource } : {}),
      }
    case "PostToolBatch":
      return {
        ...base,
        tool_calls: payload.toolCalls.map((call) => ({
          tool_name: call.toolName,
          tool_input: call.toolInput,
          ...(call.toolUseID !== undefined ? { tool_use_id: call.toolUseID } : {}),
          tool_response: call.toolResponse,
        })),
      }
    case "TeammateIdle":
      return {
        ...base,
        ...(payload.teammateID !== undefined ? { teammate_id: payload.teammateID } : {}),
        ...(payload.teammateName !== undefined ? { teammate_name: payload.teammateName } : {}),
      }
    case "DirectoryAdded":
      return { ...base, directory: payload.directory, source: payload.source }
    case "PreModelSwitch":
    case "PostModelSwitch":
      return {
        ...base,
        from_model: payload.fromModel,
        to_model: payload.toModel,
        ...(payload.requestedModel !== undefined ? { requested_model: payload.requestedModel } : {}),
        ...(payload.source !== undefined ? { source: payload.source } : {}),
        ...(payload.contextTokens !== undefined ? { context_tokens: payload.contextTokens } : {}),
        ...(payload.promptCacheWarm !== undefined ? { prompt_cache_warm: payload.promptCacheWarm } : {}),
        ...(payload.cacheTtl !== undefined ? { cache_ttl: payload.cacheTtl } : {}),
        ...(payload.estimatedCacheWriteUsd !== undefined
          ? { estimated_cache_write_usd: payload.estimatedCacheWriteUsd }
          : {}),
        ...(payload.pricing !== undefined ? { pricing: payload.pricing } : {}),
      }
    case "MessageDisplay":
      return {
        ...base,
        turn_id: payload.turnID,
        message_id: payload.messageID,
        index: payload.index,
        final: payload.final,
        delta: payload.delta,
      }
  }
  return base
}

/**
 * Decide which target string to feed the matcher for a given event (Claude
 * Code matcher table). Tool-bound events match `tool_name`; lifecycle events
 * match their event-specific field. `undefined` means the event has no matcher
 * support here, so any matcher is ignored and every group runs (CC behavior).
 */
function canonicalToolName(payload: HookPayload, ctx: TriggerContext): string | undefined {
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

function matcherTargets(payload: HookPayload, ctx: TriggerContext): string[] | undefined {
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

/**
 * Tool events report fresh feedback per call (e.g. a PostToolUse validator
 * repeating the same lint error), so their additionalContext is deduplicated
 * only within one trigger. SubagentStart is keyed by the PARENT sessionID but its
 * context lands in a fresh child session each time, so a second subagent (or a
 * resumed task_id) must receive the same text again. Every other event keeps
 * per-session dedup: its context (SessionStart, Stop, …) stays in history after
 * the first injection.
 *
 * Exception to per-session dedup: a SessionStart with source "compact" clears the
 * session's bucket first (see trigger). Compaction removes earlier injected context
 * from model history, so identical text must be injectable again. `resume` keeps
 * per-session dedup: it fires at most once per session per instance, on a fresh
 * instance state whose bucket is empty, so nothing can be wrongly dropped.
 */
const PER_TRIGGER_DEDUP_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  // Each prompt is a new turn: identical text must reach the model again.
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "SubagentStop",
])

/**
 * Identity of a handler for per-trigger dedup: only fully equivalent handlers
 * run once (CC behavior). Every configured field except loader metadata takes
 * part (headers, env allowlists, options, timeout), plus the expanded command
 * or URL. Scoped skill/agent registrations add their origin separately.
 */
function handlerKey(entry: HookCommand, origin?: string): string {
  const target =
    entry.type === "command"
      ? expandCommand(entry)
      : entry.type === "http"
        ? httpUrl(entry)
        : entry.type === "mcp_tool"
          ? `${entry.server}/${entry.tool}`
          : commandText(entry)
  const { __sourceDir: _sourceDir, ...identity } = entry
  return JSON.stringify([origin ?? "settings", target, identity], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

/** Per-event handler availability from the 2026-10-16 Claude Code hooks reference. */
const ALL_HANDLER_TYPES = new Set<HookCommand["type"]>(["command", "http", "mcp_tool", "mcp", "prompt", "agent"])
const OBSERVATIONAL_HANDLER_TYPES = new Set<HookCommand["type"]>(["command", "http", "mcp_tool", "mcp"])
function supportsHandler(event: HookEvent, type: HookCommand["type"]): boolean {
  if (event === "Setup") return type === "command"
  if (event === "SessionStart") return type === "command" || type === "mcp_tool" || type === "mcp"
  if (event === "PermissionRequest") return type !== "agent"
  if (
    [
      "UserPromptSubmit",
      "UserPromptExpansion",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "PermissionDenied",
      "Stop",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "TeammateIdle",
    ].includes(event)
  )
    return ALL_HANDLER_TYPES.has(type)
  return OBSERVATIONAL_HANDLER_TYPES.has(type)
}

// ── Effect service ──────────────────────────────────────────────

interface StopRewakeChain {
  count: number
}

interface State {
  settings: Settings
  cwd: string
  /** Stable project root; survives deletion of `cwd`, so hooks can fall back to it. */
  worktree: string
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
  onceRunning: Map<string, WeakMap<HookCommand, string>>
  stopRewakeChains: Map<string, StopRewakeChain>
  asyncResults: Map<string, TriggerResult>
  asyncFibers: Map<string, Set<Fiber.Fiber<unknown, unknown>>>
  /**
   * Async SessionEnd commands. Their session is gone by design, so ending it must not
   * interrupt them; they run for their side effects and stop only with the instance.
   */
  endFibers: Set<Fiber.Fiber<unknown, unknown>>
  /**
   * Scope-tagged summaries of the currently-effective hooks, computed by
   * `summarizeChain` alongside `settings` (same closure, same hot-reload
   * watcher). `list()` reads this without touching files.
   */
  hooksList: HookSummary[]
}

export interface Interface {
  readonly trigger: (payload: HookPayload, ctx: TriggerContext) => Effect.Effect<TriggerResult>
  /** Deliver completed background command output on the next turn only. */
  readonly drainAsync?: (sessionID: SessionID | string) => Effect.Effect<TriggerResult>
  /** Drop pending output and interrupt background commands owned by this session. */
  readonly clearSession?: (sessionID: SessionID | string) => Effect.Effect<void>
  readonly fileWatchPaths?: () => Effect.Effect<readonly string[]>
  /** Cheap event probe including currently registered session hooks. */
  readonly hasEvent?: (event: HookEvent, sessionID?: SessionID | string) => Effect.Effect<boolean>
  /** Overall SessionEnd budget, accounting for configured hooks and env override. */
  readonly sessionEndTimeout?: () => Effect.Effect<number>
  /** Wait for async SessionEnd commands within the caller's budget; interruption cancels them. */
  readonly settleSessionEnd?: () => Effect.Effect<void>
  /** Register validated skill/agent frontmatter hooks for their actual lifetime. */
  readonly registerScoped?: (sessionID: SessionID | string, input: ScopedHooksInput) => Effect.Effect<void>
  readonly unregisterScoped?: (sessionID: SessionID | string, origin: string) => Effect.Effect<void>
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
    envelope: HookEnvelope,
    cwd: string,
    inHook: boolean,
    environmentFile?: string,
    environment?: Record<string, string | undefined>,
    /** Official tool name from the runtime's real binding; internal identity, never configuration. */
    canonicalName?: string,
    /** Active effort for this trigger, exported to command hooks as `CLAUDE_EFFORT`. */
    effort?: HookEffort,
    /**
     * Stable project root for `CLAUDE_PROJECT_DIR` and its template placeholder.
     * The working directory may move inside the project (cd / MoveSession); the
     * project root does not. Defaults to the resolved working directory.
     */
    projectDir?: string,
  ) => Effect.Effect<HookExecution>
}

interface HookExecution {
  json?: HookJSONOutput
  exitBlock?: string
  rawStdout?: string
  exitCode?: number | null
  /** True only after the handler actually ran successfully; absent means failure. */
  succeeded?: boolean
  /** Failure text for the user-visible `<hook name> hook error` notice; never model context. */
  failureMessage?: string
}

const claudeTools = new Map<
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

function translateClaudeInput(toolName: string, input: object, toClaude: boolean, originalInput?: unknown) {
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

/** Exit 2 on these events keeps the agent working, so a hook that cannot run must not trap it (reference 949). */
const FAILURE_EXEMPT_EVENTS: ReadonlySet<HookEvent> = new Set(["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"])
/** Events whose exit-2 "file is missing" run is a non-blocking error (reference 800). */
const MISSING_FILE_EXIT2_EVENTS: ReadonlySet<HookEvent> = new Set(["Stop", "SubagentStop", "TaskCompleted"])
const MISSING_FILE_STDERR = /no such file or directory|enoent|cannot find (?:module|the (?:file|path))/i

/** `onFailure: "block"` applies to foreground command/http hooks outside the exempt events. */
function blocksOnFailure(entry: HookCommand, event: HookEvent): boolean {
  return entry.onFailure === "block" && !isAsync(entry) && !FAILURE_EXEMPT_EVENTS.has(event)
}

const commandHandler: HookHandler = {
  type: "command",
  run: Effect.fn("SettingsHook.handler.command")(
    function* (entry, envelope, cwd, _inHook, environmentFile, environment, _canonicalName, effort, projectDir) {
      const event = envelope.hook_event_name
      const stdinJSON = JSON.stringify(envelope)
      const { exitCode, stdout, stderr, spawnError, suspect } = yield* Effect.promise((signal) =>
        execShell(entry, stdinJSON, cwd, signal, event, environmentFile, environment, effort, projectDir),
      )
      const failureBlocks = blocksOnFailure(entry, event)

      if (spawnError)
        return {
          json: undefined,
          exitCode: 1,
          failureMessage: spawnError,
          exitBlock: failureBlocks ? `hook failed; blocking because onFailure is "block": ${spawnError}` : undefined,
        }

      // A process that kept the output pipes open after the hook exited could still
      // be writing its decision; refuse the capture instead of trusting a partial allow.
      if (suspect && !isAsync(entry)) {
        log.warn("hook output pipes outlived the hook process; refusing the capture", {
          command: commandText(entry),
        })
        return {
          json: undefined,
          exitCode: 2,
          succeeded: false,
          exitBlock: "hook output was not closed by the hook process; refusing to honor the suspect capture",
        }
      }

      const sync = (text: string): StdoutClass =>
        isAsync(entry)
          ? ((json) => (json ? { kind: "json", value: json } : { kind: "plain" }) as StdoutClass)(
              parseAsyncStdout(text, commandText(entry)),
            )
          : classifyStdout(text)

      // Exit-code 2: block + stderr-as-reason (CC contract)
      if (exitCode === 2) {
        if (
          !isAsync(entry) &&
          MISSING_FILE_EXIT2_EVENTS.has(event) &&
          !stdout.trim() &&
          MISSING_FILE_STDERR.test(stderr)
        ) {
          log.warn("hook exit 2 reports a missing file; treating as non-blocking", { command: commandText(entry) })
          return {
            json: undefined,
            exitCode,
            succeeded: false,
            failureMessage: stderr.trim() || "hook exited with code 2",
            exitBlock: undefined,
          }
        }
        const outcome = sync(stdout)
        const json = outcome.kind === "json" ? outcome.value : undefined
        const reason = stderr.trim() || stdout.trim() || "Hook blocked execution"
        return {
          json,
          // A blocking JSON decision supplies its own reason; allow-style fields never do.
          exitBlock: blockingJsonReason(json) ?? reason,
          rawStdout: stdout,
          exitCode,
        }
      }

      // Other non-zero exits: log and continue (do not abort main flow)
      if (exitCode === null) {
        log.warn("hook command timed out / killed (non-blocking)", {
          command: commandText(entry),
          timeoutMs: entry.timeout ? entry.timeout * 1000 : DEFAULT_TIMEOUT_MS,
        })
        // A canceled child can leave a complete-looking decision in buffered
        // stdout. The hook did not complete, so none of that output is valid.
        return {
          json: undefined,
          rawStdout: undefined,
          exitCode: null,
          succeeded: false,
          failureMessage: `hook timed out after ${entry.timeout ?? DEFAULT_TIMEOUT_MS / 1000}s`,
          exitBlock: failureBlocks ? 'hook timed out; blocking because onFailure is "block"' : undefined,
        }
      }
      if (exitCode !== 0) {
        log.warn("hook command exited non-zero (non-blocking)", {
          command: commandText(entry),
          exitCode,
          stderr: stderr.trim().slice(0, 200),
        })
        return {
          json: undefined,
          exitCode,
          failureMessage: stderr.trim() || `hook exited with code ${exitCode}`,
          exitBlock: failureBlocks ? `hook failed; blocking because onFailure is "block": ${stderr.trim()}` : undefined,
        }
      }

      // exit-0: a whole JSON object is control output, anything else not starting
      // with `{`/ending with `}` is plain text (surfaced via rawStdout for events
      // that inject it), and the remaining cases are parse failures.
      const outcome = sync(stdout)
      const json = outcome.kind === "json" ? outcome.value : undefined
      const invalidJson = outcome.kind === "invalid"
      return {
        json,
        rawStdout: stdout,
        exitCode,
        succeeded: !invalidJson,
        failureMessage: invalidJson ? "hook returned invalid JSON" : undefined,
        exitBlock:
          invalidJson && failureBlocks ? `hook invalid JSON; blocking because onFailure is "block"` : undefined,
      }
    },
  ),
}

/** A JSON object that itself makes a blocking decision names the reason Claude Code uses (reference 827). */
function blockingJsonReason(json: HookJSONOutput | undefined): string | undefined {
  if (!json) return undefined
  const hso = json.hookSpecificOutput
  if (hso && "permissionDecision" in hso && hso.permissionDecision === "deny" && hso.permissionDecisionReason)
    return hso.permissionDecisionReason
  if (json.decision === "block" && json.reason) return json.reason
  return undefined
}

const mcpHandler: HookHandler = {
  type: "mcp",
  run: Effect.fn("SettingsHook.handler.mcp")(function* (entry, envelope, _cwd, _inHook) {
    const mcpSvc = Option.getOrUndefined(yield* Effect.serviceOption(MCP.Service))
    if (!mcpSvc) {
      log.warn("mcp hook skipped: MCP service not in context", { command: commandText(entry) })
      return { json: undefined, exitCode: 1, exitBlock: undefined }
    }
    const timeoutMs = timeoutFor(entry, envelope.hook_event_name)
    const exit = yield* invokeMcpHook(
      mcpSvc,
      commandText(entry),
      envelope,
      typeof envelope.session_id === "string" ? envelope.session_id : undefined,
    ).pipe(Effect.timeout(timeoutMs), Effect.exit)
    if (exit._tag === "Failure") {
      log.warn("mcp hook timed out or failed (non-blocking)", {
        command: commandText(entry),
        error: String(exit.cause),
      })
      return {
        json: undefined,
        exitCode: Cause.isTimeoutError(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) ? null : 1,
        failureMessage: hookFailureText(exit.cause),
        exitBlock: undefined,
      }
    }
    return { ...exit.value, succeeded: exit.value.succeeded ?? true }
  }),
}

/** Readable failure text for the user-visible hook-error notice; never the raw cause. */
function hookFailureText(cause: Cause.Cause<unknown>): string {
  // invokeMcpHook throws, and a throw inside Effect.gen is a defect rather than
  // a typed failure, so both reason kinds carry the message the user needs.
  const error = Option.getOrUndefined(Cause.findErrorOption(cause)) ?? cause.reasons.find(Cause.isDieReason)?.defect
  if (Cause.isTimeoutError(error)) return "hook timed out"
  if (error instanceof Error) return error.message
  return String(error ?? "hook failed")
}

const mcpToolHandler: HookHandler = {
  type: "mcp_tool",
  run: Effect.fn("SettingsHook.handler.mcpTool")(function* (entry, envelope, _cwd, _inHook) {
    const mcpSvc = Option.getOrUndefined(yield* Effect.serviceOption(MCP.Service))
    if (!mcpSvc || !entry.server || !entry.tool) return { json: undefined, exitCode: 1, exitBlock: undefined }
    const command = `mcp__${entry.server.replaceAll(":", "_")}__${entry.tool}`
    const timeoutMs = timeoutFor(entry, envelope.hook_event_name)
    const exit = yield* invokeMcpHook(
      mcpSvc,
      command,
      mcpInput(entry, envelope),
      typeof envelope.session_id === "string" ? envelope.session_id : undefined,
    ).pipe(Effect.timeout(timeoutMs), Effect.exit)
    if (exit._tag === "Failure") {
      log.warn("mcp_tool hook failed", { command, error: String(exit.cause) })
      return {
        json: undefined,
        exitCode: Cause.isTimeoutError(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) ? null : 1,
        failureMessage: hookFailureText(exit.cause),
        exitBlock: undefined,
      }
    }
    return { ...exit.value, succeeded: exit.value.succeeded ?? true }
  }),
}

/**
 * `type: "http"` handler. Per CC protocol, `url` (legacy: `command`) is the
 * endpoint; the envelope is POSTed once as JSON with `headers` after `$VAR` /
 * `${VAR}` interpolation restricted to `allowedEnvVars` (unlisted variables
 * become ""). Timeout comes from `timeoutFor` (600 s default; `timeout`
 * overrides).
 *
 * 2xx empty body → success with no output. 2xx JSON object → parsed with the
 * same HookOutputSchema as command stdout; a schema mismatch is a non-blocking
 * error. 2xx with any other body (plain text, array, multiple JSON lines) →
 * non-blocking error; the text is never injected into context.
 *
 * Non-2xx, connection failure and timeout → non-blocking error (exitCode 1;
 * null on timeout, output discarded). `onFailure: "block"` on a foreground,
 * non-exempt event is the only path that turns them into a synthetic
 * `exitBlock`. There is no retry: one POST per trigger. Hooks must never crash
 * the host.
 *
 * The handler is a plain HookHandler that resolves HttpClient per run via
 * Effect.serviceOption, so `run` stays `R = never` (the WP-4A interface
 * contract); it is registered once in the handler map below.
 */
const httpHandler: HookHandler = {
  type: "http",
  run: Effect.fn("SettingsHook.handler.http")(function* (entry, envelope, _cwd, _inHook) {
    const http = Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient))
    if (!http) {
      log.warn("http hook skipped: HttpClient not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const timeoutMs = timeoutFor(entry, envelope.hook_event_name)

    const url = httpUrl(entry)
    const exit = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(httpHeaders(entry)),
      HttpClientRequest.bodyJson(envelope),
      Effect.flatMap((req) => http.execute(req)),
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
      return {
        json: undefined,
        exitCode: Cause.isTimeoutError(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) ? null : 1,
        failureMessage: hookFailureText(exit.cause),
        exitBlock: blocksOnFailure(entry, envelope.hook_event_name)
          ? `http hook failed; blocking because onFailure is "block"`
          : undefined,
      }
    }

    const { status, text } = exit.value
    if (status < 200 || status >= 300) {
      return {
        json: undefined,
        exitCode: 1,
        failureMessage: `hook returned status ${status}`,
        exitBlock: blocksOnFailure(entry, envelope.hook_event_name)
          ? `http hook returned status ${status}; blocking because onFailure is "block"`
          : undefined,
      }
    }
    const body = classifyHttpBody(text)
    if (body.kind === "empty") return { json: undefined, succeeded: true }
    const json = body.kind === "json" ? body.value : undefined
    return {
      json,
      succeeded: !!json,
      failureMessage: json ? undefined : "hook returned invalid JSON",
      exitBlock:
        !json && blocksOnFailure(entry, envelope.hook_event_name)
          ? `http hook invalid JSON; blocking because onFailure is "block"`
          : undefined,
    }
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
      const prompt = evaluatorPrompt(entry, envelope)
      const m = yield* evaluatorModel(provider, entry)
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
          {
            role: "system",
            content: "Evaluate the hook condition and return JSON with ok, and reason when ok is false.",
          } as ModelMessage,
          { role: "user", content: prompt } as ModelMessage,
        ],
        schema: HookEvaluatorOutputSchema,
      } satisfies Parameters<typeof generateObject>[0]

      // issue #286 — the header doc promises `timeout` for every hook type,
      // but promptHandler was the only executor never applying it. Honor it
      // with the same idiom as command/mcp/http; on expiry the TimeoutException
      // is captured by Effect.exit below and degrades to the non-blocking warn.
      const timeoutMs = timeoutFor(entry, envelope.hook_event_name)

      const llmExit = yield* Effect.tryPromise({
        try: (abortSignal) => generateObject({ ...params, abortSignal }).then((r) => r.object),
        catch: (e) => e,
      }).pipe(Effect.timeout(timeoutMs), Effect.exit)

      if (llmExit._tag === "Failure") {
        log.warn("prompt hook failed (non-blocking)", { error: String(llmExit.cause) })
        return { json: undefined, exitBlock: undefined }
      }
      return {
        json: evaluatorDecision(entry, envelope.hook_event_name, llmExit.value),
        exitBlock: undefined,
        succeeded: true,
      }
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
      const prompt = evaluatorPrompt(entry, envelope)
      const m = yield* evaluatorModel(provider, entry)
      const resolved = yield* provider.getModel(m.providerID, m.modelID)
      const language = yield* provider.getLanguage(resolved)
      const authInfo = yield* auth.get(m.providerID).pipe(Effect.orDie)

      if (m.providerID === "openai" && authInfo?.type === "oauth") {
        log.warn("agent hook: OpenAI OAuth provider not supported in v1", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }

      const captured: { value: HookEvaluatorOutput | null } = { value: null }
      const timeoutMs = timeoutFor(entry, envelope.hook_event_name)

      const loopExit = yield* Effect.tryPromise({
        try: async (signal) => {
          const tools = buildAgentTools({ spawner, fs, signal, cwd, captured })
          const messages: ModelMessage[] = [
            {
              role: "system",
              content:
                "Investigate the hook condition using read-only tools. End by calling synthetic_output with ok and a reason when false.",
            },
            { role: "user", content: prompt },
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
            })
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
            hint: "deep-investigation hooks must also raise entry.timeout — the 60s default aborts well before MAX_AGENT_TURNS (50) is reached",
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
      return {
        json: evaluatorDecision(entry, envelope.hook_event_name, loopExit.value),
        exitBlock: undefined,
        succeeded: true,
      }
    }).pipe(Effect.exit)

    if (exit._tag === "Failure") {
      log.warn("agent hook setup failed (non-blocking)", { error: String(exit.cause) })
      return { json: undefined, exitBlock: undefined }
    }
    return exit.value
  }),
}

// The agent loop has a bounded turn count and a separate 60-second default timeout.
const MAX_AGENT_TURNS = 50

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

/** Literal FileChanged matcher entries are the static watch list. */
function staticWatchPaths(settings: Settings): readonly string[] {
  return [
    ...new Set(
      (settings.hooks?.FileChanged ?? [])
        .flatMap((group) => (group.matcher === undefined || group.matcher === "" ? [] : group.matcher.split("|")))
        .filter(Boolean),
    ),
  ]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessionHooks = yield* SessionHooks.Service
    // Optional: only a full runtime has sessions that can veto a reload and watchers to refresh.
    const configChange = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
    const fileWatch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
    const handlerContext = Context.pick(
      MCP.Service,
      Provider.Service,
      Auth.Service,
      FSUtil.Service,
      ChildProcessSpawner,
      HttpClient.HttpClient,
    )(yield* Effect.context())

    const state = yield* InstanceState.make(
      Effect.fn("SettingsHook.state")(function* (instCtx) {
        const chain = loadChainWithSummaries(instCtx.directory, instCtx.worktree)
        const stateObj = {
          settings: chain.settings,
          hooksList: chain.summaries,
          cwd: instCtx.directory,
          worktree: instCtx.worktree,
          seen: new Map<string, Set<string>>(),
          once: new Map<string, WeakSet<HookCommand>>(),
          onceRunning: new Map<string, WeakMap<HookCommand, string>>(),
          stopRewakeChains: new Map<string, StopRewakeChain>(),
          asyncResults: new Map<string, TriggerResult>(),
          asyncFibers: new Map<string, Set<Fiber.Fiber<unknown, unknown>>>(),
          endFibers: new Set<Fiber.Fiber<unknown, unknown>>(),
        } satisfies State

        // Async commands are started from the service's background scope, but
        // their ownership is the directory instance. Dispose must interrupt
        // every command before the instance disappears.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [...stateObj.asyncFibers.values()].flatMap((fibers) => [...fibers]).concat([...stateObj.endFibers]),
            (fiber) => Fiber.interrupt(fiber),
            { discard: true },
          ),
        )

        // [FORK:hook-ext] Hot-reload hooks.json at runtime. A changed file produces a
        // CANDIDATE chain. Invalid JSON never replaces a valid chain. The ConfigChange hooks
        // then run against the CURRENT (old) settings in the real sessions of this instance;
        // a block keeps the old chain. Only an accepted candidate is committed, in one
        // synchronous assignment, and the static FileChanged watchers follow it. The watcher
        // serializes reloads and its close() (run by the finalizer below) interrupts the one
        // in flight, so a disposed instance can never commit.
        const bridge = yield* EffectBridge.make()
        const reloadCandidate = Effect.fn("SettingsHook.reloadCandidate")(function* (changedFile: string) {
          const candidate = loadChainWithSummaries(instCtx.directory, instCtx.worktree)
          if (candidate.invalid.length > 0) {
            log.warn("hooks.json is not valid JSON; keeping the current hooks", { files: candidate.invalid })
            return undefined
          }
          const scope = chainCandidates(instCtx.directory, instCtx.worktree).find(
            (item) => item.file === changedFile,
          )?.scope
          const source =
            scope === "global" ? "user_settings" : scope === "worktree" ? "local_settings" : "project_settings"
          // Real sessions of this instance decide first; with none registered, the hooks
          // run once without a session. Failures of the hooks themselves never block.
          const asked: HookConfigChange.Decision = configChange
            ? yield* configChange
                .checkInstance({ path: changedFile, source })
                .pipe(Effect.catch(() => Effect.succeed<HookConfigChange.Decision>({})))
            : {}
          let blocked = asked.blocked
          if ((asked.checked ?? 0) === 0) {
            const fallback: TriggerResult = yield* trigger(
              { event: "ConfigChange", source, configPath: changedFile },
              { sessionID: "", transcriptPath: "" },
            ).pipe(
              Effect.catchCause(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
            )
            blocked = fallback.blocked
          }
          if (blocked) {
            log.info("hooks reload blocked by a ConfigChange hook", { file: changedFile })
            return undefined
          }
          stateObj.settings = candidate.settings
          stateObj.hooksList = candidate.summaries
          if (fileWatch)
            yield* fileWatch.refreshStatic(
              candidate.settings.disableAllHooks === true ? [] : staticWatchPaths(candidate.settings),
            )
          return candidate.settings
        })
        const handle = watchSettings(
          instCtx.directory,
          instCtx.worktree,
          (changedFile) => bridge.run(reloadCandidate(changedFile)),
          () => {},
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
      mcp_tool: mcpToolHandler,
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
      envelope: HookEnvelope,
      cwd: string,
      inHook: boolean,
      environmentFile?: string,
      environment?: Record<string, string | undefined>,
      canonicalName?: string,
      projectDir?: string,
      effort?: HookEffort,
      toolOutput?: unknown,
    ) {
      using _ = log.time("runEntry", { type: entry.type, command: commandText(entry).slice(0, 80) })
      const resolvedCwd = resolveHookCwd([cwd, projectDir, os.homedir(), os.tmpdir()])
      if (resolvedCwd !== cwd)
        log.warn("hook working directory unavailable; using fallback", { cwd, fallback: resolvedCwd })
      // CLAUDE_PROJECT_DIR names the project root for the whole session, even
      // when the session was opened in (or moved to) a checkout subdirectory.
      // A directory outside the project, or a non-VCS "/" worktree, keeps cwd.
      const hookProjectDir = hasWorktreeLayer(resolvedCwd, projectDir) ? projectDir : resolvedCwd
      if (entry.type === "http") {
        const settings = (yield* InstanceState.get(state)).settings
        if (!httpHookUrlAllowed(httpUrl(entry), settings.allowedHttpHookUrls)) {
          log.warn("http hook destination rejected by allowedHttpHookUrls", { url: httpUrl(entry) })
          return {
            json: undefined as HookJSONOutput | undefined,
            exitBlock: undefined as string | undefined,
            rawStdout: undefined as string | undefined,
            exitCode: undefined as number | null | undefined,
          }
        }
        if (settings.httpHookAllowedEnvVars !== undefined) {
          const allowed = new Set(settings.httpHookAllowedEnvVars)
          entry = { ...entry, allowedEnvVars: (entry.allowedEnvVars ?? []).filter((name) => allowed.has(name)) }
        }
      }
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
      const nativeName = typeof envelope.tool_name === "string" ? envelope.tool_name : ""
      const claudeName =
        entry.inputFormat === "claude-code"
          ? (canonicalName ?? claudeTools.get(nativeName.toLowerCase())?.name)
          : undefined
      const adapted = claudeName
        ? {
            ...envelope,
            tool_name: claudeName,
            tool_input: isRecord(envelope.tool_input)
              ? translateClaudeInput(nativeName, envelope.tool_input, true)
              : envelope.tool_input,
            ...(envelope.hook_event_name === "PostToolUse"
              ? {
                  tool_response: claudeToolResponse(
                    nativeName,
                    envelope.tool_input,
                    toolOutput,
                    envelope.tool_response,
                  ),
                }
              : {}),
          }
        : envelope
      const result = yield* handler
        .run(entry, adapted, resolvedCwd, inHook, environmentFile, environment, canonicalName, effort, hookProjectDir)
        .pipe(Effect.updateContext((current: Context.Context<never>) => Context.merge(handlerContext, current)))
      const hso = result.json?.hookSpecificOutput
      if (claudeName && envelope.hook_event_name === "PreToolUse" && hso && "updatedInput" in hso && hso.updatedInput)
        hso.updatedInput = translateClaudeInput(nativeName, hso.updatedInput, false, envelope.tool_input)
      if (
        claudeName &&
        envelope.hook_event_name === "PermissionRequest" &&
        hso &&
        "decision" in hso &&
        hso.decision?.updatedInput
      )
        hso.decision.updatedInput = translateClaudeInput(
          nativeName,
          hso.decision.updatedInput,
          false,
          envelope.tool_input,
        )
      return result
    })

    // Background scope for async hooks. Lives as long as the SettingsHook service
    // instance; closed via finalizer when the instance is disposed.
    const bgScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(bgScope, Exit.void))

    const clearEndedSession = Effect.fn("SettingsHook.clearEndedSession")(function* (s: State, sessionID: string) {
      yield* sessionHooks.clear(SessionID.make(sessionID))
      s.seen.delete(sessionID)
      s.once.delete(sessionID)
      s.onceRunning.delete(sessionID)
      s.asyncResults.delete(sessionID)
      for (const fiber of s.asyncFibers.get(sessionID) ?? []) yield* Fiber.interrupt(fiber)
      s.asyncFibers.delete(sessionID)
    })

    /**
     * Async hook completion handler. Computes rewake-worthiness from the result
     * and, when `asyncRewake` is set, admits a steer prompt to the originating
     * session via the opencode Session.Service (ambient in the session runtime).
     * Best-effort — all errors swallowed to honor the "never crash host" contract.
     */
    const onAsyncComplete = Effect.fnUntraced(function* (
      entry: HookCommand,
      sessionEntry: SessionHookEntry | undefined,
      sessionOwner: string | undefined,
      event: HookEvent,
      sessionID: string | undefined,
      hookRewake: HookRewake.Interface | undefined,
      state: State,
      stopChain: StopRewakeChain | undefined,
      result: HookExecution,
      entryToken?: string,
    ) {
      const running = state.onceRunning.get(sessionOwner ?? sessionID ?? "")
      const ownsEntry = !!entryToken && running?.get(entry) === entryToken
      if (ownsEntry) running?.delete(entry)
      if (
        sessionEntry &&
        sessionEntry.kind !== "agent" &&
        entry.once &&
        ownsEntry &&
        result.succeeded === true &&
        !result.exitBlock &&
        sessionID
      ) {
        const onceBucket = state.once.get(sessionOwner ?? sessionID) ?? new WeakSet<HookCommand>()
        onceBucket.add(entry)
        state.once.set(sessionOwner ?? sessionID, onceBucket)
      }
      // SessionEnd has no later turn.
      if (event === "SessionEnd") return
      if (!sessionID) return
      const parts: string[] = []
      if (result.exitBlock) parts.push(result.exitBlock)
      if (result.json?.systemMessage) parts.push(result.json.systemMessage)
      if (result.json?.decision === "block" && result.json.reason) parts.push(result.json.reason)
      const hso = result.json?.hookSpecificOutput
      if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string") {
        parts.push(hso.additionalContext)
      }
      // Asynchronous hooks deliver only their JSON fields; plain stdout is never context.
      if (parts.length === 0) {
        return
      }

      // Ordinary async output waits for the next actual turn. asyncRewake only
      // wakes an idle session on exit 2; normal completion never invents a turn.
      if (!entry.asyncRewake || result.exitCode !== 2 || !hookRewake) {
        const queued = state.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
        // Ordinary async JSON fields are both model feedback on the next turn;
        // unlike synchronous systemMessage, neither is an ephemeral UI warning.
        // Sanitize at the queue's only producer: both consumers (V1 SessionPrompt
        // and the V2 turn bridge) drain raw strings, so an escaped/bounded value
        // must already be in the queue. This also keeps an oversized payload from
        // accumulating in memory while it waits for the next turn.
        const spillDir = yield* HookTranscript.scratchpadDir(sessionID)
        if (result.json?.systemMessage)
          queued.additionalContexts.push(sanitizeHookContext(result.json.systemMessage, spillDir))
        if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string")
          queued.additionalContexts.push(sanitizeHookContext(hso.additionalContext, spillDir))
        state.asyncResults.set(sessionID, queued)
        return
      }

      if (stopChain) {
        // A newer non-hook prompt, SessionEnd, or session cancel invalidates
        // pending Stop callbacks.
        if (state.stopRewakeChains.get(`${event}:${sessionID}`) !== stopChain) {
          log.debug("async Stop callback discarded: chain invalidated", { sessionID, event })
          return
        }
        const continuationCap = stopHookBlockCap()
        if (stopChain.count >= continuationCap) {
          log.warn("async Stop hook continuation limit reached", { sessionID, limit: continuationCap })
          return
        }
        // Reserve before yielding so concurrent completions share the same bound.
        stopChain.count++
      }

      // Claude ignores StopFailure output and exit code. Keep the chain invalidation above so a cancelled callback
      // is still discarded, but never queue context or start a new turn from this event.
      if (event === "StopFailure") return

      const text = buildRewakePrompt(
        entry,
        event,
        result.exitBlock ?? parts.join("\n"),
        yield* HookTranscript.scratchpadDir(sessionID),
      )
      // The token rides along so SessionPrompt can re-check validity at the
      // real admission point — cancel can invalidate after this completion
      // check but before the rewake lands.
      yield* hookRewake
        .rewake({
          sessionID: SessionID.make(sessionID),
          text,
          stopChain,
          valid: () =>
            Effect.sync(() => !stopChain || state.stopRewakeChains.get(`${event}:${sessionID}`) === stopChain),
        })
        .pipe(
          Effect.catchDefect((defect) => {
            log.warn("async hook rewake defect swallowed", {
              command: commandText(entry).slice(0, 80),
              error: String(defect),
            })
            return Effect.void
          }),
        )
    })

    const triggerRun = Effect.fn("SettingsHook.trigger")(function* (payload: HookPayload, ctx: TriggerContext) {
      using _ = log.time("trigger", { event: payload.event, sessionID: ctx.sessionID })
      const s = yield* InstanceState.get(state)
      const result: TriggerResult = { additionalContexts: [], systemMessages: [] }

      // Hook rewake prompts skip UserPromptSubmit in SessionPrompt. Every other
      // prompt (including a Goal continuation) begins a new automatic hook chain.
      const clearStopChains = (sessionID: string) => {
        for (const key of s.stopRewakeChains.keys()) if (key.endsWith(`:${sessionID}`)) s.stopRewakeChains.delete(key)
      }
      if (payload.event === "UserPromptSubmit" && ctx.sessionID) clearStopChains(ctx.sessionID)
      if (payload.event === "SessionEnd" && ctx.sessionID) clearStopChains(ctx.sessionID)
      let stopChain: StopRewakeChain | undefined
      if (
        (payload.event === "Stop" || payload.event === "StopFailure" || payload.event === "SubagentStop") &&
        ctx.sessionID
      ) {
        // Stop, StopFailure and SubagentStop have independent chains. Sharing one key leaks stop_hook_active from a
        // main Stop rewake into a later subagent stop.
        const chainKey = `${payload.event}:${ctx.sessionID}`
        stopChain = s.stopRewakeChains.get(chainKey) ?? { count: 0 }
        s.stopRewakeChains.set(chainKey, stopChain)
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
        s.onceRunning.delete(ctx.sessionID)
        // NOTE: sessionHooks.clear is deferred to after hook execution
        // (before each return point below) — clearing here would remove
        // session-registered SessionEnd hooks before the matcher can see them.
      }

      // Compaction dropped earlier injected context from model history: forget what this
      // session has seen so re-injection is not suppressed (per-session dedup resumes after).
      // Done before the short-circuits: other events' texts must be forgotten even when no
      // SessionStart hook is configured.
      if (payload.event === "SessionStart" && payload.source === "compact") s.seen.delete(ctx.sessionID)

      // ── WP-6A: O(1) short-circuit ─────────────────────────────
      // Skip the entire matcher pipeline (envelope build, target derivation,
      // session merge allocation, matcher regex) when neither the on-disk
      // settings chain nor the session store has any entry for this event.
      // s.settings is already cached on the InstanceState, so the file-side
      // probe is a property access. The session probe is O(1) (Map.get +
      // .some over the session's own array, typically empty).
      const sessionEvent: HookEvent = payload.event
      if (s.settings.disableAllHooks === true) {
        log.info("trigger short-circuit", { event: payload.event, reason: "disableAllHooks" })
        if (payload.event === "SessionEnd" && ctx.sessionID) yield* clearEndedSession(s, ctx.sessionID)
        return result
      }
      const hasFile = (s.settings.hooks?.[payload.event]?.length ?? 0) > 0
      const hasSession = ctx.sessionID
        ? yield* sessionHooks.hasForEvent(SessionID.make(ctx.sessionID), sessionEvent)
        : false
      const hasChildAgent =
        payload.event === "SubagentStop" && payload.agentID
          ? yield* sessionHooks.hasForEvent(SessionID.make(payload.agentID), "SubagentStop")
          : false
      if (!hasFile && !hasSession && !hasChildAgent) {
        log.info("trigger short-circuit", { event: payload.event, reason: "no_matchers", hasFile, hasSession })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* clearEndedSession(s, ctx.sessionID)
        }
        return result
      }

      const fileMatchers = s.settings.hooks?.[payload.event] ?? []

      // ── Session-scoped hook resolution (WP-5D) ────────────────
      // Sub-agent stop semantics: if the caller marks this trigger as
      // running inside a sub-agent and fires `Stop`, look up SubagentStop
      // session hooks. Settings-file lookup still uses payload.event verbatim
      // (the on-disk chain is already correctly addressed by callers).
      const sessionEntries = ctx.sessionID
        ? yield* sessionHooks.list(SessionID.make(ctx.sessionID), sessionEvent)
        : ([] as readonly SessionHookEntry[])
      // Task publishes its terminal SubagentStop from the parent session, but
      // frontmatter belongs to the child session. Include only that child's
      // agent-scoped entries; unrelated dynamic hooks cannot cross sessions.
      const childAgentEntries =
        payload.event === "SubagentStop" && payload.agentID
          ? (yield* sessionHooks.list(SessionID.make(payload.agentID), "SubagentStop")).filter(
              (entry) => entry.kind === "agent" && entry.child,
            )
          : []

      // Tag matchers with their origin so once-cleanup can remove session ones
      // after execution. The settings chain matchers carry no _sessionEntry.
      type RunMatcher = HookMatcher & { _sessionEntry?: SessionHookEntry; _sessionOwner?: string }
      const matchers: RunMatcher[] = [
        ...fileMatchers,
        ...sessionEntries.map(
          (e) =>
            ({
              matcher: e.matcher,
              hooks: e.hooks,
              _sessionEntry: e,
              _sessionOwner: ctx.sessionID,
            }) satisfies RunMatcher,
        ),
        ...childAgentEntries.map(
          (e) =>
            ({
              matcher: e.matcher,
              hooks: e.hooks,
              _sessionEntry: e,
              _sessionOwner: payload.event === "SubagentStop" ? payload.agentID : undefined,
            }) satisfies RunMatcher,
        ),
      ]
      if (!matchers.length) {
        log.info("trigger short-circuit", { event: payload.event, reason: "empty_matchers" })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* clearEndedSession(s, ctx.sessionID)
        }
        return result
      }

      const targets = matcherTargets(payload, ctx)
      // CC's `scratchpad_dir`: create it only now, after the short-circuits, so
      // sessions that never run a hook leave no directory behind. A failed
      // mkdir makes the field absent instead of failing the hook.
      const scratchpadDir =
        ctx.scratchpadDir ?? (ctx.sessionID ? yield* HookTranscript.scratchpadDir(ctx.sessionID) : undefined)
      const envelope = buildStdinEnvelope(payload, scratchpadDir ? { ...ctx, scratchpadDir } : ctx, s.cwd)
      // Identical handlers matched by several groups/layers run once per trigger.
      const ran = new Set<string>()
      // additionalContext dedup: only within this trigger for tool events,
      // per session otherwise (see PER_TRIGGER_DEDUP_EVENTS).
      const local = new Set<string>()
      const addContext = (raw: string) => {
        const text = sanitizeHookContext(raw, scratchpadDir)
        if (local.has(text)) return
        local.add(text)
        // SubagentStart lands in the target child's history, so only that child's own
        // earlier copy suppresses it; a sibling or the parent never does.
        const bucket = payload.event === "SubagentStart" ? payload.agentID : ctx.sessionID
        if (!PER_TRIGGER_DEDUP_EVENTS.has(payload.event) && !addSeen(s.seen, bucket, text)) return
        result.additionalContexts.push(text)
      }
      const runWithStatus = (entry: HookCommand, origin?: string) =>
        Effect.gen(function* () {
          // Never publish the handler definition: commands and HTTP headers can
          // contain private values. The stable digest only correlates spinner
          // start and finish events for this handler.
          const hookID = createHash("sha256").update(handlerKey(entry, origin)).digest("hex")
          if (entry.statusMessage && ctx.sessionID)
            yield* HookNotification.status(ctx.sessionID, hookID, entry.statusMessage, "started")
          return yield* runEntry(
            entry,
            envelope,
            s.cwd,
            false,
            ctx.environmentFile,
            ctx.environment,
            ctx.canonicalToolName,
            s.worktree,
            ctx.effort,
            payload.event === "PostToolUse" ? payload.toolOutput : undefined,
          ).pipe(
            Effect.ensuring(
              entry.statusMessage && ctx.sessionID
                ? HookNotification.status(ctx.sessionID, hookID, entry.statusMessage, "finished")
                : Effect.void,
            ),
          )
        })

      // Match and claim once before starting any handlers. Foreground handlers
      // then start concurrently; their results are reduced below in settings
      // order so conflicting decisions remain deterministic.
      const planned = new Map<string, Fiber.Fiber<HookExecution> | "async">()
      const claimedEntries = new Map<
        string,
        {
          owner: string
          id: string
          token: string
          remaining: Set<string>
          transferred: Set<string>
          succeeded: boolean
        }
      >()
      const settleGroup = Effect.fnUntraced(function* (claimKey: string, entryKey: string, succeeded: boolean) {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const claim = claimedEntries.get(claimKey)
            if (!claim?.remaining.delete(entryKey)) return
            claim.succeeded ||= succeeded
            if (claim.remaining.size > 0) return
            yield* sessionHooks.complete(SessionID.make(claim.owner), claim.id, claim.token, claim.succeeded)
            claimedEntries.delete(claimKey)
          }),
        )
      })
      const runningEntries: Array<{ owner: string; entry: HookCommand; token: string }> = []
      const releaseRunning = (owner: string, entry: HookCommand, token?: string) => {
        const running = s.onceRunning.get(owner)
        const owned = !!token && running?.get(entry) === token
        if (owned) running?.delete(entry)
        const index = runningEntries.findIndex(
          (item) => item.owner === owner && item.entry === entry && item.token === token,
        )
        if (index !== -1) runningEntries.splice(index, 1)
        return owned
      }
      const transferRunning = (owner: string, entry: HookCommand, token?: string) => {
        const index = runningEntries.findIndex(
          (item) => item.owner === owner && item.entry === entry && item.token === token,
        )
        if (index !== -1) runningEntries.splice(index, 1)
      }
      // A trigger may be interrupted while joining a foreground handler. Scope
      // finalization releases every reservation it still owns, including a
      // group claim made before the first handler started.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const [key, claim] of claimedEntries) {
            // Only background entries transferred to bgScope may outlive this
            // trigger. Interrupted foreground and not-yet-forked entries fail.
            for (const entryKey of claim.remaining)
              if (!claim.transferred.has(entryKey)) claim.remaining.delete(entryKey)
            if (claim.remaining.size === 0) {
              yield* sessionHooks.complete(SessionID.make(claim.owner), claim.id, claim.token, claim.succeeded)
              claimedEntries.delete(key)
            }
          }
          for (let index = runningEntries.length - 1; index >= 0; index--) {
            const item = runningEntries[index]
            if (item) releaseRunning(item.owner, item.entry, item.token)
          }
        }),
      )
      for (const group of matchers) {
        if (targets !== undefined && !targets.some((target) => matches(group.matcher, target, payload.event))) continue
        let claimed = false
        for (const entry of group.hooks) {
          if (!supportsHandler(payload.event, entry.type)) continue
          if (
            (entry.type === "mcp_tool" || entry.type === "mcp") &&
            (payload.event === "Setup" ||
              (payload.event === "SessionStart" && ["startup", "resume", "fork"].includes(payload.source)))
          )
            continue
          if (
            forkHooks?.beforeRunEntry &&
            !forkHooks.beforeRunEntry(entry, envelope, payload.event, {
              canonicalToolName: canonicalToolName(payload, ctx),
            })
          )
            continue
          const key = handlerKey(entry, group._sessionEntry?.origin)
          if (planned.has(key)) continue
          const onceOwner = group._sessionOwner ?? ctx.sessionID
          const onceBucket = s.once.get(onceOwner) ?? new WeakSet<HookCommand>()
          const runningBucket = s.onceRunning.get(onceOwner) ?? new WeakMap<HookCommand, string>()
          if (
            entry.once &&
            group._sessionEntry &&
            group._sessionEntry.kind !== "agent" &&
            (onceBucket.has(entry) || runningBucket.has(entry))
          )
            continue
          if (group._sessionEntry?.once && group._sessionOwner && !claimed) {
            const owner = group._sessionOwner
            const id = group._sessionEntry.id
            const token = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const reserved = yield* sessionHooks.claim(SessionID.make(owner), id)
                if (!reserved) return undefined
                claimedEntries.set(`${owner}:${id}`, {
                  owner,
                  id,
                  token: reserved,
                  remaining: new Set<string>(),
                  transferred: new Set<string>(),
                  succeeded: false,
                })
                return reserved
              }),
            )
            if (!token) break
            claimed = true
          }
          if (entry.once && group._sessionEntry && group._sessionEntry.kind !== "agent") {
            const token = crypto.randomUUID()
            runningBucket.set(entry, token)
            s.onceRunning.set(onceOwner, runningBucket)
            runningEntries.push({ owner: onceOwner, entry, token })
          }
          if (group._sessionEntry?.once && group._sessionOwner)
            claimedEntries.get(`${group._sessionOwner}:${group._sessionEntry.id}`)?.remaining.add(key)
          planned.set(
            key,
            isAsync(entry) ? "async" : yield* runWithStatus(entry, group._sessionEntry?.origin).pipe(Effect.forkChild),
          )
        }
      }

      for (const group of matchers) {
        if (targets !== undefined && !targets.some((target) => matches(group.matcher, target, payload.event))) continue

        for (const entry of group.hooks) {
          // Forward-compat: skip truly unknown types so future schema additions don't crash
          // older handlers. Known types (command/mcp/http/prompt/agent) all flow into runEntry.
          const key = handlerKey(entry, group._sessionEntry?.origin)
          if (ran.has(key)) continue
          const pending = planned.get(key)
          if (!pending) continue
          ran.add(key)

          // ── Async fork (hook-async-rewake) ──────────────────────
          // async:true and asyncRewake:true entries are forked into the background and do NOT
          // participate in the current TriggerResult aggregation. Their output
          // (when asyncRewake:true) is delivered back via onAsyncComplete →
          // Session.rewake once the background fiber settles.
          if (isAsync(entry)) {
            const hookRewake = Option.getOrUndefined(yield* Effect.serviceOption(HookRewake.Service))
            const capturedEvent = payload.event
            const capturedSessionID = ctx.sessionID
            const claimKey = `${group._sessionOwner}:${group._sessionEntry?.id}`
            const claim = claimedEntries.get(claimKey)
            const owner = group._sessionOwner ?? capturedSessionID
            const entryToken = s.onceRunning.get(owner)?.get(entry)
            let fiber: Fiber.Fiber<unknown, unknown> | undefined
            let succeeded = false
            const background = runWithStatus(entry, group._sessionEntry?.origin).pipe(
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
                  succeeded: false,
                })
              }),
              Effect.flatMap((r) => {
                succeeded = r.succeeded === true && !r.exitBlock
                return Effect.gen(function* () {
                  // Exit-2 rewake may park in a busy session. Its command has
                  // settled, so release this handler before waiting there.
                  // Ordinary async output, however, must reach the next-turn
                  // queue before the claim becomes an observable barrier.
                  if (claim && entry.asyncRewake && r.exitCode === 2 && hookRewake)
                    yield* settleGroup(claimKey, key, succeeded)
                  yield* onAsyncComplete(
                    entry,
                    group._sessionEntry,
                    group._sessionOwner,
                    capturedEvent,
                    capturedSessionID,
                    hookRewake,
                    s,
                    stopChain,
                    r,
                    entryToken,
                  )
                  if (claim) yield* settleGroup(claimKey, key, succeeded)
                })
              }),
              Effect.catchDefect((defect) => {
                log.warn("async hook completion defect swallowed", {
                  command: commandText(entry),
                  error: String(defect),
                })
                return Effect.void
              }),
              Effect.ensuring(
                Effect.gen(function* () {
                  if (claim) yield* settleGroup(claimKey, key, succeeded)
                  const running = s.onceRunning.get(owner)
                  if (entryToken && running?.get(entry) === entryToken) running.delete(entry)
                  if (fiber) {
                    s.endFibers.delete(fiber)
                    s.asyncFibers.get(capturedSessionID)?.delete(fiber)
                  }
                }),
              ),
            )
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                claim?.transferred.add(key)
                fiber = yield* background.pipe(Effect.forkIn(bgScope))
                if (capturedEvent === "SessionEnd") s.endFibers.add(fiber)
                else {
                  const owned = s.asyncFibers.get(capturedSessionID) ?? new Set<Fiber.Fiber<unknown, unknown>>()
                  owned.add(fiber)
                  s.asyncFibers.set(capturedSessionID, owned)
                }
                transferRunning(owner, entry, entryToken)
              }),
            )
            continue
          }
          if (pending === "async") continue

          // "Never crash host" contract: a hook handler can throw an unrecoverable
          // defect (null deref, OOM, native assert). Effect.catch at the tool-layer
          // call sites only catches typed Failures, so a defect would propagate and
          // kill the session. Catch defects here at the single entry-execution point
          // (covers all handler types: command/mcp/http/prompt/agent) → silent allow,
          // log, and continue to the next entry.
          const { json, exitBlock, rawStdout, exitCode, succeeded, failureMessage } = yield* Fiber.join(pending).pipe(
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
                succeeded: false,
                failureMessage: undefined,
              })
            }),
          )
          // Reference parity: a hook that failed without blocking still leaves a
          // user-visible `<hook name> hook error` notice. It never enters model
          // context, tool feedback, or any hook decision.
          if (succeeded !== true && !exitBlock && failureMessage)
            (result.hookErrors ??= []).push(
              `${group.matcher ? `${payload.event}:${group.matcher}` : payload.event} hook error: ${sanitizeHookContext(failureMessage, scratchpadDir)}`,
            )
          if (group._sessionEntry?.once && group._sessionOwner)
            yield* settleGroup(
              `${group._sessionOwner}:${group._sessionEntry.id}`,
              key,
              succeeded === true && !exitBlock,
            )
          const onceOwner = group._sessionOwner ?? ctx.sessionID
          const owned = releaseRunning(
            onceOwner,
            entry,
            runningEntries.find((item) => item.owner === onceOwner && item.entry === entry)?.token,
          )
          if (
            entry.once &&
            owned &&
            succeeded &&
            !exitBlock &&
            group._sessionEntry &&
            group._sessionEntry.kind !== "agent"
          ) {
            const owner = group._sessionOwner ?? ctx.sessionID
            const onceBucket = s.once.get(owner) ?? new WeakSet<HookCommand>()
            onceBucket.add(entry)
            s.once.set(owner, onceBucket)
          }

          // [FORK:hook-ext] Post-dispatch observation — never modifies result
          forkHooks?.afterRunEntry?.(entry, envelope, payload.event, { json, exitBlock })

          // Exit-code-2 block beats stdout decision
          const observational = new Set<HookEvent>([
            "Setup",
            "Notification",
            "SessionStart",
            "SubagentStart",
            "PostModelSwitch",
            "SessionEnd",
            "PostCompact",
            "InstructionsLoaded",
            "StopFailure",
            "CwdChanged",
            "DirectoryAdded",
            "FileChanged",
            "MessageDisplay",
            "WorktreeCreate",
            "WorktreeRemove",
          ])
          if (exitBlock && SHOW_STDERR_EVENTS.has(payload.event))
            result.systemMessages.push(sanitizeHookContext(exitBlock, scratchpadDir))
          if (exitBlock && payload.event !== "PermissionRequest" && !observational.has(payload.event)) {
            result.blocked = { reason: exitBlock, command: commandText(entry) }
            // A failed or exit-2 PreToolUse hook is a deny that outranks defer, and no JSON
            // from any hook can lift it.
            if (payload.event === "PreToolUse") {
              result.permissionDecision = "deny"
              result.permissionDecisionReason = exitBlock
              result.updatedInput = undefined
            }
          }
          if (exitBlock && payload.event === "PermissionRequest" && entry.onFailure === "block" && exitCode !== 2)
            result.permissionRequestDecision = { behavior: "deny", message: exitBlock }
          if (payload.event === "Elicitation" || payload.event === "ElicitationResult") {
            if (exitBlock) {
              result.elicitation = { action: "decline" }
              result.blocked = undefined
            }
          }
          if (payload.event === "WorktreeCreate" && exitCode !== undefined && exitCode !== 0)
            result.blocked = { reason: exitBlock ?? "Worktree creation hook failed", command: commandText(entry) }
          if (
            payload.event === "WorktreeRemove" &&
            exitCode !== undefined &&
            exitCode !== 0 &&
            existsSync(payload.worktreePath ?? payload.path ?? "")
          ) {
            result.worktreeRemoveFailed = true
            result.blocked = { reason: exitBlock ?? "Worktree removal hook failed", command: commandText(entry) }
          }
          if (payload.event === "PreModelSwitch" && exitCode === null)
            result.blocked = { reason: "Model-switch hook timed out", command: commandText(entry) }

          if (
            payload.event === "WorktreeCreate" &&
            (entry.type === "command" || entry.type === "mcp" || entry.type === "mcp_tool")
          ) {
            if (succeeded) {
              const lines = (rawStdout ?? "")
                .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
                .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
              const returned = lines.at(-1)
              if (returned) result.worktreePath = returned
              else result.blocked = { reason: "Worktree creation hook returned no path", command: commandText(entry) }
            }
            continue
          }

          if (!json) {
            // P1a: exit-0 plain-text stdout → additionalContext for the two
            // events CC injects it for (UserPromptSubmit / SessionStart). JSON
            // stdout was already parsed above (json defined → this branch
            // skipped); only non-JSON exit-0 output reaches here. Runs through
            // the same per-session dedup bucket as hookSpecificOutput.
            if (
              rawStdout &&
              succeeded &&
              (payload.event === "UserPromptSubmit" ||
                payload.event === "UserPromptExpansion" ||
                payload.event === "SessionStart" ||
                payload.event === "PostModelSwitch")
            ) {
              const text = rawStdout.trim()
              if (text) addContext(text)
            }
            continue
          }

          const topLevelBlockEvents = new Set<HookEvent>([
            "UserPromptSubmit",
            "UserPromptExpansion",
            "PostToolUse",
            "PostToolUseFailure",
            "PostToolBatch",
            "Stop",
            "SubagentStop",
            "ConfigChange",
            "PreCompact",
            "TaskCreated",
            "TaskCompleted",
            "PreModelSwitch",
          ])
          if (json.decision === "block" && topLevelBlockEvents.has(payload.event) && !result.blocked) {
            result.blocked = { reason: json.reason ?? "Blocked by hook", command: commandText(entry) }
          }
          if ((payload.event === "Elicitation" || payload.event === "ElicitationResult") && json.decision === "block") {
            result.elicitation = { action: "decline" }
            result.blocked = undefined
          }

          if (
            json.continue === false &&
            !observational.has(payload.event) &&
            payload.event !== "TaskCreated" &&
            !(payload.event === "TaskCompleted" && payload.source === "task_update") &&
            payload.event !== "ConfigChange" &&
            payload.event !== "PreCompact" &&
            payload.event !== "Elicitation" &&
            payload.event !== "ElicitationResult"
          ) {
            result.preventContinuation = true
            if (json.stopReason && !result.stopReason) result.stopReason = json.stopReason
          }

          if (
            json.systemMessage &&
            (!observational.has(payload.event) ||
              payload.event === "FileChanged" ||
              payload.event === "CwdChanged" ||
              payload.event === "SessionStart" ||
              payload.event === "SubagentStart" ||
              payload.event === "PostModelSwitch") &&
            payload.event !== "ConfigChange" &&
            payload.event !== "PreCompact" &&
            payload.event !== "Elicitation" &&
            payload.event !== "ElicitationResult"
          )
            result.systemMessages.push(sanitizeHookContext(json.systemMessage, scratchpadDir))
          if ((payload.event === "FileChanged" || payload.event === "CwdChanged") && json.watchPaths)
            result.watchPaths = json.watchPaths
          if (json.terminalSequence && validTerminalSequence(json.terminalSequence))
            (result.terminalSequences ??= []).push(json.terminalSequence)
          if (json.terminalSequence && validTerminalSequence(json.terminalSequence) && ctx.sessionID)
            yield* HookNotification.terminal(ctx.sessionID, json.terminalSequence)

          // Missing discriminator is retained as a legacy OpenCode alias; a
          // present but different event name cannot control this event.
          const parsedHso = HookSpecificOutputSchema.safeParse(json.hookSpecificOutput)
          const hso =
            (!(payload.event === "Elicitation" || payload.event === "ElicitationResult") ||
              exitCode === undefined ||
              exitCode === 0) &&
            (!json.hookSpecificOutput?.hookEventName || json.hookSpecificOutput.hookEventName === payload.event)
              ? parsedHso.success
                ? parsedHso.data
                : undefined
              : undefined
          // Property-based narrowing — works across union variants without depending on
          // hookEventName tag (which the fallback variant may also accept).
          if (
            hso &&
            "additionalContext" in hso &&
            typeof hso.additionalContext === "string" &&
            new Set<HookEvent>([
              "SessionStart",
              "SubagentStart",
              "UserPromptSubmit",
              "UserPromptExpansion",
              "PreToolUse",
              "PostToolUse",
              "PostToolUseFailure",
              "PostToolBatch",
              "Stop",
              "SubagentStop",
              "PostModelSwitch",
            ]).has(payload.event)
          ) {
            // Per-session dedup (F2) applies to non-tool events; the bucket is
            // keyed by TriggerContext.sessionID (see addContext).
            addContext(hso.additionalContext)
          }
          // Deprecated top-level approve/block map to allow/deny; hookSpecificOutput wins.
          const hsoDecision = hso && "permissionDecision" in hso ? hso.permissionDecision : undefined
          const preDecision =
            payload.event === "PreToolUse"
              ? (hsoDecision ?? (json.decision ? (json.decision === "approve" ? "allow" : "deny") : undefined))
              : undefined
          const preReason =
            hsoDecision !== undefined && hso && "permissionDecisionReason" in hso
              ? hso.permissionDecisionReason
              : hsoDecision === undefined
                ? json.reason
                : undefined
          if (payload.event === "PreToolUse" && preDecision) {
            const incoming = preDecision
            const current = result.permissionDecision
            // Most-restrictive-wins: deny > defer > ask > allow. A later hook cannot
            // relax an earlier hook's deny (Claude Code permission semantics).
            const moreRestrictive =
              current === undefined ||
              { allow: 0, ask: 1, defer: 2, deny: 3 }[incoming] > { allow: 0, ask: 1, defer: 2, deny: 3 }[current]
            if (moreRestrictive) {
              result.permissionDecision = incoming
              result.permissionDecisionReason = preReason
            }
          }
          if (
            payload.event === "PreToolUse" &&
            hso &&
            "updatedInput" in hso &&
            hso.updatedInput &&
            result.permissionDecision !== "defer" &&
            !result.blocked
          ) {
            result.updatedInput = hso.updatedInput
          }
          if (
            payload.event === "PermissionRequest" &&
            hso &&
            "decision" in hso &&
            hso.decision &&
            (entry.type === "command" || entry.type === "http" || entry.type === "mcp" || entry.type === "mcp_tool")
          ) {
            if (hso.decision.behavior === "deny" || result.permissionRequestDecision?.behavior !== "deny")
              result.permissionRequestDecision = hso.decision
          }
          if (payload.event === "PostToolUse" && hso) {
            if (Object.hasOwn(hso, "updatedToolOutput"))
              result.updatedToolOutput = (hso as { updatedToolOutput?: unknown }).updatedToolOutput
            if (Object.hasOwn(hso, "updatedMCPToolOutput"))
              result.updatedMCPToolOutput = (hso as { updatedMCPToolOutput?: unknown }).updatedMCPToolOutput
          }
          if (
            (payload.event === "Elicitation" || payload.event === "ElicitationResult") &&
            hso &&
            "action" in hso &&
            hso.action
          ) {
            if (hso.action === "decline" || result.elicitation?.action !== "decline")
              result.elicitation = { action: hso.action, content: "content" in hso ? hso.content : undefined }
          }
          if (payload.event === "SessionStart" && hso) {
            // This value is admitted as a user turn, so it gets the same reminder
            // escaping and length bound as every other hook-supplied string.
            if (hso.initialUserMessage !== undefined)
              result.initialUserMessage = sanitizeHookContext(hso.initialUserMessage, scratchpadDir)
            if ("watchPaths" in hso) result.watchPaths = hso.watchPaths
            if ("sessionTitle" in hso) result.sessionTitle = hso.sessionTitle
            if ("reloadSkills" in hso) result.reloadSkills = hso.reloadSkills
          }
          if ((payload.event === "FileChanged" || payload.event === "CwdChanged") && hso && "watchPaths" in hso)
            result.watchPaths = hso.watchPaths
          if (payload.event === "UserPromptSubmit" && hso) {
            if ("sessionTitle" in hso) result.sessionTitle = hso.sessionTitle
            if ("suppressOriginalPrompt" in hso) result.suppressOriginalPrompt = hso.suppressOriginalPrompt
          }
          if (payload.event === "PermissionDenied" && hso && hso.retry === true) result.retry = true
          if (
            payload.event === "PreModelSwitch" &&
            hso &&
            hso.permissionDecision &&
            hso.permissionDecision !== "defer"
          ) {
            const incoming = hso.permissionDecision
            const current = result.modelSwitchDecision
            if (
              current === undefined ||
              { allow: 0, ask: 1, deny: 2 }[incoming] > { allow: 0, ask: 1, deny: 2 }[current]
            ) {
              result.modelSwitchDecision = incoming
              result.modelSwitchDecisionReason = hso.permissionDecisionReason
            }
          }
          if (payload.event === "MessageDisplay" && hso && Object.hasOwn(hso, "displayContent"))
            result.displayContent = hso.displayContent
          if (payload.event === "WorktreeCreate" && hso && "worktreePath" in hso) result.worktreePath = hso.worktreePath
        }
      }

      if (payload.event === "WorktreeCreate" && ran.size > 0) {
        if (!result.worktreePath) {
          result.blocked ??= { reason: "Worktree creation hook returned no path", command: "WorktreeCreate" }
        } else {
          const resolved = resolveWorktreeHookPath(result.worktreePath, s.cwd)
          if (resolved.error) result.blocked = { reason: resolved.error, command: "WorktreeCreate" }
          else result.worktreePath = resolved.path
        }
      }

      if (payload.event === "SessionEnd" && ctx.sessionID) {
        yield* clearEndedSession(s, ctx.sessionID)
      }
      return result
    })
    const trigger = (payload: HookPayload, ctx: TriggerContext) => triggerRun(payload, ctx).pipe(Effect.scoped)

    const list = Effect.fn("SettingsHook.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooksList
    })

    const hasEvent = Effect.fn("SettingsHook.hasEvent")(function* (event: HookEvent, sessionID?: SessionID | string) {
      const s = yield* InstanceState.get(state)
      if (s.settings.disableAllHooks === true) return false
      if ((s.settings.hooks?.[event]?.length ?? 0) > 0) return true
      return sessionID ? yield* sessionHooks.hasForEvent(SessionID.make(sessionID), event) : false
    })

    const drainAsync = Effect.fn("SettingsHook.drainAsync")(function* (sessionID: SessionID | string) {
      const s = yield* InstanceState.get(state)
      const queued = s.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
      s.asyncResults.delete(sessionID)
      return queued
    })

    const clearSession = Effect.fn("SettingsHook.clearSession")(function* (sessionID: SessionID | string) {
      const s = yield* InstanceState.get(state)
      s.asyncResults.delete(sessionID)
      s.seen.delete(sessionID)
      s.once.delete(sessionID)
      s.onceRunning.delete(sessionID)
      for (const key of s.stopRewakeChains.keys()) if (key.endsWith(`:${sessionID}`)) s.stopRewakeChains.delete(key)
      for (const fiber of s.asyncFibers.get(sessionID) ?? []) yield* Fiber.interrupt(fiber)
      s.asyncFibers.delete(sessionID)
      yield* sessionHooks.clear(SessionID.make(String(sessionID)))
    })

    const fileWatchPaths = Effect.fn("SettingsHook.fileWatchPaths")(function* () {
      const s = yield* InstanceState.get(state)
      return s.settings.disableAllHooks === true ? [] : staticWatchPaths(s.settings)
    })

    const sessionEndTimeout = Effect.fn("SettingsHook.sessionEndTimeout")(function* () {
      const override = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS)
      if (Number.isFinite(override) && override > 0) return override
      const s = yield* InstanceState.get(state)
      const configured = (s.settings.hooks?.SessionEnd ?? [])
        .flatMap((group) => group.hooks)
        .map((entry) => (entry.timeout === undefined ? 1_500 : entry.timeout * 1000))
      return Math.min(60_000, Math.max(1_500, ...configured))
    })

    // Async SessionEnd commands run for side effects after the session ends. A headless client waits for the
    // configured SessionEnd budget, then cancels what remains; an instance that outlives the process keeps them.
    const settleSessionEnd = Effect.fn("SettingsHook.settleSessionEnd")(function* () {
      const s = yield* InstanceState.get(state)
      const fibers = [...s.endFibers]
      if (fibers.length === 0) return
      yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { concurrency: "unbounded" }).pipe(
        Effect.onInterrupt(() =>
          Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded" }),
        ),
        Effect.asVoid,
      )
    })

    const registerScoped = Effect.fn("SettingsHook.registerScoped")(
      (sessionID: SessionID | string, input: ScopedHooksInput) =>
        sessionHooks.registerScoped(SessionID.make(String(sessionID)), input).pipe(
          Effect.catchTag("InvalidHookError", (error) => {
            log.warn("invalid scoped hooks ignored", { kind: input.kind, origin: input.origin, error: error.message })
            return Effect.void
          }),
        ),
    )

    const unregisterScoped = Effect.fn("SettingsHook.unregisterScoped")(
      (sessionID: SessionID | string, origin: string) =>
        sessionHooks.unregisterScoped(SessionID.make(String(sessionID)), origin),
    )

    // A pending Stop/SubagentStop/StopFailure rewake chain dies with the
    // user's cancel intent. `stopRewakeChains` holds one chain object per
    // session while callbacks are in flight; identity comparison is monotonic
    // across abort/prompt cycles: after invalidation, a later Stop trigger
    // creates a new chain object, so an old token cannot match that chain.
    const invalidateStopRewakeChain = Effect.fn("SettingsHook.invalidateStopRewakeChain")(function* (
      sessionID: SessionID | string,
    ) {
      const s = yield* InstanceState.get(state)
      let deleted = false
      for (const key of s.stopRewakeChains.keys())
        if (key.endsWith(`:${sessionID}`)) deleted = s.stopRewakeChains.delete(key) || deleted
      if (deleted) log.info("stop rewake chain invalidated", { sessionID })
    })

    const validateStopRewakeChain = Effect.fn("SettingsHook.validateStopRewakeChain")(function* (
      sessionID: SessionID | string,
      token: unknown,
    ) {
      const s = yield* InstanceState.get(state)
      for (const [key, chain] of s.stopRewakeChains) if (key.endsWith(`:${sessionID}`) && chain === token) return true
      return false
    })

    return Service.of({
      trigger,
      list,
      hasEvent,
      drainAsync,
      clearSession,
      fileWatchPaths,
      sessionEndTimeout,
      settleSessionEnd,
      registerScoped,
      unregisterScoped,
      invalidateStopRewakeChain,
      validateStopRewakeChain,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionHooks.defaultLayer),
    Layer.provide(HookConfigChange.defaultLayer),
    Layer.provide(HookFileWatch.defaultLayer),
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
 * tool with the hook envelope as `arguments`. The first text content item is
 * treated as command stdout: JSON supplies control output, while plain text
 * remains available to event-specific consumers. Other content is ignored.
 */
function invokeMcpHook(
  mcpSvc: MCP.Interface,
  command: string,
  input: Record<string, unknown>,
  sessionID?: string,
): Effect.Effect<{ json?: HookJSONOutput; rawStdout?: string; succeeded?: boolean }, unknown> {
  return Effect.gen(function* () {
    if (!command.startsWith("mcp__")) {
      log.warn("mcp hook command must start with mcp__", { command })
      throw new Error(`Invalid MCP hook command: ${command}`)
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
      throw new Error(`MCP hook tool not found: ${command}`)
    }

    const execute = tool.execute
    if (!execute) {
      log.warn("mcp hook tool has no execute()", { command })
      throw new Error(`MCP hook tool has no execute(): ${command}`)
    }

    const result = yield* Effect.promise((signal) =>
      Promise.resolve(
        execute(
          input,
          mcpHookOptions(
            {
              toolCallId: `hook-${Date.now()}`,
              messages: [],
              abortSignal: signal,
            },
            sessionID,
          ),
        ),
      ),
    )

    if (!result || typeof result !== "object" || !("content" in result)) return {}
    if ("isError" in result && result.isError === true) {
      log.warn("mcp hook tool returned isError", { command })
      throw new Error(`MCP hook tool returned isError: ${command}`)
    }

    const content = result.content
    if (!Array.isArray(content)) return {}
    const firstText = content.find(
      (item: unknown): item is { type: "text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )?.text
    if (firstText === undefined) return {}

    const outcome = classifyStdout(firstText)
    if (outcome.kind === "invalid") log.warn("mcp hook returned invalid output", { command, error: outcome.message })
    return {
      json: outcome.kind === "json" ? outcome.value : undefined,
      rawStdout: firstText,
      succeeded: outcome.kind !== "invalid",
    }
  })
}

// Resolve module references after initialization; provider/plugin imports can
// otherwise encounter this module while their own node exports are in the TDZ.
export const node = {
  ...LayerNode.make(layer, [SessionHooks.node]),
  get dependencies() {
    return [
      SessionHooks.node,
      HookConfigChange.node,
      HookFileWatch.node,
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
