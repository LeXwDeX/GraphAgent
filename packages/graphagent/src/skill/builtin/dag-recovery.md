# DAG Recovery and Replanning

This skill owns adaptation after execution starts: replanning, escalation,
crash recovery, node-failure triage, verdict disposal, checkpoint gating, and
bounded repair. Load skill dag-policy for admission, roles, and review
contracts; load skill dag-nodes for node fields.

## Adaptive replanning

Use `extend` and `control(replan)` based on observed results:

- **Scale up / cut short**: work is larger than expected → `extend` with
  parallel nodes; remaining work is unnecessary → `control(complete)`.
- **Redirect**: a gate shows the wrong direction → `control(pause)`, then
  `control(replan)` with `restart: true` on affected nodes and `cancel: true` on
  downstream dependents. A successful replan resumes automatically; call
  `control(resume)` only if the output says automatic resume raced.
- **Grant more time**: extend a running node only after its formal timeout
  escalation reached the parent. `control(extend_timeout)` with a larger
  `timeout_ms` extends in place with no replan, graph rewrite, new child, or
  replan attempt; prefer it over replan unless the graph must change.

Only `report_to_parent: true` nodes produce checkpoints, at the next actionable
wake boundary; terminal state also wakes the parent. Do not poll `status`
merely to wait. A flawed decomposition may call for targeted replanning, direct
follow-up, or stopping. The mandatory-action guard covers only live workflows,
so a checkpoint that terminalizes its workflow delivers its verdict without
enforcement; the Verdict Disposal Contract governs that case (`extend` remains
valid after a reporting leaf completed the graph).

### Escalation: change approach after repeated failures

Change approach after `orchestrator_unresponsive` (the turn ended with the
workflow RUNNING and stalled), a replan-attempt ceiling rejection, or repeated
review failures. A rejected replan/extend parks the workflow paused and
recoverable, not failed. Try a different decomposition, model, or prompt, or
split the node; repeating the same failing plan wastes budget. If the workflow
is terminal or out of node budget and in-scope work remains, start a bounded
successor workflow (reusing valid outputs) or do it directly, without asking
(see Keep Going Past a Terminal Graph). Ask the user only when continuing would
widen scope, need new permissions, or take an irreversible external action;
pause a live workflow first. Never cancel the graph just to avoid
`orchestrator_unresponsive`; pause instead of destroying in-flight work.

### Crash recovery: a recovered workflow arrives paused

After a process restart, mid-flight nodes are failed conservatively
(`execution ownership lost on recovery`); recovery never re-runs provider work
implicitly. The workflow PAUSES instead of terminalizing, and the failed-node
wake arrives. Downstream nodes stay `pending`, so the graph is still
replannable. Choices:

- **Recover (preferred for an unchanged graph)**: read `status`, then
  `control(recover)` with the failed `node_ids` and `expected_graph_rev`; it
  creates attempts for the affected subtree and resumes scheduling. If prompts
  or topology must change, use pause → replan.
- **Resume as-is**: a required-node failure terminalizes `failed` (attributed
  to the node IDs); optional failures degrade and continue.
- **Cancel**: abandon the workflow.

A crashed workflow never resumes or retries on its own; it waits, paused, until
you act.

### Node failure triage

A node-failure wake is evidence for diagnosis, not an automatic retry. Every
`dag.node.failed` row carries an `error_class` in `status` and the wake summary;
a node cancelled via replan shows `failed` with `error_reason` `cancelled via
replan` and NO `error_class` — deliberate, no triage.

| error_class | Meaning / response |
| ----------- | ------------------ |
| `timeout` | Exceeded `timeout_ms`; child cancelled. Inspect partial work before a larger budget, smaller task, direct follow-up, or stop. |
| `exec_failed` | Runtime/session failure; `error_reason` separates configuration, provider, crash ownership, and workflow-collateral causes. Diagnose; recover after an authorized fix (configuration errors do not authorize model/credential changes). |
| `verdict_fail` | Output/review contract failure, including template/input problems or missing structured output. Inspect evidence before retrying; emphasis cannot repair broken interpolation, stale fingerprints, or provider failures. |
| (cascade) | Dependents of a failed node. Determine which upstream evidence failed first. |

Required-node failure terminalizes `failed`: running nodes fail with the
workflow reason and pending/queued/paused dependents become `skipped` with
`workflow_failed` (untouched only while `paused`). The culprit is a Failed-nodes
row with a real `error_class`; collateral rows carry the workflow reason.
Optional failures interpolate `Dependency "X" failed: ...` / `skipped: ...` into
dependents' prompts; inspect the rendered prompt/input, not `error_reason`.

`orchestrator_unresponsive` has zero attribution by design: read `status`,
identify nodes `running` or stuck at the guard, then recover them or change
approach if the stall repeats. Never repair collateral rows blindly.
`push_exhausted` is reserved and never emitted. Budget exhaustion (`replan
attempt ceiling exceeded`, `Total node ceiling exceeded`) means the budget is
spent: do not retry the plan; continue in a successor workflow or directly.

Where to apply the repair:

- **Local retry**: pause scheduling, read `status`, then `control(recover)` with
  the current `expected_graph_rev` and the root/classed `node_ids`; the
  downstream closure is replaced automatically while unrelated nodes, reusable
  artifacts, and scheduling resume atomically.
- **Cancelled workflow**: also requires `resume_cancelled: true`. Completed and
  archived workflows use `extend` when allowed, otherwise a successor.
