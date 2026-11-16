# DAG Nodes

Nodes are the low-level durable interface: a graph is a list of nodes connected
by `depends_on`; blocks compile into them. Load skill dag-blocks for the block
route and skill dag-policy for policy contracts. This skill owns node fields,
prompt assets, budgets, and workspace discipline.

## Saved workflows

A `spec_path` with no separator, no leading `.`, no control characters, and no
`.yaml`/`.yml` extension is a **name** resolved against the workflow library (a
leading dot or extension means a path). The synthetic `builtin://<name>` marker
from `list` also resolves by name:

1. `.agents/workflows/<name>.yaml` — project scope, committed with the repo
2. `<graphagent config dir>/workflows/<name>.yaml` — global, every project
3. bundled builtin templates shipped with the runtime

Project shadows global, and both shadow builtin. List with
`workflow({params:{action:"spec",operation:"list"}})` and use only an exact
returned name; never infer one. `{ operation: "read", spec_path: "<listed-name>" }
inspects a saved graph without starting it; retarget it in the parent, write a
task-local YAML file, then start that path. A name that resolves nowhere fails
with the searched locations.

A saved workflow can be a starting point; a small task-local graph needs no
library search. Borrow secondary checks rather than concatenating whole
workflows. `lite` and `full` are reference shapes, not mandatory tiers.
Uncertainty, irreversibility, public contracts, concurrency, persistence,
authorization, or upstream executable dependencies warrant risk-addressing
evidence; a risk label or non-`ACCEPT` verdict alone never requires a full graph
or a fixed reviewer count. Retarget a matching custom workflow and reuse valid
results; skill dag-recovery covers verdict disposal.

## Node inputs and model selection

Every node receives its direct `depends_on` outputs:

- The exact dependency ID is the default template variable: `depends_on:
  [node-a, node-b]` exposes `{{node-a}}` and `{{node-b}}`.
- Uninterpolated values append as structured context.
- Use `input_mapping` only to rename a variable or select a field. Its direction
  is **template variable → upstream source**:

```yaml
input_mapping:
  resultA: node-a
  count: node-c.output.count
prompt_template:
  inline: "Summarize {{resultA}} and count={{count}}."
