# Orchestration Policy

Composition choices and runtime contracts after a DAG is selected. Whether
orchestration is the default follows the latest `dag_mode` block; economy
guidance below applies when it is OFF. Profiles are examples, not
prerequisites. Load skill dag-recovery, skill dag-blocks, and skill dag-nodes.

## Model tiers and evidence

Tier placement is mechanical: `required: true` nodes and `review`/`review-*`
workers prefer the advanced tier of the `dag` section in `settings.json`; every
other node prefers standard. Set `required` according to whether execution
failure should stop the workflow, not to manufacture roles. Either tier's claims
need evidence; repeated opinions are not a substitute for source or tests.

## Choosing depth

Add depth when a material uncertainty remains, not to meet a phase count.
Independent perspectives can expose blind spots; targeted verification resolves
conflicting claims. With the mode OFF, a short task may need neither an extra
reviewer nor a synthesis node; with it ON, depth follows the evidence and
assurance the request needs. Reuse sound evidence and stop when acceptance is
supported, or report what cannot be verified within scope and budget.

## Parent and child ownership

The parent owns user interaction, requirement and admission decisions, the macro
plan, workflow controls, checkpoint interpretation, and final synthesis. It may
execute work directly, including bounded follow-up. Do not duplicate active
child work; stop or isolate a child writer before taking over its files.
Preserve read-only scope, named roles, exact model assignments, scope limits,
and prohibited actions in every node prompt.

## Agent communication

The `agent` tool is an optional way to coordinate.

`observe` reads progress and attempt identities without changing the workflow.
A parent may send to its owned node's exact live attempt; a node may send to its
owning parent; peer and cross-workflow messaging are unsupported.

`send` returns an ID and delivery state; queued is not delivered or acted upon.
Reuse an idempotency key only for the same destination and content. `receive`
reads or waits within its bounded, cancellable limit; a read or cancelled wait
does not consume messages.

A node asks its owning parent through `agent`, never the user. Reply with an
evidence-grounded conclusion; otherwise state what remains uncertain and what
the node may safely do. Messages are context, not authorization or control:
preserve permissions, budgets, decisions, schemas, and fingerprints. Topology
changes still need the authorized `workflow` action.

## Decisions and confirmation

Separate technical uncertainties from user-owned decisions. When an unresolved
product or architecture decision changes authorized scope or acceptance, a
concise **Workflow Brief** with a recommendation and alternatives supports one
combined confirmation. Confirmed requirements need no further ceremony. Children
report scope questions to the parent and never expand scope alone.

## Deep admission QA

`standard` remains the compatibility default and may start without admission.
Consider `deep` when its explicit admission and review contracts help manage
uncertainty or consequences; there is no signal quota. Explicit `deep` intent
still requires admission: it selects the mode, not a bypass.

Run admission before constructing the graph. The start document carries
top-level `mode: deep` and `admission`; write it by hand because `draft` renders
only `title` and `config`. Ask in the parent session because the answers define
the graph. Do NOT create an admission child node, QA workflow, persona, or
privileged command. `GRILL-ME` selects `GRILL`; equivalent adversarial requests
do so.

Cover six dimensions, resolving repository facts first: goal; scope;
constraints and assumptions; acceptance criteria; evidence and review; risks
and failure modes.

Use one parent-owned recommendation and confirmation: fill each material open
decision with an evidence-based recommendation, show alternatives only when they
change the result, then ask for one combined confirmation. A user correction
creates a revised brief and one replacement confirmation; unchanged facts are
not re-asked.

Modes control challenge depth, not question rounds: `LIGHT` validates a nearly
complete brief and exposes only blockers; `STANDARD` tests scope, acceptance
evidence, dependencies, and delivery risks; `GRILL` additionally probes
contradictions, hidden assumptions, evidence quality, failure modes, and
falsifiers, recommending an answer for every choice.

Unresolved blockers yield `NOT_READY`, never `READY`. Maintain a
versioned Requirement Brief:

