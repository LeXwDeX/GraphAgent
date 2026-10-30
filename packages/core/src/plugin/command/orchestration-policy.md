# Orchestration Policy

This guide describes composition choices and runtime contracts after a DAG is
selected. The model can reconsider execution mode as evidence changes; the
profiles below are examples, not prerequisites for completing a task.

## Model Tiers and Evidence

Tier placement is mechanical, not a model-ID choice: `required: true` nodes
and `review`/`review-*` workers prefer the advanced model tier of
`dag.jsonc`; every other node prefers standard. A single configured tier
serves both groups. This mapping does not
prescribe who may analyze, implement, or summarize. Set `required` according to
whether execution failure should stop the workflow, not to manufacture roles.

Stronger reasoning can help with ambiguous decisions; faster workers can help
with independent well-specified work. Either tier's claims need evidence.
Repeated opinions from more agents are not a substitute for source or tests.

## Choosing Depth

Add depth when a material uncertainty remains, not to meet a phase count.
Independent perspectives can expose blind spots; targeted verification can
resolve conflicting claims. A short task may need neither an extra reviewer
nor a synthesis node. A broad task may benefit from both. Reuse sound evidence
and stop expanding when the requested acceptance is supported, or report what
cannot be verified within the available scope and budget.

## Parent and Child Ownership

The parent conversation owns user interaction, requirement and admission
decisions, the macro plan, workflow controls, checkpoint interpretation, and
the final user-facing synthesis. The parent may execute work directly, including
bounded follow-up after a child result. Do not duplicate active child work;
stop or isolate a child writer before taking over its files.

The resident Router describes direct, `task`, and `workflow` choices and explicit
opt-outs. Preserve read-only scope, named roles, exact model
assignments, scope limits, and prohibited actions in every node prompt.

## Agent Communication

When the `agent` tool is available, use observation or messages when they help
resolve an uncertainty, share a finding, or coordinate a current work package.
They are optional; neither a DAG nor an extra message is required for work that
already has enough context and evidence.

`observe` reads permitted progress and attempt identities without changing the
workflow. A parent may send to its owned node's exact live attempt; a node may
send to its owning parent. Peer-node and cross-workflow communication are not
supported. Reuse the identity returned by observation rather than guessing an
attempt or redirecting an old request to a restarted child.

`send` accepts a message durably and returns its ID and delivery state. Queued
does not mean delivered, answered, or acted upon. Reuse the same idempotency key
for a retry of the same destination and content; a changed request needs a new
key. `receive` reads immediately by default or waits within the tool's bounded,
cancellable limit. A read or cancelled wait does not consume messages; delivery
means inclusion in a model input snapshot. An ordinary message does not require
interrupting the active turn or polling merely to wait.

A node that needs clarification or a decision asks its owning parent through
`agent`; nodes do not ask the user. When a node asks you, reply to its message
with a conclusion you can stand behind, grounded in the user's instructions or
evidence you checked. If you cannot reach one, state what remains uncertain and
what the node may safely do, or ask the user before replying. Never present a
guess as settled.

Agent messages are supplied context with their recorded source, not human user
authorization or a workflow-control operation. Preserve permissions, budgets,
checkpoint decisions, output schemas, and review fingerprints. If a message
justifies a topology or lifecycle change, the parent must use the authorized
`workflow` action explicitly. Messages do not change timeout escalation or
`on_orchestrator_lost` policy.

## Decisions and Confirmation

Use available evidence to distinguish technical uncertainties from decisions
only the user can make. For an unresolved product or architecture decision that
changes authorized scope or acceptance, a concise **Workflow Brief** with a
recommendation and alternatives can support one combined confirmation. Already
confirmed requirements do not need another approval ceremony. Children report
scope questions to the parent, never expanding scope alone.

## Deep Admission QA

`standard` remains the compatibility default and may start without admission.
Consider `deep` when its explicit admission and review contracts help manage
the task's uncertainty or consequences. There is no complexity-signal quota.
Explicit `deep` intent still requires admission; it selects the mode, not a
bypass. These admission fields are specific to deep workflows, not a mandatory
planning ritual for direct work or standard DAGs.

