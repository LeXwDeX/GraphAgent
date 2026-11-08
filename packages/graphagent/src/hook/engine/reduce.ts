/**
 * TriggerResult reduction from one completed hook handler.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import { existsSync } from "fs"
import { Effect } from "effect"
import { HookNotification } from "../notifications"
import { HookSpecificOutputSchema } from "../schema"
import { validTerminalSequence } from "../exec/output"
import { commandText } from "../exec/command"
import type { HookCommand, HookEvent, HookJSONOutput, HookPayload, TriggerContext } from "../types"
import type { TriggerResult } from "../trigger-result"
import { sanitizeHookContext } from "./async"

const SHOW_STDERR_EVENTS = new Set<HookEvent>([
  "SessionStart",
  "SessionEnd",
  "CwdChanged",
  "FileChanged",
  "PostCompact",
  "SubagentStart",
  "PostModelSwitch",
])

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
export const PER_TRIGGER_DEDUP_EVENTS: ReadonlySet<HookEvent> = new Set([
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

export interface ApplyResultArgs {
  payload: HookPayload
  ctx: TriggerContext
  scratchpadDir: string | undefined
  result: TriggerResult
  addContext: (raw: string) => void
  entry: HookCommand
  json: HookJSONOutput | undefined
  exitBlock: string | undefined
  rawStdout: string | undefined
  exitCode: number | null | undefined
  succeeded: boolean | undefined
}

export const applyResult = Effect.fnUntraced(function* (args: ApplyResultArgs) {
  const { payload, ctx, scratchpadDir, result, addContext, entry, json, exitBlock, rawStdout, exitCode, succeeded } =
    args
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
    return
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
    return
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
  if (payload.event === "PreModelSwitch" && hso && hso.permissionDecision && hso.permissionDecision !== "defer") {
    const incoming = hso.permissionDecision
    const current = result.modelSwitchDecision
    if (current === undefined || { allow: 0, ask: 1, deny: 2 }[incoming] > { allow: 0, ask: 1, deny: 2 }[current]) {
      result.modelSwitchDecision = incoming
      result.modelSwitchDecisionReason = hso.permissionDecisionReason
    }
  }
  if (payload.event === "MessageDisplay" && hso && Object.hasOwn(hso, "displayContent"))
    result.displayContent = hso.displayContent
  if (payload.event === "WorktreeCreate" && hso && "worktreePath" in hso) result.worktreePath = hso.worktreePath
})
