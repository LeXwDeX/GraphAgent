# Task Delegation Context

Task delegation moves one self-contained piece of work into a child session so the main agent can keep its own context focused. The classification below governs model-driven delegation: whether the main agent waits for the result in the same turn (foreground) or does not wait and receives the result as a later message (background). A user-issued command may instead select background through its command definition.

## Glossary

**Foreground Delegation**:
A task call the main agent awaits; its result is the call's return value, unless the run is promoted to the background mid-call.
_Avoid_: Synchronous task, blocking task

**Background Delegation**:
A detached task run owned by a background job; its result is delivered to the parent as a later message, not as the tool call's return value.
_Avoid_: Async task

**User-issued Background Command**:
A command started by the user whose definition declares `background: true`. It runs as a detached subtask, survives Esc, and its result is presented back as findings.
_Avoid_: Background command (unqualified; configured and hook-driven commands do not share these semantics)

**Read-only Reviewer**:
The built-in `review` agent; it can read, search, query LSP, and run read-only git and forge commands only.
_Avoid_: Code reviewer (does not distinguish the built-in agent from a user-defined one)

## Choosing foreground or background

Foreground is the default. Always foreground when any of these holds:

- **F-1:** The work needs the user's input or confirmation.
- **F-2:** It changes session or context state shared with the main agent, so ordering matters.
- **F-3:** The result is the direct input to the main agent's next step.
- **F-4:** It is a quick lookup the main agent can answer directly; the background notification and context overhead outweigh the gain.

Background only when all of these hold:

- **B-1:** The user signals parallel work: they say they will keep working on something else while this is done ("meanwhile", "at the same time", "I'll keep working on ...", "no need to wait"), or they ask for background. The main agent then delegates with `background: true` instead of doing the work itself in this turn.
- **B-2:** The agent only reads, or writes files neither the main agent nor the user will touch.
- **B-3:** Its result fits in one message.

Delegate first: once background is chosen, the main agent does not read files or run commands beforehand to investigate the work. It passes on the user's request and what it already knows, and the agent gathers its own context. The main agent then carries on with any foreground work the user also asked for; if none is left, it replies briefly and ends its turn. The result arrives as a message.

Reviews, audits, and test or type-check runs of finished work are good background work; research that decides the main agent's next edit is not. When neither list applies cleanly, default to foreground.

The criteria live in the `task` tool description (`packages/graphagent/src/tool/task.txt`, "Choosing foreground or background"); the runtime does not classify calls. A real-model evaluation shaped this wording (the original duration condition was dropped and the user's parallel signal became the trigger). While the evaluation harness still ran read-only shell commands, the final wording did not stably meet the background gate (72%–83% of the scenarios that should go to the background, against a gate of 5/6); on the final harness, which never runs the shell, it met all gates (88.9%). A code-level execution mode (#1357) removes the dependence on wording and model variance. Results: Amendment 1 in `docs/adr/0003-task-execution-classification.md`.

## Default classification

| Work | Classification | Basis |
| --- | --- | --- |
| `/review` | Background, read-only | Selected by the command definition (`background: true`), not by model classification; the `review` agent holds read-only permissions (B-2) and returns one report (B-3). |
| `task` → `explore` | Either; commonly foreground | Often F-3 when the result decides the next edit; background only when B-1 through B-3 all hold. |
| `task` → `general` | Either; a writing run must also satisfy B-2 | A background writer may only touch files neither the main agent nor the user will touch. |
| `watch_pr`, workflow, async hook | Background (unchanged) | They stay background as before and are not decided by the `task` criteria. |
| Synchronous hook, compaction, goal | Foreground | F-2: each changes shared session state with ordering semantics. |
| Long-running shell command | Background candidate | Not covered by this decision; tracked separately. |

## Invariants

- Foreground is the default. Backgrounding removes the result from the current turn and pays a notification and context cost.
- Never run two writers on the same files.
- Never background a task and then wait for it with sleep or polling; if nothing else is left, end the turn and let the result arrive as a message.
- A background delegation is only useful when its result can be summarized in one message for the user.
- A task run started by the agent does not survive session cancellation. A user-issued background command survives Esc but is force-cancelled when its session is deleted. Other background tools keep their own cancellation semantics.
- A command-defined `background: true` applies only to a user-issued interactive run. A non-interactive turn or hook follow-up runs the subtask inline.
- The `review` agent is read-only: read, grep, glob, LSP, and read-only git and forge shell commands. It never edits files or runs mutating commands.

## Related decisions

- `docs/adr/0003-task-execution-classification.md` records the prompt-first decision, the criteria, the `/review` behavior change, and (Amendment 1) the evaluation-driven revision of the criteria.
