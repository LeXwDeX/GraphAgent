/**
 * Claude Code-compatible stdin envelope construction.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import path from "path"
import { lstatSync, statSync } from "fs"
import { FSUtil } from "@graphagent/core/fs-util"
import type { HookEnvelope, HookEvent, HookPayload, TriggerContext } from "./types"
import { agentToPermissionMode } from "./match"

export function resolveWorktreeHookPath(raw: string, cwd: string): { path?: string; error?: string } {
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

// ── Payload → stdin envelope ────────────────────────────────────

// Envelope cwd for bash tool events: the call's `workdir` resolved against the instance
// directory (mirrors ShellTool's path.resolve(instanceDir, workdir), minus cygpath
// lookups). Any other event/tool, or a missing/blank/non-string workdir, keeps `cwd`.
function envelopeCwd(payload: HookPayload, cwd: string): string {
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest": {
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
  "Stop",
  "StopFailure",
  "SubagentStop",
])

/**
 * A trigger context whose lazy transcript has already been resolved by the
 * engine. `transcriptPath` stays internal to envelope construction: the public
 * context never carries an eagerly materialized path.
 */
export type EnvelopeContext = TriggerContext & { transcriptPath?: string }

export function buildStdinEnvelope(payload: HookPayload, ctx: EnvelopeContext, cwd: string): HookEnvelope {
  // Provider/MCP auth notifications can occur before a user session exists.
  // An empty sentinel in the internal context is not a session identity.
  const sessionlessNotification = payload.event === "Notification" && !ctx.sessionID
  const base: HookEnvelope = {
    hook_event_name: payload.event,
    // A sessionless trigger has no transcript to name. `transcript_path` is
    // omitted rather than sent as an empty string: "absent" is part of CC's
    // contract for events that do not run inside a session.
    ...(!sessionlessNotification ? { session_id: ctx.sessionID } : {}),
    ...(!sessionlessNotification && ctx.transcriptPath !== undefined ? { transcript_path: ctx.transcriptPath } : {}),
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
        // Read-only: hooks observe the session's DAG mode; they cannot change it.
        ...(payload.dagMode !== undefined ? { dag_mode: payload.dagMode } : {}),
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
        // Read-only: hooks observe the session's DAG mode; they cannot change it.
        ...(payload.dagMode !== undefined ? { dag_mode: payload.dagMode } : {}),
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
