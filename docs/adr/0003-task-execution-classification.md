# ADR 0003: Task execution classification and background `/review`

- **Status:** Accepted
- **Date:** 2026-11-14
- **Issue:** #1057 (delivery: #1301, #1302, and the documentation PR that adds this ADR)
- **Supersedes:** none

## Context

Before this decision, the `task` tool description mentioned background execution in one
sentence ("Background execution, when enabled, notifies you on completion") without saying when
backgrounding is appropriate. The model had no shared criteria for choosing between foreground
and background, so the same kind of work could be awaited in one turn and detached in the next.

`/review` had a second problem: it ran its subtask in the foreground, so the main agent blocked
for the whole review. Background task runs also had no notion of who initiated them, so a result
could not be marked as the findings of the user's own command. A detached task started by an
ordinary tool was owned by the session-cancellation path, so Esc would cancel it; `watch_pr` was
the only holder of the existing `survivesSessionCancel` flag.

#1057 split the work into three deliveries:

- #1301 added foreground/background criteria to the `task` tool description.
- #1302 added the built-in read-only `review` agent, the command-level `background` declaration,
  task-origin metadata, the survival flag, and result relay.
- The documentation PR adds this ADR and `packages/graphagent/CONTEXT.md`.

## Decisions

1. **Classification is prompt-first.** The criteria live in the `task` tool description
   (`packages/graphagent/src/tool/task.txt`, "Choosing foreground or background") and are
   documented in `packages/graphagent/CONTEXT.md`. The model classifies each call. No scheduler
   or heuristic in code inspects a task's parameters to move it between foreground and
   background.
2. **Criteria.** Foreground when any of F-1 through F-4 holds; background only when all of B-1
   through B-4 hold; foreground otherwise.
   - F-1: the work needs the user's input or confirmation.
   - F-2: it changes session or context state shared with the main agent, so ordering matters.
   - F-3: the result is the direct input to the main agent's next step.
   - F-4: it is quick and cheap (seconds); background notification and context overhead outweigh
     the gain.
   - B-1: the result does not block the main agent's next step.
   - B-2: the work only reads, or writes files the main agent will not touch.
   - B-3: it is long-running or of uncertain duration (minutes).
   - B-4: its result fits in one message.
3. **Code supplies command declarations, not classification.** A command definition may set
   `background: true` (`packages/core/src/v1/config/command.ts`, exported in
   `schema/config.json`). When a user-issued interactive command with that flag runs as a subtask,
   `resolveSubtaskRun` passes `background: true` to the task tool. A non-interactive turn or hook
   follow-up ignores the flag and runs the subtask inline. Agent-started task calls are unaffected
   and follow the prompt criteria.
4. **`/review` is background and read-only by default.** The built-in command
   (`packages/graphagent/src/command/index.ts`) declares `agent: "review"`, `subtask: true`, and
   `background: true`. The `review` agent (`packages/graphagent/src/agent/agent.ts`) denies every
   tool by default and allows only `read`, `grep`, `glob`, `lsp`, `skill`, session bootstrap
   instructions, whitelisted external-directory reads (other external paths still ask), and
   read-only `git`/`gh`/`glab` shell commands. Output-writing git variants (`--output`) are
   denied after the allowlist, so they win the last-match evaluation. The agent cannot edit
   files, spawn sub-tasks, or run mutating commands.
5. **User-issued background commands survive Esc.** A detached task started from a user command
   records `initiator: "user"`, `command`, and `survivesSessionCancel: true` in job metadata.
   Session cancellation (Esc) skips jobs carrying that flag. Session deletion is terminal and
   force-cancels survivors (`Session.remove` passes `force = true`). Agent-started task runs do
   not set the flag; other background tools keep their own cancellation semantics.
6. **Background command results return as a message, not as tool output.** The result ledger
   delivers `child.result` when the run settles. For `initiator: "user"`, the delivery prepends
   `userBackgroundNotice(command)`, which tells the main agent to present the findings faithfully
   and concisely, grouped by severity, and not to edit files or act on them unless the user asks.
   The main agent relays the result; the user does not read the child session directly.
