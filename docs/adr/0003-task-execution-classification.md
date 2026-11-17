# ADR 0003: Task execution classification and background `/review`

- **Status:** Accepted
- **Date:** 2026-11-14
- **Issue:** #1057 (delivery: #1301, #1302, and the documentation PR that adds this ADR)
- **Supersedes:** none
- **Amended:** 2026-11-17, Amendment 1 (criteria revised after a real-model evaluation)

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

   Amended (2026-11-17): a real-model evaluation led to revised criteria (B-3 removed, B-1
   replaced by a trigger based on the user's parallel signal, a delegate-first rule added); the
   list above is the original decision, and Amendment 1 below gives the current criteria and the
   ID mapping.

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

## Amendment 1 (2026-11-17): evaluation-driven revision of the criteria

The criteria shipped in #1301 were measured against a real model and then revised. This amendment
replaces the criteria in Decision 2; Decisions 1 and 3 through 7 stand. The F-n and B-n IDs in the
rest of this document are the original numbering. The revised IDs are the ones used in
`packages/graphagent/CONTEXT.md` and are mapped under "Revised criteria" below. The final wording
(the one now in `task.txt`) did not stably meet the evaluation's background gate; the follow-up is
#1357 (see "Consequences and risks" below).

### Evaluation

Plan 6 of #1057 added a real-model evaluation in
`packages/graphagent/test/live/delegation-timing/`. It is a script, not part of any test run, and
it does not load the test preload (which clears standard provider credential variables):

```sh
cd packages/graphagent
GRAPHAGENT_LIVE_EVAL_CONFIG=<path to graphagent.json> bun run test/live/delegation-timing/run.ts
```

Each model runs 20 deterministic scenarios (a fixture project plus a scripted user request), three
rounds by default, each scenario capped at 8 model steps: 8 F scenarios whose work must not be
backgrounded, 6 B scenarios (independent, read-only, slow work the user does not wait for) that
should be delegated in the background, and 6 A scenarios where either choice is accepted. A model
family passes with no foreground violation (backgrounding in an F scenario, or editing after an
injected `/review` result), at least 5/6 background hits on the B scenarios, and at least 85%
accuracy over all runs. Only the DeepSeek family was evaluated; no QWEN or GLM model was
configured. Counts below are summed over three rounds (F: 8 × 3, B: 6 × 3, all: 20 × 3).

| Wording                                           | F violations | B background hits | Accuracy      | Gates                            |
| ------------------------------------------------- | ------------ | ----------------- | ------------- | -------------------------------- |
| Original (#1301)                                  | 0/24         | 3/18 (16.7%)      | 45/60 (75.0%) | B and accuracy fail              |
| Revision 1                                        | 0/24         | 12/18 (66.7%)     | 54/60 (90.0%) | B fails                          |
| Revision 2                                        | 0/24         | 15/18 (83.3%)     | 57/60 (95.0%) | all pass (B exactly at the gate) |
| Revision 2 + review correction (final wording)    | 0/24         | 14/18 (77.8%)     | 56/60 (93.3%) | B fails                          |
| Final wording + no-preparation clause (withdrawn) | 0/24         | 13/18 (72.2%)     | 55/60 (91.7%) | B fails                          |
| Final wording, final harness (shell never runs)   | 0/24         | 16/18 (88.9%)     | 58/60 (96.7%) | all pass                         |

Among the batches run while the harness still executed read-only shell commands, only Revision 2
reached all three gates, with the background gate met exactly; the two later ones, including the
final wording, fall below it. The last batch ran the final wording on the final harness, which
never runs the shell (a read-only shell call is denied and the model is pointed to the read tools,
because whether a command line is harmless cannot be proven from its text). It met all three gates.
The conditions differ: without the shell the model cannot start the work itself through a quick
command before delegating, which may favour background delegation, so the batches are not directly
comparable and the earlier variation stands.

The transcripts of the original wording showed three causes. In the B scenarios the model rarely
considered delegating: it read for 5 to 9 steps and then ran the tests itself. "Takes minutes"
cannot be judged in a small repository. And when the model did decide to background, it often
investigated first and ended up doing the work itself.

### Revisions

Plan 6 allows at most two revision iterations of the `task.txt` wording; both were used. Two
changes were measured afterwards: a review correction, which stayed in the wording, and a
supplementary trial, which was withdrawn.

- **Revision 1: the user's parallel signal.** The background trigger became the user's own
  signal: they say they will keep working on something else meanwhile ("meanwhile", "at the same
  time", "I'll keep working on ...", "no need to wait") or ask for background. The model then
  delegates with `background: true` instead of doing the work in the same turn, provided the agent
  only reads or writes files neither the main agent nor the user will touch and its result fits in
  one message. The "takes minutes" condition (original B-3) was removed. Test and type-check runs
  of finished work joined reviews and audits as good background work. The foreground conditions
  kept their substance, and "quick (seconds)" became "a quick lookup the main agent can answer
  directly".
- **Revision 2: delegate first.** Once background is chosen, the main agent no longer reads files
  or runs commands beforehand to investigate the work. It passes on the user's request and what it
  already knows, the agent gathers its own context, and the main agent replies briefly and ends
  its turn (the turn-ending part was corrected afterwards, see below).
- **Review correction: continue foreground work after delegating.** PR review pointed out that
  "reply briefly and end your turn" drops the foreground part of a request that asks for both, for
  example a background review plus a foreground edit, and that it contradicts the existing rule to
  end the turn only when nothing else is left. The wording now tells the main agent to carry on
  with any foreground work the user also asked for, and to reply briefly and end its turn only if
  none is left; the result still arrives as a message. This is the final wording: F 0/24, B 14/18
  (77.8%), accuracy 93.3%.
- **No-preparation trial (withdrawn).** On top of the correction, a clause was tried that tells
  the main agent not to do preparation work, such as installing dependencies, before delegating. It
  did not help (F 0/24, B 13/18 (72.2%), accuracy 91.7%), so it was withdrawn and is not in the
  final wording.

### Revised criteria

Foreground is the default and always applies when any of F-1 through F-4 holds; background only
when all of B-1 through B-3 hold. The wording is in `packages/graphagent/src/tool/task.txt` and
`packages/graphagent/CONTEXT.md`. Mapping from the original IDs:

| Original                                                       | Revised        | Change                                                                                     |
| -------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| F-1, F-2, F-3                                                  | F-1, F-2, F-3  | Unchanged.                                                                                 |
| F-4: quick and cheap (seconds)                                 | F-4            | Now "a quick lookup the main agent can answer directly"; no duration threshold.            |
| B-1: the result does not block the next step                   | B-1            | Replaced by the trigger: the user's parallel signal or an explicit request for background. |
| B-2: only reads, or writes files the main agent will not touch | B-2            | Also covers files the user will touch.                                                     |
| B-3: long-running or of uncertain duration (minutes)           | removed        | The model could not judge duration in small repositories.                                  |
| B-4: its result fits in one message                            | B-3            | Renumbered.                                                                                |
| none                                                           | delegate first | New rule, applies once background is chosen.                                               |

F-3 still sends work whose result the next step needs to the foreground, which is what the old
B-1 expressed from the other side.

### Consequences and risks

- The background gate was not stably met. The foreground gate held in every batch (0/24), and
  accuracy passed its gate from Revision 1 on (90.0% to 95.0% against 85%). B hits were 15/18 for
  Revision 2, 14/18 for the final wording and 13/18 for the withdrawn trial (72.2% to 83.3%),
  against a gate of 5/6; only the Revision 2 batch reached it, and exactly.
- The misses repeat in the same scenarios. In b6 (the user writes documentation while the main
  agent runs the full test suite and type check and lists the failures by cause), all three rounds
  failed in most batches: the model ran `bun install` or the tests itself instead of delegating.
  b2 (review of uncommitted billing changes) and b5 (test-gap inventory) failed only occasionally.
- Prompt wording alone therefore does not reliably put background-suitable work in the
  background. Under Plan 6 of #1057 the prompt iteration stops here. A code-level execution mode
  is tracked in #1357 (Appendix A of #1057): agents and commands declare an `execution` mode, and
  hard constraints take precedence.
- The evidence covers one model family. QWEN and GLM were not configured, so the final wording
  has not been evaluated on them.
- All six B scenarios contain an explicit user signal. The result shows how reliably the model
  acts on the signal, not whether it would background suitable work without one; without a signal
  or an explicit request, `task.txt` says to use foreground.
- None of the 20 scenarios asks for foreground work in the same request as the delegated work, so
  the evaluation does not exercise the review correction directly; it shows only that the
  foreground and accuracy gates held with it.
- Delegating first moves context gathering from the main agent to the child agent. The delegation
  message carries the user's request and what the main agent already knows.
- The product change is the `task.txt` wording only: no runtime code, schema, or persisted state.
  Rollback is restoring the original wording, which failed two of the three gates (background and
  accuracy); the final wording fails only the background gate.

### Acceptance

- `task.txt`, `packages/graphagent/CONTEXT.md`, `README.md`, `README.en.md`, and this amendment
  describe the same criteria and the same turn-end rule: after delegating, continue any foreground
  work the user also asked for, and end the turn only when none is left.
- Foreground gate (no F violation): met, 0/24 with every wording measured.
- Accuracy gate (at least 85%): met with the final wording, 93.3% (96.7% on the final harness).
- Background gate (at least 5/6 B hits): met on the final harness (16/18, 88.9%), not stably met
  while the harness ran shell reads (72.2% to 83.3%). The code-level execution mode of #1357
  makes the result independent of wording and model variance.
