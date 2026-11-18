# ADR-0006: DAG mode and review gates

- Status: Accepted
- Date: 2026-11-16

## Context

Before #1031 the main agent could not tell that the user wanted orchestration:
the routing guidance told it to promote a request to a workflow "on your own
judgment", and a workflow node's permission prompt landed in the same question
area as the user's own requests. The intended product is the opposite.
Orchestration runs without human intervention, the user talks only to the main
agent, and a user who turns it on expects the agent to use it actively, for
parallelism, collaboration, and review quality.

This ADR records the boundaries that make the mode safe enough to leave on: who
may change it, what runs without asking, what the safety net is and is not,
where parallel writers may work, and when a review may be accepted. The
decisions come from #1031 (M1, M2, and M6-M9; the concurrency pool and the
token budget are not covered here); #1324 adds user-selectable permission tiers
and #1325 the per-layer hook switch they lean on. A first version of the
unattended guard (#1323) tried to judge bash command text. `safety-guard.ts`
grew from about 740 to about 2,180 lines, mostly shell semantics, and every
review round found another spelling that escaped. It was cut back to structured
facts; decision 3 is the result. Paths are relative to `packages/graphagent/`.

## Decision

### 1. DAG mode is a per-session setting that only the user changes

DAG mode (`on` or `off`; unrelated to a workflow's `mode: standard | deep`) is
`session.dag_mode` on the session row. A new top-level session takes the value
given at creation (`run --dag-mode`), else the global `dag.mode`, else `off`; a
child session is always `off`. Only the user changes it, with `/dag-mode`
(`src/session/command.ts`). The model has no tool parameter for it, `/dag-mode`
is not a skill, hook output cannot change it, and the session update endpoint
rejects `dagMode`. A shell could in principle reach the local HTTP API; that
soft boundary is shared by every session setting, and L1 forbids it.

The mode changes what the main agent is told, the review gate a started
workflow gets, and whether a completed workflow gives it a completion turn
(decision 5). It does not change permission rules: if the workflow tool is
disabled or denied, L2 reports DAG mode as unavailable and the agent works
directly. An explicit instruction in the current message ("work directly", "use
a workflow") overrides the setting for that request only. Switching off cancels
nothing: running workflows continue to a terminal state and no successor starts
unless the user asks. The `dag` policy keys (mode, concurrency, node and token
limits, safety, permission) are read from the global layer only
(`PROJECT_SCOPED_DAG_KEYS`, `src/config/config.ts`), so a repository cannot turn
the mode on, raise a limit, or change what a user's agents may do unattended.

The agent is told in three layers (`src/dag/mode.ts`):

- **L1, `DagMode.SYSTEM`.** Constant system text on the mechanism and who holds
  authority. It goes in the turn's system list for a top-level session whose
  workflow tool is published, so a custom agent prompt still receives it and
  child sessions never do. It does not vary with the switch, so the cached
  prefix stays stable.
- **L2, the `dag_mode` state block.** A runtime-context slot rebuilt on each
  request from the durable row (`src/session/turn/prepare.ts`), so it survives a
  restart. It reads ON with the user's limits, a cleared OFF, or "ON but
  unavailable", plus lines for the `plan` agent, a non-interactive run, the
  token-budget tier, and a `dag.permission` tier other than `allow`.
- **L3, `DagModeReminder`** (`src/session/dag-mode-reminder.ts`). One static
  tail note per user-authored turn while the mode is on, added to the request
  only and withheld from automated turns and local commands. It is latched per
  turn, so a mid-turn `/dag-mode` applies from the next user turn.

### 2. Unattended sessions never ask the user by default

A session is unattended when nobody is expected to answer its permission
requests: a DAG node attempt, and a `task` child while its root session's DAG
mode is on, read at each request (with the mode off, a task child asks as
before). Child sessions never own the human dialog: `question` and `plan_exit`
are root-only tools (`ROOT_ONLY_TOOLS`, `src/tool/pipeline.ts`).

`ChildPolicy.askWith` (`src/session/child/policy.ts`; `askOf` binds it to the
database) decides in two steps: is the session unattended, then who answers. An
unattended session is settled automatically unless `dag.permission` is `ask`.
The tier is read from the global configuration on every request, so a change
reaches nodes that are already running. For an automatic session,
`Permission.ask` hands each pattern to the `AskAdjudicator` after the deny rules
and before any question; a pattern it settles creates no pending request and no
`permission.asked` event.

- **`allow`** (default). The safety guard adjudicates (decision 3).
- **`ask`.** Edit (which covers write and apply_patch), bash, and MCP calls go to
  the user, and the safety list does not run. Only a user-written allow with a
  concrete pattern (for an MCP tool, one that names that tool), or an "always"
  reply earlier in the same session, spares the question. Deny rules still win,
  and a non-interactive `run` rejects the requests rather than hanging.
  Implemented by #1324 PR1.
- **`readonly`.** Unattended sessions get a read-only tool surface (#1324 PR2).
  `edit`, `write`, and `apply_patch` are hidden (`src/tool/registry.ts`), and an
  `edit` request already in flight is refused. Bash runs only `READONLY_BASH`
  (`src/permission/index.ts`), the read-only git and gh allowlist that the
  `review` profile shares; a user's allow does not widen it. An MCP tool is
  refused unless the user wrote an allow that names exactly that tool. `read`,
  `grep`, `glob`, `webfetch`, and the agent tool keep their ordinary rules, and
  a request that would need an answer is denied as `RO-1` (decision 3). The
  tier only narrows: its override is consulted after the agent's and the user's
  deny rules, so it never lifts a deny. A workflow with a writer cannot start.
  `start` returns `error_code: permission_readonly`, and `extend`, `replan`, and
  `recover` are rejected with kind `permission-readonly`, for every caller and
  ahead of the plan-agent check (`DagWriteGuard.readonlyRejection`, decision 4).
  A running writer is not cancelled; the tier is read at every request, so it
  meets the surface from its next call.

### 3. The safety list is insurance, not a security boundary

In the `allow` and `readonly` tiers, `SafetyGuard`
(`src/permission/safety-guard.ts`) is the `AskAdjudicator` that `Permission.ask`
consults for unattended sessions; the `ask` tier leaves the judgment to the
user. It guards against the mistakes of an honest agent, not adversarial input.
It is not a sandbox and GraphAgent provides none (see "No Sandbox" in
[SECURITY.md](../../../../../../SECURITY.md#no-sandbox), and the
[user guide](../../../../../../docs/unattended-permissions.en.md) for what each
tier and the list do and do not catch); real isolation means a container or a
VM. The order of judgment, per pattern:

1. A `deny` rule refuses the call, as for any session.
2. SF-6: an ask only a human could settle (a hook returned `ask`, or an MCP tool
   requires user interaction) is denied, and no allow lifts it, the user's own
   included. Such an ask means "this cannot be confirmed"; approving it unseen
   would disarm whatever raised it.
3. An explicit allow settles the call: an allow the user wrote, on the permission
   key being judged, with a concrete pattern. Role and default rules do not
   count, and neither do whole-key wildcards such as `bash: "allow"`, which would
   otherwise switch the list off wholesale.
4. A list hit denies the call. The node gets a tool error naming the rule and the
   reason and keeps running; nothing pauses, escalates, or wakes the main agent.
5. Everything else is allowed, including what the rules would have turned into
   an ask. The `readonly` tier is the exception: an ask that nothing above
   decided is denied as `RO-1`, because nobody can fetch the approval.

The list is SF-1 writes outside the project, SF-2 credential files, SF-3
destructive commands, SF-4 publishing, SF-5 repeated identical calls, SF-6
above, `RO-1` for the `readonly` tier only, and the user's own `SX-<n>` entries
in global `dag.safety.extra`, which can only deny ([tool-profiles.md](../tool-profiles.md)
spells out the SF rules). It judges structured facts only: the permission key,
the paths native tools provide, which tool raised an `external_directory`
request, the doom-loop detector, the `forced` flag, and literal Wildcard tables
over the text of one simple command. It never interprets shell text (quoting,
wrappers, variables, redirects, `cd`, git state). For bash it uses only what the
shell tool already produces: each simple command's text and its own
`external_directory` detection.

**Native path contract.** SF-1 (a) and SF-2 judge the path a native file tool
actually hands to the filesystem: `read`, `write`, and `edit` report it in
`metadata.filepath`, `grep` and `glob` in `metadata.searchPath`, and
`apply_patch` in its patterns and `metadata.files`. The guard resolves it
component by component, following symlinks before `..` as the kernel does, and
denies a write target whose real location cannot be proven.

**Known gaps, by design.** Bash writes that bypass the shell tool's
`external_directory` detection (redirects, `tee`, `sed -i`, a changed working
directory); bash reads of sensitive files; any spelling that changes a command's
text (`env X=1 git reset --hard`, `bash -c '...'`, variables, `curl ... | sh`); a
push to the default branch (only force pushes match); and, for native tools,
hard links, a path swapped between check and use (TOCTOU), Windows-specific path
semantics, and the path arguments of non-native and MCP tools. The `readonly`
tier has the same gap: its bash allowlist is literal rules over the command
text, so a redirect after an allowed command (`git diff > file`) still writes.
The "known gaps" tests in `test/permission/safety-guard.test.ts` assert that the
bash cases are not denied, so extending the guard's reach starts by changing
those tests and this ADR.

**Disclosure.** A denied DAG-node call publishes the durable `NodeSafetyDenied`
event, projected into `workflow_node.safety_denials` (the first 20 per node and
a running total). The rules that publish it are SF-1..6, `SX-<n>`, `RO-1`, and
`HOOK` (below); the `readonly` tier's tool-surface refusals (edit, bash outside
the allowlist, MCP) are ordinary rule denials and publish nothing. `inspect`
shows the denials, coverage lists them, and the node and workflow wakes carry
the counts; a denial never wakes the parent by itself. A task child has no node
row, so its denial is only the tool result.

**External guard.** Stronger cover for bash lives outside the engine: a command
guard that the user installs as a user-level `PreToolUse` hook. The hook fires
for child sessions' tool calls before the tool's own permission request, and a
deny reaches the node as a tool result (`[Tool denied by hook] ...`). GraphAgent
bundles, downloads, and names no guard in code, and
`test/hook/unattended-guard-docs.test.ts` keeps it that way. The user guide,
linked from `SECURITY.md`
([English](../../../../../../docs/unattended-permissions.en.md),
[Chinese](../../../../../../docs/unattended-permissions.md)), shows how to wire
one up. `src/permission/hook-guard.ts` adds two pieces of engine support
(#1324 PR3):

- `permission_mode`. The tool hooks of an unattended session are told the tier's
  mode in place of the session's own: `dontAsk` under `allow` and `plan` under
  `readonly`, whatever `hookPermissions.mode` says. Under `ask` nothing is
  overridden. With nobody to ask, a guard that is unsure should deny; if it asks
  anyway, SF-6 refuses the call, except under `ask`, where the question reaches
  the user.
- `HOOK` denials. A PreToolUse deny of a DAG node's call, a guard that fails
  closed included, publishes `NodeSafetyDenied` with `ruleID: "HOOK"`, the
  tool's permission key, and the hook's reason cut to 200 characters.
  `src/tool/pipeline.ts` does this for built-in tools, MCP resource tools, and
  MCP server tools, in every tier. A confirmation the user refuses is not a
  safety denial, and a task child has no node row, so it records nothing.

Hooks fail open unless configured with `onFailure: "block"`. What keeps a
project from switching off a user-level guard is the layering rule of #1325
(`src/hook/engine/disabled.ts`): `disableAllHooks` applies per layer. `true` in
the global layer disables every hook; `true` in a project or local layer
disables only that side's hooks, and a project value never re-enables what the
global layer disabled.

### 4. Writers and workspaces

One definition of "writer" feeds every check: `DagBlocks.isWriterNode`
(`src/dag/blocks.ts`) is true for a `coding` or `prototype` block, or for a node
whose worker is not a read-only profile and whose effective `workspace_writes`
is not `deny`; the generated fan-out aggregator never is. `DagWriteGuard`
(`src/dag/write-guard.ts`) holds the rules. It is pure over facts its caller
read, plus one store read of live workflows, and never mutates or parks a
workflow. `workflow start` (`src/tool/workflow/run.ts`) and `DagControl`
(`src/dag/control.ts`) call it before any durable write, so a refusal means
nothing was attempted.

- **Plan agent: read-only.** `start`, `extend`, `replan`, and `recover` refuse a
  request that would newly run a writer when the caller is the `plan` agent. The
  `readonly` permission tier applies the same check to every caller, and first
  (decision 2). Draft, validate, resume, and step are not gated, and running
  writers keep running. This closes a way round plan's edit ban: a node derives
  its permissions from the parent session's deny and `external_directory` rules,
  not from the `plan` profile.
- **Cross-workflow conflicts.** `start`, `extend`, `replan`, `recover`, and
  `retarget` refuse a request that would newly run (for a retarget, move) an
  unisolated writer in a directory where another live workflow, in any session,
  still has an unfinished unisolated writer. Directories compare canonically by
  effective directory: node workspace, else execution directory, else owner
  directory, with a running node counted where it started. Writers isolated in a
  worktree, at node or workflow level, never conflict.
- **Default isolation.** A strict workflow whose document binds no workspace or
  isolation, and whose writers include a pair with no dependency path between
  them, starts with `config.isolation: "worktree"` when the directory is a clean
  git checkout with a commit. On a dirty, non-git, or commit-less directory it
  starts unisolated, and the start result warns the parent to keep write sets
  disjoint or run the writers serially, and not to commit or stash the user's
  changes. The pair test is the conservative reading of ADR-0002's addendum.
- **Isolated results are kept, never merged.** Settlement
  (`src/dag/runtime/worktree-completion.ts`) commits and writes a patch. The
  branch is always kept, and nothing merges it: the parent merges it or opens a
  PR, and asks the user when the merge conflicts.

Worktree isolation separates working trees for writers. It is not a sandbox and
does not limit reading host files, network access, or publishing. A `fan_out`
writer is one writer to `hasUnorderedWriters`, which runs on the authored graph:
its package writers exist only after the plan has run and the engine has proven
their declared write sets disjoint (ADR-0004). They share the checkout and rely
on the plan's disjoint write sets and the aggregator (ADR-0002).

### 5. Staging and review gates

The strict gate (`review_gate: strict`, or `mode: deep`) makes review structure
checkable. Every writer has a downstream diff review, after a verify, bound to
its fingerprint. Review decisions are required, not skippable, and include the
`completeness` lens, so a failed verification fails the workflow instead of
completing around the review, and `Dag.complete` refuses an explicit completion
while a diff review is unresolved. Lanes and arbitration run on a read-only
profile, by default the built-in `auditor`. A graph with writers carries 1-50
`config.acceptance` items with unique ids. `standard` reports the same gaps as
warnings (`requireReviewCoverage` in `src/dag/blocks.ts`;
`strictReviewCoverageErrors` in `src/dag/review-lifecycle.ts`), except `skip_ok`
on a block-compiled review decision: the block compiler sets it itself and a
template cannot change it, so persisted graphs keep that check and an authored
document does not. With DAG mode on,
`workflow start` forces `strict`, overriding an authored `standard`
(`src/tool/workflow/run.ts`). The gate is stored with the workflow and fixed at
start: extend and replan fragments are checked against it, so a later mode
switch neither loosens nor tightens a running workflow.

A `review` block takes `lenses`, `skeptics` (0-4 lanes that assume the change is
wrong), and `prior_round`, which continues a stored review decision. The
workflow tool resolves it into `prior_findings` before authoring; the model
never writes them. The arbitration output carries `dispositions` for every lane
action and `resolved` for every prior finding, and `src/dag/review-lifecycle.ts`
refuses an ACCEPT while an action is unrefuted or upheld, a prior finding is
still open, or, under strict, a lens or skeptic lane did not complete. The
parent runs the rounds, by extending a live workflow or starting a successor with
`prior_round`; the engine checks and bounds them but does not loop. A loop stops
after five rounds or two consecutive rounds without a new upheld finding: the
prior-round loader refuses a successor (`src/tool/workflow/prepare.ts`) and the
reason enters coverage (`src/dag/coverage.ts`), which is deterministic engine
output rather than authored prose.

A multi-phase objective is staged as understand, design, implement, review: one
workflow per stage, or one with a reporting checkpoint between stages (ADR-0003).
The parent reads each stage's result before the next. One live workflow per
objective is guidance, not an engine rule; the engine enforces only the
workspace rule of decision 4.

Four stage specs, `stage-understand`, `stage-design`, `stage-implement`, and
`stage-review`, ship in the binary (`src/dag/builtin-workflows/`, through
`builtinTemplates()` in `src/dag/workflows.ts`), so `spec list` and `spec read`
find them in every build and source run. Resolution is project, then global, then
builtin, and a release snapshot template of the same name replaces a stage spec.
Each declares the strict gate, pins no model, and keeps its reviewing, verifying,
and synthesizing nodes read-only; only `stage-implement` writes, through a
plan-driven `fan_out` coding block (ADR-0004). Each declares template inputs
(ADR-0007): the parent starts one with `run.start { spec_path, inputs }`, putting
the request in `objective` and, for implement and review, the acceptance items in
`acceptance`, instead of copying and rewriting the file.

Whether a completed workflow gives the parent a turn follows the mode
(`src/dag/runtime/delivery.ts`, #1015). Every terminal workflow reaches the
parent once; failed and cancelled workflows, completed ones with a reporting
checkpoint, and completed ones without a delivered final answer wake it in
either mode. The one case the mode decides is a workflow that ends in an
ordinary delivery leaf. With the mode on, its report is delivered and then one
completion turn wakes the parent, so a staged plan never stops half way. With
the mode off it is displayed without waking the parent (#891), which leaves no
turn in which to read the result and start the next stage. Delivery reads the
durable mode of the parent session at the moment of terminal delivery, not when
the workflow started or finished, and a failed read counts as off, so it never
adds a turn. Each stage spec is therefore built to give the parent a turn in
either mode: it carries a review decision, a reporting checkpoint that is not an
ordinary delivery leaf.

### 6. Review and merge policy for this area

- A finding inside a declared non-goal or known gap of #1031 or this ADR (for
  example, "the literal table misses `env X=1 git reset --hard`") is answered
  with a reference to the declaration, marked resolved, and not fixed.
- Two consecutive review rounds of one PR that raise the same class of P1
  finding stop the loop. The author goes back to the Issue and re-examines the
  boundary. If it is finite, it is written down as a contract and closed in one
  change (the native path contract of decision 3 was closed this way); if not,
  it is added to the known gaps.
- Before merge, the automated review of the latest head has no unresolved
  finding.

## Consequences

- The safety list is bypassed by any spelling that changes a command's text, by
  redirects, and by bash reads (decision 3). The `readonly` tier inherits the
  gap: a redirect after an allowed command (`git diff > file`) still writes.
  Real isolation needs a container or a VM, and command-level cover needs `deny`
  rules, `dag.safety.extra`, or an external guard hook.
- In the default tier an unattended session's asks are auto-approved unless the
  list matches, so edits inside the project, `webfetch`, and bash commands the
  list does not match get no human confirmation. Worktree isolation does not
  offset this; it only prevents write conflicts.
- In the `readonly` tier an MCP tool is refused unless the user allowed exactly
  that tool, so even a read-only search tool needs an explicit allow by name.
- A guard hook fails open by default, so a guard that cannot start is the same
  as no guard. With `onFailure: "block"` it fails closed, and because it is a
  user-level hook that runs for the user's own session too, a broken guard then
  refuses the user's own shell commands as well.
- The cross-workflow checks are not atomic. Each reads state just before the
  durable write and takes no cross-workflow lock, so two requests racing in the
  same instant can both pass.
- Default isolation costs a branch to merge for some pairs that would never have
  touched the same file; no disjointness claim is trusted. A dirty, non-git, or
  commit-less checkout is never isolated, and `fan_out` writers are not seen by
  the pair test. A completed isolated workflow cannot be reopened by `extend`,
  because its directory is gone while its branch remains; the parent starts a
  successor.
- "Read-only" describes a tool surface, not enforcement: the built-in `auditor`
  denies `edit`, `write`, and `apply_patch` but keeps bash.
- The stage specs are not named in L1, L2, or the built-in skills; the parent
  discovers them with `spec list` and `spec read`.
- With DAG mode on, a workflow the user simply asked to run and answer costs one
  extra parent turn after its displayed report; the wake tells the parent to
  stop without restating the report. With the mode off that request still ends
  at the displayed report.

## Alternatives Considered

- Judge shell command text, as #1323 first did: rejected. The set of spellings
  has no boundary a review can close, and the code tripled.
- Ask the user for node permissions by default: rejected, because it interrupts
  work meant to run unattended. It remains available as the `ask` tier.
- Let a guard hook's `ask` count as an ordinary ask, which an unattended session
  would auto-approve: rejected; it would disarm the guard (SF-6).
- Enforce one live workflow per objective in the engine: rejected. The engine
  blocks only the same-workspace write conflict.
- Give the model a way to switch DAG mode, through a tool field or a skill:
  rejected; the setting is the user's.
- Bundle or download a command guard: rejected. Installing one is the user's own
  choice and responsibility, and the repository ships only the guide that
  explains how.

## Deferred

- Engine-native review constructs: first-class `challenge` and `panel` blocks,
  an engine-driven `until_dry` loop, and engine-computed jury scoring. The parent
  drives review rounds through `prior_round`; the engine only checks and bounds
  them.