7. **Background results are summarized, not acted on.** The parent is instructed to treat a
   completed user background command as a report. Acting on its findings is a new user request.

## Consequences and risks

- The prompt is the only classification mechanism. A misclassified call cannot be corrected by
  code: over-backgrounding delivers a needed result later, and over-foregrounding blocks the
  turn. Both remain correct, only slower.
- `/review` no longer blocks the turn. A user who wants to act on findings must wait for the
  result message, or continue with unrelated work while the review runs.
- The review agent is narrower than the previous command template: it has no sub-agent and no
  web search, and its template now names Read/Grep/Glob/LSP and read-only git instead.
- `survivesSessionCancel` changes cancellation semantics: Esc ends the turn but not a background
  command the user started. Deletion and `task action="cancel"` remain the explicit stop paths.
- User-configured commands can request `background: true`; the config schema accepts only a
  boolean.
- Findings pass through the main agent, so the relay can lose nuance or overstate severity. The
  injected notice asks for a faithful presentation, but nothing enforces it.

## Alternatives considered

- **Classify in code.** Rejected: foreground versus background depends on the main agent's plan,
  not on parameters the runtime can inspect. A deterministic heuristic would misfire on both
  sides.
- **Keep `/review` foreground.** Rejected: a review is independent of the main agent's next step,
  writes nothing, takes minutes, and returns one report, satisfying B-1 through B-4.
- **Let Esc cancel user-launched background commands.** Rejected: Esc stops the turn, not work
  the user explicitly launched. Deletion and `task action="cancel"` remain the explicit stop
  paths.
- **Have the review agent report directly to the user.** Rejected: child session messages are
  not user-visible; the main agent is the only relay.
- **Honor `background: true` in non-interactive and hook-driven runs.** Rejected: those runs have
  no user waiting for a later message and need the subtask result inline.

## Rollout and rollback

Prompt criteria shipped in #1301; the review agent, command flag, metadata, survival semantics,
and result relay shipped in #1302. This ADR and `packages/graphagent/CONTEXT.md` are
documentation only.

Rollback of the criteria is editing `task.txt`. Rollback of `/review` is removing
`background: true` (and optionally the `review` agent) from the command definition; the command
then runs foreground as before. No database migration or persisted schema change is involved. A
rollback changes cancellation behavior at the code level for future and in-flight jobs.

## Acceptance

- `task.txt` contains foreground/background criteria consistent with
  `packages/graphagent/CONTEXT.md`.
- The `review` command declares `agent: "review"`, `subtask: true`, and `background: true`.
- The `review` agent cannot edit files or run mutating shell commands; git output-writing
  variants are denied.
- A user-issued `/review` runs detached with job metadata `background: true`,
  `initiator: "user"`, `command: "review"`, and `survivesSessionCancel: true`.
- Esc/session cancellation leaves a `survivesSessionCancel` job running; session deletion
  force-cancels it.
- A completed user background command is delivered as a message that starts with the
  user-background notice instructing the parent to present findings without acting on them.
- A non-interactive command turn keeps a `background: true` subtask in the foreground.
- `packages/graphagent/test/command/command.test.ts`,
  `packages/graphagent/test/session/prompt.test.ts`, and
  `packages/graphagent/test/background/cancel.test.ts` cover these behaviors.

## Release note

No `CHANGELOG` is checked in; release notes are generated from commits at release time. The
release-note entry for this decision is:

> `/review` now runs in the background as a read-only review by default. Background commands
> started by the user are not cancelled by Esc, and their results are relayed by the main agent.

## Non-goals

- **No automatic classification or scheduling.** The model decides; code does not move calls
  between modes.
- **No change to `watch_pr`, workflows, or async hooks.** They remain background as before.
- **No change to agent-started background tasks.** They do not survive session cancellation, and
  their results keep the existing result delivery.
- **No backgrounding of long-running shell commands.** That is a separate Issue.
- **No new user-visible transcript surface for child sessions.** The main agent remains the
  relay.
- **No permission widening for review.** The agent stays read-only.