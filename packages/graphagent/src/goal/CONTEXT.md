# Standing Goal Context

Standing Goal keeps one durable autonomous objective for a Session and advances it only when that Session becomes idle.

## Glossary

| Term | Meaning |
| --- | --- |
| Goal Instance | One objective generation, identified by `goal_id`; clearing and creating a new objective creates a different instance. |
| Goal Revision | The monotonic version of one Goal Instance. Loop decisions carry the revision they observed. |
| Goal Transition | One serialized read, decision, and save/delete operation over a Goal row. |
| Goal Outcome | The durable terminal snapshot written in the same transaction that removes the current Goal row. |
| Judge Verdict | `done`, `continue`, or `blocked`; blocked is a recoverable pause, never successful completion. |
| Session Automation Lease | The process-local right to admit an autonomous prompt while a Session is idle. |

## Invariants

- `transition` in `goal.ts` is the only durable Goal mutation seam.
- A Goal transition reads and writes or deletes inside one immediate database transaction.
- A delayed loop decision applies only to the same `goal_id` and revision it observed.
- Terminal completion writes `goal_outcome` and deletes the current row in one transition; a durable `done` row is never an intermediate cleanup obligation.
- `blocked` pauses the Goal and remains distinguishable from `done` in state, events, transcript text, and judge prompts.
- `SessionAutomationLease` elects one automation owner per Session. DAG owns the Session while any registered workflow remains; Goal is eligible only after the final DAG owner releases it.
- Goal and DAG hold the claimed generation fence through a durable mutation or prompt admission. Provider execution starts only after that fence is released; `SessionPrompt.promptIfIdle` remains the final idle-state guard.
- The current Session runner is process-local, so the automation lease is process-local. Clustered execution requires a separate durable lease design.

## Boundaries

- `Goal` owns durable state transitions and Goal lifecycle events.
- `GoalJudge` owns verdict parsing and transport-failure fallback.
- `GoalLoop` observes idle Sessions, asks the judge, submits version-bound transitions, and requests the shared Session automation lease.
- `SessionAutomationLease` owns Goal/DAG arbitration; `SessionPrompt` and `SessionRunState` own final prompt admission and runner idleness.
- `DagLoop` and `GoalLoop` may both observe one Session, but neither may mutate from an unverified automation claim or bypass `promptIfIdle` for autonomous driving.

## Decisions

- [ADR-0001: Serialized Goal transitions and shared Session automation admission](docs/adr/0001-goal-transition-authority.md)
