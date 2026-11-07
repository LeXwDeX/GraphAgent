<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (CreateDagWorkflowDescription). The body
  below becomes the skill's content.
-->

# Creating a saved DAG workflow

A saved workflow is a YAML spec that lives on disk under a name, so a recurring
multi-agent procedure can be started with one call instead of being redesigned
every time. This skill covers authoring one. Load
`workflow(action: "guide", topic: "blocks")` for the high-level interface or
`topic: "interface"` for low-level node fields and replanning.

## Where the file goes

| Scope | Path | Use when |
|---|---|---|
| Project | `.agents/workflows/<name>.yaml` | The procedure depends on this repo (its packages, its test commands, its review rules). Committed, so the whole team gets it. |
| Global | `<graphagent config dir>/workflows/<name>.yaml` | The procedure is repo-agnostic (a generic review or research pattern). Available in every project. |

The opencode config dir is `~/.config/graphagent` on Linux/macOS unless
`GRAPHAGENT_CONFIG_DIR` redirects it. Ask the user which scope they want when the
answer is not obvious from the request; a repo-specific graph in the global
scope will break in other projects.

**The name is the filename stem.** `.agents/workflows/code-review.yaml`
starts as `workflow(action: "start", spec_path: "code-review")`. Use kebab-case
and no path separators. A project file shadows a global one with the same name.

## Before writing the file

Do not invent the graph. Establish these with the user first — a saved workflow
gets reused, so a wrong assumption gets repeated:

1. **The trigger.** What does the user say to run this? That phrasing should be recognizable in the workflow's `title`.
2. **The phases.** Which steps genuinely depend on an earlier step's output, and which are independent? Only real data dependencies become `depends_on` edges; everything else runs in parallel.
3. **The gate.** Is there a point where downstream work must not start until quality is confirmed? Prefer a `review` block; use low-level nodes for custom verdict branches.
4. **The inputs.** Does the graph need per-run values? Put the stable purpose in `objective` and retargetable details in block `instruction`; use low-level template inputs only when bindings are necessary.
5. **The finish.** What does success produce? End with `review` when its verdict is the result, or `synthesize` when several accepted artifacts need a parent-facing report.

## File shape

```yaml
title: Code review workflow
config:
  name: code-review
  max_concurrency: 5
  node_defaults:
    worker_config:
      timeout_ms: 600000
  objective: Review the working-tree change against repository standards and confirmed intent.
  blocks:
    - id: survey
      kind: explore
      instruction: Inspect the complete diff, affected modules, and repository instructions.
    - id: checks
      kind: verify
      depends_on: [survey]
      instruction: Run the documented gates from the affected package directories.
    - id: decision
      kind: review
      depends_on: [survey, checks]
```

Use blocks for the common explore/plan/prototype/debug/coding/verify/review/
synthesize routes. Drop to `nodes` only for custom bindings, multiple verdict
branches, specialized output schemas, restart/cancel fragments, or deep diff
review metadata. Never declare both `blocks` and `nodes` in one graph.

`title` and `config` sit at the file root. A deep workflow adds `mode: deep`
and an `admission` block at the same level — but admission answers are
per-request, so a saved spec is usually `standard`; let the parent run the
admission Q&A and write a one-off deep spec when depth is needed.

## Rules that a saved spec must respect

- **Never write `model` on a node or in `node_defaults`.** Model choice is configuration-owned: `dag.jsonc` supplies the `advanced` tier preference for `required: true` or `worker_type: review` / `review-*`, `standard` for the rest. A single configured tier serves both groups. Resolution then falls back to the agent model and the parent session model. A saved spec that pins a model breaks on machines without it.
- **Every `worker_type` must exist** as a built-in (`explore`, `build`, `general`, `plan`) or a configured agent. A custom agent name makes the workflow project-scoped in practice, even if the file sits in the global directory.
- **Referenced `prompt_template.id` must exist** under project `.agents/dag-prompts/` or global `<graphagent config dir>/dag-prompts/`. Project assets shadow global assets; there is no bundled prompt fallback. Missing assets are rejected during environment validation. A global workflow needs its referenced assets installed in each target environment; use `inline` prompts for portable specs.
- **Supply every required template variable.** Validation checks bindings before acceptance. Spawn resolves actual values; an unresolved `{{var}}` fails the node, so a valid binding alone does not prove runtime input availability.
- **No cycles, no dangling `depends_on` ids.** Both are rejected at creation.
- **Terminal nodes are immutable at runtime.** Design retries as new nodes added by a replan, not as in-place restarts of finished ones.

## Verify it

A spec is only proven by a real start. After writing the file:

1. `workflow(action: "list")` — confirm the name resolves and the reported block/node count matches the file. A file missing from the listing is in the wrong directory or has the wrong extension (`.yaml`/`.yml` only).
2. `workflow(action: "start", spec_path: "<name>")` on a small, real target. Schema and graph validation happen here: an invalid spec fails the start with the offending field, and no workflow is created.
3. Read the wake report when it arrives. A graph that "succeeded" while its fan-in node produced an empty synthesis is not working — check that the reporting node's output actually contains the comparison or decision the procedure exists to produce.

Fix the file and start again; do not patch a running workflow to compensate for
a spec bug. Tell the user the workflow is saved, where it lives, and the exact
phrase that starts it.
