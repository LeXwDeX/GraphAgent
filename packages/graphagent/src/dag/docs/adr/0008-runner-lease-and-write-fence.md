# ADR-0008: Runner lease and write fence

- Status: Accepted
- Date: 2026-11-17

## Context

Several engine processes on one machine can open the same SQLite database
(WAL), and each runs a `DagLoop` that drives workflows. Which process drives a
workflow exists only in memory: the runtime entry, its watchers, and the child
sessions. The durable side has no owner. The workflow lock is a per-process
`KeyedMutex`. `DagStore.tryClaimAdoption` is one conditional UPDATE that
compares the workflow status and nothing else, and the projectors' conditional
UPDATEs do the same. A command reads its guard (attempt identity, transition
table) in one statement and publishes in another, except where `DagMessages`
wraps both in one transaction. Nothing can refuse a write from a process that
should no longer be writing.

Issue #1029 set out to close this. Its design review on 2026-11-17 corrected
three premises of the first draft (the issue body):

- `Dag.create` already commits `WorkflowCreated`, `NodeRegistered`, and
  `WorkflowStarted` in one `publishMany` transaction, so an interrupted create
  no longer leaves an orphan `pending` workflow.
- The process identity exists: `EngineProcess.runner` is `pid:nonce`, and
  `runnerAlive` judges it. The DAG has no lease.
- Five paths put a workflow into a runtime entry, or settle it without one:
  startup recovery, a replan that finds no entry, a session `Moved` event, the
  host supervision sweep, and the first wave on `WorkflowStarted`. They share
  no authority. The four instance-level paths exclude one another through the
  in-process `recovering` reservation, which works inside one process only,
  and the sweep assumes that this process owns every row it can read.

PR0 measured the consequences on a dual-runner fixture: two complete layer
graphs (connection, event bus, `Dag` with its lock, `DagMessages`, `DagLoop`)
in one test process, over one WAL database file. What one runner publishes
reaches the other only through the database. R1 and R2 are its two runners.

- **Race 1, a second runner starts while the first drives a node.** Reproduces,
  deterministically. R2's `reconcileWorkflow` runs before `tryClaimAdoption`,
  judges R1's running node as "execution ownership lost", fails it, and pauses
  the workflow. R1's later completion is rejected and the workflow stays
  paused. Fixed by PR2.
- **Race 2, start half: a stalled R1 wakes up after R2 took its node over.**
  Reproduces. R1's late `NodeStarted` lands (the projector compares the status
  only, and `running` matches) and points `child_session_id` back at R1's
  child. R2's completion is then rejected as stale and R1's is accepted: the
  zombie wins. Fixed by PR3b.
- **Race 2, completion half.** Does not reproduce. The attempt identity
  (`replanAttempts`, `childSessionID`) rejects a stale `NodeCompleted`, and in
  the production configuration `DagMessages.guard` checks it again in the same
  transaction. It is pinned as a plain test so that PR3a and PR3b cannot lose
  it.
- **Race 3, the wall clock jumps past the TTL while R1 is stalled.** Everything
  on the machine sees the jump, so R2 finds R1's lease expired only because
  nobody could renew it. The minimal form (R2 must not take over a live R1)
  fails today, for race 1's reason; the full assertions wait for the lease
  API. Fixed by PR4a.
- **Phantom event.** A `publish` inside an outer transaction that then rolls
  back still reaches `subscribe` and `all` (the bridge forwards `all` to
  `GlobalBus`), so listeners see an event that was never committed.
  `onCommitted` observers and the mailbox `changed` stream defer through
  `afterCommit` and are not affected. Fixed by PR3a.

The measurements narrow what the fence is for. A completion or failure of a
running attempt already has a second check inside its own transaction.
`NodeStarted` has none, and `nodeQueued`, timeout escalation, and deadline
extension have the same shape (the guard is read in one statement and the
event published in another). Only `NodeStarted` was measured; PR3b adds a case
for each of the others. These are the writes an epoch check has to cover.

The repository rule is not to assume cross-process locking or exactly-once
execution ([AGENTS.md](../../../../../../AGENTS.md)), and it stands. The lease
is a cooperative fence for several processes on one machine (see
Consequences), not a lock. Paths below are relative to `packages/graphagent/`
unless they start with `packages/`.

## Decision

### 1. One lease row per workflow, taken by a claim

A **runner** is an engine process, identified by `EngineProcess.runner`
(`pid:nonce`). A workflow's **lease** is one row of a new table, `dag_runner`
(`packages/core/src/dag/sql.ts`): `(dag_id, runner_id, epoch, expires_at)`. Its
**token** is the pair `(runner_id, epoch)`. The workflow is the unit because it
is already the engine's unit of ordering: it is locked, guarded, and fenced per
workflow.

- `dag_runner` joins the baseline in place before v2.0.0, under the baseline
  rules (Drizzle definition, `--rebaseline`, "baseline changed" in the PR). It
  is a source table like the mailbox tables: only the lease primitives write
  it, and event replay neither writes nor clears it.
- `DagLease`, in `packages/core`, has four operations: `claim`, `renew`,
  `release`, and `held`. Each takes the `runnerID` and `now` as arguments and
  reads neither `EngineProcess.runner` nor the clock, so a test can drive two
  runners in one process on a `TestClock`.
- `claim` is the only operation that takes a lease from another runner. It
  succeeds when the row is missing, has expired, or already names the caller,
  as one compare-and-set. A takeover from another runner increases the epoch
  and renewal never does, so the epoch only grows.
- `renew` extends `expires_at` only while the row still names the caller's
  token, and reports in the same statement (`RETURNING`) whether it did. It
  never changes the epoch, never takes a lease back, and does not compare
  time: a lease that has expired but that nobody took can still be renewed.
- `release` expires the caller's own lease at a clean exit. `held` reports
  whether a token still holds the lease.
