# DAG Auto

Routing and composition for the appended request. An explicit
invocation prefers DAG orchestration, not a particular template, agent count,
or stage sequence; an explicit request for direct work or no DAG takes
precedence. Routing stays in the parent conversation and children get bounded
work. Platform delivery is out of scope.

## DAG mode

The latest `dag_mode` runtime-context block reports the user's session setting;
only the user changes it. When ON, a substantive request defaults to
orchestration: use workflows for grouped, parallel, or staged work, state the
plan in one line, and start. Raise quality with verification and an independent
review before accepting file changes; iterate review until a round raises no new
upheld finding. `/dag-auto` always orchestrates. Work directly only for
conversational turns, answers already in context, trivial mechanical edits
verifiable with one command, commands the user asked to run as given, or when
the user asked to work directly for this request; say why in one short clause.
When the block says OFF or is absent, start a workflow only when the user
explicitly asks, in a message or with /dag-auto.

## Choose a useful shape

Judge the task from its evidence, dependencies, uncertainty, and coordination
cost. A broad request need not become a pipeline, a narrow one need not add
reviewers; size the graph to the evidence and assurance it must produce.

Saved workflows are optional references:
`workflow({params:{action:"spec",operation:"list"}})` and
`{operation:"read",spec_path}` find and inspect one, then retarget it; names
come from tool results, not guesses. `ultra-flow-route`, when available, is one
possible end-to-end reference, not the default for "finish this". Keep only
phases that add evidence or advance the result; a review request does not
authorize repairs or a release phase.

For a selected DAG, draft with
`workflow({params:{action:"spec",operation:"draft",config}})` or write a
task-local YAML under the XDG workflow-artifacts area; then `spec(validate)`
and `run(start)`. A draft or validation response is not execution.

## Orchestration lifecycle

Phases to adapt (examples: skill dag-patterns):

1. **Explore + brainstorm** — exploration fans out while independent
   generators propose approaches; a required synthesizer converges them.
2. **Design review gate** — an advanced-tier gate (`report_to_parent: true`,
   normalized verdict `output_schema`). `required: true` fails only when the
   gate cannot execute or meet its contract; a successful `REVISE` or `REJECT`
   is a business verdict. Gate ACCEPT with a downstream `condition`; dispose of
   other verdicts per the Verdict Disposal Contract (skill dag-recovery).
3. **Parallel execution** — the accepted design decomposes into workers with
   disjoint write sets, fanning into a required assembler.
4. **Verify + diff review + audit** — `implementation → verification(PASS) →
   diff review → final gate/audit` with fingerprint echo; `REJECT` loops
   through corrected implementation and verification.
5. **Expansion decision** — bounded `control(replan)`, `extend`, or
   `control(complete)`; prefer `control(recover)` for failed work. Cancelled
   workflows need `resume_cancelled: true`. Start a successor only when the
   original cannot be adapted or recovered.

Existing evidence can remove whole phases; settle active child writers before
switching to direct work.

## Saved workflows

A saved workflow is a named YAML spec on disk; a recurring procedure starts
with one call.

- Project: `.agents/workflows/<name>.yaml` — depends on this repo, committed
  for the team.
- Global: `<graphagent config dir>/workflows/<name>.yaml` — repo-agnostic,
  available everywhere.

The name is the filename stem: `.agents/workflows/code-review.yaml` starts as
`{params:{action:"run",operation:"start",spec_path:"code-review"}}`. A project
file shadows a global file of the same name; both shadow a builtin template.

Before writing, establish the trigger phrase (`title`), real data dependencies
(only those become `depends_on`), the quality gate (prefer `review`), per-run
inputs (`objective` plus `instruction`), and the success output (`review` or
`synthesize`); a reused spec repeats a wrong assumption.

```yaml
title: Code review workflow
config:
  name: code-review
  objective: Review the change against repository standards and confirmed intent.
  blocks:
    - { id: survey, kind: explore }
    - { id: checks, kind: verify, depends_on: [survey] }
    - { id: decision, kind: review, depends_on: [survey, checks] }
```

Use blocks for the common routes; drop to `nodes` only for custom bindings,
multiple verdict branches, special output schemas, restart/cancel fragments, or
deep diff-review metadata (skill dag-blocks). Never declare both.

Rules a saved spec must respect:

- Never write `model` on a node or in `node_defaults`: `dag.model` in
  `.agents/settings.json` owns both tiers; the node's role picks one (skill
  dag-policy).
- Every `worker_type` must exist as a builtin (`explore`, `build`, `general`,
  `plan`) or a configured agent; never invent one.
- `prompt_template.id` assets live under project `.agents/workflows/prompts/`
  or global `<config dir>/workflows/prompts/`; project shadows global, no
  bundled fallback. Prefer `inline` prompts for portable specs.
- Supply every required template variable; validation checks bindings and
  spawn resolves values.
- No cycles or dangling `depends_on` IDs. Terminal nodes are immutable: add
  retries as new nodes through a replan.

Verify it: `spec(list)` confirms the name; `spec(validate)` then `run(start)` on
a small real target. Read the wake report: a graph that "succeeded" with an
empty fan-in synthesis is not working. Fix the file and restart; do not patch a
running workflow for a spec bug. Tell the user where the file lives and the
phrase that starts it.

## Design principles

- Each node is a real child session with its own history, tools, and context;
  data flows only through `depends_on` and `input_mapping`.
- `required: true` means failure fails the workflow (terminal `failed`,
  attributed to node IDs); use it for indispensable outputs only.
- A successful fan-in must contain the requested comparison, synthesis, or
  decision.
- Layers come from `depends_on`; same-layer nodes run concurrently up to
  `max_concurrency`. Declare dependencies, do not script order.
- A node with `output_schema` must end with exactly one matching JSON value; a
  near-miss gets one correction turn.
- A completed workflow delivers its result once; set `delivery_node`, or the
  parent gets a deterministic index.

## Adapt to results

Continue authorized work without unnecessary approval rounds. Reuse valid
evidence and respect budgets; repeated failure means reconsider the cause, not
add identical attempts. Read each checkpoint's actual output contract: a child
reports evidence, the parent chooses control actions. Stop or isolate child
writers before taking over, and never leave a live graph running after deciding
to stop. A flawed decomposition can justify targeted replanning, direct
follow-up, or stopping.

**Product decision checkpoint.** Ask when an unresolved choice changes
authorized scope, acceptance, or an irreversible boundary. Give a
recommendation and alternatives; do not re-ask decided questions. Carry
confirmed scope into child instructions without granting permissions.

## Completion report

Give one concise summary of what ran, remaining limitations, and the Workflow
ID if any. A route choice or one passing check does not prove the requested
outcome.

## Rules

- Routing decisions live in this conversation; child nodes get concrete work,
  not routing questions.
- Never write workflow state to local files; local persistence is only a
  task-local spec YAML.
- Platform delivery (issues, PRs, CI, merge, release) is out of scope; if
  asked, name the boundary and stop.
- Keep one objective on one live DAG.

## Request

When invoked as `/dag-auto`, the request is appended after this body; treat it
as the request to route.