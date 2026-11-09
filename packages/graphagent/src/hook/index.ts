// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings-based hooks with Claude Code-compatible envelopes and explicit runtime support.
 *
 * Reads hooks from a dedicated hooks.json chain (later layers concat-append on
 * top of earlier ones, mirroring Claude Code's merge semantics — hooks
 * accumulate, they do not replace):
 *
 *   1. ~/.config/graphagent/hooks.json         (global, hot-reloaded)
 *   2. <root>/.agents/hooks.json               (project, hot-reloaded)
 *   3. <root>/.agents/hooks.local.json         (local, hot-reloaded)
 *
 * A linked worktree is itself a project root, so there is no separate worktree
 * layer. `.claude/` directories are never read for hooks (complete cut).
 *
 * Supports the Claude Code hook event surface at the protocol/schema layer.
 *
 * Hook entry types:
 *   - { type: "command",   command: "<shell>", timeout?: <seconds> }
 *   - { type: "mcp_tool",  server: "<server>", tool: "<tool>", timeout?: <seconds> }
 *   - { type: "http",      url: "<url>", timeout?: <seconds> }
 *   - { type: "prompt",    prompt: "<llm-system-prompt>", timeout?: <seconds> }
 *   - { type: "agent",     prompt: "<llm-task-prompt>", timeout?: <seconds> }
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

export type {
  HookCommand,
  HookEffort,
  HookEvent,
  HookJSONOutput,
  HookPayload,
  HookSpecificOutput,
  HookSummary,
  HookSource,
  HookSourceScope,
  RewakeToken,
  Settings,
  ToolHookContext,
  TriggerContext,
} from "./types"
export { VALID_HOOK_EVENTS } from "./types"
export { expandHookCommand, resolveHookShell } from "./exec/command"
export type { ResolvedShell, ShellProbe } from "./exec/command"
export { classifyStdout } from "./exec/output"
export type { StdoutClass } from "./exec/output"
export { agentToPermissionMode } from "./match"
export { detectUnsupportedFields, readJSON, warnUnsupportedFields } from "./config/load"
export { loadChain, loadChainWithSummaries, mergeSettings, summarizeChain } from "./config/chain"
export type { HookLayer } from "./config/chain"
export { chainCandidates as __chainCandidates } from "./config/chain"
export { landSystemMessages } from "./trigger-result"
export type { TriggerResult } from "./trigger-result"
export { HOOK_REWAKE_SENTINEL, MAX_STOP_CONTINUATIONS, sanitizeHookContext, stopHookBlockCap } from "./engine/async"
export type { Interface } from "./service"
export { Service, defaultLayer, layer, node } from "./service"

export * as SettingsHook from "./index"