```

`config.node_defaults` supplies shared defaults; nodes inherit omitted values
and explicit values win.

The listed node and default fields are exhaustive; workflow YAML has no
model-selection field. Configuration owns model selection: `required: true`
and `worker_type: review` / `review-*` nodes prefer the `advanced` tier in the
`dag` section of `settings.json`; others prefer `standard`. Resolution falls
back to the selected agent model and the parent-session model; if none provides
one, the tool returns a blocked diagnostic and creates no workflow.

## Acceptance and review gate

`config.acceptance` is `[{ id, text }]`, start-only: the completeness lane
judges each item covered/partial/missing with evidence, and lists unlisted
expectations; missing/unlisted items enter `required_actions`. A `mode: deep`
workflow without `acceptance` derives `AC1..ACn` from
`admission.brief.acceptance_criteria`.

`config.review_gate` is `"strict"` or `"standard"`, start-only, and fixed at
run.start: DAG mode on or `mode: deep` fixes `strict`, overriding an authored
`standard`; otherwise it defaults to `standard`. Later mode switches or
mutations cannot change it. `strict` enables the review-coverage requirements,
including completeness; `standard` keeps them advisory. A strict block decision
is required and non-skippable, uses read-only lanes and arbitration, and an
ACCEPT requires every lane completed. Fragments cannot set either field.

Review blocks also accept `lenses` (`standards`, `intent`, `completeness`,
`security`, `tests`, `performance`; default `[standards, intent]`) and
`skeptics` (0-4, default 0, rotating fixed attack angles). They do not apply to
low-level nodes, which use the `review` field. Block decisions also submit
`dispositions`/`resolved` and continue a stored loop via `prior_round`;
`review_round`/`prior_findings` are compiler-owned. Lanes may declare
`not_examined` gaps, which surface under coverage. Lanes, the decision,
`verify`, and `synthesize` default to the read-only `auditor`; a writing
`synthesize` declares `worker_type`.

## Permissions

A running node is unattended: it never asks the user. `question`/`plan_exit` are
root-only, so it asks its parent via `agent.send` (a task child asks in its
final answer). After a safety-list denial (skill dag-policy) it does not retry:
it changes approach (outside files are read with `read`, not the shell), or
finishes the rest and says so. Publishing, merging, and default-branch pushes
are for the parent and user: commit locally and report. Global
`dag.safety.extra` adds SX-n denials; a user-written allow with a concrete
pattern lifts any rule but SF-6. Each denial is recorded on the node's
`safety_denials` and shown by `inspect`, coverage, and the wake and report.

## Prompt Templates

Templates are read-only prompt fragments under project
`.agents/workflows/prompts/*.md` or global
`<graphagent config dir>/workflows/prompts/*.md`. Project assets shadow global;
prompt IDs have no bundled fallback. Missing assets are rejected during
environment validation. Supply required `{{variable}}` inputs through static
`prompt_template.input` or `input_mapping`; validation checks bindings and spawn
resolves actual values.

Review prompts should request `unverified_claims` for downstream verification.

For ad-hoc prompts, use `prompt_template: { inline: "...", input: {...} }`.
Static `prompt_template.input` supplies literals and does not read upstream
output; inline templates interpolate static values and direct dependency
variables. Mapped objects/arrays render as indented JSON; they must never appear
as `[object Object]`.

## Budget Declaration

The engine enforces budgets without adaptive increases. Higher concurrency
helps only independent work:

- `max_concurrency`: default 5.
- `max_node_replan_attempts`: default 5. Increase only for iterative
  quality-driven convergence (review → revise → review on one artifact).
- `max_total_nodes`: your user's global `dag.max_total_nodes` (default 100) is a
  hard cap; only a lower declaration tightens it.
- `worker_config.timeout_ms`: default 10 minutes from slot acquisition. Queue
  time is free; a running node that exceeds the budget escalates before failing.
  Verifiers and aggregators often need 20–30 minutes (for example
  `timeout_ms: 1800000`).

## Single-Workspace Discipline

All nodes share one workspace; write conflicts are an orchestration concern.
Two tiers:

**Tier A — Disjoint write sets**: parallel nodes writing to non-overlapping
files/paths run concurrently when each owns a distinct module or file set.

**Tier B — Propose-then-assemble**: when disjoint write sets cannot be
guaranteed, parallel nodes produce proposals (structured output via
`output_schema`) instead of writing files. One assembly node applies the
changes sequentially; review converges on its diff.

## Node Fields

| Field              | Required | Description |
| ------------------ | -------- | ----------- |
| `id`               | yes      | Unique node identifier, used in `depends_on` |
| `name`             | yes      | Human-readable name |
| `worker_type`      | yes      | Agent type (`explore`, `build`, `general`, `plan`, or custom) |
| `depends_on`       | yes      | Node IDs this node waits for (`[]` for root) |
| `required`         | no       | If true and this node fails, the workflow terminalizes as failed. Default: false |
| `prompt_template`  | yes      | `{ id: "..." }` or `{ inline: "...", input: {...} }` |
| `condition`        | no       | One comparison `<dep-id>.output.<field> <op> <value>` over a direct dependency, evaluated before spawn; false skips the node. `op` is `==`, `!=`, `>`, `<`, `>=`, or `<=`; `value` is a number, `true`/`false`/`null`, a bare word, or a quoted string |
| `input_mapping`    | no       | Map upstream node outputs into template variables |
| `report_to_parent` | no       | If true, the parent wakes when this node completes or fails |
| `worker_config`    | no       | `{ timeout_ms }` bounds the node from slot acquisition to completion (default 10 minutes); queued time does not count |
| `workspace_writes` | no       | `"allow"`/`"deny"`. Deny withholds edit, write, apply_patch; shell keeps agent permission, so reviewers can test. Default deny for `review`/`review-*` and `auditor`, else allow |
| `output_schema`    | no       | JSON Schema for the node result; the final answer must be exactly one matching JSON value |
| `restart`          | no       | (replan only) Re-spawn this running node with the new prompt |
| `cancel`           | no       | (replan only) Cancel this node |
| `review`           | no       | (review workers) `{ phase: "design" \| "diff" }`; a `diff` review must declare `implementation_node_id` / `verification_node_id` and wire transitive review→verification→implementation dependencies, `input_mapping` for the diff artifact + fingerprint + verification output, a PASS-gated `condition`, and a `verdict` + `implementation_fingerprint` `output_schema`. `strict` and deep reject violations; standard warns. Block `lenses`/`skeptics` are block-only |

A node that declares `output_schema` must end with exactly one matching JSON
value, without fences or prose; otherwise it returns its complete final answer
as plain text. The final answer is the only result path — use `agent.send` for
questions, decisions, and collaboration, never for the result.

### Result delivery

A completed workflow delivers its selected result to the parent once; do not
summarize it again. In DAG mode you also get one turn after it. `delivery_node`
chooses the result node; a one-leaf `synthesize` workflow selects it
automatically, otherwise the parent gets a deterministic index. When coverage
is non-empty, delivery appends the engine-owned `Coverage and truncation`
(`覆盖与截断` under zh-CN) section; `inspect` exposes the same entries.