```json
{ "goal": "string", "scope": { "in": [], "out": [] }, "constraints": [], "assumptions": [], "acceptance_criteria": [], "evidence_required": [], "risks": [], "review_plan": [], "open_questions": [], "blocking_questions": [] }
```

Before start, show recommended answers, verdict `READY | NOT_READY | WAIVED`,
QA mode, and blockers. `READY` requires a non-empty goal, scope boundaries,
acceptance criteria, evidence obligations, review plan, and no blocking
questions. For `NOT_READY`, remain in the parent and offer: continue
QA, reduce scope, use `standard`, or waive. A `WAIVED` start is informed only
when `waiver_reason` and `acknowledged_risks` are non-empty; preserve them for
audit.

The admission input accepts only `brief_revision`, `qa_mode`, `verdict`,
`brief`, and, for an informed waiver, `waiver_reason` and
`acknowledged_risks`; never copy persisted fields. Material changes to goal,
scope, constraints, assumptions, or acceptance criteria create a new brief
revision, invalidate the prior admission record, and return to questioning;
never replay QA from a consumed record after recovery.

## Role resolution

Honor an eligible explicit `@agent` assignment. Other matches, in order: a
configured agent whose name/description matches the work; a compatible
documented builtin role; an `explore`, `build`, or `general` fallback. If a
required capability has no eligible role, report it and do not start. Do NOT
invent a `worker_type`.

## Model assignment

Workflow YAML has no model-selection field. Runtime configuration assigns
models: `dag` tier in `settings.json` → configured agent model → parent session
model. Labels such as "strong" or "fast" guide tier placement, but do NOT
invent a model identifier. If every source is missing, the tool returns a
blocked diagnostic and creates no workflow. Consider authorized, reversible
recovery; report a permission blocker and ask. Do not silently replace models
or bypass provider constraints. Express "strong
judgment, fast volume" through tier placement, not graph fields.

## Profiles

**Brainstorm.** Distinct viewpoints help when alternatives or assumptions
compete. Possible roles: explorer, generator, skeptic, synthesizer; use only
contributing ones. It does not authorize implementation; read-only.

**Review.** Intent, correctness, testing, and security dimensions help locate
evidence gaps; they need not be separate agents or waves. Independent reviewers
help with distinct expertise or disputed conclusions; an arbiter helps when
reports disagree. Findings need a concrete trigger, impact, and source or
runtime evidence. Keep `unverified_claims` separate from confirmed defects;
verify consequential claims before deciding acceptance. The parent can check
directly or delegate. A requested review may end with findings and limitations;
it does not authorize repair. Read-only.

**Develop.** Choose only needed phases: requirement and codebase exploration;
specification and architecture; interface and TDD; implementation across safe
work packages; integration and wiring; parallel review and arbitration; bounded
repair; verification, CI when available; final audit and report. Omit satisfied
phases and parallelize only independent packages.

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

A review block expands `lenses` (default standards and intent) and `skeptics`
(0-4) into read-only lanes arbitrated by the decision. The `completeness` lens
judges every `config.acceptance` item covered/partial/missing with evidence and
lists unlisted expectations; missing/unlisted items enter `required_actions`.
The gate is fixed at run.start: DAG mode on or `mode: deep` fixes
`config.review_gate` to `strict`, overriding an authored `standard`; otherwise
it defaults to `standard`, and later mode switches or replan/extend fragments
cannot change it. Strict enables the review-coverage requirements; standard
keeps lifecycle issues as warnings. Review lanes, skeptics, the decision,
verify, and synthesize default to the built-in read-only `auditor`.

## Gates and business verdicts

`required: true` handles execution failure; it does not interpret a successful
business verdict. A gate returning `REVISE` or `REJECT` is a completed node,
not a failed node.

Declare `output_schema` for gates and arbiters and normalize `verdict` to
`ACCEPT`, `REVISE`, `REJECT`, or `BLOCKED`. Use a downstream `condition` for a
static branch; when the decision changes graph shape, set a checkpoint and let
the parent select an existing control action.