# Task Delegation Context

Task delegation moves one self-contained piece of work into a child session so the main agent can keep its own context focused. The classification below governs model-driven delegation: whether the main agent waits for the result in the same turn (foreground) or continues without it and receives the result as a later message (background). A user-issued command may instead select background through its command definition.

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

Foreground when any of these holds:

- **F-1:** The work needs the user's input or confirmation.
- **F-2:** It changes session or context state shared with the main agent, so ordering matters.
- **F-3:** The result is the direct input to the main agent's next step.
- **F-4:** It is quick and cheap (seconds); the background notification and context overhead outweigh the gain.

Background only when all of these hold:

- **B-1:** The result does not block the main agent's next step.
- **B-2:** The work only reads, or writes files the main agent will not touch.
- **B-3:** It is long-running or of uncertain duration (minutes).
- **B-4:** Its result fits in one message.

When neither list applies cleanly, default to foreground. The criteria live in the `task` tool description (`packages/graphagent/src/tool/task.txt`, "Choosing foreground or background"); the runtime does not classify calls.

## Default classification

| Work | Classification | Basis |
| --- | --- | --- |
| `/review` | Background, read-only | B-1 through B-4; the command declares `background: true` and the `review` agent holds read-only permissions. |
| `task` → `explore` | Either; commonly foreground | Often F-3 when the result decides the next edit; background only when B-1 through B-4 all hold. |
| `task` → `general` | Either; a writing run must also satisfy B-2 | A background writer may only touch files the main agent will not touch. |
| `watch_pr`, workflow, async hook | Background (unchanged) | B-1 through B-4. |
| Synchronous hook, compaction, goal | Foreground | F-2: each changes shared session state with ordering semantics. |
| Long-running shell command | Background candidate | Not covered by this decision; tracked separately. |

## Invariants

- Foreground is the default. Backgrounding removes the result from the current turn and pays a notification and context cost.
- Never run two writers on the same files.
- Never background a task and then wait for it with sleep or polling; end the turn and let the result arrive as a message.
- A background delegation is only useful when its result can be summarized in one message for the user.
- A task run started by the agent does not survive session cancellation. A user-issued background command survives Esc but is force-cancelled when its session is deleted. Other background tools keep their own cancellation semantics.
- A command-defined `background: true` applies only to a user-issued interactive run. A non-interactive turn or hook follow-up runs the subtask inline.
- The `review` agent is read-only: read, grep, glob, LSP, and read-only git and forge shell commands. It never edits files or runs mutating commands.

## Related decisions

- `docs/adr/0003-task-execution-classification.md` records the prompt-first decision, the criteria, and the `/review` behavior change.