- `claim` and `held` keep the admission guarantee of `tryClaimAdoption` (#270):
  they fail when the workflow row is gone or terminal.
- The TTL is 90 seconds and the renewal period 30 seconds.
- A new workflow has no row. `Dag.create` stays one `publishMany` and does not
  touch the table. A workflow without a row is unowned, and ownership comes
  from a claim by a reconciler (decision 6).
- After a hard crash nothing renews the lease, and another runner may claim it
  once `expires_at` has passed. Recovery then takes up to about two minutes:
  the TTL plus up to one 30 second tick before the next runner looks. That
  latency is accepted for the sake of epoch correctness, and `runnerAlive` is
  not used to shorten it. A clean exit releases at once (decision 2).

### 2. A runner fences itself

A runner does not wait to be told that it lost a lease.

- Renewal reports whether the row still names the runner's token. If it does
  not, the lease is lost and the runner evicts the workflow at once.
  **Eviction** stops scheduling the workflow, aborts its local watchers and
  child sessions, and drops its runtime entry. It writes nothing for the
  workflow: the new holder decides the outcome.
- Before it creates a child session, or commits or removes a worktree, the
  runner reads the lease again (`held`) and goes on only if its token still
  holds.
- If the wall-clock gap between two ticks of the same reconciler exceeds two
  periods (a suspended machine, a long stall), that round and the next do not
  preempt. An expired lease seen right after such a gap is evidence of the
  stall, not of a dead owner: everything on the machine sees the same jump,
  and the owner has had no chance to renew.
- `SQLITE_BUSY` is a transient failure. It is retried at the next opportunity
  and is never read as a lost lease.
- On a clean exit the instance's finalizer releases the leases it holds, after
  it has interrupted its fibers.

### 3. Every write is one IMMEDIATE transaction: fence, guard, publish

The `BEGIN IMMEDIATE` wrapper that `DagMessages.fenceWorkflow` uses today
(`packages/core/src/dag/messages.ts`) is extracted into a core primitive,
`transact(dagID, token?, body)`, and every `Dag` command that changes workflow
state runs through it. The body has a fixed order and may contain database
reads and writes only:

1. **Fence.** If a token is given, the lease row must still name it, otherwise
   the transaction fails with `StaleRunnerError` and rolls back. The
   comparison is on `(runner_id, epoch)` only, never on `expires_at`: expiry
   makes a lease claimable but does not by itself invalidate its holder, and a
   takeover does, because it changes the token.
2. **Guard.** The existing attempt-identity and transition-table checks, read
   inside the transaction.
3. **Publish.** The events and their projections.

An IMMEDIATE transaction takes SQLite's write reservation before its first
read, so the three steps see one state. The window between a guard read and
its publish closes for every command, `NodeStarted` included. A failed fence
rolls everything back, so a stale runner leaves no trace.

Notification moves behind the outermost commit (PR3a). Today `publish` notifies
`subscribe` and `all` as soon as its own savepoint is released, so a body that
publishes and then fails, or whose enclosing transaction rolls back, would
notify listeners of events that were never committed. `onCommitted` observers
and the mailbox `changed` stream already defer through `afterCommit`; the
notification takes the same route, and a rolled-back transaction delivers
nothing.

Work that needs the filesystem or git, such as the completion fingerprint of
`nodeCompleted`, is done before the transaction begins. The per-process
`KeyedMutex` stays and only queues writers inside one process; correctness no
longer depends on it.

### 4. Intent writes and runner writes

Only some writes carry a token. A write is a **runner write** when the
decision rests on the runner's own scheduling state: its runtime entry, a
watcher, a child it started, or the node-level reconciliation after a claim.
It is an **intent write** when a user, an agent, or a policy asked for it. The
class follows the origin of the decision, not the name of the command: `pause`
is an intent write when `DagControl` applies a request and a runner write when
the loop pauses a workflow because recovery invented failures.

- **Runner writes carry the token of the runtime entry.** `nodeQueued`,
  `nodeStarted`, `nodeCompleted`, `nodeFailed`, `nodeSkipped`,
  `nodeTimeoutEscalated`, and `nodeExtendTimeout` as issued by the scheduler,
  the spawn path, the deadline watchers, and node-level recovery
  (`src/dag/runtime/spawn-ready.ts`, `gates.ts`, `recover-workflow.ts`,
  `replan-handler.ts`, `spawn.ts`, `recovery.ts`); `settleCompletion`;
  the `extend` that fan-out planning issues; the recovery `pause`; and `fail`
  for an orphan `pending` workflow or for `orchestrator_unresponsive`
  (`src/dag/runtime/delivery.ts`).
- **Intent writes carry no token.** Everything `DagControl` applies
  (`src/dag/control.ts`): `pause`, `resume`, `step`, `cancel`, `complete`,
  `nodeCancelled`, `replan`, `extend`, `recover`, `extendTimeout`, and
  `retarget`, plus its parking `pause` and automatic `resume`; `create`;
  `cancel` on session removal; `pauseForArchive` on session archive; and
  `DagBudget` (`pauseForBudget`, `requeueNodes`, `resumeIfPausedFor`), which enforces a
  limit the user set and has to take effect whichever runner holds the
  workflow. They still run in the
  transaction of decision 3, without its fence step, and a lease never refuses
  them: a user can pause, cancel, or replan a workflow whatever process drives
  it. The lease holder meets the result in the guard of its next write, for
  example a node write on a cancelled workflow.
- **Durable-fact writes carry no token.** `failUnrecoverable` rests on the
  row's execution location alone and is re-validated inside the transaction; a
  concurrent move to a valid directory wins. It is not applied while another
  runner's lease is live (decision 6, rows 4 and 5). The writes of the host
  sweep follow the same rule: they are not runner writes, and decision 7 bounds
  them.

The attempt identity and the token answer different questions: whether a write
is about the current attempt of a node, and whether the writer still owns the
workflow. A runner write has to pass both, and neither replaces the other.
`Dag.extend` already takes a `fence` argument (`{ nodeID, attempt }`) that ties
a fan-out extend to the pending node that planned it. It checks the attempt,
not the lease; it stays and does not become the token.

### 5. The runner port

Runtime code writes through one runner port. The port binds the token of the
runtime entry to every runner write, so a call site cannot leave it out, and it
is the only place that handles `StaleRunnerError`. On the error it evicts the
workflow's local state first (decision 2) and then fails the call with an
existing transition rejection, so a caller learns that its write is obsolete
and never sees a node failure to act on.

`StaleRunnerError` is not added to `isTransitionRejection`. That predicate says
that a concurrent change made a transition obsolete, so carry on. Many call
sites catch it and move on, and a fenced runner that merely carried on would
keep scheduling. Some callers also turn an error they do not recognise into
`nodeFailed(exec_failed)`; the fan-out expansion in the scheduler does. The
error must not reach them as it is.

### 6. One reconciler per instance, one pure decision

Each `DagLoop` instance (one directory) runs one fiber with a 30 second
period. It renews the leases of the instance's runtime entries, paused and
stepping workflows included, and reconciles the non-terminal workflows that
the directory owns. The judgment is a pure function, `decide(observation)`,
that returns one action. A thin shell reads the observation, runs the action,
and makes `reconcile(dagID)` single-flight, so concurrent triggers for one
workflow collapse into one evaluation; this replaces the `recovering`
reservations. Startup, `WorkflowStarted`, a replan with no entry, a session
`Moved` event, and a lost lease are triggers for `reconcile(dagID)` and no
longer recovery paths of their own. There is no registry of instances, and the
reconciler does not move into `SessionInbox`.

The observation is a plain record. It holds the workflow's durable status and,
for a `pending` workflow, whether every node is still `pending` and the
workflow is past the grace period; whether the instance's directory owns it
(`DagLocation.ownsWorkflow`); the verdict on its execution location
(`DagLocation.resolveExecution`); the lease row as read (none, held by this
runner, held by another runner and live, or held by another runner and
expired); whether the instance has a runtime entry; and whether this round or
the previous one follows a clock jump (decision 2). `decide` reads nothing
itself, which makes the table testable row by row. The first matching row
wins.

| # | When | Action |
| --- | --- | --- |
| 1 | The workflow is terminal or gone | `noop` |
| 2 | The instance's directory does not own it | `evict` if the instance has an entry, else `noop` |
| 3 | The instance has an entry and the lease row no longer names its token | `evict`; the lease is lost |
| 4 | The execution location is unusable and no other runner holds a live lease | `fail-unrecoverable` |
| 5 | Another runner holds a live lease | `defer`; do not claim, do not judge its nodes |
| 6 | The instance has an entry (its lease is held) | `renew` |
| 7 | Another runner's lease is expired and this round or the previous one follows a clock jump | `defer`; no preemption |
| 8 | The workflow is `pending`, all its nodes are `pending`, and it is past the grace period | `terminalize-orphan`; claim, then publish `WorkflowStarted` and fail it, as `recoverOrphanPending` does today |
| 9 | The workflow is `pending` otherwise | `defer`; wait for `WorkflowStarted` |
| 10 | Otherwise: no lease row, another runner's expired row, or a row that names this runner while the instance has no entry | `adopt`; claim, then node-level reconciliation, then arm the runtime entry. A lost claim ends as `defer` |

- **The claim comes first.** `reconcileWorkflow` runs only inside `adopt`,
  after the claim. Today it runs first, which is race 1; with the claim ahead
  of it, a node that a live runner drives is never judged lost. After a
  successful claim the node-level reconciliation is unchanged: a node that is
  `running` without proof of its child's outcome is failed as `ownershipLost`,
  and the workflow is paused instead of cascading skips.
- **Orphan `pending` is a row, not a path.** `Dag.create` no longer leaves such
  a workflow, so the rule is a guard for rows that an older version wrote. It
  carries a grace period.
- **A jump is not a death.** Row 7 is how decision 2's clock rule reaches the
  decision. A claim of a workflow that has no lease row takes nothing from
  anyone, so it is not held back.
- A row that names this runner while the instance has no entry is what a
  session moved between two directories of one process looks like to the new
  owner (see Consequences).

### 7. The host sweep stays apart

`DagSupervisionSweep` keeps running at the process level with no instance
context. It is not merged into the reconciler. PR4b tightens its contract in
two places: it stops assuming that this process owns every row it can read, so
a workflow whose lease is live is left to its holder, and
`failUnusableWorkspaces` acts only on rows that have no live lease. Its writes
are not runner writes: it holds no lease and carries no token.

### 8. Delivery order

| PR | Scope | Done when |
| --- | --- | --- |
| 0 | This ADR; the dual-runner fixture; the three races and the phantom-event probe, registered as `test.failing` | The fixture reproduces race 1 |
| 1 | `dag_runner` and `DagLease` in `packages/core` | Table-driven claim, renew, release, and held tests pass; `migration --check` passes; the PR says "baseline changed" |
| 2 | `lease.claim` replaces `tryClaimAdoption` and runs ahead of `reconcileWorkflow`; per-instance renewal; eviction and release | Race 1 turns green |
| 3a | The `transact` primitive, wired into every `Dag` command; notification after the outermost commit; the phantom-event test and fix. Independent of PR1 and PR2 | Guard and publish share one transaction; the phantom-event probe turns green |
| 3b | The token on every runner write; `StaleRunnerError`; the runner port | Race 2 turns green |
| 4a | `decide` and the single-flight `reconcile(dagID)`, wired to startup and the tick | The truth table is fully covered; race 3 turns green |
| 4b | The other triggers call `reconcile`; `recoverOrphanPending`, `recovering`, and the duplicate first-wave adoption are deleted; the sweep contract is tightened | `test:dag-core` passes and `loop.ts` has fewer lines |

A known race is registered with `test.failing`: green while the race exists,
red once a fix lands, which is the signal to turn it into a plain test. The PR
that fixes a race converts its case. `DAG_RACES_STRICT=1` runs the cases as
plain tests and shows the real assertion failure.

The fixture's hold point sits before `publish` opens its transaction. Once
every command runs inside `transact` it cannot park a writer there, so PR3a
and PR3b add a hold at the command entry, ahead of the transaction.
`EngineProcess` and `GlobalBus` are process singletons that the fixture does
not isolate, so an inbox nudge reaches both runners.

These PRs put new code in new files. `loop.ts` and `dag.ts` only lose lines.

## Consequences

- Every runner write reads the workflow's lease row inside its transaction;
  intent writes do not. Each instance writes renewals every 30 seconds while
  it holds workflows.
- Guard reads now run while the transaction holds SQLite's write reservation,
  which `nodeQueued`, `nodeStarted`, timeout escalation, and deadline
  extension did not do before. That is why the body is limited to database
  work: a body that waited on anything else would block every other process's
  writers.
- One runner drives a workflow at a time. The lease makes that assumption
  checkable; it does not make the engine a multi-writer. The runtime entry,
  its watchers, and its children stay single-owner.
- The fence is cooperative. It binds the writers that go through `transact`
  with a token. A writer that does not, such as a tool that opens the database
  file directly, is not constrained, and intent writes carry no token by
  design.
- The fence protects durable DAG state, not side effects. A runner that lost
  its lease can still have children and tools running until it learns of the
  loss: at its next renewal, at its next fenced write, or at the re-check
  before it creates a child session or commits or removes a worktree. That
  re-check narrows the window and does not close it, because a check and the
  action it guards are not one atomic step. The guarantee is that no stale
  write to DAG state is accepted. It is not a lock that a caller may hold
  around a side effect, and it is not exactly-once execution.
- A hard crash costs up to about two minutes before another runner adopts the
  workflow. A runner that is stalled for longer than the TTL can lose its
  workflows to another runner although its process is alive; if one took them,
  it learns of it at its next renewal or fenced write and evicts them.
- The lease is a single-machine mechanism. Expiry compares the wall clocks of
  processes on one host, SQLite's WAL needs all its processes on one host, and
  the other recovery passes that share this database judge a runner with
  `runnerAlive`, which probes a pid inside one pid namespace. **One database
  file shared by processes in different containers or on different hosts is
  not supported in v2.0.**
- The token identifies a process, not an instance. Two instances of one
  process, as when a session moves between two directories, share a
  `runner_id`, and the fence cannot tell their writes apart. Their separation
  keeps resting on the in-process lock, the evaluation lock, the attempt
  identity, and the old owner's eviction on `Moved`.
- A workflow whose directory has no live instance waits for one. The
  reconciler runs inside instances; only the host sweep's durable actions
  reach such a workflow.
- A durable event does not record the epoch that wrote it, so the log cannot
  show which holder produced an event.
- `dag_runner` changes the database baseline. PR1 says "baseline changed", and
  every local development database must be deleted and recreated.

## Alternatives Considered

- A process-level reconciler with a registry that routes to live instances (the
  first draft): not adopted. Adoption needs services that exist only inside an
  instance, so the host layer would only forward work. The per-instance fiber
  needs no registry; its cost is the directory without a live instance, above.
- Merging the host sweep into the reconciler: not adopted. The sweep runs in
  the layer scope with no `InstanceRef`, while adoption needs instance
  services. It only loses its ownership assumption and learns to respect a
  live lease (decision 7).
- Inserting the lease row in `Dag.create` (the first draft): not adopted. The
  first draft needed it to tell a create in progress from a crashed one.
  Creation is now one atomic transaction, so no such state exists, and a lease
  then always means that a runner claimed the workflow.
- Putting the fence in `PublishOptions.commit` (the first draft): not adopted.
  The hook runs inside `publish`, after the guard was read and decided outside
  the transaction and after the projectors ran, and its type has no failure
  channel. `transact` puts fence, guard, and publish in one transaction.
- Taking over a dead holder at once by probing its pid with `runnerAlive` (the
  first draft, same host): not used. It would cut hard-crash recovery to
  seconds, but the design puts epoch correctness first. Heartbeats to replace
  the probe are deferred.
- Adding `StaleRunnerError` to `isTransitionRejection`: not adopted (decision
  5).

## Deferred

- The splits of `loop.ts` and `dag.ts` (#1344), the asynchronous git
  fingerprint of `DagLocation` (#1476) and git under the workflow lock
  (Amendment 5) are done.
- Writing the epoch into the event payload.
- Having the host start instances for directories that have none.
- Replacing the pid probe of `runnerAlive` with heartbeats.
- Policies that decide who may recover a workflow, such as the lead workflows
  of #1292, attach to `decide` as further rows, not as new recovery paths.

## Amendment 1 (PR3b, #1029)

What PR3b adds to this ADR and where it departs from it. The text above stays as
written; where it conflicts with this section, this section wins.

### Decisions 3 and 4: the token travels in fiber context, not in arguments

- The text above says only that runner writes carry the token of the runtime
  entry, not how it reaches `transact`. No `Dag` command gained a token
  argument.
- Core adds a fiber-level reference, `DagTransact.Fence`
  (`packages/core/src/dag/transact.ts`, a `Context.Reference` with no token by
  default), and `underFence(service, dagID, body)` hands it to the transaction's
  fence. `transact(dagID, token, body)` keeps its signature.
- The `Fence` is cleared as soon as it has been handed over: the transaction
  body and any fiber it forks see no token, so a pause or a budget requeue
  issued from an observer is still an intent write.
- The only entry point on the runtime side is the new file
  `src/dag/runtime/runner-port.ts`. `RunnerPort.make({ dag, token, lost })`
  returns a `Dag.Interface` proxy that provides the `Fence` for 12 runner
  commands only (the 11 of decision 4 plus `pauseForCheckpoint`) and passes
  reads, intent writes, and `failUnrecoverable` through unchanged.
- Trade-off: no command signature and none of the many `Layer.mock(Dag.Service)`
  fixtures have to change. The cost is that the token travels implicitly in the
  fiber context and the compiler does not check that it is present; the
  guarantee rests on the port being the only entry point plus a static guard
  test (`test/dag/dag-runner-port.test.ts`).
- Classification: `pauseForCheckpoint` is in neither the runner-write list nor
  the intent-write list of decision 4. It depends on the runner's own scheduling
  state, so it is a runner write. `pause` and `extend` also have call sites in
  `DagControl`, and `settleCompletion` has one in the host sweep; the port binds
  only the runner's call sites.

### Decision 5: handling a refusal

- The port is the only place that handles `StaleRunnerError`. It first starts
  `RunnerLease.refused(dagID, token)`, which reuses the evictor (child-session
  abort reason `lease-lost`), and then fails with the existing transition
  rejection `InvalidTransitionError`.
- The eviction runs in a fiber of its own and the port does not wait for it: the
  refused write may come from a fiber the eviction interrupts, or from one that
  holds the `evalLock` the eviction takes.
- A caller does not mistake the rejection for a node failure. The refused
  transaction rolls back as a whole and leaves no event.
- The read-only work that `nodeCompleted` and `nodeFailed` do before their
  transaction (the node guard; for `nodeCompleted`, also the git fingerprint)
  comes ahead of the fence, so a runner that lost its lease finishes that work
  before it is refused. That is acceptable.

### Decisions 2 and 5: no eviction on a terminal workflow (a departure)

- The text above has the runner evict on every refusal by the fence. `refused`
  does not evict when the lease row cannot be read together with its workflow
  (the workflow is terminal or deleted).
- Why: the fence reads the holder through a join with the workflow row, so a
  terminal workflow has no holder. An eviction that got there first would make
  the `WorkflowTerminal` handler skip the terminal worktree settlement and the
  terminal wake.
- Result: a late runner write to a terminal workflow is refused by the fence and
  downgraded to a transition rejection. PR2's `verify` still evicts on a
  terminal workflow; bringing the two into line is left to PR4b.

### Decisions 2 and 6: the rest of decision 2, and orphan recovery

- An isolated node reads `leaseHeld` once more before it commits, writes its
  patch, and removes its worktree. If the lease is lost, the attempt ends there
  with no commit and no removal.
- Orphan `pending` recovery (`recoverOrphanPending`) claims the lease first,
  then fails the workflow through the port, and gives the lease back at the end.
  It leaves a workflow alone while another runner holds a live lease.

### Decision 3: unfenced writes that bypass `Dag` commands (left to PR4b)

- The bare `WorkflowStarted` that orphan `pending` recovery publishes.
- The `WorkflowWorktreeSettled` published when a worktree completes.
- The captured-output receipts of spawn and recovery (bound by the attempt
  identity guard, but not by the lease).
- The `NodeSafetyDenied` published by the child-session tool guard.

### Decision 8: line counts of `loop.ts` and `dag.ts`

- The text above says that `loop.ts` and `dag.ts` only lose lines. PR3b's wiring
  could not avoid growing them: `loop.ts` by a net 25 lines, `dag.ts` by a net
  4. The logic itself lives in `runner-port.ts` and `runner-lease.ts`.

## Amendment 2 (PR4a, #1029)

What PR4a adds to this ADR and where it departs from it. The text above and
Amendment 1 stay as written; where they conflict with this section, this section
wins.

### Decisions 2 and 6: race 3, and the clock watch

- PR0's race 3 froze R1 alone, moved the wall clock past the TTL, and only then
  started R2. That arrangement is the one of "a runner takes a lease over once it
  has expired" in `dag-runner-lease.test.ts`, with the opposite expectation. By
  the Consequences section a single runner that stalls past the TTL while the rest
  of the machine runs on is taken over, and that is correct: the lease test stays.
  Race 3 is now the case that decision 2 describes. R2 is already running, the
  whole machine is suspended (both runners are frozen and the clock jumps past the
  TTL), and both wake up together. R2 must not take over; R1's renewal succeeds at
  the epoch it had and its settlement is accepted. A second case pins the other
  half, that the rule is a delay and not a veto: a runner that never comes back
  (R1 stays frozen) is taken over at the third round from the wake-up, the first
  of which is the one that sees the jump.
- One clock watch per instance measures the jump. `ReconcileDecide.noteClock(watch,
  at, period)` is a pure state machine over `{ lastAt, quietUntil }`. A reading
  jumps when it is more than two periods (60 s) after the latest one; exactly two
  is not a jump, and neither is the first reading or a clock that went backwards.
  A jump arms a quiet period of two periods from itself, and a reading is
  `afterJump` when it jumps or falls inside the quiet period. `lastAt` is the
  largest reading seen, so two fibers that feed one watch need not feed it in
  order. `RunnerLease.make` keeps the watch, seeded at the start of the instance,
  and exposes it as `noteClock`; the loop hands that to the reconciler.
  `clockJumped` is gone; `classifyLease` and `noteClock` are pure and live with
  `decide`.
- Two feeds. Every tick feeds its reading, and every observation of the reconciler
  feeds the reading it takes first. The first version measured the gap between two
  ticks only and told "that round and the next". A machine that slept between the
  observations of one round (after the first workflow was looked at, before the
  second) left the later observation with a lease that looked expired and a round
  that had been told no jump, and the runner took the workflow over. With the
  observations feeding the watch, the later observation sees the jump itself.
- The quiet period is wall-clock time, not a count of rounds. It is what the owner
  has to renew a lease that the jump made look expired, whichever reading, a
  tick's or an observation's, comes first after the jump. At the tick's pace it is
  what "that round and the next" was: the round that sees the jump and the one 30 s
  later hold back, the one after them preempts. `Round.afterClockJump` stays as the
  caller's own verdict (the tick passes the one of its own reading, startup passes
  false), and an observation is `afterClockJump` when either it or the watch says
  so.
- A round that is merely long is no jump: the tick does not wait for the round
  (below), so the watch is fed every period however long a round takes.
- Under the TestClock, `adjust` wakes the sleepers one at a time. A sleeping tick
  is therefore woken at every period and never sees a gap; only a tick that is
  parked when the clock moves does, as a real suspension stops the process in the
  middle of whatever it was doing. `freeze()` parks a renewal, so race 3's R2
  drives a workflow of its own, and the tick sequence test parks a scripted
  renewal. No fixture change was needed.
- A second rule to the same end, in the observation: the clock is read once, before
  the lease row is read, and the lease is judged expired or live against that
  reading. A process that is suspended in between (a round that was in flight when
  the machine went to sleep) then sees the lease as it was before, which can only
  make it look younger than it is. `dag-reconciler.test.ts` pins it with a stall
  between the two reads.

### Decision 6: two fibers

- The renewal and the reconcile round run in two fibers of the instance, a
  departure from decision 6's one. The tick (every 30 seconds) renews the leases
  and reads the clock and does nothing else. It starts the round in a fiber of its
  own, in the instance's scope, when none is in flight, and does not wait for it. A
  tick that finds the previous round still running starts none and logs at debug
  level. Startup runs a round itself and awaits it, so `init` still blocks on the
  first reconciliation. `RunnerLease.make` keeps its inputs and takes an optional
  `round`; its other additions are optional too.
- Why. A round can wait for a worktree removal, the entry's lifecycle lock or a
  user `WorktreeRemove` hook (`recoverWorkflow` and `reconcileWorkflow` do), and a
  round that outlasted the TTL less one period delayed the next renewal past the
  lease's expiry: another runner then took over a workflow that this one still
  drove. Renewal is the owner's proof of life, and nothing may stand in front of it.
- The fiber of a round is a child of the scope `RunnerLease.make` was given, so
  closing the instance interrupts it, ahead of the release of the leases (the
  release is the scope's first finalizer and runs last). A round that fails is
  logged and the next tick starts another; a workflow that fails is logged and the
  round carries on to the next one.
- Cost. A round is no longer bounded by the renewal period, but it is still single:
  one at a time per instance, and `reconcile(dagID)` single-flights the workflows
  inside it. A round that never ends keeps the instance from reconciling again and
  nothing else; each tick says so at debug level.

### Decision 6, rows 2, 3, 4 and 6: the actions

- Row 6 (`renew`) writes nothing: the renewals of the tick that started the round
  ran ahead of it.
- Row 3 (`evict`, lease lost) is the lease's own eviction (`RunnerLease.evict`,
  the one the renewal's loss path runs). It is awaited and idempotent: an entry
  that is gone by the time the eviction has its lock is left alone. It also reads
  the lease row again under that lock, as the next section says.
- Row 2 (`evict`, not owned) is the eviction of the session `Moved` handler,
  extracted as `DagReconciler.movedEvictor`, and the `Moved` handler calls it. It
  cancels the children that the node rows name, since the workflow stays in this
  process, and it keeps the dag registration of the parent session, because the
  new owner is an instance of the same process and registers the same key again.
- Row 4 applies while the instance itself drives the workflow, as the table says
  (the entry is cleaned up by the terminal handler); another runner's live lease
  still wins over it (row 5).

### Decision 6, row 3: the order of the reads, and the eviction's re-read

- An observation reads the clock, the instance's entry, the lease row and then the
  workflow row, in that order. `DagLease.held` joins the workflow row and has none
  for a workflow that ended. Read after the workflow, a workflow that went terminal
  in between looks like a live one whose lease is gone: row 3 evicts its entry, and
  an eviction that takes the entry's `evalLock` before the `WorkflowTerminal`
  handler does leaves the handler no entry, which skips the terminal worktree
  settlement and the wake of the parent (the reason of Amendment 1's "no eviction
  on a terminal workflow", which `refused` already keeps). Read before it, a missing
  lease row of an entry means that the workflow had already ended, and the workflow
  row read afterwards says so: row 1 (`noop`; for an instance that has an entry for
  it, 4b-C makes it `retire`, below). A terminal workflow does not turn live in
  between, bar the reopen of a completed one by an extend, which follows the
  terminal wake that the handler sends after it took the entry.
- The eviction of row 3 (`RunnerLease.Interface.evict`) reads the lease row again
  once it holds the entry's `evalLock` and before it touches the entry, and leaves
  the entry alone unless the row shows another holder. No row (the workflow ended),
  a row that names the entry's token and a row that cannot be read (transient, the
  next round looks again) all mean "not lost". This is `refused`'s own judgement
  (Amendment 1), moved under the lock because the reconciler's verdict has waited
  for it. The check is a parameter of the evictor (`stillLost`) and only the
  reconciler's call passes it: `verify` and the renewal's loss path evict as before,
  so PR2's `verify` still evicts the entry of a workflow that ended, and bringing
  the two into line is left to PR4b, as Amendment 1 says.
- Not covered: a workflow that ends inside the lock section, after the re-read. By
  then another runner holds the lease, and the settlement of a workflow that this
  runner lost is that runner's.

### Decision 6, rows 8 and 9: orphan pending

- `ORPHAN_PENDING_GRACE_MS` is 60 seconds, measured as `Clock.currentTimeMillis`
  less `workflow.time_created`. `Dag.create` is one transaction, so a `pending` row
  older than that with all its nodes `pending` comes from an older version, and the
  grace period only keeps a writer that is still at it from being cut off. The row's
  timestamp is `Date.now()` at creation, not the TestClock's, so tests make a legacy
  row by moving `time_created` back, or by setting it to 0 under a TestClock. The
  failure reason stays "orphan pending workflow recovered at startup", although a
  tick can now terminalize an orphan too.
- Owner-less rows. An older version could leave `directory = ""`, which
  `ownsWorkflow` never owns (fail-closed). A `pending` row of this kind is treated
  as owned by every instance, as `recoverOrphanPending` always did; any other
  status stays unowned. Its location is unusable, so row 4 fails it at once, with
  no grace period: the outcome it had before.
- `recoverOrphanPending` is deleted. With the startup scan a round, it had no
  caller. Its sequence (claim, the bare `WorkflowStarted`, `fail` through the port,
  give the claim back) is the `terminalize-orphan` action, under the same
  `recovering` reservation. The bare publish is still unfenced (Amendment 1,
  PR4b).

### Decision 6, row 10: adopt

- `adopt` calls the loop's `recoverWorkflow` (claim, node-level reconciliation,
  entry, first spawn), which keeps its own guards and the `recovering` reservation.
  `reconcile(dagID)` is single-flight by itself (overlapping calls share one
  evaluation; a call that joined an evaluation that was interrupted evaluates for
  itself), and the two coexist until PR4b removes `recovering`.
- A running workflow whose adoption ended without an entry (a recovery that could
  not read a child session, which gives its claim back) used to wait for the next
  instance load. It is retried at the next round now, and so is a workflow whose
  holder's lease ran out while this instance was already up.
- `Replanned`, `Moved` and `WorkflowStarted` still adopt through their own paths.
  PR4b turns them into calls of `reconcile`.

### Decision 8: line counts

- `loop.ts` loses 65 lines (2494 to 2429): the orphan sweep, the body of the `Moved`
  eviction and the startup scan are replaced by wiring. The new code is `reconcile-decide.ts`
  and `reconciler.ts`.

## Amendment 3 (PR4b, #1029)

What PR4b adds to this ADR and where it departs from it. PR4b is delivered in
parts, and each part writes the subsections it owns (named in their headings).
The text above and Amendments 1 and 2 stay as written; where they conflict with
this section, this section wins.

### Decision 6: two entries, `reconcile` and `reconcileAfter` (4b-A)

- The text above has every trigger call `reconcile(dagID)`, so that concurrent
  triggers collapse into one evaluation. That is right for a caller that asks
  "what is the state now" on its own schedule, the startup round and the tick.
  It is wrong for a trigger that carries news. An event (`WorkflowStarted`, a
  replan, a session `Moved`) is handled after its change was committed, and an
  evaluation that began before the commit may be under way: joining it hands back
  a verdict made from the state before the event. A `noop` for a workflow that was
  `completed` when the evaluation read it and has been reopened by an extend since
  (the replan finds no entry, and the workflow waits for the next tick); a `renew`
  for an entry whose session has moved away; a `defer` for a workflow that was still
  `pending` when the evaluation looked and has been started since.
- `reconcile` keeps its meaning, and the case that pins it stays: three concurrent
  calls, one observation. The startup round and the tick keep calling it.
  `reconcileAfter(dagID)` is the second entry, for the event triggers. With nothing
  under way it is `reconcile`. With an evaluation under way it waits for that
  evaluation to end, however it ends (a verdict, a failure, an interruption: none
  of them is its answer, and a failure is not its failure), and evaluates once
  more. The calls that arrive during the same wait share that one re-evaluation
  through a per-workflow slot that the first of them creates (its leader). A call
  that arrives while the re-evaluation is running does not join it, because the
  reads of the re-evaluation began before the call; it waits for the next one.
- The re-evaluation runs in the fiber of its leader, which is the fiber of the
  event handler, as the adoption did when the handlers called `recoverWorkflow`
  themselves. A `reconcile` that arrives while a re-evaluation waits joins the
  evaluation under way, and one that arrives during the re-evaluation joins that
  one, so a trigger never holds a tick up.
- Mechanism. The evaluations under way (flights) and the slots are two maps keyed
  by workflow. Looking at the maps and registering in them is one synchronous
  step; `reconcile` used to look and register in two consecutive steps of one
  fiber, which holds only as long as the runtime does not yield between them. The
  step in which a leader registers the flight of its re-evaluation also gives up
  its slot, so a later call is never answered by an evaluation whose reads began
  before it. Every flight and every slot is ended by a release step that always
  runs, with the verdict, the failure, or "interrupted"; the calls that waited on
  an interrupted one look again, as joiners of an interrupted flight always did,
  so a leader that is cut off leaves its followers an answer.
- Cost. A trigger now waits behind an evaluation of its own workflow that is under
  way, which can be an adoption that waits for a worktree removal or a user hook.
  The `WorkflowStarted` and `WorkflowReplanned` handlers call it inline, as they
  ran the adoption itself before, so their subscriptions can be held up for as
  long. The `Moved` handler forks its calls (below).

### Decision 6, rows 2 and 10: the first wave, a replan and a move are triggers (4b-A)

- `WorkflowStarted`: the handler no longer adopts. It calls `reconcileAfter`, and
  the roughly 100 lines of `loop.ts` that duplicated `recoverWorkflow` for the
  first wave (claim, entry, deletion-race re-check, confirm, first spawn) are
  deleted. The steps that `recoverWorkflow` has and the first wave did not are
  no-ops for a workflow that was just created: the node-level reconciliation skips
  `pending` and `queued` nodes, there is no checkpoint and there are no message
  continuations. The handler's status guard (running rows only) is the truth
  table's now: a terminal row is row 1; a `pending` row is row 9, or row 8 for an
  orphan, whose own `WorkflowStarted` the handler meets while the orphan's
  evaluation is under way (the call waits for it and finds the workflow failed);
  a `paused` or `stepping` row, which the guard left to the next round, is adopted
  like any other. An unusable location is row 4 and another runner's live lease is
  row 5, and neither claims.
- `WorkflowReplanned`: the two places that called `recoverWorkflow` (no entry; an
  entry that was dropped while the handler waited for its lock) call
  `reconcileAfter`, the second one outside the entry's lock, which the evaluation
  takes itself when it evicts or adopts.
- Session `Moved`: the old owner's entries whose workflow the directory no longer
  owns, and the new owner's non-terminal rows that have no entry, are each handed
  to `reconcileAfter` in a fiber of their own, so that one evaluation that waits
  holds up neither the other workflows of the session nor the next event. The old
  owner's call ends in row 2, the eviction that `movedEvictor` has always made
  (the children that the node rows name are cancelled, the dag registration is
  kept); the new owner's in row 10. The wake nudge that follows is unchanged.

### Decision 6: `recovering` is deleted (4b-A)

- The in-process reservation of the loop had two jobs. One was to keep two
  adoptions of a workflow from running at once. That is the single flight now that
  every path which creates an entry comes through it: the one `runtimes.set` of
  the loop is in `recoverWorkflow`, which only the reconciler's `adopt` calls
  (`dag-location-guards.test.ts` pins both facts). The other was to keep the first
  wave off an orphan whose `WorkflowStarted` the terminalization had just
  published. The terminalization runs inside the flight of the orphan, so the
  first-wave call waits for it and finds the workflow failed.
- `recoverWorkflow` keeps a check for an entry that is there already, as the last
  line of defense. It loses the branch that failed an unusable location: row 4
  comes before row 10, so an adoption never saw one.

### Decision 6, row 10: adopt reads the row again (4b-A)

- The row that `adopt` is given is the observation's, older than the claim.
  `recoverWorkflow` reads the workflow once it holds the claim and works from that
  row (status, config, graph revision, execution directory). A workflow that is
  gone or terminal then is not adopted, and the claim is given back.

### Decision 3: the writes that bypass `Dag` commands (4b-A; completes Amendment 1)

Amendment 1 listed four writes that carry no token. None of them takes one. They
fall into two classes, plus the one that is replaced.

- `WorkflowWorktreeSettled` is a durable-fact write. It is protected by the
  write-once projection of `workflow.worktree` and by the `{graphRev, seq}`
  episode fence: a settlement computed for an episode that a replan has since
  reopened folds to a no-op. It cannot carry a token, because settlement runs
  after the terminal event, when the entry is gone and the lease has been given
  back, and a fence would refuse any token.
- The captured-output receipts are durable-fact writes bound by the attempt
  identity: `DagStore.setCapturedOutput` is one
  `UPDATE ... WHERE child_session_id = ? AND status = 'running'`. A late receipt of
  a runner that lost the lease reaches only the child session it created, and does
  not reach a row that was given a new child session. There are four call sites,
  in `spawn.ts`, in `recovery.ts` (two) and in `final-response.ts`, which
  Amendment 1 did not list.
- `NodeSafetyDenied` is an audit write. It records a tool denial that has already
  happened, and the node goes on running, so a token would fence nothing worth
  fencing. It has two publishers, `permission/safety-guard.ts` and
  `permission/hook-guard.ts`; Amendment 1 named one.
- The bare `WorkflowStarted` of the orphan's terminalization is not classified
  here. It stays a runner write and is replaced by an atomic runner command in
  4b-C.

### Decision 7: the host sweep (4b-B)

The host-level `DagSupervisionSweep` no longer assumes that the process's
database owns every workflow row it can read. It reads the lease table
(`DagLease.held`) and never writes it: it holds no lease and carries no token.

- Workspace failure (`failUnusableWorkspaces`) acts only on a workflow with no
  live lease: no row, or `expires_at <= now`, the boundary at which
  `DagLease.claim` lets another runner take over. A live lease is left to its
  holder, whoever it is, this process included; the holder's own reconcile
  round judges the location (decision 6, row 4). The clock is read before the
  lease row, in the reconciler's order. Only rows whose location is unusable
  pay for the read.
- A lease that cannot be read (a database defect such as `SQLITE_BUSY`) is not
  "no lease": the row is logged and left for the next tick.
- The node-timeout settle is unchanged. It is a durable-fact write bounded by
  the attempt identity and reads no lease.
- The fallback still holds: an instance that is torn down releases its leases
  in its exit finalizer, and a dead process stops renewing, so its lease runs
  out within the TTL. The case the sweep exists for, nobody driving the row,
  still has no live lease.

### Decision 3: the orphan's terminalization is one runner command (4b-C)

The last write that 4b-A left unclassified, the bare `WorkflowStarted` of the orphan's
terminalization, is fenced now. `Dag.failOrphan(dagID, reason)` does everything that row 8 has
after the claim in one `transact`: the guard, `WorkflowStarted`, and `fail` (`WorkflowFailed`, then
`NodeSkipped` for each node that is still `pending`).

- It closes the first item of Amendment 1's "Decision 3: unfenced writes that bypass `Dag`
  commands (left to PR4b)". The reconciler publishes nothing itself and is given no event bus any
  more; `terminalizeOrphan` is the claim, `failOrphan` through the port of that claim, and the
  give-back. It is a runner write like `fail` and is on the port: `RunnerPort.COMMANDS` has 13
  commands now.
- A refused token leaves neither event. Before, the `WorkflowStarted` went in ahead of the fence,
  so a runner that lost its claim between the two writes left a `running` workflow with every node
  `pending`. That is what a workflow that has just been started looks like, so whichever runner
  adopts it drives its nodes. Nobody can observe that midpoint now, neither a reader nor the
  first-wave handler (the notification of `WorkflowStarted` follows the commit that also failed the
  workflow), and a crash between the two legs cannot leave it behind.
- The guard admits `pending` and nothing else. `guardWorkflow` alone would let a `paused` workflow
  through (paused -> running is legal), and no create sequence leaves one. Any other status is
  refused with the transition rejection, and nothing is written.
- The events do not change. There is no new type and no new version: `WorkflowStarted` is
  projected from `pending` and `WorkflowFailed` from `running`, so a replay applies the same two
  events in the same order. The reason is still "orphan pending workflow recovered at startup", on
  the durable event, and the workflow is failed, not cancelled (an interrupted create).
- The evaluation still runs in the workflow's flight (4b-A), so the first-wave call that the commit
  raises waits for it and finds the workflow failed. It would find the same without waiting.
- `dag.ts` grows by 29 lines, the command and its comments.

### Decisions 2 and 5: `verify` does not evict a workflow that ended (4b-C)

- `verify` answers as before: `false` when the lease row, read together with its workflow
  (`DagLease.held`), does not name the entry's token. A workflow that is terminal or deleted has
  no row for anybody, so that is its answer too.
- What changed is what it does about `false`. It no longer evicts. It starts the reconciler's
  judgement (the next section), and the truth table reads a workflow that ended as row 1: the
  entry is retired, with the settlement of the worktree and the wake of the parent ("Decision 6,
  row 1", below), not evicted, as `refused` has left it alone since Amendment 1. When another
  holder shows, row 3 evicts it.
  The spawn that asked ends either way: no child session, no node event.
- This closes the departure that Amendment 1 recorded under "Decisions 2 and 5: no eviction on a
  terminal workflow" ("PR2's `verify` still evicts on a terminal workflow; bringing the two into
  line is left to PR4b"), and Amendment 2's repetition of it under "Decision 6, row 3: the order of
  the reads, and the eviction's re-read". `verify`, the renewal, `refused` and the reconciler's
  eviction now agree on a workflow that ended.

### Decisions 2 and 6: a lost lease is news for the reconciler (4b-C)

- `RunnerLease.make` takes an optional `reconcile`, and the loop wires it to
  `reconciler.reconcileAfter`. A renewal that finds the row naming another token and a `verify`
  that finds the lease not held each start `reconcile(dagID)`. Neither evicts directly any more.
- The trailing entry, because a lost lease is news in the sense of 4b-A: an evaluation under way may
  have read the lease row before the takeover, and joining it would hand back its older verdict.
  Triggers for one workflow collapse in the reconciler's slots.
- Each trigger is a fiber of the instance's scope that nobody waits for. The tick does not wait for
  it (Amendment 2, "Decision 6: two fibers": a judgement that waits for the entry's lock or a user
  hook must not hold a renewal back), and the spawn that asked returns `false` at once (the
  eviction interrupts its fiber, which therefore cannot wait for it). A judgement that fails is
  logged, and the next round, whose row 3 reads the same, looks again.
- The verdict is `decide`'s. Another holder's row evicts through `RunnerLease.evict`, which reads
  the row again under the entry's lock (`stillLost`), as the renewal's own eviction did; a workflow
  that ended or was deleted is row 1, and its entry is retired ("Decision 6, row 1", below). A
  renewal that cannot read (a database failure) is still no lost lease.
- Fallback. Without a `reconcile`, a lost lease is evicted on the spot, as in PR2 (from a fiber of
  the scope too, so the tick does not wait for it). A graph that builds `RunnerLease` with no
  reconciler, as the unit graphs of `dag-runner-lease.test.ts` do, has nobody to judge. The loop
  always passes one.
- `refused` is unchanged. It has its own judgement (`heldByAnother`) and its own de-duplication,
  and it already leaves a workflow that ended alone.
- Another process ended the workflow before this runner's renewal noticed the loss. The terminal event
  reaches the subscribers of the bus that published it, and another process's bus is not this one, so no
  terminal handler runs in this process, and the failed renewal is the only news. Judged as `noop`, as row 1 was
  at first, the entry would stay: the renewal fails at every tick, each trigger ends in row 1, and the children
  that the entry started run to their end, their writes refused by the fence. Row 1 retires the entry instead
  (the next section). When the workflow is still live at that renewal, which is the usual order (the other
  runner took the lease and has not ended the workflow yet), the entry is evicted by row 3, as before.
- `loop.ts` grows by 3 lines, the wiring.

### Decision 6, row 1: the entry of a workflow that ended is retired (4b-C)

- The row. A workflow that is terminal or gone is judged first, as before, and the verdict now depends on
  whether the instance has an entry for it: `retire` when it has, `noop` when it has not. Row 1 stays ahead of
  row 2, so a workflow that ended is retired whoever owns it and whatever its lease row says. The table's row 1
  reads "`retire` if the instance has an entry, else `noop`", as row 2 reads for `evict`.
- Why. Terminal events do not cross processes: when another process ended the workflow, no handler in this
  one hears of it, and the entry has no other way out (see "a lost lease is news", above). `retire` is that
  way out. It does what the `WorkflowTerminal` handlers do for an event this process did hear of.
- One routine, two callers. `retireTerminal` in `teardown.ts` is the body of the `WorkflowTerminal` handlers,
  moved, and the reconciler's `retire` input is the same routine; the action runs in the workflow's flight, as an
  eviction does. Under the entry's `evalLock` it reads the workflow row again (a live row means that the news is
  stale, a late terminal event or a verdict made before an extend reopened the workflow, and the entry stays),
  checks that the entry is still the table's, stops the children that the entry's own attempts recorded, interrupts the
  fibers and watchers and drops the entry. Then, outside the lock and only for the call that dropped it, it gives the lease
  back (`abandon`), settles the worktree, releases the dag registration of the parent session and nudges its
  wake. The reason the children are stopped for is the durable status (completed, failed, cancelled; a row that is
  gone is a deleted session); it used to follow the event type of the handler, which is the same in every order
  but a stale event for a workflow that has ended differently since.
- Once. Whichever call takes the entry's lock first retires it, and the other finds the entry gone or replaced and
  ends there: the lease, the settlement, the registration and the wake follow once per entry, whether the handler
  or the reconciler is first. A terminal event that arrives after the retirement finds no entry and takes the
  entry-less path of the handler, unchanged. Its settlement is the durable-fact write of decision 3 (4b-A):
  `workflow.worktree` is write-once, so a second settlement is a no-op. Its wake is a nudge, a notification whose
  authority is the durable wake ledger, so a second one delivers nothing new. When another process settled and
  woke already, this runner's settlement and nudge are the same no-ops: one effective settlement and one wake per
  ended workflow, whoever runs them.
- A row that is gone (the session was deleted in another process and the rows cascaded) takes the same path.
  There is nothing to settle (the seam finds no row), the node rows that name the children are gone with it, so
  no child is named, and the fibers are interrupted; the registration is released and the claim given back. The
  handler's treatment of an entry whose row is missing was this already.
- Without a `retire` given to the reconciler (the scripted collaborators of `dag-reconciler.test.ts`) row 1 does
  nothing, as it did. The loop always gives one.
- The round. A control op (a cancel) needs no lease, so another process that ends a workflow with one leaves this
  runner's lease row alone: the renewal keeps succeeding, no spawn asks, and no event reaches this bus. `round` therefore
  looks, after its scan of the live statuses, at every entry of the instance that the scan did not list, once per
  workflow (a failing one is logged and skipped, as in the scan), and the tick's round reaches row 1 for such an entry
  within one period. Before this, only the re-read of a spawn ever noticed it, which was the variant that the first
  version of this section left open. It is `reconcile`, not `reconcileAfter`: the round asks what the state is now.
- Which children. The children that the retirement stops are the ones the entry's own attempts recorded
  (`Evictable.attemptChild`, as the eviction's are), not the ones the node rows name: once another runner took the
  workflow over and restarted a node, the row names that runner's child, which this one must not touch. An attempt that
  recorded none (its spawn had not created the child yet) falls back to the row, as the handler always did; that is the
  one case in which the row's child can still be another runner's. For a workflow that ended it costs nothing (the
  holder stops its own children), and the durable re-read under the lock keeps it from a workflow that is live again.
- Not changed. `refused` still leaves a workflow that ended alone, and so does a renewal that cannot read.
- `loop.ts` grows by 38 lines (2317 to 2355): the routine has its comments, and `settleWorkflowTerminal` moved up
  ahead of the reconciler's construction.

### Decision 3: `DagTransact` is required (4b-E)

The last part of PR4b makes the transaction of decision 3 a dependency that `Dag.layer` cannot go without. Until now
`Dag.layer` read `DagTransact.Service` with `Effect.serviceOption`, and without it `transact` ran the command's body as
it stood: no `BEGIN IMMEDIATE`, no fence, and the window between the guard and the publish that decision 3 closes. The
production layers always provided the service. The case without it was a harness that built `Dag.layer` out of mocked
dependencies, so that harness ran a `Dag` that does not ship.

- `dag.ts` takes the service with `yield* DagTransact.Service`, and `transact` is `DagTransact.underFence` for every
  command. The type of `Dag.layer` names the dependency, so a graph that leaves it out no longer type-checks.
  `Dag.defaultLayer` and `Dag.node` already provided it and are unchanged. `DagMessages` stays optional; it is not part of
  4b-E.
- Deleted: the `Option` branch, the "optional for now" comment, and the sentence of the terminal-settlement comment that
  said the same decision ran unfenced without the service. `runner-port.ts` and the other runtime files had no branch for
  a missing transaction. `dag.ts` loses 5 lines (2795 to 2790).
- Every test graph that builds `Dag.layer` provides a real `DagTransact` over the database that its store and event bus
  use: `transactLayer(database)` of the shared `test/dag/fixture/transact.ts`, or `DagTransact.defaultLayer` where the
  graph is made of default layers. There is no stand-in that runs the body outside a transaction; it would put the
  removed path back into the tests. A graph whose store and bus are `Layer.mock` doubles had no database at all. It gets
  an in-memory one that only the transaction uses, and its commands still run on the doubles.
- The loop graphs now run under a real fence. `RunnerLease.resolve` builds a `DagLease` over the graph's database when none
  is provided, so every `DagLoop` in a test claims real leases and its runner port stamps each runner write with the token.
  In a graph without `DagTransact` nothing consumed that token. The fence checks it now, and every such test passes
  unchanged.
- Deleted test: "a command without the transaction service runs as it did before (no transaction, a window)" in
  `dag-transact.test.ts`, with the harness option that built that graph. Its subject is the path that no longer exists.
- Tests a real transaction could expose. A body that waits holds SQLite's write reservation, and every other statement
  on that connection queues behind it, so a test that parks a command's body on a latch while another fiber needs the
  database would time out. Every graph above was searched for that shape (a bus `publish`, a store read, or a projector
  that waits inside a command) and run. None needed a rewrite: the stops of these tests are on event subscriptions and
  `listen` callbacks (delivered after the outermost commit), on child prompts, on the loop's own reads, and on the
  delivery's `markWakeBatchReported`, all outside a command's body. The one test group that does wait inside the body is
  `dag-workflow-lock.test.ts`, whose mock `getWorkflow` sleeps past `WORKFLOW_LOCK_TIMEOUT` inside the critical section.
  It stands for a database read that takes too long, nothing else uses the in-memory connection of its graph, and it
  keeps its assertions. It now also covers one more thing: the interruption by the lock timeout rolls the transaction
  back, so the next command can begin its own.
- The mixed graph of `dag-settle-cross-connection.test.ts` (store and bus on the default in-memory database, the mailbox
  on a file) stays as it was; `DagTransact.defaultLayer` joins the store's database.
- No assertion was loosened, and no test other than the one above was deleted.

### Decision 8: line counts of `loop.ts` (4b-A)

- `loop.ts` loses 114 lines (2428 to 2314): the duplicate first-wave adoption, the
  `recovering` reservation with its uses and the unusable-location branch are
  deleted, and the other triggers become calls of `reconcileAfter`. The new code
  is in `reconciler.ts` (the two entries and their flights).

## Amendment 4 (#1344, the delivery sets)

The part of #1344 that the Deferred list named and that is now done: the
removal of the in-flight delivery sets of `DagDelivery` (the wake reservation
with its pending mark, and the mailbox reservation) in favour of
`SessionInbox`. The text above and Amendments 1 to 3 stay as written.

- Delivery has one entry, the `dag.delivery` inbox claim. Every event source of
  the loop and the startup scan nudge the session through the inbox (forked,
  because `inbox.nudge` resolves after the drain it starts or joins); none of
  them calls the delivery attempt itself, and the inbox is no longer optional
  in `DagLoop`.
- The inbox's per-session drain does what the sets did: one attempt per
  session at a time, a nudge that arrives mid-attempt becomes exactly one more
  pass over the durable rows, and the session is given back by a finalizer
  when the attempt ends, is interrupted by its 7-minute lease, or dies. The
  lease stays inside the claim, because the drain holds the session for as
  long as the claim runs.
- One semantic change: delivery and the other sources of one session
  (`goal.continue`, reminders, `pr_watch`, ...) now share that lock. Before, a
  delivery started by a DAG event ran beside another source's claim.
  `dag-delivery-session-lock.test.ts` pins both directions.
- The runner lease, the write fence and the reconciler are untouched: delivery
  writes the workflow only through the entry's port, as before.

## Amendment 5 (#1344, git under the workflow lock)

The last acceptance item of #1344, which the asynchronous fingerprint of
`DagLocation` (#1476) left open: no command that holds the workflow lock runs a
synchronous git call, and none starts git inside its transaction. The text above
and Amendments 1 to 4 stay as written, except the Deferred list, which is
updated in place. Paths are relative to `packages/graphagent/`.

### Decision 3: what a command reads before its transaction, inside the lock

The order of `retarget` (#1476) is now the order of every command that has to
wait for git before it writes: take the workflow lock, read the row, read what
waits (git, the disk, the config service), open the transaction, re-read the row
in it, and apply what was read only while the row still names what it was read
against. A row that moved in between rejects or ignores the call; it is never
resolved in the transaction, where it would hold the write reservation for as
long as git takes.

- `retarget` (`workflow-recover.ts`): the lock, the row, `observeTarget`, then
  the transaction, where `observationHolds` compares the owner and execution
  directories. `observeTarget` resolved the requested workspace with
  `resolveWorkspace`, up to three synchronous git commands under the lock; it now
  calls `resolveWorkspaceAsync`.
- `failUnrecoverable` (`workflow-terminal.ts`) called `resolveExecution` inside
  the transaction; for an explicitly bound execution directory that is
  `resolveWorkspace` again, up to three synchronous git commands. It is now a
  command of its own, like `retarget`: the lock, the row (a missing or terminal
  row skips the observation), `observeExecution` (`resolveExecutionAsync`), then
  the transaction, which re-reads the row and acts only while
  `executionObservationHolds` (the row still names the same `directory` and
  `executionDirectory`) and the verdict is not `ok`. A session move that
  re-stamped the row in between still wins and returns `ignored`, as the
  decision 4 text above requires. What the transaction can no longer see is the
  disk: it used to judge the directory as it was when the transaction ran, and
  now judges it as it was when git was asked, a gap as long as git takes. A
  directory that reappears in that gap is not seen; a row that is re-stamped is.
- `replan` and `extend` (`graph-mutation.ts`) pinned every workspace of the
  fragment with `pinNodeWorkspaces` inside the transaction (up to three
  synchronous git commands per distinct workspace), and `_replan` also read the
  user's node cap there (`readUserMaxTotalNodes`: a dynamic import and a read of
  the config service). Both are now read by `prepare` before the transaction
  opens. `extend` carries the pending and queued nodes forward with their stored
  definitions, so `prepare` also resolves the workspaces of the pending and
  queued nodes of the row it read: the workspaces checked are those of the
  fragment `_extend` builds, as before. The transaction hands
  `pinNodeWorkspaces` a resolver that answers from what `prepare` read, and only
  while the row still has the owner directory it was resolved against; a
  workspace it did not read, or a moved owner, rejects with `Replan rejected:
  the workflow changed while its workspaces were being resolved; inspect status
  and retry`. Verdicts and their reasons are those of `resolveWorkspace`, so an
  unusable workspace is reported as before.
- `Dag.exclusive` carries the workflow worktree settlement of the loop
  (`runtime/worktree-completion.ts`, D9-g). The settlement has to stay inside
  the lock: it makes the terminal read, the commit, the patch and the fenced
  publish one critical section with recovery and replan. Its git was
  synchronous: `commitWorktree` (up to seven commands: status, add, commit,
  status, rev-parse and two diffs) and `gitHead`. It now waits for
  `commitWorktreeAsync` and `gitHeadAsync`. There is no transaction in
  `exclusive`, so nothing moves; the git only stops blocking the event loop.

The asynchronous functions are the synchronous ones with the same commands, the
same order and the same results, run as child processes of `AppProcess` (the
runner the fingerprint of #1476 uses). `commitWorktree` is written once as a
coroutine over its git commands and has the two runners; the others are mirrors
whose equivalence `test/dag/dag-lock-git-async.test.ts` checks value by value.
The synchronous versions stay for the callers outside the lock: create, spawn,
validation, the write guard, recovery, the reconciler, the supervision sweep and
the change facts.

### The cap of the lock

`WORKFLOW_LOCK_TIMEOUT` (30 seconds) covers the wait for the lock and the whole
critical section, so it now also bounds the git a command waits for in the lock.
Each command has a timeout and an output cap of its own (20 seconds and 64 MiB:
`FINGERPRINT_GIT_TIMEOUT_MS` and `GIT_TIMEOUT_MS`); the synchronous
`gitCommonDir`, `gitWorktrees` and `gitHead` had no timeout, and their
asynchronous versions have one. A section that outlasts the cap is interrupted
and the child process is killed (`exclusive` turns the timeout into a defect, as
before). Synchronous git in the lock could not be interrupted at all, which is
why it is not allowed there. The comment on `WORKFLOW_LOCK_TIMEOUT` in
`command-core.ts` said that a critical section must never await async work,
which stopped being true with #1476; it now describes this rule.

### Decision 3: the transaction body takes database work only

With the commands above, this holds for git in every command that waits for it
under the lock: `nodeCompleted` and `retarget` (#1476), `failUnrecoverable`,
`replan` and `extend`. `_replan` no longer waits on a dynamic import inside its
transaction either. Filesystem calls that are not git are not covered: the
canonical-path and `stat` checks of `resolveWorkspace` and `resolveExecution`,
and the existence check, the patch artifact and the settlement evidence that the
worktree settlement writes under `exclusive`, are still synchronous.
