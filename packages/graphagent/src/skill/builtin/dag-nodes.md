# DAG Nodes

Nodes are the low-level durable interface: a graph is a list of nodes connected
by `depends_on`. Blocks compile into these nodes; load skill dag-blocks for the
block route and skill dag-policy for policy contracts. It owns node fields,
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

A saved workflow can be a useful starting point; a small task-local graph needs
no library search. Keep one primary reference and borrow secondary checks rather
than concatenating whole workflows. `lite` and `full` are reference shapes, not
mandatory tiers. Uncertainty, irreversibility, public contracts, concurrency,
persistence, authorization, or upstream executable dependencies warrant
risk-addressing evidence. A risk label or non-`ACCEPT` verdict alone never
requires a full graph or a fixed reviewer count. Retarget a matching custom
workflow and reuse valid results; skill dag-recovery covers verdict disposal.

## Node inputs and model selection

Every node receives its direct `depends_on` outputs:

- The exact dependency ID is the default template variable: a node with
  `depends_on: [node-a, node-b]` can use `{{node-a}}` and `{{node-b}}` directly.
- Values not interpolated into the prompt append as structured context for
  downstream nodes.
- Use `input_mapping` only to rename a variable or select a field. Its direction
  is **template variable → upstream source**:

```yaml
input_mapping:
  resultA: node-a
  count: node-c.output.count
prompt_template:
  inline: "Summarize {{resultA}} and count={{count}}."
```

Put shared node defaults in `config.node_defaults`; nodes inherit omitted values
and explicit values win.

The listed node and default fields are exhaustive; workflow YAML has no
model-selection field. Model selection is configuration-owned: `required: true`
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
`standard`; otherwise it defaults to `standard`. Later mode switches do not
change it; extend, replan, recover, and retry validate against the persisted
value. `strict` enables the review-coverage requirements, including
completeness; `standard` keeps them advisory. Fragments cannot set either field.

Review blocks also accept `lenses` (`standards`, `intent`, `completeness`,
`security`, `tests`, `performance`; default `[standards, intent]`) and
`skeptics` (0-4, default 0, rotating fixed attack angles). They do not apply to
low-level nodes, which use the `review` field. Review lanes, skeptics, the
decision, `verify`, and `synthesize` default to the read-only `auditor`; a
writing `synthesize` declares `worker_type`.

## Prompt Templates

Templates are read-only prompt fragments under project
`.agents/workflows/prompts/*.md` or global
`<graphagent config dir>/workflows/prompts/*.md`. Project assets shadow global;
prompt IDs have no bundled fallback, and bundled YAML does not install
fragments. Missing assets are rejected during environment validation. Supply
required `{{variable}}` inputs through static `prompt_template.input` or
`input_mapping`; validation checks bindings and spawn resolves actual values.
Example assets: `code-explore` / `test-explore` / `config-explore` (each requires
`target`) for structure searches, plus `arch-gate`, `implement` (requires
`spec`), `plan`, `verify`, `integration-test`, `patcher-assemble`, `review-arch`,
`review-logic`, `review-style`.

For review prompts, request an `unverified_claims` section downstream
verification can check against the code.

For ad-hoc prompts, use `prompt_template: { inline: "...", input: {...} }`.
Static `prompt_template.input` supplies literals and does not read upstream
output; inline templates interpolate static values and direct dependency
variables. Use `input_mapping` when an upstream output needs a stable variable
name or field selection. Mapped objects/arrays render as indented JSON; they
must never appear as `[object Object]`.

## Budget Declaration

The engine enforces declared budgets without adaptive increases; adjust only
when tool time, resource limits, or evidence volume warrants it. Higher
concurrency helps only genuinely independent work:

- `max_concurrency`: default 5.
- `max_node_replan_attempts`: default 5. Increase only for iterative
  quality-driven convergence (review → revise → review on one artifact).
- `max_total_nodes`: your user's global `dag.max_total_nodes` (default 100) is a
  hard cap; only a lower declaration tightens it.
- `worker_config.timeout_ms`: default 10 minutes from slot acquisition. Queue
  time is free and never fails a queued node; a running node that exceeds the
  budget escalates before failing. Increase for long-running nodes. Verifiers
  and aggregators are the most common timeout victims: consuming several
  parallel reports and re-checking their claims sequentially needs 20–30
  minutes (for example `timeout_ms: 1800000`); declaring the fan-out lanes'
  budget for the fan-in lane is a recurring failure pattern.

## Single-Workspace Discipline

All nodes share the same workspace. Write conflicts are an orchestration
concern, not an infrastructure one. Two tiers:

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
| `condition`        | no       | One comparison `<dep-id>.output.<field> <op> <value>` over a direct dependency, evaluated before spawn; the node is skipped if false. `op` is `==`, `!=`, `>`, `<`, `>=`, or `<=`; `value` is a number, `true`/`false`/`null`, a bare word, or a quoted string |
| `input_mapping`    | no       | Map upstream node outputs into template variables |
| `report_to_parent` | no       | If true, the parent wakes when this node completes or fails; terminal status always wakes the parent |
| `worker_config`    | no       | `{ timeout_ms }` bounds the node from slot acquisition to completion (default 10 minutes); queued time does not count and a queued node never times out |
| `workspace_writes` | no       | `"allow"`/`"deny"`. Deny withholds edit, write, apply_patch; shell keeps agent permission, so reviewers can test. Default deny for `review`/`review-*` and `auditor`, else allow |
| `output_schema`    | no       | JSON Schema for the node result; the final answer must be exactly one matching JSON value (one bounded correction turn on a near-miss) |
| `restart`          | no       | (replan only) Re-spawn this running node with the new prompt |
| `cancel`           | no       | (replan only) Cancel this node |
| `review`           | no       | (review workers) `{ phase: "design" \| "diff" }`; a `diff` review must declare `implementation_node_id` / `verification_node_id` and wire transitive review→verification→implementation dependencies, `input_mapping` for the diff artifact + fingerprint + verification output, a PASS-gated `condition`, and a `verdict` + `implementation_fingerprint` `output_schema`. A fixed `strict` gate or deep mode rejects violations; standard warns. Block `lenses`/`skeptics` are block-only |

A node that declares `output_schema` must end with exactly one matching JSON
value, without fences or prose; otherwise it returns its complete final answer
as plain text. The final answer is the only result path — use `agent.send` for
questions, decisions, and collaboration, never for the result.

### Result delivery

A completed workflow delivers its selected result to the parent once; do not
summarize it again. `delivery_node` chooses the result node; a one-leaf
`synthesize` workflow selects it automatically, otherwise the parent gets a
deterministic index. Delivery does not change scheduling, pause, failure,
timeout, or actionable-wake behavior.