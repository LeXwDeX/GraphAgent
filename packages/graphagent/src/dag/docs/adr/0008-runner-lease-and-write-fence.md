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
  (`src/dag/runtime/loop.ts`, `spawn.ts`, `recovery.ts`); `settleCompletion`;
  the `extend` that fan-out planning issues; the recovery `pause`; and `fail`
  for an orphan `pending` workflow or for `orchestrator_unresponsive`
  (`src/dag/runtime/delivery.ts`).
- **Intent writes carry no token.** Everything `DagControl` applies
  (`src/dag/control.ts`): `pause`, `resume`, `step`, `cancel`, `complete`,
  `nodeCancelled`, `replan`, `extend`, `recover`, `extendTimeout`, and
  `retarget`, plus its parking `pause` and automatic `resume`; `create`;
  `cancel` on session removal; and `DagBudget` (`pauseForBudget`,
  `requeueNodes`, `resume`), which enforces a limit the user set and has to
  take effect whichever runner holds the workflow. They still run in the
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

- The full split of `loop.ts` and `dag.ts`, the removal of the in-flight
  delivery sets `wakeInFlight`, `wakePending`, and `mailboxInFlight` in favour
  of `SessionInbox`, and an asynchronous git fingerprint in `DagLocation`:
  #1344, v2.1.
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

### Decisions 2 and 6: race 3, and how the tick measures a jump

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
  (R1 stays frozen) is taken over at the third round after the jump.
- The tick measures the jump itself, in the fiber that renews: the clock reading
  at the start of a tick minus the reading at the start of the previous one,
  more than two periods (60 s). The first tick is measured from the start of the
  fiber, which is the instance's startup. A tick whose round is stuck is not late
  itself, since it started on time, so the jump shows in the next tick, whose gap
  spans the stall. `afterClockJump` is true for that round and the one after it
  ("this round and the next"). The startup round has no predecessor and takes
  false. `clockJumped` and `classifyLease` are pure and live with `decide`.
- Under the TestClock, `adjust` wakes the sleepers one at a time. A tick that is
  not parked therefore runs every period and never sees a jump; only a tick that
  is parked on a gate (`freeze()` in the fixture) measures a long gap, in its next
  round. No fixture change was needed.
- A second rule to the same end, in the observation: the clock is read once, before
  the lease row is read, and the lease is judged expired or live against that
  reading. A process that is suspended in between (a round that was in flight when
  the machine went to sleep) then sees the lease as it was before, which can only
  make it look younger than it is. Race 3's first case pins this, because R2's
  round is parked on its lease read across the jump.

### Decision 6: one fiber

- The renewal and the reconcile round share the existing 30 second fiber, in that
  order. `RunnerLease.make` keeps its inputs and takes an optional `round`; the
  loop passes the reconciler's, and its startup scan runs a round itself. No
  second periodic fiber.
- Cost. A round runs in the renewal fiber, so a round that outlasts the TTL less
  one period would delay the next renewal beyond the lease's expiry. A round does
  bounded work: a few reads per workflow, one adoption at a time, and an adoption
  forks its children without waiting for them. `resolveExecution` now runs once per
  owned live workflow per round: a filesystem probe and, for a bound workspace,
  two synchronous git calls.
- A round that fails is logged and the fiber carries on; a workflow that fails is
  logged and the round carries on to the next one.

### Decision 6, rows 2, 3, 4 and 6: the actions

- Row 6 (`renew`) writes nothing: the renewals of the same tick ran ahead of the
  round.
- Row 3 (`evict`, lease lost) is the lease's own eviction (`RunnerLease.evict`,
  the one the renewal's loss path runs). It is awaited and idempotent: an entry
  that is gone by the time the eviction has its lock is left alone.
- Row 2 (`evict`, not owned) is the eviction of the session `Moved` handler,
  extracted as `DagReconciler.movedEvictor`, and the `Moved` handler calls it. It
  cancels the children that the node rows name, since the workflow stays in this
  process, and it keeps the dag registration of the parent session, because the
  new owner is an instance of the same process and registers the same key again.
- Row 4 applies while the instance itself drives the workflow, as the table says
  (the entry is cleaned up by the terminal handler); another runner's live lease
  still wins over it (row 5).

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

- `loop.ts` loses 70 lines (2494 to 2424): the orphan sweep, the body of the `Moved`
  eviction and the startup scan are replaced by wiring. The new code is `reconcile-decide.ts`
  and `reconciler.ts`.
