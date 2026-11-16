// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Trigger binding table (Issue #1070, step 1).
 *
 * Every hook event has exactly one entry. The entry names the one canonical
 * state transition the event derives from, a value of a domain in the shared
 * lifecycle vocabulary (#1069, `@graphagent/core/lifecycle/vocabulary`), or
 * says that no such transition exists yet. The table is data only. The
 * engine does not read it and no trigger site consults it yet; the single
 * dispatcher that does is the next step of #1070.
 *
 * Two kinds of binding exist:
 *
 * - `lifecycle`: the event rides on a vocabulary value (`domain` -> `to`).
 *   `when` states, in words, which of that value's transitions carries the
 *   event; it is the contract text and is not machine-checked.
 * - `unbound`: no canonical transition names the point where the owner fires
 *   the event today. The vocabulary has no domain for it (compaction,
 *   worktree, MCP elicitation, ...), so the table says so instead of
 *   inventing one. This list is a ratchet (`test/hook/binding-table.test.ts`):
 *   it may only shrink, as the vocabulary gains the missing domains.
 *
 * `HOOK_BINDINGS` is typed `Record<HookEvent, ...>`, so adding an event to the
 * union without a binding fails the typecheck; the test pins the runtime
 * `VALID_HOOK_EVENTS` set to the same keys.
 */
import type { Domain } from "@graphagent/schema/lifecycle-status"
import type { HookEvent } from "./types"

export interface LifecycleTransition {
  readonly kind: "lifecycle"
  /** A domain of the shared vocabulary. */
  readonly domain: Domain
  /** A value of that domain (`valuesOf(domain)`). */
  readonly to: string
  /** Which transition into `to` carries the event, as contract text. */
  readonly when: string
}

export interface UnboundTransition {
  readonly kind: "unbound"
  /** Why no canonical transition exists for the point where the event fires. */
  readonly reason: string
}

export type HookTransition = LifecycleTransition | UnboundTransition

export interface HookBinding {
  /** The one transition this event derives from. */
  readonly transition: HookTransition
}

const bound = (domain: Domain, to: string, when: string): HookBinding => ({
  transition: { kind: "lifecycle", domain, to, when },
})

const unbound = (reason: string): HookBinding => ({ transition: { kind: "unbound", reason } })

export const HOOK_BINDINGS = {
  PreToolUse: bound("tool", "running", "a tool call starts executing; a hook may deny or rewrite it first"),
  PostToolUse: bound(
    "tool",
    "completed",
    "a tool call finished executing; a hook may replace the result before it is recorded",
  ),
  PostToolUseFailure: bound("tool", "error", "a tool call failed or was interrupted; exclusive with PostToolUse"),
  Stop: bound("turn", "ended", "a root session turn reached its natural end without an error; a block continues it"),
  StopFailure: bound(
    "turn",
    "ended",
    "a turn ended on an assistant error; a user cancellation fires neither Stop nor StopFailure",
  ),
  PermissionRequest: unbound("a permission ask has no lifecycle domain"),
  UserPromptSubmit: unbound("prompt admission has no lifecycle domain; the inbox domain covers automatic input only"),
  Notification: unbound(
    "four sources (permission ask, MCP elicitation, idle prompt, background agent input) share no waiting-for-user transition",
  ),
  Setup: unbound("an explicit init or maintenance run has no lifecycle domain"),
  SubagentStart: unbound(
    "a child run has no lifecycle domain; task, background task and DAG node runs start separately",
  ),
  SubagentStop: unbound("a child run has no lifecycle domain; task, background task and DAG node runs end separately"),
  PreCompact: unbound("compaction has no lifecycle domain"),
  PostCompact: unbound("compaction has no lifecycle domain"),
  SessionStart: unbound(
    "session start, resume, fork and compact are not lifecycle values; `session` is idle, retry, busy",
  ),
  SessionEnd: unbound("session deletion and detach are not lifecycle values; `session` is idle, retry, busy"),
  TaskCreated: unbound("a todo item change has no lifecycle domain"),
  TaskCompleted: unbound("a todo item change has no lifecycle domain"),
  Elicitation: unbound("an MCP elicitation has no lifecycle domain"),
  ElicitationResult: unbound("an MCP elicitation has no lifecycle domain"),
  ConfigChange: unbound("a configuration file change has no lifecycle domain"),
  WorktreeCreate: unbound("a worktree operation has no lifecycle domain"),
  WorktreeRemove: unbound("a worktree operation has no lifecycle domain"),
  InstructionsLoaded: unbound("instruction discovery has no lifecycle domain"),
  CwdChanged: unbound("a session directory move is not a lifecycle value"),
  FileChanged: unbound("a watched file change is not a lifecycle value"),
  UserPromptExpansion: unbound("slash command and MCP prompt expansion has no lifecycle domain"),
  PostToolBatch: unbound("a settled provider tool batch is not a lifecycle value"),
  DirectoryAdded: unbound("an added working directory has no lifecycle domain"),
  PreModelSwitch: unbound("a model switch has no lifecycle domain"),
  PostModelSwitch: unbound("a model switch has no lifecycle domain"),
  MessageDisplay: unbound("a streamed text batch is not a lifecycle value"),
} as const satisfies Record<HookEvent, HookBinding>

export function bindingOf(event: HookEvent): HookBinding {
  return HOOK_BINDINGS[event]
}

export * as HookBindings from "./bindings"
