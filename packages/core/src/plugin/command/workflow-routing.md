# Orchestration Router

The workflow tool is available when orchestration helps; its availability is
not a reason to use it. The parent owns execution choices and workflow controls.
Children stay within their assigned scope and do not start nested workflows.

## Execution mode

Choose direct execution, a `task` child, or a `workflow` DAG according to the
expected benefit and coordination cost, not a task-category rule.

- Direct execution: useful when the work fits the current context and can be
  checked without delegation. Small edits, bounded debugging, and read-only
  questions often fit here, including project source and tests.
- One `task` child: useful for a bounded question or work package when
  isolation or specialist attention helps without a durable graph.
- One `workflow` DAG: useful when parallel work, isolated contexts, dependent
  stages, independent assurance, or recoverable execution justify orchestration.

These are examples, not thresholds. File count, module boundaries, CI/release,
or the word "review" alone do not require a DAG. Risk can justify stronger
verification without adding agents. No routing checklist is needed for routine
direct work. Promote to a DAG on your own judgment; the user need not ask.

Explicit user instructions take precedence: one agent, direct work, or no DAG
means no delegation; an explicit DAG request calls for an appropriately scoped
graph. Reconsider the approach when evidence changes. Before taking over an
active child's work, stop or isolate its writes.

A read-only request keeps every selected child read-only. Preserve named roles,
configured model constraints, scope limits, and prohibited actions in child prompts.

## Qualify before composing

Use available evidence to distinguish technical uncertainties from decisions
only the user can make. For an unresolved product or architecture decision
that changes authorized scope or acceptance, a concise **Workflow Brief** with
a recommendation and alternatives can support one combined confirmation.
Already confirmed requirements do not need another approval ceremony. Children
report scope questions to the parent, never expanding scope alone.

## Optional references

After choosing a DAG, saved workflows can be useful starting points. To discover
one, call `workflow(action="list")` and read the relevant returned name; never
guess a route name. A user-supplied `spec_path` can be read directly. A small
task-local graph can also be authored without searching the library.

Match references to the requested outcome, for example:

- product planning — decide what or why to build;
- technical design — produce an implementation-ready system or migration design;
- project development — deliver a confirmed project change;
- debug and repair — reproduce a defect, prove its cause, and repair it;
- code review — return a verdict on a pinned implementation change or diff;
- security audit — return a code, trust-boundary, authorization, or supply-chain verdict;
- performance audit — return a measured resource or scale verdict.

`lite` and `full` are reference shapes, not mandatory tiers. Uncertainty,
irreversibility, public contracts, concurrency, persistence, authorization, or
upstream executable dependencies can warrant more evidence. Choose the checks
that address the actual risk; a risk label or non-`ACCEPT` verdict alone never
requires a full graph or a fixed reviewer count.

A primary reference often keeps the objective clear. Borrow secondary checks
where they add evidence, rather than concatenating whole workflows. Retarget a
matching custom workflow to the task. Related work can usually
reuse the existing workflow and valid results; the Verdict Disposal Contract
describes follow-up options. Do not pause or replan a completed workflow.

## Compose the smallest justified graph

Use only phases that contribute to the result. A saved reference is not a
checklist to complete: omit redundant exploration, reviews, or synthesis and
reuse evidence already available. Start a saved `spec_path` unchanged only when
its target and acceptance match. Load `guide(topic="blocks")` for block
contracts, `guide(topic="patterns")` for cross-domain examples; low-level
nodes cover fields blocks cannot express.

Prefer `workflow(action="draft")` over hand-writing YAML: pass the structured
`config` (same fields as the YAML below) and the tool renders and validates the
spec file, returning the `spec_path` to start. Field-name drift is impossible
because the parameter schema rejects unknown fields. Hand-write YAML only for
features draft does not carry (admission, custom bindings). Draft writes this
start document only — an extend file takes a top-level `{ objective, blocks }`
or `{ nodes }` graph, and a replan file wraps the graph in `fragment`; the
blocks guide owns their exact shape. The start shape, for that fallback and
for reading draft output:

```yaml
title: Implement session recovery
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests and review.
  blocks:
    - id: map
      kind: explore
      instruction: Locate the ownership and persistence seams.
    - id: coding
      kind: coding
      depends_on: [map]
    - id: verify
      kind: verify
      depends_on: [coding]
```

Top level is `title`/`mode`/`admission` (optional) and `config` (required);
`objective` lives INSIDE `config`; every block field is one of `id` (required),
`kind` (required), `depends_on`, `instruction`, `worker_type`, `worker_config`,
`required`, `report_to_parent` — never `worker`, `prompt`, or `agent`.

A `report_to_parent` node with dependents is a reporting checkpoint: gate
dependents on its output via `condition`, keep it a leaf, or drop the flag.

Validate the authored `spec_path` before start; validation creates no workflow.
Resolve blocking diagnostics rather than bypassing validation. A successful
start returns the exact workflow ID, not proof of node execution. Checkpoint
wakes let the parent act without polling merely to wait. Do not duplicate
active child work or claim an unstarted graph is running.

## Progressive guidance

`guide` without a topic is the index. Topics: `blocks` for block shape,
`interface` for low-level fields, `policy` for recovery, and `patterns` for
cross-domain conflicts. Load only the needed topic.

The tool parameter schema owns action fields and `spec_path`; on-demand guides
own YAML fields; validation is the file authority.
