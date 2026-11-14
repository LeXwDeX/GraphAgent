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

## Actions

Graph content lives in a spec file; the parameter schema owns action fields.

- `spec` — list/read/draft/validate saved specs. Draft writes a start file and
  returns its `spec_path`; validate pre-flights a spec without creating a workflow.
- `run` — start a workflow from `spec_path`, or extend a live one.
- `inspect` — status/result for durable state and paged node output.
- `control` — pause/resume/step/cancel/complete/cancel_node/replan/recover/
  extend_timeout/retarget a live workflow.

Keep one objective on one live DAG. Start from the smallest justified graph:
draft a structured `config`, validate the returned `spec_path`, then start it.
Use `spec(list)` to find a saved reference; never guess a route name.

## Coordination

- Messaging and result delivery use the `agent` tool (`send`, `receive`,
  `observe`); workflow has no send/receive/observe action.
- Reporting checkpoints are gates: wait for the wake a reporting node produces
  instead of polling `inspect(status)`, and answer the verdict before dependents
  can proceed.
- A rejected mutation parks the workflow paused. Correct the reported cause and
  retry the rejected call; never restart or cancel the graph to escape a
  rejection, and never claim work ran without evidence.