Run admission before constructing or starting the graph. The start document must
carry `admission`; `workflow(action="draft")` renders only `title` and `config`,
so write that start YAML by hand. Questions belong to
the existing parent-session question interaction because the answers define the
graph. You MUST NOT create an admission child node, QA workflow, separate
persona, or privileged command. `GRILL-ME` selects `GRILL`; equivalent explicit
requests for adversarial qualification do the same.

Cover these six dimensions, resolving repository-discoverable facts before
asking the user:

1. goal;
2. scope;
3. constraints and assumptions;
4. acceptance criteria;
5. evidence and review;
6. risks and failure modes.

Use one parent-owned recommendation and confirmation interaction. Fill every
material open decision with a recommended answer based on available evidence,
show alternatives only when they change the result, then ask the user for one
combined confirmation. Do not drip questions across several turns. A user
correction creates a revised brief and one replacement confirmation; unchanged
facts are not asked again.

The modes control challenge depth, not the number of user question rounds:

- `LIGHT`: validate a nearly complete brief and expose only blockers.
- `STANDARD`: test scope, acceptance evidence, dependencies, and material
  delivery risks.
- `GRILL`: additionally probe contradictions, hidden assumptions, evidence
  quality, failure modes, and falsifiers, while still recommending an answer
  for every surfaced choice.

Unresolved blockers yield `NOT_READY`; they never silently yield `READY`.

Maintain a versioned Requirement Brief with this structure:

```json
{
  "goal": "string",
  "scope": {
    "in": [],
    "out": []
  },
  "constraints": [],
  "assumptions": [],
  "acceptance_criteria": [],
  "evidence_required": [],
  "risks": [],
  "review_plan": [],
  "open_questions": [],
  "blocking_questions": []
}
```

Before start, proactively show the recommended answers, a concise brief
summary, and verdict:
`READY | NOT_READY | WAIVED`, plus QA mode, brief revision, and remaining
blockers. `READY` requires a non-empty goal, scope boundaries,
acceptance criteria, evidence obligations, review plan, and no blocking
questions. For `NOT_READY`, remain in the parent conversation and offer:
continue QA, reduce scope, use `standard`, or explicitly waive. A `WAIVED`
start is informed only when both `waiver_reason` and `acknowledged_risks` are
non-empty; preserve them for audit.

The author-written admission input accepts only `brief_revision`, `qa_mode`,
`verdict`, `brief`, and, for an informed waiver, `waiver_reason` and
`acknowledged_risks`. Do not copy any additional fields from a persisted
workflow or tool response. The workflow boundary creates and advances its
durable audit record.

Material changes to goal, scope, constraints, assumptions, or acceptance
criteria create a new brief revision, invalidate the prior admission record,
and return admission to questioning. Do not replay QA from a consumed record
after recovery.

## Role Resolution

Profiles describe possible capabilities, not mandatory roles. When delegating,
honor an eligible explicit `@agent` assignment. Other useful matches include:

1. a configured agent whose name or description matches the work;
2. a compatible documented built-in role;
3. a compatible `explore`, `build`, or `general` fallback.

If a required capability has no eligible role, report the missing capability and do not start the workflow. You MUST NOT invent a `worker_type`.

## Model Assignment

Workflow YAML has no model-selection field. Model assignment belongs to
runtime configuration, not the workflow graph:

`dag.jsonc` tier → configured agent model → parent session model

Qualitative labels such as "strong", "fast", or "cheap" guide tier placement,
but you MUST NOT invent a model identifier. If every configured source is
missing, the workflow tool returns a blocked diagnostic and does not create the
workflow. Consider authorized, reversible recovery; if configuration changes
need permission, report the blocker and ask the user. Do not silently replace
models or bypass provider constraints.

Prefer expressing "strong model for judgment, fast model for volume" through
tier placement — `required: true` and `review`/`review-*` workers prefer
the advanced tier of `dag.jsonc`, everything else prefers standard — rather than
graph-level model fields.

