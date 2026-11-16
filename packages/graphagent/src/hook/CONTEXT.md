# Hook Trigger Context

Hooks run configured handlers at fixed points of a session's life. Each point is a **Hook Event**. The module that owns the transition at that point calls the engine (`SettingsHook.trigger`, or `hookCall` for tool events) from its **Trigger Site** and gets a `TriggerResult` back. This document is the contract between those owners and the hook engine: where each event fires, whether the owner acts on the result, and what keeps the event from firing twice. The binding table in `hook/bindings.ts` holds the facts. The two generated blocks below are rendered from it, and `test/hook/context-doc.test.ts` fails when either side drifts.

## Glossary

| Term | Meaning |
| --- | --- |
| Hook Event | One name of `HookEvent`, listed by `VALID_HOOK_EVENTS`. |
| Trigger Site | A source file that builds an event's payload and calls the engine. |
| Owner | The module that owns the state transition at a trigger site: the tool pipeline for tool calls, the turn loop for stops, the session service for session start and end. |
| Source | What a hook event derives from. `lifecycle`: a value of the shared lifecycle vocabulary (#1069). `event`: an event the owner publishes. `none`: nothing announces the occurrence, and the binding says why. |
| Gating Event | An event whose result the code at the trigger site reads and acts on before it continues: a veto, a replacement, an answer, or context injected into the next step. |
| Observing Event | An event whose result the trigger site discards, apart from `systemMessage` notices shown to the user. |
| Stop Gate | The step of the turn loop where `Decide.decide` asks for the stop hooks (`run_stop_hooks`). |

## Choosing a source

A binding names the one source its event is tied to, in this order of preference:

1. A value of the lifecycle vocabulary, when one names the transition (tool calls, the end of a turn).
2. Otherwise an event the owner of the trigger site publishes next to the hook. A hook that can still stop the transition the event announces (a prompt, a permission ask, a compaction) runs before that publication; a hook that follows the transition (a session already created, a move already committed) runs after it.
3. Otherwise nothing: the event is `unbound` and the binding says why no source exists.

The source is a pointer to what the hook is tied to, not a subscription; no code reads it. Several events may share one source (for example `message.updated`), and an event with several occasions names the principal one. The Fires text of each contract gives the order and lists the other occasions.

## Event bindings

<!-- hook-summary:start -->
31 events: 6 derive from a lifecycle value, 19 from an owner event, 6 from nothing. 24 are gating.

| Event | Source | Gating |
| --- | --- | --- |
| `PreToolUse` | lifecycle `tool.running` | yes |
| `PostToolUse` | lifecycle `tool.completed` | yes |
| `PostToolUseFailure` | lifecycle `tool.error` | yes |
| `PostToolBatch` | event `message.updated` | yes |
| `UserPromptSubmit` | event `message.updated` | yes |
| `UserPromptExpansion` | event `command.executed` | yes |
| `PermissionRequest` | event `permission.asked` | yes |
| `Notification` | none | no |
| `Setup` | none | no |
| `Stop` | lifecycle `turn.ended` | yes |
| `StopFailure` | lifecycle `turn.ended` | no |
| `SubagentStart` | event `session.created` | yes |
| `SubagentStop` | lifecycle `turn.ended` | yes |
| `PreCompact` | event `session.compacted` | yes |
| `PostCompact` | event `session.compacted` | no |
| `SessionStart` | event `session.created` | yes |
| `SessionEnd` | event `session.deleted` | no |
| `TaskCreated` | event `todo.updated` | yes |
| `TaskCompleted` | event `todo.updated` | yes |
| `Elicitation` | event `question.asked` | yes |
| `ElicitationResult` | event `question.replied` | yes |
| `ConfigChange` | none | yes |
| `WorktreeCreate` | event `worktree.ready` | yes |
| `WorktreeRemove` | event `project.updated` | yes |
| `InstructionsLoaded` | none | no |
| `CwdChanged` | event `session.next.moved` | yes |
| `FileChanged` | none | yes |
| `DirectoryAdded` | none | no |
| `PreModelSwitch` | event `session.model.switched` | yes |
| `PostModelSwitch` | event `session.model.switched` | yes |
| `MessageDisplay` | event `message.part.delta` | yes |
<!-- hook-summary:end -->

## Event contracts

<!-- hook-contracts:start -->
### `PreToolUse`

- Source: lifecycle `tool.running`
- Gating: yes
- Fires: A tool call is about to execute, before the tool's own permission checks. A hook may deny, defer, stop, ask, or rewrite the input.
- Exactly once: Once per tool call execution, in the `ToolPipeline` wrapper around it.
- Trigger sites: `graphagent/src/tool/pipeline.ts`

### `PostToolUse`

- Source: lifecycle `tool.completed`
- Gating: yes
- Fires: A tool call finished executing, before its result is recorded. A hook may append feedback, replace the output, or stop the turn.
- Exactly once: Once per tool call that completes. Exclusive with PostToolUseFailure through the `executionPending` flag of `ToolPipeline`.
- Trigger sites: `graphagent/src/tool/pipeline.ts`

### `PostToolUseFailure`

- Source: lifecycle `tool.error`
- Gating: yes
- Fires: A tool call failed, returned a failure the tool reports (a non-zero shell exit), or was interrupted while executing. Its feedback rides on the failure; the interrupt report is best-effort and its result is ignored.
- Exactly once: Once per failing tool call. Exclusive with PostToolUse through `executionPending` in `ToolPipeline`; `reportInterrupt` in `SessionTools` fires only for an execution that was aborted.
- Trigger sites: `graphagent/src/tool/pipeline.ts`, `graphagent/src/session/tools.ts`

### `PostToolBatch`

- Source: event `message.updated`
- Gating: yes
- Fires: An assistant message completed (its `message.updated` is already published) with at least one settled tool call. A hook may add feedback or stop the turn.
- Exactly once: Once per assistant message that has settled tool parts, in `SessionPrompt.settleAttempt`.
- Trigger sites: `graphagent/src/session/turn/settle.ts`

### `UserPromptSubmit`

- Source: event `message.updated`
- Gating: yes
- Fires: A prompt is admitted, before its user message is persisted. A hook may block it, add context, set the session title, or stop the turn.
- Exactly once: Once per admitted prompt, in `admitPrompt`. Skipped for hook rewake prompts (text starting with `HOOK_REWAKE_SENTINEL`) and for internal delegations.
- Trigger sites: `graphagent/src/session/turn/admit.ts`

### `UserPromptExpansion`

- Source: event `command.executed`
- Gating: yes
- Fires: A slash command or MCP prompt is expanded, before the expanded prompt is admitted. A block replaces it with a notice and `command.executed` is never published.
- Exactly once: Once per command invocation, in `commandBody`.
- Trigger sites: `graphagent/src/session/command.ts`

### `PermissionRequest`

- Source: event `permission.asked`
- Gating: yes
- Fires: A permission ask needs an answer, before `permission.asked` is published. A hook decision (allow, deny, interrupt) can settle it without a dialog.
- Exactly once: Once per ask that reaches the dialog step in `Permission.ask`. An ask that the rules answer never fires it.
- Trigger sites: `graphagent/src/permission/index.ts`

### `Notification`

- Source: none. Notifications of several kinds (permission, MCP elicitation, idle prompt, authentication, task completion, background agent input) fan in through `Notification.notify`; no single owner event announces them and the service publishes none.
- Gating: no
- Fires: The host asks for the user's attention: a permission or elicitation dialog stays unanswered, the session idles, an authentication or task finishes, or a background agent needs input.
- Exactly once: Once per `Notification.notify` call. A background agent that needs input adds one `agent_needs_input` notification when its parent session is being viewed.
- Trigger sites: `graphagent/src/notification/index.ts`

### `Setup`

- Source: none. `run --init`, `--maintenance` and `--init-only` are explicit CLI requests, not state transitions; no owner event or lifecycle domain exists for them.
- Gating: no
- Fires: A non-interactive `run` starts with `--init`, `--maintenance` or `--init-only`, before its first prompt.
- Exactly once: Once per such `run` invocation.
- Trigger sites: `graphagent/src/cli/cmd/run.ts`

### `Stop`

- Source: lifecycle `turn.ended`
- Gating: yes
- Fires: A root session's turn reached its natural end without an error, while the turn is still running and before it is recorded as ended. A block continues the turn. A cancelled turn never reaches this gate.
- Exactly once: Once per completion candidate: `Decide.decide` asks for the stop hooks only while `stopHook` is `not_run`. A block continues the turn and the next candidate runs them again with `stop_hook_active`, bounded by `stopHookBlockCap`.
- Trigger sites: `graphagent/src/session/turn/stop.ts`

### `StopFailure`

- Source: lifecycle `turn.ended`
- Gating: no
- Fires: A turn ended on an assistant error, before it is recorded as ended. Hook output is ignored and nothing continues. A cancelled turn fires neither StopFailure nor Stop.
- Exactly once: Once per failed completion, through the same stop gate as Stop.
- Trigger sites: `graphagent/src/session/turn/stop.ts`

### `SubagentStart`

- Source: event `session.created`
- Gating: yes
- Fires: A child run's session was created (its `session.created` is already published) and is about to receive its first prompt, for a task call or a DAG node. Hook context is queued for the child's first message.
- Exactly once: Once per child run start. A DAG attempt claims it with `HookLifecycle.claimChildStart`: a replay of the same attempt cannot repeat it, and recovery of a historical attempt never claims it.
- Trigger sites: `graphagent/src/tool/task.ts`, `graphagent/src/dag/runtime/spawn.ts`

### `SubagentStop`

- Source: lifecycle `turn.ended`
- Gating: yes
- Fires: A child run's turn has ended. The task tool fires it in the parent session after the child's prompt returns and continues the child on a block; a DAG node fires it once after its attempt settles; a child driven only by its own loop fires it from the stop gate. A failed child fires StopFailure in its own session instead.
- Exactly once: Once per child run. A DAG attempt claims it with `HookLifecycle.claimChildStop`; `ChildRegistry.delegateStop` keeps a child's own loop from firing it when its owner delivers it; a task promoted to the background is delivered once through `stopDelegated`.
- Trigger sites: `graphagent/src/tool/task.ts`, `graphagent/src/dag/runtime/spawn.ts`, `graphagent/src/session/turn/stop.ts`

### `PreCompact`

- Source: event `session.compacted`
- Gating: yes
- Fires: A compaction starts, before the summary is requested. A block vetoes it: the pending compaction marker is removed, a manual or overflow compaction reports the reason, and `session.compacted` is never published.
- Exactly once: Once per compaction run, in `processCompaction`.
- Trigger sites: `graphagent/src/session/compaction.ts`

### `PostCompact`

- Source: event `session.compacted`
- Gating: no
- Fires: After `session.compacted` is published, once the compacted conversation is committed.
- Exactly once: Once per completed compaction, in `runPostCompactHooks`. A vetoed or failed compaction never reaches it.
- Trigger sites: `graphagent/src/session/compaction.ts`

### `SessionStart`

- Source: event `session.created`
- Gating: yes
- Fires: A top-level session starts. `startup` and `fork` follow `session.created`; `resume` is the first prompt of an existing session in a new process, and `compact` follows `session.compacted`, so neither has an event of its own. A hook may add context, set the title, or queue an initial message.
- Exactly once: `startup`: once per `SessionLifecycle.create`, which marks the session started so its first prompt is not a resume. `resume`: `HookStartContext.claimResume`, once per session per instance and only for a session with earlier messages. `fork`: once per `Session.fork`. `compact`: once per completed compaction. A child session never fires it.
- Trigger sites: `graphagent/src/session/lifecycle.ts`, `graphagent/src/session/session.ts`, `graphagent/src/session/turn/admit.ts`, `graphagent/src/session/compaction.ts`

### `SessionEnd`

- Source: event `session.deleted`
- Gating: no
- Fires: A top-level session ends. Deletion fires it before `session.deleted` is published; a local client detach, `HookClientLifecycle.endLocalSession`, fires it with no owner event.
- Exactly once: Once per attach: `HookLifecycle.claimEnd` succeeds only for an attached session that has not ended.
- Trigger sites: `graphagent/src/session/session.ts`, `graphagent/src/hook/client-lifecycle.ts`

### `TaskCreated`

- Source: event `todo.updated`
- Gating: yes
- Fires: A todo update adds an item, before the update is written and `todo.updated` is published. A block rejects the update. The todo service reaches the engine through the `SessionTodoHooks` port, which `HookTodo` implements.
- Exactly once: Once per new item identity (a hash of session, content and ordinal), under the per-session `SessionTodoHooks.withLock`.
- Trigger sites: `core/src/session/todo-hooks.ts`

### `TaskCompleted`

- Source: event `todo.updated`
- Gating: yes
- Fires: A todo update moves an item to completed, before the update is written and `todo.updated` is published. A block rejects the update. The todo service reaches the engine through the `SessionTodoHooks` port, which `HookTodo` implements.
- Exactly once: Once per item that was not completed before, under the per-session `SessionTodoHooks.withLock`.
- Trigger sites: `core/src/session/todo-hooks.ts`

### `Elicitation`

- Source: event `question.asked`
- Gating: yes
- Fires: An MCP server asks for user input, before the question is shown (`question.asked`). A hook can answer or decline, which skips the question.
- Exactly once: Once per `handleElicitation` call. A request with no bound session declines without running hooks.
- Trigger sites: `graphagent/src/mcp/elicitation.ts`

### `ElicitationResult`

- Source: event `question.replied`
- Gating: yes
- Fires: The response to an elicitation is ready (the user's reply, a rejection or timeout, or a hook answer), before it returns to the server. A hook may replace it.
- Exactly once: Once per `handleElicitation` call that reaches a response.
- Trigger sites: `graphagent/src/mcp/elicitation.ts`

### `ConfigChange`

- Source: none. A configuration write or a hooks.json reload publishes no event, and the lifecycle vocabulary has no configuration domain.
- Gating: yes
- Fires: A configuration file is about to change. `Config.update`, `Config.updateGlobal` and `Config.updateHookPermissions` ask before writing, and a hooks.json reload asks before the new chain replaces the old one. A block keeps the current configuration.
- Exactly once: Once per change attempt and per live session the change concerns, through `HookConfigChange.check`, or `checkInstance` for a reload. A reload with no live session fires one sessionless trigger.
- Trigger sites: `graphagent/src/hook/session-context.ts`, `graphagent/src/hook/engine/run.ts`

### `WorktreeCreate`

- Source: event `worktree.ready`
- Gating: yes
- Fires: A worktree is created while a WorktreeCreate hook is configured. The hook owns the creation and must return the directory; `worktree.ready` follows once it is booted. A block or a missing directory fails the creation.
- Exactly once: Once per `Worktree.create` with the hook configured. There is no git fallback.
- Trigger sites: `graphagent/src/worktree/index.ts`

### `WorktreeRemove`

- Source: event `project.updated`
- Gating: yes
- Fires: A hook-created worktree is removed while a WorktreeRemove hook is configured, before the project drops its sandbox registration (`project.updated`). A failing hook that leaves the directory behind fails the removal.
- Exactly once: Once per `Worktree.remove` of an owned worktree with the hook configured.
- Trigger sites: `graphagent/src/worktree/index.ts`

### `InstructionsLoaded`

- Source: none. Instruction files are read while the system prompt is built and nothing announces a load; only the re-read after a compaction follows `session.compacted`.
- Gating: no
- Fires: An instruction file is loaded into a session's system context (`session_start`) or re-read after a compaction (`compact`). It runs in the background and never delays the model request.
- Exactly once: Once per session, file path and content hash, remembered in `announced`. Each compaction announces the reloaded files again.
- Trigger sites: `graphagent/src/session/instruction.ts`

### `CwdChanged`

- Source: event `session.next.moved`
- Gating: yes
- Fires: After a session move is committed (`session.next.moved` is published). The hook cannot undo the move, and the core move ignores its result; the hook adapter, `HookCwd`, applies the watch paths and environment to the new directory.
- Exactly once: Once per committed move, through `SessionCwdHooks.changed` in `MoveSession`.
- Trigger sites: `graphagent/src/hook/cwd.ts`

### `FileChanged`

- Source: none. The hook module watches its declared paths with its own `fs.watch`; `file.watcher.updated` comes from the project file watcher, which neither covers those paths nor feeds this hook.
- Gating: yes
- Fires: A watched file is added, changed or removed: the static FileChanged matchers plus the paths a hook returned as `watchPaths`. A hook may replace the watch list.
- Exactly once: Once per change of the file's signature in `HookFileWatch`. An event that leaves the signature unchanged is dropped.
- Trigger sites: `graphagent/src/hook/session-context.ts`

### `DirectoryAdded`

- Source: none. The directory joins a session's hook-managed permission policy; `project.directories.updated` announces the project's directory registry, a different fact, and no event covers the policy.
- Gating: no
- Fires: A hook's permission update (`addDirectories`) makes a directory part of the session's policy.
- Exactly once: Once per directory that was not in the policy before the update.
- Trigger sites: `graphagent/src/permission/index.ts`

### `PreModelSwitch`

- Source: event `session.model.switched`
- Gating: yes
- Fires: A user-requested model change, before it is persisted (`session.model.switched`). A block, a deny, or a declined ask refuses the switch.
- Exactly once: Once per requested change of model. Automatic selection and restoring a saved model on resume do not fire it.
- Trigger sites: `graphagent/src/session/turn/prepare.ts`

### `PostModelSwitch`

- Source: event `session.model.switched`
- Gating: yes
- Fires: After a model change is persisted, or a saved model is restored on resume. The hook runs in the background; its context joins the next model request that targets the new model, which waits up to five seconds for it.
- Exactly once: Once per persisted change, queued by `queueModelSwitch`. A newer switch interrupts the pending one.
- Trigger sites: `graphagent/src/session/turn/prepare.ts`, `graphagent/src/session/model-switch.ts`

### `MessageDisplay`

- Source: event `message.part.delta`
- Gating: yes
- Fires: A batch of assistant text is displayed. Interactive sessions get one batch per completed line while streaming, and every session gets the final batch. A hook may replace the displayed text.
- Exactly once: Exactly one batch per message carries `final`: `SessionProcessor.display` stops at `displayFinished`.
- Trigger sites: `graphagent/src/session/turn/loop.ts`
<!-- hook-contracts:end -->

## Stop, StopFailure and SubagentStop

These three events share the Stop Gate in `session/turn/stop.ts`. Their present behavior is pinned here and by `test/hook/trigger-counts.test.ts`.

- **A natural end fires Stop.** A root session's turn that reaches a completion candidate without an error runs the stop hooks while the turn is still running; the ended row and `session.turn.settled` follow. `Stop` never fires for a cancelled turn.
- **A block continues the turn.** A hook that blocks (`decision: "block"` or exit code 2) makes `applyStopFeedback` append a synthetic user message that ends with the block reason, and the loop takes another model step. The next completion candidate fires `Stop` again with `stop_hook_active` set. Consecutive blocked continuations without tool work are capped by `stopHookBlockCap` (`MAX_STOP_CONTINUATIONS`, 8 by default; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides it). `continue: false` ends the turn instead, and its `stopReason` is shown to the user.
- **A failure fires StopFailure.** A turn that ends on an assistant error (for example a provider failure after the retries, or a context overflow) fires `StopFailure` instead of `Stop`. Its output is ignored, and a turn with an error never continues.
- **A cancellation fires neither.** A cancelled turn leaves the loop without reaching the Stop Gate, so no event of the family fires for it.
- **A child session fires SubagentStop, not Stop.** `session/turn/stop.ts` chooses the event name from the session's `parentID`. The payload goes to the parent session (`session_id` is the parent, `agent_id` the child), except `StopFailure`, which fires in the child's own session. When the task tool or a DAG node owns the child run, `ChildRegistry.delegateStop` is true on a clean end and the child's own loop stays silent. The task tool then fires `SubagentStop` after the child's prompt returns and may continue the child on a block, with the same cap. A DAG node fires it once per attempt after the attempt settles and cannot continue. Any other child (one created through the API, or a background task) fires it from its own Stop Gate.
- **A failed child fires StopFailure and never SubagentStop.** The parent sees the failed task call as `PostToolUseFailure`.
- **An async Stop hook can wake the session.** A Stop hook with `asyncRewake` that exits with code 2 wakes the session later through the inbox source `hook.rewake`. The `RewakeToken` (cancellation epoch plus rewake generation) ties the wake to the chain that fired it, so a cancel, a newer prompt, or `SessionEnd` discards a late wake. `claimStopContinuation` applies the same cap.

## Writes to session state

Hook code returns data to the owner; it does not write session state. `test/hook/session-state-writes.test.ts` scans `hook/` and allows exactly one write.

**The write the hook module makes.** `HookSessionContext.applyStart` calls `Session.setTitle` for the `sessionTitle` a `SessionStart` hook returned. It is a documented, user-visible feature: the title names the session in every client. The call goes through the owner's API and marks the title custom. `admitPrompt` applies the `sessionTitle` of a `UserPromptSubmit` hook with the same call.

**State the hook module owns.** The engine state, `HookLifecycle`, `HookStartContext`, `HookFileWatch`, `HookConfigChange`, `SessionHooks`, and the `HookTranscript` files. `HookClientLifecycle.endLocalSession` and `SettingsHook.clearSession` drop them when a session ends. The permission policy that hooks install through `updatedPermissions` lives in `Permission`; `Permission.clearHookPolicy` clears only that.

**Results the owner applies.** Tool input and output rewrites are applied by `ToolPipeline`. Permission decisions and `updatedPermissions` are applied by `Permission.applyHookUpdates`. An `initialUserMessage` is queued in `HookLifecycle.queueInitial` and admitted by `SessionPrompt.resume` as a user turn. Additional context is queued in `HookStartContext` and attached to the next admitted prompt. Async results wait in the engine until `drainAsync` hands them to the next model request, and an async rewake enters the session through the inbox.

**Not a hook concern.** Detaching a local client clears the session's live status entry and its attention record. `ClientDetach.local` does that, then calls `HookClientLifecycle.endLocalSession`, which only ends hooks.

## Invariants

- `HOOK_BINDINGS` has one entry per `HookEvent`. The typecheck, `VALID_HOOK_EVENTS` and `test/hook/binding-table.test.ts` keep the three equal.
- The files a binding lists are exactly the files whose code builds that event's payload (`event: "<Name>"`). A new trigger site has to be added to the table.
- The exactly-once guarantee lives at the owner, beside the trigger site, as a claim, a flag, or a lock. The engine runs each matching handler once per trigger and deduplicates context per session, but it never decides whether an occurrence happened.
- An unbound event stays unbound until an owner publishes an event for it or the vocabulary gains a value; the list in `binding-table.test.ts` only shrinks.
- A gating event is triggered synchronously at its owner, and the owner reads the result at that site.
- Hook code writes no `SessionStatus` or `SessionAttention`.

## Why events are not dispatched from transition events

Every trigger stays at its owner and the binding table is their contract. A single dispatcher that subscribes to transition events is out of scope, for four reasons.

- A gating event must hand its result back to the owner before the owner continues (a denial, a block, a replacement, an answer, injected context). Most events are gating (see the count above), and a subscriber to `lifecycle.transitioned` or to an owner event has no return path.
- The hook of a gating event runs before the owner publishes or commits the transition: the prompt is not persisted yet, the permission is not asked yet, the compaction has not started. A published event only reports what already happened.
- The exactly-once guarantee is a claim, flag, or lock beside each trigger site. A dispatcher would have to carry every one of them.
- Some events have no source to subscribe to; the unbound entries above say which.

Out of scope here and tracked separately: `hookPendingInput`, the saved followup record of non-interactive hook mode (it is not a copy of the async hook results, which the engine holds until `drainAsync`), and deriving `Stop` or `SubagentStop` from a child's role instead of `parentID` (#1288).

## Adding or changing an event

1. Add the name to `HookEvent` and `VALID_HOOK_EVENTS` in `hook/types.ts`. The typecheck then asks for the binding.
2. Add the entry to `HOOK_BINDINGS`: source, gating, the files that fire it, when it fires, and what keeps it to once. Run `HOOK_CONTEXT_WRITE=1 bun test test/hook/context-doc.test.ts` from `packages/graphagent` to render the two blocks above.
3. List the event in the user-facing reference `skill/builtin/configure-hooks.md`; `test/hook/event-trigger-coverage.test.ts` checks it.
4. Pin its trigger count with a scenario in `test/hook/trigger-counts.test.ts`, or name the existing test that does.
