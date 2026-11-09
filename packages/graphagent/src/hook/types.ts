/**
 * Hook protocol types shared by the hook engine.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1). Runtime
 * behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import type { Effect } from "effect"
import type { PermissionUpdate } from "./schema"

// ── Hook protocol types ────────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "UserPromptSubmit"
  | "PermissionRequest"
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
  "DirectoryAdded",
  "PreModelSwitch",
  "PostModelSwitch",
  "MessageDisplay",
])

/** Layer of the hooks.json chain that declared an entry. */
export type HookSourceScope = "global" | "project" | "local"

/** Loader metadata naming the layer and file a hook entry came from. */
export interface HookSource {
  readonly scope: HookSourceScope
  readonly file: string
}

/**
 * Identity of the Stop-continuation chain that produced an async rewake.
 *
 * `epoch` is the session-cancellation epoch (`SessionCancellation.epoch`); it
 * advances on every cancel. `generation` advances whenever the session's
 * rewake chain resets: a real (non-rewake) UserPromptSubmit, SessionEnd,
 * clearSession, or a user cancel. A callback whose token no longer matches
 * either value must never wake the session.
 */
export interface RewakeToken {
  readonly epoch: number
  readonly generation: number
}

export interface HookCommand {
  /**
   * Hook execution kind.
   * - `command`: shell command via stdin/stdout JSON envelope
   * - `mcp_tool`: invoke MCP tool `server`/`tool`
   * - `http`: POST envelope to URL, parse JSON body
   * - `prompt`: LLM call with structured output (HookJSONOutput schema)
   * - `agent`: autonomous agent loop with bash/read_file/list_dir/grep tools
   */
  type: "command" | "mcp_tool" | "http" | "prompt" | "agent"
  command?: string
  args?: string[]
  server?: string
  tool?: string
  input?: Record<string, unknown>
  /** Claude Code `type:"http"` endpoint. */
  url?: string
  /** Claude Code `type:"prompt" | "agent"` prompt. */
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
  /** Per-handler compatibility adapter. Omitted or graphagent preserves the native envelope. */
  inputFormat?: "graphagent" | "claude-code"
  /**
   * Conditional gate, evaluated by `match.ts` during trigger planning BEFORE a
   * matched entry runs (returning false skips the entry). Syntax:
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
   * Runtime metadata naming the hooks.json layer that declared this hook.
   * Injected by the chain loader, never authored by users, and excluded from
   * handler identity so the same handler dedups across layers. The `__` prefix
   * marks it as loader-owned.
   */
  __source?: HookSource
  /**
   * Runtime metadata reserved for a plugin/scoped source: absolute directory
   * driving `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`. The hooks.json chain
   * does not stamp it (there is no plugin source), so a hooks.json handler is
   * never given those variables. The `__` prefix marks it loader-owned.
   */
  __sourceDir?: string
}

export const isAsync = (entry: HookCommand) => entry.async === true || entry.asyncRewake === true

export interface HookMatcher {
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
   * value left after layer precedence applies decides (global, then project, then local), so
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
  scope: HookSourceScope
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

/**
 * hookSpecificOutput discriminated union — Claude Code 1:1.
 * 仅 5 个事件有 union 分支；Stop / SubagentStop / PreCompact / SessionEnd
 * 在 CC types/hooks.ts:50-166 中无对应 case，仅消费顶层字段（continue/decision/reason 等）。
 *
 * `hookEventName` is the discriminator: reduce.ts ignores the whole
 * hookSpecificOutput object when it is missing or names a different event.
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
  | { event: "Notification"; message: string; title?: string; notificationType?: string }
  | {
      event: "UserPromptSubmit"
      prompt: string
      sessionTitle?: string
      /** DAG mode of the top-level session; omitted for child sessions and when unset. */
      dagMode?: "on" | "off"
    }
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
      /** DAG mode of the top-level session; omitted for child sessions and when unset. */
      dagMode?: "on" | "off"
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

// Callers provide truthful session identifiers. Tool-event cwd follows a Bash
// call's workdir; all other events use the current instance directory.
export interface TriggerContext {
  sessionID: string
  /**
   * Lazily materialize this session's JSONL transcript. The engine evaluates it
   * at most once per trigger, immediately before the first handler starts, and
   * only when a handler will actually run; sessionless triggers omit it (and
   * the stdin envelope then omits `transcript_path`). Callers that already hold
   * a stable snapshot may return it directly instead of re-materializing.
   */
  transcript?: () => Effect.Effect<string>
  /**
   * Which environment file `CLAUDE_ENV_FILE` names. `session` (default) is the
   * SessionStart layer; `directory` is the overlay a CwdChanged hook writes.
   */
  environmentLifetime?: "session" | "directory"
  /** Explicit override for the environment file the engine would derive lazily. */
  environmentFile?: string
  /** Explicit override for the session environment the engine would load lazily. */
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

/**
 * Narrow trigger context for tool-lifecycle calls (`SettingsHook.Interface.hookCall`).
 * The engine fills transcript, environment, prompt identity and permission mode
 * lazily; tool call sites only provide the real session and tool/MCP identity.
 */
export type ToolHookContext = Pick<
  TriggerContext,
  "sessionID" | "canonicalToolName" | "mcpServer" | "agentID" | "agentType" | "isSubAgent"
>

/** CC's effort levels (the `level` reported inside the `effort` envelope object). */
export type HookEffort = "low" | "medium" | "high" | "xhigh" | "max"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export type HookEnvelope = Record<string, unknown> & { hook_event_name: HookEvent }
