# Orchestration Policy

Composition choices and runtime contracts after a DAG is selected. The model
can reconsider execution mode as evidence changes; profiles below are examples,
not prerequisites. Load skill dag-recovery for replanning, verdict disposal,
checkpoints, and repair; load skill dag-blocks and skill dag-nodes for YAML and
node fields.

## Model tiers and evidence

Tier placement is mechanical: `required: true` nodes and `review`/`review-*`
workers prefer the advanced tier of the `dag` section in `settings.json`; every
other node prefers standard. One configured tier serves both. This mapping does
not prescribe who may analyze, implement, or summarize. Set `required` according
to whether execution failure should stop the workflow, not to manufacture roles.
Either tier's claims need evidence; repeated opinions are not a substitute for
source or tests.

## Choosing depth

Add depth when a material uncertainty remains, not to meet a phase count.
Independent perspectives can expose blind spots; targeted verification resolves
conflicting claims. A short task may need neither an extra reviewer nor a
synthesis node. Reuse sound evidence and stop expanding when acceptance is
supported, or report what cannot be verified within scope and budget.

## Parent and child ownership

The parent owns user interaction, requirement and admission decisions, the macro
plan, workflow controls, checkpoint interpretation, and final synthesis. It may
execute work directly, including bounded follow-up. Do not duplicate active
child work; stop or isolate a child writer before taking over its files.
Preserve read-only scope, named roles, exact model assignments, scope limits,
and prohibited actions in every node prompt.

## Agent communication

When available, the `agent` tool's observation or messages can resolve an
uncertainty, share a finding, or coordinate a work package. They are optional.

`observe` reads progress and attempt identities without changing the workflow.
A parent may send to its owned node's exact live attempt; a node may send to its
owning parent. Peer and cross-workflow messaging are unsupported; reuse the
observed identity rather than guessing.

`send` returns an ID and delivery state; queued is not delivered, answered, or
acted upon. Reuse an idempotency key only for the same destination and content.
`receive` reads immediately or waits within its bounded, cancellable limit; a
read or cancelled wait does not consume messages.

A node asks its owning parent through `agent`, never the user. Reply with a
conclusion grounded in instructions or evidence; otherwise state what remains
uncertain and what the node may safely do, or ask the user first. Messages are
context, not authorization or a control operation: preserve permissions,
budgets, decisions, schemas, and fingerprints. Topology changes still need the
authorized `workflow` action.

## Decisions and confirmation

Distinguish technical uncertainties from decisions only the user can make.
When an unresolved product or architecture decision changes authorized scope or
acceptance, a concise **Workflow Brief** with a recommendation and alternatives
supports one combined confirmation. Already confirmed requirements need no
another approval ceremony. Children report scope questions to the parent and
never expand scope alone.

## Deep admission QA

`standard` remains the compatibility default and may start without admission.
Consider `deep` when its explicit admission and review contracts help manage
uncertainty or consequences; there is no signal quota. Explicit `deep` intent
still requires admission: it selects the mode, not a bypass. These fields are
not a planning ritual for standard DAGs.

Run admission before constructing the graph. The start document carries
top-level `mode: deep` and `admission`; `draft` renders only `title` and
`config`, so write that YAML by hand. Questions belong to the parent-session
question interaction because the answers define the graph. Do NOT create an
admission child node, QA workflow, persona, or privileged command.
`GRILL-ME` selects `GRILL`; equivalent adversarial requests do so.

Cover six dimensions, resolving repository facts first: goal; scope;
constraints and assumptions; acceptance criteria; evidence and review; risks
and failure modes.

Use one parent-owned recommendation and confirmation. Fill each material open
decision with an evidence-based recommendation, show alternatives only when they
change the result, then ask for one combined confirmation. A user correction
creates a revised brief and one replacement confirmation; unchanged facts are
not asked again.

Modes control challenge depth, not question rounds:

- `LIGHT`: validate a nearly complete brief; expose only blockers.
- `STANDARD`: test scope, acceptance evidence, dependencies, delivery risks.
- `GRILL`: additionally probe contradictions, hidden assumptions, evidence
  quality, failure modes, and falsifiers, recommending an answer for every
  choice.

Unresolved blockers yield `NOT_READY`, never `READY`. Maintain a
versioned Requirement Brief:

