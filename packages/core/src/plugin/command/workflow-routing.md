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

## How to start

Start from the smallest justified graph. Prefer `workflow(action="draft")` with
a structured `config`; validate the returned `spec_path`, then start it.
After choosing a DAG, use `workflow(action="list")` to find a saved reference;
never guess a route name. A task-local graph needs no library search.

Load the guide for the decision at hand: `guide(topic="blocks")` for YAML and
block contracts, `interface` for actions and low-level fields, `policy` for
admission, verdicts and recovery, and `patterns` for cross-domain examples. The
parameter schema owns action fields; validation is the file authority.
