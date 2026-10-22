# ADR-0004: Plan-driven fan-out of implementation writers

- Status: Accepted
- Date: 2026-10-22

## Context

ADR-0002 made unordered writers truly parallel, but the number of writers is
fixed when the graph is authored, before the plan that decides the work
packages has run. Saved routes either guessed a count (three slices) or
collapsed implementation into one writer and relied on the parent to remember
an additive `extend` after planning. A guessed count misfits most tasks; a
forgotten extend silently runs everything serially.

The question "when should the graph expand?" has no good timing answer. The
expansion trigger is data instead: the plan's structured output.

## Decision

A writer may declare `fan_out: <dependency>` (block field on `coding`, node
field on implementation writers). The block compiler gives the referenced plan
a `packages: [{ id, instruction, write_set }]` output schema and a contract
explaining that packages become concurrent writers.

The scheduler never spawns a node that still carries the marker. When it is
ready, `DagFanOut.planFanOut` reads the dependency's durable output and the
loop applies the result through `Dag.extend`:

- Two or more packages that are provably safe become writers
  `<writer>--<package>` (the writer's definition plus the package as
  `fan_out_package`), and the writer's id is replaced in place by the ADR-0002
  aggregator over them. Downstream verify/review bindings already reference
  that id and the implementation schema, so no other node is rewritten.
- Zero or one package replaces the writer with itself minus the marker.
- An unsafe shape (malformed or duplicate ids, empty or overlapping
  `write_set`, traversal paths, id collisions) or a rejected extend (node
  ceiling) also replaces the writer with itself minus the marker, with the
  reason appended to its prompt and logged.

How many packages exist and where their boundaries fall is the planner's
judgment. The engine only declines parallelism it cannot prove safe, and the
declined path is the always-safe serial writer, never a failed workflow.

## Consequences

- Expansion is durable and replay-safe: it is an ordinary extend, and the
  marker lives in the persisted definition, so a crash before the extend
  commits expands again on the next scheduling round. Recovery re-points
  `fan_out` at the recovered dependency attempt.
- The engine pre-checks declared write-set overlap with path-prefix logic; the
  aggregator still reconciles declared sets against the actual workspace.
- Writers see the whole plan as dependency context plus their own assignment.
- Expanded graphs count toward `max_total_nodes`; routes that fan out should
  budget for the largest split they expect.
