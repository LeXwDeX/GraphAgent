# DAG workflows

A workflow is a set of nodes connected by dependency edges. Each node is a real child session with its own agent and context window; an edge means the downstream node consumes the upstream node's output. Nodes run wave by wave in dependency order, so independent work executes in parallel and dependent work waits.

The parent agent (your main conversation) owns the graph. It designs the graph for a task, starts it, and gets woken when a node reports or the workflow finishes — it never polls. When a wave fails, the parent requests recovery of the affected nodes and the engine continues in the same workflow; the view always shows the current graph, not the history of rewrites (more on this under [Revisions](#revisions)).

Three terms worth knowing:

- **Node** — one unit of work: an `explore`, `build`, `general`, or custom agent running one prompt, with optional timeout, retry budget, and structured-output contract.
- **Wave** — the set of nodes whose dependencies are all satisfied; a wave runs in parallel up to a concurrency limit.
- **Gate** — a node whose job is judgment (review, verification, arbitration). Gates emit verdicts (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`) and downstream nodes can be conditioned on the verdict.

## DAG features

**Orchestration**

- Composable blocks (`explore`, `plan`, `prototype`, `debug`, `coding`, `verify`, `review`, `synthesize`) compile into the node graph; low-level node fields remain available for anything blocks cannot express.
- `workflow(action="draft")` renders a structured graph through the tool schema into a validated YAML spec — field-name mistakes are rejected by the provider, not discovered at validation time.
- Saved workflow libraries at three scopes (project / global / builtin), startable by name; the `/dag-auto` command routes a requirement to a curated reference topology and retargets it to the task at hand.
- The agent promotes to a workflow on its own judgment — the user need not ask — and declares the graph structure up front, mutating it at runtime only for structure that depends on results. When later work depends on items a node produces (for example one verifier per finding), the parent turns that node into a checkpoint, deduplicates and ranks the reported items, and adds only the needed item nodes with a bounded `extend`; `fan_out` is for writers from a plan's `packages`, not general per-item expansion.
- Model tiers in `dag.model` separate decisions from volume: critical nodes on the `advanced` model, fan-out work on `standard`.

**Reliability**

- Event-sourced state with a declared state machine; the SQLite read model is projected inside the publish transaction. Crash recovery reconciles from durable evidence and never fabricates provider work.
- Execution-location authority: each workflow row carries the directory stamp of the session that created it, re-read from the database on every ownership check, so sibling worktrees of one project cannot act on each other's workflows. Stamps move with the session when it moves.
- Revision view: a replan supersedes the replaced segment — the inspector, status output, and summary counts render the current graph only. Live failures on the current graph (quota exhausted, API error, timeout cap) stay visible; superseded ones do not count toward the workflow's terminal state.
- Node outputs that are a single absolute file path are captured as `{content_ref, size, sha256, summary}`; the result action returns the pointer and the parent reads the file. Inline and structured payloads unchanged.

**Observability & control**

- TUI DAG inspector (`dag.open` in the command palette): workflow list, wave-ordered node view with live status, node detail with deadline countdown; `p`/`r`/`s`/`x` for pause/resume/step/cancel, `enter` drops into a node's child session.
- Sidebar panel with per-session progress; HTTP API mirroring every tool action (see [below](#observing)).
- Deep mode admission: a bounded Q&A pass (1/3/5 rounds) produces a fingerprinted Requirement Brief with a `READY` / `NOT_READY` / `WAIVED` verdict before an expensive graph starts.

**Messaging**

- The main agent can observe nodes of its own workflows and exchange messages with an exact current node attempt. Sending is non-blocking; messages provide context and never grant authorization or change workflow lifecycle.

## Using workflows

Nothing has to be configured to try it: ask for work that has stages, parallel
parts, or a review gate in the middle (`/dag-auto <task>`), and the agent
designs a graph and runs it. Three things turn that into a repeatable setup of
your own.

### 1. Choose the model tiers — `dag.model` in `.agents/settings.json`

Nodes never name their own model. The graph declares _which nodes are critical_
and configuration decides _what runs them_:

```jsonc
{
  "dag": {
    // Critical nodes: required: true, plus review/arbiter workers.
    "model": {
      "advanced": "anthropic/claude-sonnet-4-5",
      "standard": "anthropic/claude-haiku-4-5"
    },
    // Reasoning variant for DAG child sessions, when the model defines one.
    "thinking_depth": "medium"
  }
}
```

A project `.agents/settings.json` overrides the user-level
`graphagent.json`/`graphagent.jsonc` in the config dir, field by field; the
rest of the `dag` section (`mode`, `concurrency`, budgets, safety rules) stays
user-level policy. With only one tier configured, it serves as the unified
default. Resolution order per node is
tier → worker agent model → parent session model; when none of them yields a
model, the workflow is not created and you are asked to configure one.

### 2. Save the workflows you rerun — `.agents/workflows/`

A workflow spec is a YAML file describing the graph. Put it in a workflow
directory and it gains a **name**:

| Scope   | Path                                          | Availability                                                          |
| ------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Project | `.agents/workflows/<name>.yaml`               | This repo, committed with it — the whole team gets the same procedure |
| Global  | `<config dir>/workflows/<name>.yaml`          | Every project on the machine                                          |
| Builtin | Compiled into release binaries                | Every release install — the last-resort tier                          |

Resolution takes the first match in that order, so a project file shadows a
global one with the same name, and both shadow the builtin tier. The global
scope is maintained by the [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config)
repository (sync it with a plain `git clone`/`git pull` into your config
dir). A minimal spec:

```yaml
title: Dependency audit
config:
  name: dependency-audit
  nodes:
    - id: inventory
      name: inventory
      worker_type: explore
      depends_on: []
      required: true
      prompt_template:
        id: config-explore
        input:
          target: "package.json files and lockfiles"

    - id: report
      name: report
      worker_type: general
      depends_on: [inventory]
      report_to_parent: true
      prompt_template:
        inline: "Flag outdated or duplicated dependencies in {{inventory}} and propose an upgrade order."
```

Then just say "run the dependency-audit workflow" — the agent starts it by
name, no path needed. Ad-hoc specs still work exactly as before: a `spec_path`
that looks like a path (has a separator or a `.yaml`/`.yml` extension) is read
relative to the session directory instead of the library.

### 3. Let the agent author it

For one-off graphs, `workflow(action="draft")` takes the structured graph as
tool parameters and hands back a validated `spec_path`, so field drift never
reaches the file.

Node prompts referenced by `prompt_template.id` resolve from the project's
`.agents/workflows/prompts/<id>.md`, then the global
`<config dir>/workflows/prompts/`. Add your own `.md` file there to make a new
template available; a global workflow should prefer `inline` prompts so it does
not depend on a repo-local template.

## The engine

The engine lives in [`packages/core/src/dag`](../packages/core/src/dag) (state machine, dependency graph, scheduling, event projection, SQLite read model) and [`packages/graphagent/src/dag`](../packages/graphagent/src/dag) (workflow service, execution loop, node spawn, admission, review lifecycle, crash recovery, templates). Agents drive it through a single `workflow` tool; humans watch and control it through the TUI or HTTP API.

### Graph definition

Each node declares:

| Field              | Purpose                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `depends_on`       | Dependency edges; cycle detection and dangling-reference validation at creation                     |
| `worker_type`      | Which agent runs the node (`explore`, `build`, `general`, or any configured agent)                  |
| `prompt_template`  | Prompt by `id` (from project, then global `.agents/workflows/prompts/`) or `inline`, with `{{var}}` interpolation |
| `input_mapping`    | Map upstream node outputs into template variables (`"count": "node-b.output.count"`)                |
| `condition`        | Expression over upstream outputs; false → node skipped, pure descendants cascade-skip               |
| `output_schema`    | JSON Schema; the child agent's final answer must be exactly one JSON value matching it              |
| `required`         | Failure of a required node fails the workflow                                                       |
| `report_to_parent` | Wake the parent agent when this node reaches a terminal state                                       |
| `review`           | `design` or `diff` review phase with an implementation-fingerprint contract (below)                 |

Workflow-level knobs: `max_concurrency` (default 5), `max_node_replan_attempts` (5), `max_total_nodes` (100), per-node `timeout_ms` (default 10 min, counted from permit acquisition; time spent queued does not count).

### Scheduling & execution

- Nodes spawn as real child sessions through the same code path as the `task` tool, wave by wave in dependency order, bounded by a concurrency semaphore. A node is durably `queued` at admission and the child session only materializes inside the permit, so a 100-node fan-out never creates 100 sessions at once.
- Dynamic replanning, pause-first: `pause` freezes scheduling, `replan` merges a fragment atomically, and `resume` continues. `control(recover)` replaces selected nodes and their downstream attempts in the same failed or paused workflow, using `expected_graph_rev` to reject stale requests. Old attempts remain immutable. Cancelled workflows require explicit resume intent. `extend` appends nodes and may reopen a naturally completed workflow at a reporting checkpoint.
- Step mode runs one node at a time for debugging.
- The parent does not poll. Synthetic messages wake it when a `report_to_parent` node or the workflow terminalizes. Checkpoint nodes emit a normalized verdict (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`), and the disposal contract governs what happens next. Iteration is a bounded, verdict-driven replan wave; the graph never contains a cyclic edge.

### Revisions

Rewriting a graph does not erase history, but it does retire it. A replan that supersedes nodes marks them; the workflow row carries a `graph_rev` counter and every view — status output, HTTP API, TUI inspector, summary counts — filters to the current revision. Unrelated completed nodes and valid outputs survive into the new revision untouched; recovery replaces the selected nodes and their downstream closure. Audit of superseded nodes stays possible through the result store (an agent can look it up by node id); the TUI exposes no entry to it.

Two things this fixes. A workflow whose failed segment was rewritten now reports `completed` when the replacement succeeds, instead of dragging the old failure along. And the failure counts you see are the failures that exist — a quota exhaustion or API error on the current graph stays visible until it is actually fixed.

### State machine & persistence

- Declared transition tables for workflow and node status; every mutation goes through a guard, invalid transitions and terminal violations are typed errors (HTTP 409, not 500).
- All changes are published as durable `dag.*` events; a projector writes the SQLite read model _inside_ the publish transaction. History is event replay, not a log table. A drift test fails whenever the projector's guards and the declared transition tables are edited out of sync.
- Crash recovery is lazy, per-workflow, and evidence-based: nodes left `running` are reconciled against their child session's durable state. Sessions that finished back-fill their captured output; when execution ownership was genuinely lost, the workflow pauses and the parent decides disposition (replan / resume / cancel). Recovery never adopts or restarts provider work on its own.
- Failure triage: every failed node carries a failure class (`timeout` / `exec_failed` / `verdict_fail`) surfaced in `workflow(action=status)` and in the parent's wake — including a failed-nodes attribution digest when a workflow terminalizes failed — so the parent agent can select the failed node for local recovery instead of rebuilding the graph.

### Node outputs

A node's final reply can be plain text, a structured payload (one final JSON value matching `output_schema`), or a file. For a node without an output schema, a final reply containing one absolute path to a non-empty file (up to 64 MiB) commits a managed copy under application data. Its receipt records the digest, size, short summary and execution provenance. Downstream nodes receive a path and read the body as needed; deleting the source working tree does not delete the managed result. Result reads, downstream execution and local recovery verify managed object integrity before reuse. Legacy receipts remain compatible. See [file artifacts and recovery](./dag-file-artifacts-and-recovery.md) for the tool calls and limits.

### Deep mode: admission & review

- Admission Q&A covers six dimensions (goal, scope, constraints/assumptions, acceptance criteria, evidence, risks) under a bounded policy: `LIGHT` (1 round), `STANDARD` (3), `GRILL` (5, adversarial). The resulting Requirement Brief is fingerprinted (SHA-256 over a canonical form); material changes invalidate the fingerprint and return admission to questioning. A consumed record is persisted with the workflow and never replayed.
- Review nodes declare their phase honestly: `design` reviews pre-implementation artifacts; `diff` reviews the actual implementation and requires the implementation node, a passing verification node, and a fingerprint echo. Changing the implementation changes the fingerprint, so a stale `ACCEPT` cannot satisfy the gate.

### Observing

- TUI DAG inspector (command palette → `dag.open`): workflow list, wave-ordered node view with live status, node detail (deps, errors, output preview, deadline countdown); `enter` drops into a node's child session. Workflow control goes through the `workflow` tool, not the inspector.
- Sidebar panel: per-session workflow progress (completed/running/failed/queued), expandable node list, driven by ephemeral summary events, with a fetch-on-open safety net instead of polling.
- HTTP API (read-only queries; mutations go through the `workflow` tool):

  ```
  GET  /dag                              list workflows
  GET  /dag/session/:sessionID           workflows for a session
  GET  /dag/session/:sessionID/summary   progress summaries
  GET  /dag/:dagID                       workflow detail
  GET  /dag/:dagID/nodes                 node list
  GET  /dag/:dagID/nodes/:nodeID         node detail
  ```

### Project configuration files

Everything DAG-specific lives under `.agents/`, with a global counterpart in
the config dir (`GRAPHAGENT_CONFIG_DIR`, else `~/.config/graphagent`).
Everything else inherits the main GraphAgent configuration.

| Path                                | Purpose                                                                       | User-level counterpart                                             |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.agents/settings.json` `dag.model` | Model tiers (`advanced` / `standard`) and `thinking_depth` for child sessions | `graphagent.json(c)` `dag`, overridden by the project              |
| `.agents/workflows/*.yaml`          | Saved workflow specs, startable by name                                       | `<config dir>/workflows/*.yaml`                                    |
| `.agents/workflows/prompts/*.md`    | Node prompt templates referenced by `prompt_template.id` (project first)      | `<config dir>/workflows/prompts/*.md`                              |

Both the DAG settings and the workflow library are read lazily, so an edit applies to
the next workflow start without a restart.