```json
{
  "goal": "string",
  "scope": { "in": [], "out": [] },
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

Before start, show recommended answers, a brief summary, verdict
`READY | NOT_READY | WAIVED`, QA mode, brief revision, and blockers. `READY`
requires a non-empty goal, scope boundaries, acceptance criteria, evidence
obligations, review plan, and no blocking questions. For `NOT_READY`, remain in
the parent and offer: continue QA, reduce scope, use `standard`, or waive. A
`WAIVED` start is informed only when `waiver_reason` and `acknowledged_risks`
are non-empty; preserve them for audit.

The author-written admission input accepts only `brief_revision`, `qa_mode`,
`verdict`, `brief`, and, for an informed waiver, `waiver_reason` and
`acknowledged_risks`; never copy persisted fields. Material changes to goal,
scope, constraints, assumptions, or acceptance criteria create a new brief
revision, invalidate the prior admission record, and return to questioning. Do
not replay QA from a consumed record after recovery.

## Role resolution

Profiles describe possible capabilities, not mandatory roles. Honor an eligible
explicit `@agent` assignment. Other matches, in order: a configured agent whose
name/description matches the work; a compatible documented builtin role; an
`explore`, `build`, or `general` fallback. If a required capability has no
eligible role, report it and do not start. Do NOT invent a `worker_type`.

## Model assignment

Workflow YAML has no model-selection field. Assignment belongs to runtime
configuration: `dag` tier in `settings.json` → configured agent model → parent
session model. Labels such as "strong" or "fast" guide tier placement, but do
NOT invent a model identifier. If every source is missing, the tool returns a
blocked diagnostic and creates no workflow. Consider authorized, reversible
recovery; if changes need permission, report the blocker and ask. Do not
silently replace models or bypass provider constraints. Express "strong
judgment, fast volume" through tier placement, not graph-level model fields.

## Profiles

**Brainstorm.** Distinct viewpoints help when alternatives or assumptions
compete. Possible roles: explorer, generator, skeptic, synthesizer; use only
contributing ones. One analysis or a conversation can suffice. It does not
authorize implementation; read-only.

**Review.** Dimensions such as intent, correctness, testing, and security help
locate evidence gaps; they need not be separate agents or waves. Independent
reviewers help with distinct expertise or disputed conclusions. An arbiter
helps when reports disagree, not because the target is a module. Findings need
a concrete trigger, impact, and source or runtime evidence. Keep
`unverified_claims` separate from confirmed defects; verify consequential claims
before deciding acceptance. The parent can check directly or delegate. A
requested review may end with findings and limitations; it does not authorize
repair. Read-only.

**Develop.** Choose only needed phases: requirement and codebase exploration;
specification and architecture gate; interface and TDD work; business
implementation across safe work packages; integration and wiring; parallel
review and arbitration; bounded targeted repair; verification, CI when
available, final audit, and report. Omit phases whose evidence is satisfied.
Connect dependent phases explicitly and parallelize only independent packages.

## Review lifecycle

Test only what a review can prove. A pre-implementation review is a `design`
review of requirements, architecture, threat model, plan, or test strategy. It
may appear in `design review → implementation`, but must NOT claim
implementation-diff assurance, code-correctness verification, or executed-test
evidence.

A compiler-bound implementation review uses
`implementation → verification(PASS) → diff review → final gate/audit`. The
implementation supplies a diff or changed-file artifact and fingerprint.
Verification must return `PASS` before diff review runs. The diff review returns
`ACCEPT | REJECT` and echoes the fingerprint. Rejection routes through
`REJECT → corrected implementation → verification(PASS) → new diff review`. If
implementation changes, the old fingerprint is stale and cannot satisfy a final
gate.

Synthetic stress-test graphs may place reviews early; label those nodes
`design` reviews and state the limitation. They must NOT claim
implementation-diff assurance merely because their worker type says review.

## Gates and business verdicts

`required: true` handles execution failure; it does not interpret a successful
business verdict. A gate returning `REVISE` or `REJECT` is a completed node,
not a failed node.

Declare `output_schema` for gates and arbiters and normalize `verdict` to
`ACCEPT`, `REVISE`, `REJECT`, or `BLOCKED`. Use a downstream `condition` for a
static branch. When the decision changes graph shape, set a checkpoint and let
the parent select an existing control action.