// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Trigger binding table (Issue #1070).
 *
 * Every hook event has exactly one entry. The entry names the one source the
 * event derives from, says whether the owner consumes the hook result, lists
 * the files that fire it, and states when it fires and what keeps it to once.
 * `hook/CONTEXT.md` renders this table; `test/hook/binding-table.test.ts` pins
 * both against the code.
 *
 * A source is one of:
 *
 * - `lifecycle`: a value of a domain in the shared lifecycle vocabulary
 *   (#1069, `@graphagent/core/lifecycle/vocabulary`).
 * - `ownerEvent`: an event the owner of the trigger site publishes, named as
 *   in `EventManifest.Definitions`. The hook fires beside that publication:
 *   before it when the hook gates the transition the event announces, after
 *   it when the hook observes the transition.
 * - `unbound`: no owner event or vocabulary value announces the occurrence the
 *   hook fires on, so the entry says why instead of naming a source. The
 *   list is a ratchet in the test; it may only shrink.
 *
 * `gating` is true when the code at the trigger site reads the hook result
 * (a veto, a replacement, an answer, or context it injects) and acts on it. A
 * non-gating event is an observation: the owner awaits or forks the hooks and
 * discards what they return, apart from user-visible `systemMessage` notices.
 *
 * The table is data only. The engine does not read it and the trigger sites
 * stay with their owners: a gating event needs the result back at the owner
 * before the owner continues, which a subscriber to transition events cannot
 * provide (see `hook/CONTEXT.md`).
 *
 * `HOOK_BINDINGS` is typed `Record<HookEvent, ...>`, so adding an event to the
 * union without an entry fails the typecheck; the test pins the runtime
 * `VALID_HOOK_EVENTS` set to the same keys.
 */
import type { Domain } from "@graphagent/schema/lifecycle-status"
import type { HookEvent } from "./types"

export interface LifecycleSource {
  readonly kind: "lifecycle"
  /** A domain of the shared vocabulary. */
  readonly domain: Domain
  /** A value of that domain (`valuesOf(domain)`). */
  readonly to: string
}

export interface OwnerEventSource {
  readonly kind: "ownerEvent"
  /** The event type, as `EventManifest.Definitions` names it. */
  readonly event: string
}

export interface UnboundSource {
  readonly kind: "unbound"
  /** Why nothing announces the occurrence the hook fires on. */
  readonly reason: string
}

export type HookSource = LifecycleSource | OwnerEventSource | UnboundSource

export interface HookBinding {
  readonly source: HookSource
  /** True when the owner reads the hook result and its next step depends on it. */
  readonly gating: boolean
  /** Source files, relative to `packages/`, whose code builds this event's payload. */
  readonly sites: readonly string[]
  /** The occurrence the hook fires on, relative to the source. */
  readonly when: string
  /** What keeps the event to once per occurrence. */
  readonly once: string
}

type Detail = Omit<HookBinding, "source">

const lifecycle = (domain: Domain, to: string, detail: Detail): HookBinding => ({
  source: { kind: "lifecycle", domain, to },
  ...detail,
})

const ownerEvent = (event: string, detail: Detail): HookBinding => ({
  source: { kind: "ownerEvent", event },
  ...detail,
})

const unbound = (reason: string, detail: Detail): HookBinding => ({ source: { kind: "unbound", reason }, ...detail })

const src = (file: string) => `graphagent/src/${file}`
const core = (file: string) => `core/src/${file}`

export const HOOK_BINDINGS = {
  PreToolUse: lifecycle("tool", "running", {
    gating: true,
    sites: [src("tool/pipeline.ts")],
    when: "A tool call is about to execute, before the tool's own permission checks. A hook may deny, defer, stop, ask, or rewrite the input.",
    once: "Once per tool call execution, in the `ToolPipeline` wrapper around it.",
  }),
  PostToolUse: lifecycle("tool", "completed", {
    gating: true,
    sites: [src("tool/pipeline.ts")],
    when: "A tool call finished executing, before its result is recorded. A hook may append feedback, replace the output, or stop the turn.",
    once: "Once per tool call that completes. Exclusive with PostToolUseFailure through the `executionPending` flag of `ToolPipeline`.",
  }),
  PostToolUseFailure: lifecycle("tool", "error", {
    gating: true,
    sites: [src("tool/pipeline.ts"), src("session/tools.ts")],
    when: "A tool call failed, returned a failure the tool reports (a non-zero shell exit), or was interrupted while executing. Its feedback rides on the failure; the interrupt report is best-effort and its result is ignored.",
    once: "Once per failing tool call. Exclusive with PostToolUse through `executionPending` in `ToolPipeline`; `reportInterrupt` in `SessionTools` fires only for an execution that was aborted.",
  }),
  PostToolBatch: ownerEvent("message.updated", {
    gating: true,
    sites: [src("session/turn/settle.ts")],
    when: "An assistant message completed (its `message.updated` is already published) with at least one settled tool call. A hook may add feedback or stop the turn.",
    once: "Once per assistant message that has settled tool parts, in `SessionPrompt.settleAttempt`.",
  }),
  UserPromptSubmit: ownerEvent("message.updated", {
    gating: true,
    sites: [src("session/turn/admit.ts")],
    when: "A prompt is admitted, before its user message is persisted. A hook may block it, add context, set the session title, or stop the turn.",
    once: "Once per admitted prompt, in `admitPrompt`. Skipped for hook rewake prompts (text starting with `HOOK_REWAKE_SENTINEL`) and for internal delegations.",
  }),
  UserPromptExpansion: ownerEvent("command.executed", {
    gating: true,
    sites: [src("session/command.ts")],
    when: "A slash command or MCP prompt is expanded, before the expanded prompt is admitted. A block replaces it with a notice and `command.executed` is never published.",
    once: "Once per command invocation, in `commandBody`.",
  }),
  PermissionRequest: ownerEvent("permission.asked", {
    gating: true,
    sites: [src("permission/index.ts")],
    when: "A permission ask needs an answer, before `permission.asked` is published. A hook decision (allow, deny, interrupt) can settle it without a dialog.",
    once: "Once per ask that reaches the dialog step in `Permission.ask`. An ask that the rules answer never fires it.",
  }),
  Notification: unbound(
    "Notifications of several kinds (permission, MCP elicitation, idle prompt, authentication, task completion, background agent input) fan in through `Notification.notify`; no single owner event announces them and the service publishes none.",
    {
      gating: false,
      sites: [src("notification/index.ts")],
      when: "The host asks for the user's attention: a permission or elicitation dialog stays unanswered, the session idles, an authentication or task finishes, or a background agent needs input.",
      once: "Once per `Notification.notify` call. A background agent that needs input adds one `agent_needs_input` notification when its parent session is being viewed.",
    },
  ),
  Setup: unbound(
    "`run --init`, `--maintenance` and `--init-only` are explicit CLI requests, not state transitions; no owner event or lifecycle domain exists for them.",
    {
      gating: false,
      sites: [src("cli/cmd/run.ts")],
      when: "A non-interactive `run` starts with `--init`, `--maintenance` or `--init-only`, before its first prompt.",
      once: "Once per such `run` invocation.",
    },
  ),
  Stop: lifecycle("turn", "ended", {
    gating: true,
    sites: [src("session/turn/stop.ts")],
    when: "A root session's turn reached its natural end without an error, while the turn is still running and before it is recorded as ended. A block continues the turn. A cancelled turn never reaches this gate.",
    once: "Once per completion candidate: `Decide.decide` asks for the stop hooks only while `stopHook` is `not_run`. A block continues the turn and the next candidate runs them again with `stop_hook_active`, bounded by `stopHookBlockCap`.",
  }),
  StopFailure: lifecycle("turn", "ended", {
    gating: false,
    sites: [src("session/turn/stop.ts")],
    when: "A turn ended on an assistant error, before it is recorded as ended. Hook output is ignored and nothing continues. A cancelled turn fires neither StopFailure nor Stop.",
    once: "Once per failed completion, through the same stop gate as Stop.",
  }),
  SubagentStart: ownerEvent("session.created", {
    gating: true,
    sites: [src("tool/task.ts"), src("dag/runtime/spawn.ts")],
    when: "A child run's session was created (its `session.created` is already published) and is about to receive its first prompt, for a task call or a DAG node. Hook context is queued for the child's first message.",
    once: "Once per child run start. A DAG attempt claims it with `HookLifecycle.claimChildStart`: a replay of the same attempt cannot repeat it, and recovery of a historical attempt never claims it.",
  }),
  SubagentStop: lifecycle("turn", "ended", {
    gating: true,
    sites: [src("tool/task.ts"), src("dag/runtime/spawn.ts"), src("session/turn/stop.ts")],
    when: "A child run's turn has ended. The task tool fires it in the parent session after the child's prompt returns and continues the child on a block; a DAG node fires it once after its attempt settles; a child driven only by its own loop fires it from the stop gate. A failed child fires StopFailure in its own session instead.",
    once: "Once per child run. A DAG attempt claims it with `HookLifecycle.claimChildStop`; `ChildRegistry.delegateStop` keeps a child's own loop from firing it when its owner delivers it; a task promoted to the background is delivered once through `stopDelegated`.",
  }),
  PreCompact: ownerEvent("session.compacted", {
    gating: true,
    sites: [src("session/compaction.ts")],
    when: "A compaction starts, before the summary is requested. A block vetoes it: the pending compaction marker is removed, a manual or overflow compaction reports the reason, and `session.compacted` is never published.",
    once: "Once per compaction run, in `processCompaction`.",
  }),
  PostCompact: ownerEvent("session.compacted", {
    gating: false,
    sites: [src("session/compaction.ts")],
    when: "After `session.compacted` is published, once the compacted conversation is committed.",
    once: "Once per completed compaction, in `runPostCompactHooks`. A vetoed or failed compaction never reaches it.",
  }),
  SessionStart: ownerEvent("session.created", {
    gating: true,
    sites: [
      src("session/lifecycle.ts"),
      src("session/session.ts"),
      src("session/turn/admit.ts"),
      src("session/compaction.ts"),
    ],
    when: "A top-level session starts. `startup` and `fork` follow `session.created`; `resume` is the first prompt of an existing session in a new process, and `compact` follows `session.compacted`, so neither has an event of its own. A hook may add context, set the title, or queue an initial message.",
    once: "`startup`: once per `SessionLifecycle.create`, which marks the session started so its first prompt is not a resume. `resume`: `HookStartContext.claimResume`, once per session per instance and only for a session with earlier messages. `fork`: once per `Session.fork`. `compact`: once per completed compaction. A child session never fires it.",
  }),
  SessionEnd: ownerEvent("session.deleted", {
    gating: false,
    sites: [src("session/session.ts"), src("hook/client-lifecycle.ts")],
    when: "A top-level session ends. Deletion fires it before `session.deleted` is published; a local client detach, `HookClientLifecycle.endLocalSession`, fires it with no owner event.",
    once: "Once per attach: `HookLifecycle.claimEnd` succeeds only for an attached session that has not ended.",
  }),
  TaskCreated: ownerEvent("todo.updated", {
    gating: true,
    sites: [core("session/todo-hooks.ts")],
    when: "A todo update adds an item, before the update is written and `todo.updated` is published. A block rejects the update. The todo service reaches the engine through the `SessionTodoHooks` port, which `HookTodo` implements.",
    once: "Once per new item identity (a hash of session, content and ordinal), under the per-session `SessionTodoHooks.withLock`.",
  }),
  TaskCompleted: ownerEvent("todo.updated", {
    gating: true,
    sites: [core("session/todo-hooks.ts")],
    when: "A todo update moves an item to completed, before the update is written and `todo.updated` is published. A block rejects the update. The todo service reaches the engine through the `SessionTodoHooks` port, which `HookTodo` implements.",
    once: "Once per item that was not completed before, under the per-session `SessionTodoHooks.withLock`.",
  }),
  Elicitation: ownerEvent("question.asked", {
    gating: true,
    sites: [src("mcp/elicitation.ts")],
    when: "An MCP server asks for user input, before the question is shown (`question.asked`). A hook can answer or decline, which skips the question.",
    once: "Once per `handleElicitation` call. A request with no bound session declines without running hooks.",
  }),
  ElicitationResult: ownerEvent("question.replied", {
    gating: true,
    sites: [src("mcp/elicitation.ts")],
    when: "The response to an elicitation is ready (the user's reply, a rejection or timeout, or a hook answer), before it returns to the server. A hook may replace it.",
    once: "Once per `handleElicitation` call that reaches a response.",
  }),
  ConfigChange: unbound(
    "A configuration write or a hooks.json reload publishes no event, and the lifecycle vocabulary has no configuration domain.",
    {
      gating: true,
      sites: [src("hook/session-context.ts"), src("hook/engine/run.ts")],
      when: "A configuration file is about to change. `Config.update`, `Config.updateGlobal` and `Config.updateHookPermissions` ask before writing, and a hooks.json reload asks before the new chain replaces the old one. A block keeps the current configuration.",
      once: "Once per change attempt and per live session the change concerns, through `HookConfigChange.check`, or `checkInstance` for a reload. A reload with no live session fires one sessionless trigger.",
    },
  ),
  WorktreeCreate: ownerEvent("worktree.ready", {
    gating: true,
    sites: [src("worktree/index.ts")],
    when: "A worktree is created while a WorktreeCreate hook is configured. The hook owns the creation and must return the directory; `worktree.ready` follows once it is booted. A block or a missing directory fails the creation.",
    once: "Once per `Worktree.create` with the hook configured. There is no git fallback.",
  }),
  WorktreeRemove: ownerEvent("project.updated", {
    gating: true,
    sites: [src("worktree/index.ts")],
    when: "A hook-created worktree is removed while a WorktreeRemove hook is configured, before the project drops its sandbox registration (`project.updated`). A failing hook that leaves the directory behind fails the removal.",
    once: "Once per `Worktree.remove` of an owned worktree with the hook configured.",
  }),
  InstructionsLoaded: unbound(
    "Instruction files are read while the system prompt is built and nothing announces a load; only the re-read after a compaction follows `session.compacted`.",
    {
      gating: false,
      sites: [src("session/instruction.ts")],
      when: "An instruction file is loaded into a session's system context (`session_start`) or re-read after a compaction (`compact`). It runs in the background and never delays the model request.",
      once: "Once per session, file path and content hash, remembered in `announced`. Each compaction announces the reloaded files again.",
    },
  ),
  CwdChanged: ownerEvent("session.next.moved", {
    gating: true,
    sites: [src("hook/cwd.ts")],
    when: "After a session move is committed (`session.next.moved` is published). The hook cannot undo the move, and the core move ignores its result; the hook adapter, `HookCwd`, applies the watch paths and environment to the new directory.",
    once: "Once per committed move, through `SessionCwdHooks.changed` in `MoveSession`.",
  }),
  FileChanged: unbound(
    "The hook module watches its declared paths with its own `fs.watch`; `file.watcher.updated` comes from the project file watcher, which neither covers those paths nor feeds this hook.",
    {
      gating: true,
      sites: [src("hook/session-context.ts")],
      when: "A watched file is added, changed or removed: the static FileChanged matchers plus the paths a hook returned as `watchPaths`. A hook may replace the watch list.",
      once: "Once per change of the file's signature in `HookFileWatch`. An event that leaves the signature unchanged is dropped.",
    },
  ),
  DirectoryAdded: unbound(
    "The directory joins a session's hook-managed permission policy; `project.directories.updated` announces the project's directory registry, a different fact, and no event covers the policy.",
    {
      gating: false,
      sites: [src("permission/index.ts")],
      when: "A hook's permission update (`addDirectories`) makes a directory part of the session's policy.",
      once: "Once per directory that was not in the policy before the update.",
    },
  ),
  PreModelSwitch: ownerEvent("session.model.switched", {
    gating: true,
    sites: [src("session/turn/prepare.ts")],
    when: "A user-requested model change, before it is persisted (`session.model.switched`). A block, a deny, or a declined ask refuses the switch.",
    once: "Once per requested change of model. Automatic selection and restoring a saved model on resume do not fire it.",
  }),
  PostModelSwitch: ownerEvent("session.model.switched", {
    gating: true,
    sites: [src("session/turn/prepare.ts"), src("session/model-switch.ts")],
    when: "After a model change is persisted, or a saved model is restored on resume. The hook runs in the background; its context joins the next model request that targets the new model, which waits up to five seconds for it.",
    once: "Once per persisted change, queued by `queueModelSwitch`. A newer switch interrupts the pending one.",
  }),
  MessageDisplay: ownerEvent("message.part.delta", {
    gating: true,
    sites: [src("session/turn/loop.ts")],
    when: "A batch of assistant text is displayed. Interactive sessions get one batch per completed line while streaming, and every session gets the final batch. A hook may replace the displayed text.",
    once: "Exactly one batch per message carries `final`: `SessionProcessor.display` stops at `displayFinished`.",
  }),
} satisfies Record<HookEvent, HookBinding>

export function bindingOf(event: HookEvent): HookBinding {
  return HOOK_BINDINGS[event]
}

/** The source's name as the contract and the tests spell it: `tool.running`, `session.created`, or `unbound`. */
export function sourceName(binding: HookBinding): string {
  const { source } = binding
  if (source.kind === "lifecycle") return `${source.domain}.${source.to}`
  if (source.kind === "ownerEvent") return source.event
  return "unbound"
}

export * as HookBindings from "./bindings"