## Profile: Brainstorm

Distinct viewpoints can help when alternatives or assumptions genuinely
compete. Possible roles include an explorer, generator, skeptic, or synthesizer;
use only those that contribute. One analysis or a direct conversation can be
enough. Brainstorming does not authorize implementation; the profile is
read-only by default.

## Profile: Review

Review dimensions such as intent, correctness, testing, and security help
locate evidence gaps; they need not be separate agents or waves. Independent
reviewers are useful for distinct expertise or disputed conclusions. An
arbiter helps when reports disagree, not simply because the target is a module.

Findings need a concrete trigger, impact, and source or runtime evidence.
Keep `unverified_claims` separate from confirmed defects; verify consequential
claims before using them to decide acceptance. The parent can perform that
check directly or delegate it. A requested review may end with findings and
limitations; it does not automatically authorize repair. The profile is
read-only by default. See the Verdict Disposal Contract for follow-up choices.

## Profile: Develop

Choose only the phases the task still needs:

1. requirement and codebase exploration;
2. specification and architecture gate;
3. interface and TDD work;
4. business implementation across safe work packages;
5. integration and wiring;
6. parallel review and arbitration;
7. bounded targeted repair;
8. verification, CI when available, final audit, and report.

Omit phases whose evidence is already satisfied. Connect dependent phases explicitly, and run only independent work packages in parallel.

## Review Lifecycle

Name what a review can actually prove. A pre-implementation review is a
`design` review of requirements, architecture, threat model, plan, or test
strategy. It may appear in the flow `design review → implementation`, but it
MUST NOT claim implementation-diff assurance, code-correctness verification, or
executed-test evidence.

A compiler-bound implementation review uses:
`implementation → verification(PASS) → diff review → final gate/audit`.
The implementation supplies an actual diff or changed-file artifact and an
implementation fingerprint. Verification consumes that implementation and must
return `PASS` before the diff review can run. The diff review returns
`ACCEPT | REJECT` and echoes the reviewed fingerprint.

Route rejection through a finite correction wave:
`REJECT → corrected implementation → verification(PASS) → new diff review`.
If implementation changes, the old review fingerprint is stale and cannot
satisfy a final gate.

Synthetic stress-test graphs may intentionally place reviews early to exercise
fan-out and fan-in. Label those nodes `design` reviews and state the limitation;
they MUST NOT claim implementation-diff assurance merely because their worker
type says review.

## Gates and Business Verdicts

`required: true` handles execution failure; it does not interpret a successful business verdict. A gate that successfully returns `REVISE` or `REJECT` is a completed node, not a failed node.

Declare `output_schema` for gates and arbiters and normalize `verdict` to `ACCEPT`, `REVISE`, `REJECT`, or `BLOCKED`. Use a downstream `condition` for a static branch. When the decision changes graph shape, set a checkpoint and let the parent select an existing workflow control action.

## Verdict Disposal Contract

A verdict is evidence for the parent's next decision, not automatic permission
to expand the task. Compare it with the user's requested outcome: reporting
findings may complete a review, while an implementation request may still need
repair and verification. A green build alone does not prove acceptance.

Useful follow-ups include a direct bounded repair, one delegated check, a
targeted `extend`, or a paused `control(replan)` when dependencies need to
change. Reuse valid outputs where useful. A new workflow is the expected path when the
existing graph cannot represent the work (terminal, or out of node budget), not
a requirement of a changed risk label. A non-`ACCEPT` verdict does not mandate more agents or a full template.

