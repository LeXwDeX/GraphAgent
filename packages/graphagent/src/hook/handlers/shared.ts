/**
 * Shared handler contracts and failure policy for hook handlers.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 */
import { Cause, Effect, Option } from "effect"
import {
  isAsync,
  type HookCommand,
  type HookEffort,
  type HookEnvelope,
  type HookEvent,
  type HookJSONOutput,
} from "../types"

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
export interface HookHandler<E extends HookCommand = HookCommand> {
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

export interface HookExecution {
  json?: HookJSONOutput
  exitBlock?: string
  rawStdout?: string
  exitCode?: number | null
  /** True only after the handler actually ran successfully; absent means failure. */
  succeeded?: boolean
  /** Failure text for the user-visible `<hook name> hook error` notice; never model context. */
  failureMessage?: string
}

/** Exit 2 on these events keeps the agent working, so a hook that cannot run must not trap it (reference 949). */
export const FAILURE_EXEMPT_EVENTS: ReadonlySet<HookEvent> = new Set([
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TeammateIdle",
])
/** Events whose exit-2 "file is missing" run is a non-blocking error (reference 800). */
export const MISSING_FILE_EXIT2_EVENTS: ReadonlySet<HookEvent> = new Set(["Stop", "SubagentStop", "TaskCompleted"])
export const MISSING_FILE_STDERR = /no such file or directory|enoent|cannot find (?:module|the (?:file|path))/i

/** `onFailure: "block"` applies to foreground command/http hooks outside the exempt events. */
export function blocksOnFailure(entry: HookCommand, event: HookEvent): boolean {
  return entry.onFailure === "block" && !isAsync(entry) && !FAILURE_EXEMPT_EVENTS.has(event)
}

/** Readable failure text for the user-visible hook-error notice; never the raw cause. */
export function hookFailureText(cause: Cause.Cause<unknown>): string {
  // invokeMcpHook throws, and a throw inside Effect.gen is a defect rather than
  // a typed failure, so both reason kinds carry the message the user needs.
  const error = Option.getOrUndefined(Cause.findErrorOption(cause)) ?? cause.reasons.find(Cause.isDieReason)?.defect
  if (Cause.isTimeoutError(error)) return "hook timed out"
  if (error instanceof Error) return error.message
  return String(error ?? "hook failed")
}