- **Change the work definition**: use `replan`/`extend`; recovery retries
  stored definitions and does not rewrite prompts, reset budgets, roll back
  code, or undo external actions.

Check completed outputs for reuse; if the graph no longer helps, use direct
follow-up or another decomposition while preserving evidence.

### Graph-action acceptance is not execution

`start`, `extend`, `control(replan)`, and `control(recover)` confirm that a
graph was **accepted**, not that its nodes **execute**. Acceptance-time
validation checks variable bindings, input-mapping structure, and condition
syntax; environment validation also checks prompt assets. It does not
substitute real outputs or prove runtime values. Missing output fields,
interpolation failures, or assets changed after acceptance can still fail a
node at spawn. Report only observed state: a wake or `status` result establishes
execution; an acceptance receipt cannot. After a rejected call, repair and retry
or report a blocker. Editing the spec does not apply a change, and repeating
unchanged invalid input is not recovery.

## Verdict Disposal Contract

A verdict is evidence for the parent's next decision, not permission to expand.
Compare it with the requested outcome: reporting findings may complete a
review, while an implementation request may still need repair and verification.
A green build alone does not prove acceptance.

Useful follow-ups: a direct bounded repair, one delegated check, a targeted
`extend`, or a paused `control(replan)` when dependencies must change. Reuse
valid outputs. A new workflow is expected when the graph cannot represent the
work (terminal or out of node budget), not because a risk label changed. A
non-`ACCEPT` verdict does not mandate more agents or a full template.

Report blockers and actual state; never claim rejected work passed. A
validation-rejected replan/extend does not fail or cancel the workflow; the tool
tries to park it paused, but that pause can fail or race with terminalization.
Inspect the actual state: paused → fix the fragment and retry; RUNNING → pause
or settle before ending the turn (the `orchestrator_unresponsive` guard still
applies); terminal/unknown → inspect status and choose the recovery path. Never
cancel the graph to avoid an unresponsive verdict. With a pending timeout
escalation already delivered, prefer `control(extend_timeout)` — no replan, no
lost child. Settle live scheduling rather than abandon active children.
Naturally completed workflows can be extended, but not paused or replanned. For
a ceiling breach, do not retry the identical plan.

## Keep Going Past a Terminal Graph

A terminal workflow, a node-ceiling rejection, or a refused `recover`/`extend`
ends that graph, not the task. When work the request already covers remains
(verification, review, acceptance, a bounded repair), continue it yourself:
start a bounded successor workflow for the remaining steps, or do it directly.
Reuse the predecessor's valid outputs, cite its failure evidence, and leave the
old workflow untouched. Do not pause, end the turn, or ask permission; the
original request is the authorization. Ask only when the next step would widen
scope, need new permissions or credentials, take an irreversible external
action, or repeat a plan already failed twice.

## Actionable Checkpoints

Normal leaf workers use `report_to_parent: false`. Gates, arbiters, and final
auditors use `report_to_parent: true` only when the result requires graph-level
action. Their structured output follows this shape:

```json
{
  "verdict": "ACCEPT | REVISE | REJECT | BLOCKED",
  "summary": "string",
  "findings": [],
  "required_actions": []
}
```

The child reports evidence and required actions only; the parent interprets the
verdict and chooses control actions.

A `report_to_parent` node with dependents is a reporting checkpoint: gate its
dependents on the reported output via `condition`, keep it a leaf, or drop the
flag. A gated checkpoint must declare `output_schema`. Checkpoint wakes avoid
polling. A paused workflow gets one durable, delayed reminder per pause episode
through the wake marker; a reminder never resumes, completes, or fails the
workflow.

When later work depends on items a node produces — for example one verifier per
finding — make it an actionable checkpoint, deduplicate and rank its
`findings`, then add item nodes with a bounded `extend`. `fan_out` only expands
writers from a plan's `packages`, not general per-item work. Expand only items
that need separate work.

Do not poll `status` to wait; wakes report checkpoints and terminal outcomes.
Use `status` for diagnosis, a control decision, or an accurate report.

## Bounded Repair

For graph-based repair, use finite `extend` or `control(replan)` targeting
remaining findings. Direct repair may be simpler once child writers have
stopped. Do not create cyclic `depends_on` or bypass budgets. Additional waves
need a concrete evidence gap, not a quota. Declare finite
`max_node_replan_attempts`; when exhausted, change approach (direct repair or a
successor with a different decomposition). Only stop with `BLOCKED` when no
in-scope approach remains.

## Replan Protocol (pause-first)

Composing a replan fragment takes real time — rendering, reasoning, node
rewiring. The workflow keeps scheduling meanwhile and can reach a terminal
status, after which replan is rejected. Freeze first, then think:

1. For a live graph needing replanning, pause before composing the fragment;
   for explicit cancellation, use `control(cancel)` instead.
2. Pause does not interrupt running nodes. In the fragment, `restart: true`
   re-spawns a running node with the new definition (hard-aborting its in-flight
   child), `cancel: true` terminates it, absence keeps it running.
3. Compose the fragment, then issue `control(replan)` — valid while paused.
4. A successful replan auto-resumes. Issue `control(resume)` manually only when
   the output reports the automatic resume raced and the workflow is still
   paused; never resume one the output says was already resumed.

If the workflow terminalized before you paused, replan is unavailable. Consider
recovery, extension, a new workflow, or direct execution. State which results
remain valid rather than treating superseded attempts as current.