Report blockers and the actual workflow state when stopping or asking for a
decision. Do not claim rejected work passed. A replan or extend rejected by
validation does not itself fail or cancel the workflow. The tool attempts to
park it paused, but automatic pause can fail or race with terminalization.
Inspect the reported actual state. If it is paused, fix the fragment using
the diagnostic and retry. If it remains RUNNING, explicitly pause or settle
it before ending the turn; the `orchestrator_unresponsive` guard can still
apply to a stalled RUNNING workflow. If the state is terminal or unknown,
inspect status and choose the applicable recovery path. Do not cancel the
graph merely to avoid an unresponsive verdict. For a running node with a
pending formal timeout escalation already delivered to the parent,
prefer `control(extend_timeout)` to grant more time in place — no replan, no
lost child session. If ending the work, settle live scheduling rather than
abandoning active children. Naturally completed workflows can be extended, but
cannot be paused or replanned. For a ceiling breach, do not retry the identical
plan; change approach instead.

## Keep Going Past a Terminal Graph

A terminal workflow, a node-ceiling rejection, or a refused `recover`/`extend`
ends that graph, not the task. When work the user's request already covers
remains (verification, review, acceptance, a bounded repair), continue it
yourself: start a bounded successor workflow scoped to the remaining steps, or
do it directly. Reuse the predecessor's valid outputs, cite its failure
evidence, and leave the old workflow untouched. Do not pause, end the turn, or
ask the user for permission to do this; the original request is the
authorization. Ask only when the next step would widen scope, need new
permissions or credentials, take an irreversible external action, or repeat a
plan that has already failed twice for the same reason.

## Actionable Checkpoints

Normal leaf workers use `report_to_parent: false`. Gates, arbiters, and final auditors use `report_to_parent: true` only when their result requires graph-level action. Their structured output follows this shape:

```json
{
  "verdict": "ACCEPT | REVISE | REJECT | BLOCKED",
  "summary": "string",
  "findings": [],
  "required_actions": []
}
```

The child reports evidence and required actions only. The parent interprets
the verdict and chooses any workflow control action under the Verdict Disposal
Contract.

A `report_to_parent` node with dependents is a reporting checkpoint: gate its
dependents on the reported output via `condition`, keep it a leaf, or drop the
flag. Checkpoint wakes let the parent act without polling merely to wait.

When later work depends on the items a node produces — for example one
verifier per finding — make that node an actionable checkpoint, then
deduplicate and rank its `findings` and add the item nodes with a bounded
`extend`. `fan_out` only expands writers from a plan's `packages`; it is not a
general per-item expansion. Expand only the items that need separate work.

Do not poll `status` merely to wait. Wakes report checkpoints and terminal
outcomes. Use `status` when fresh durable state is needed for diagnosis, a
control decision, or an accurate user-facing report.

## Bounded Repair

When graph-based repair helps, use finite `extend` or `control(replan)`
operations targeting the remaining findings. Direct repair may be simpler once
child writers have stopped. You MUST NOT create cyclic `depends_on` or bypass
runtime budgets. Additional waves need a concrete evidence gap, not a quota.

Declare a finite `max_node_replan_attempts`. When the ceiling is exhausted, do not retry the identical plan: change approach (direct repair or a successor workflow with a different decomposition). Only stop with `BLOCKED` when no in-scope approach remains.

## Replan Protocol (pause-first)

A replan fragment takes real time to compose — template rendering, model reasoning, node rewiring. While you compose it, the workflow keeps scheduling and can reach a terminal status, after which replan is rejected (terminal workflows are immutable). Freeze first, then think:

1. For a live graph that needs replanning, pause scheduling before composing the fragment. For an explicit cancellation, use `control(cancel)` instead. Pause stops new node spawns.
2. Pause does not interrupt nodes that are already running. Decide their disposition inside the fragment: `restart: true` re-spawns a running node with the new definition (its in-flight child session is hard-aborted at re-spawn), `cancel: true` terminates it, absence keeps it running to completion.
3. Compose the fragment, then issue `control(replan)` — replan is valid while paused.
4. A successful replan auto-resumes the workflow. Issue `control(resume)` manually only when the replan output reports the automatic resume raced with another control op and the workflow is still paused; never resume a workflow the output says was already resumed.

If the workflow terminalized before you paused, replan is unavailable. Depending
on the remaining work, consider supported recovery, extension, a new workflow,
or direct execution. State which results remain valid rather than silently
treating superseded attempts as current.
