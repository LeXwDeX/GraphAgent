# DAG Auto

Routing and composition assistance for the request appended by the command
expander. An explicit invocation prefers DAG orchestration, not a particular
template, agent count, or stage sequence; an explicit request for direct work
or no DAG takes precedence. Routing stays in the parent conversation and
children get bounded work. Platform delivery (issues, PRs, CI, merge, release)
is out of scope.

## Choose a useful shape

Judge the task from its evidence, dependencies, uncertainty, and coordination
cost. A broad request does not automatically need an end-to-end pipeline; a
narrow one does not need several reviewers merely to qualify. If orchestration
adds little value, explain briefly and offer direct execution rather than
manufacture stages.

Saved workflows are optional references:
`workflow({params:{action:"spec",operation:"list"}})` and
`{operation:"read",spec_path}` find and inspect one, then retarget it; names
come from tool results, not guesses. `ultra-flow-route`, when available, is one
possible end-to-end reference, not the default for "finish this". Custom
task-local graphs are valid. Keep only phases that add evidence or
advance the result; a review request does not authorize repairs or a release
phase.

For a selected DAG, draft with
`workflow({params:{action:"spec",operation:"draft",config}})` or write a
task-local YAML under the XDG workflow-artifacts area; then `spec(validate)`
and `run(start)`. A draft or validation response is not execution.

## Orchestration lifecycle

Possible phases to adapt to the remaining work (examples: skill dag-patterns);
not a mandatory sequence:

1. **Explore + brainstorm** — exploration fans out while independent
   generators propose approaches; a required synthesizer converges them.
2. **Design review gate** — an advanced-tier gate (`report_to_parent: true`,
   normalized verdict `output_schema`). `required: true` fails only when the
   gate cannot execute or meet its output contract; a successful `REVISE` or
   `REJECT` is a business verdict. Gate ACCEPT with a downstream `condition`;
   dispose of other verdicts per the Verdict Disposal Contract (skill
   dag-recovery).
3. **Parallel execution** — the accepted design decomposes into workers with
   disjoint write sets, fanning into a required assembler.
4. **Verify + diff review + audit** — `implementation → verification(PASS) →
   diff review → final gate/audit` with fingerprint echo; `REJECT` loops
   through corrected implementation and verification.
5. **Expansion decision** — bounded `control(replan)`, `extend`, or
   `control(complete)`; prefer `control(recover)` for failed work. Cancelled
   workflows need `resume_cancelled: true`. Start a successor only when the
   original cannot be adapted or recovered.

Existing evidence can remove whole phases. Direct execution remains an option
once orchestration stops helping, after settling active child writers.

## Saved workflows

A saved workflow is a YAML spec on disk under a name, so a recurring procedure
starts with one call instead of being redesigned each time.

- Project: `.agents/workflows/<name>.yaml` — depends on this repo, committed
  for the team.
- Global: `<graphagent config dir>/workflows/<name>.yaml` — repo-agnostic,
  available everywhere.

The name is the filename stem: `.agents/workflows/code-review.yaml` starts as
`{params:{action:"run",operation:"start",spec_path:"code-review"}}`; use
kebab-case, no path separators. A project file shadows a global file of the
same name; both shadow a builtin template.

Before writing, establish the trigger phrase (`title`), real data dependencies
(only those become `depends_on`), the quality gate (prefer `review`), per-run
inputs (`objective` plus `instruction`), and the success output (`review` or
`synthesize`). A saved workflow is reused, so a wrong assumption gets repeated.

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
  `.agents/settings.json` owns the advanced tier for `required: true` and
  `review`/`review-*` workers, standard for the rest.
- Every `worker_type` must exist as a builtin (`explore`, `build`, `general`,
  `plan`) or a configured agent; never invent one.
- `prompt_template.id` assets live under project `.agents/workflows/prompts/`
  or global `<config dir>/workflows/prompts/`; project shadows global, no
  bundled fallback. Prefer `inline` prompts for portable specs.
- Supply every required template variable; validation checks bindings and
  spawn resolves values.
- No cycles or dangling `depends_on` IDs. Terminal nodes are immutable: add
  retries as new nodes through a replan.

Verify it: `spec(list)` confirms the name resolves; `spec(validate)` then
`run(start)` on a small real target, where validation names the offending field
and creates no workflow. Read the wake report: a graph that "succeeded" while
its fan-in produced an empty synthesis is not working. Fix the file and start
again; do not patch a running workflow for a spec bug. Tell the user where the
file lives and the phrase that starts it.

## Design principles

- Each node is a real child session with its own history, tools, and context;
  data flows only through `depends_on` and `input_mapping`.
- `required: true` means failure fails the workflow (terminal `failed`,
  attributed to node IDs); use it for indispensable outputs only.
- A successful fan-in must contain the requested comparison, synthesis, or
  decision; unresolved placeholders are not aggregation.
- Layers come from `depends_on`; same-layer nodes run concurrently up to
  `max_concurrency`. Declare dependencies, do not script order.
- A node with `output_schema` must end with exactly one matching JSON value,
  without fences or prose; a near-miss gets one correction turn.
- A completed workflow delivers its selected result once; the parent must not
  summarize it again. Set `delivery_node`; without a unique one, the parent
  gets a deterministic index.

## Adapt to results

Continue authorized work without unnecessary approval rounds. Checkpoint
results can justify targeted repair, direct follow-up, a changed graph, or a
report of limitations. Reuse valid evidence and respect budgets; repeated
failure means reconsider the cause, not add identical attempts.

Read each checkpoint's actual output contract; a child reports evidence and the
parent chooses control actions. Stop or isolate child writers before taking
over, and never leave a live graph running after deciding to stop. A flawed
decomposition can call for targeted replanning, direct follow-up, or stopping.

**Product decision checkpoint.** Ask when an unresolved choice changes
authorized scope, acceptance, or an irreversible boundary. Give a
recommendation and alternatives; do not re-ask decided questions. Carry
confirmed scope into child instructions without granting permissions.

## Completion report

Give one concise summary of what ran, remaining limitations, and the Workflow
ID if any. Distinguish a saved reference from completed execution; a route choice or one passing check does not prove the
requested outcome.

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