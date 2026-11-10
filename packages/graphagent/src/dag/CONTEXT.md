# Workflow Orchestration Context

Workflow Orchestration turns one user objective into one durable DAG. Its model-facing tool accepts saved or file-backed custom workflows and recommends heuristic composition from reusable Blocks. Low-level Nodes remain available when a Block route cannot express the objective.

## Glossary

| Term                     | Meaning                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow Source          | An in-memory object used by trusted internal callers or a YAML document supplied to runtime and release tooling. Model-authored graph actions use YAML through `spec_path`.                                                                       |
| Workflow Authoring Check | The side-effect-free source-to-graph boundary that parses, normalizes file compatibility, decodes the action shape, compiles Blocks, applies the selected validation profile, and returns diagnostics or a Prepared Workflow Graph.               |
| Prepared Workflow Graph  | A strictly decoded and compiled graph that passed the requested authoring checks and is ready for a runtime mutation.                                                                                                                             |
| Workflow Control         | The shared owner-checked boundary that applies pause, resume, step, cancel, complete, replan, extend, recover, extend_timeout, and retarget requests through `Dag`, with one rejection vocabulary and the post-failure parking protocol.          |
| Workflow Route           | A complete Block or Node composition selected for one objective. It may be custom, saved, or assembled heuristically.                                                                                                                             |
| Orchestration Router     | The product-owned parent guidance that qualifies an objective and selects one Workflow Route without external Skill discovery.                                                                                                                    |
| Block Composer           | The Orchestration Router decision that selects the smallest Block graph justified by current evidence.                                                                                                                                            |
| Decision Checkpoint      | One parent-owned confirmation for unresolved user choices that materially change behavior, scope, acceptance, or an irreversible boundary.                                                                                                        |
| Reporting Checkpoint     | A `report_to_parent: true` node with dependents; its dependents must gate on its output via `condition`, or it must be a reporting leaf.                                                                                                          |
| Workflow Brief           | The recommended route, scope, acceptance evidence, assumptions, risks, and material alternatives presented at a Decision Checkpoint.                                                                                                              |
| Block                    | A reusable high-level orchestration capability such as explore, plan, debug, coding, verify, or review. Blocks compile into Nodes.                                                                                                                |
| Fan-out Writer           | A writer whose `fan_out` dependency's `packages` output decides, at admission, whether it runs as parallel package writers joined by an aggregator under its id or as itself.                                                                     |
| Node                     | A low-level durable unit of child-agent work with dependencies, prompt input, policy, and output contract.                                                                                                                                        |
| Pause Reason             | The durable `workflow.pause_reason` recorded with `WorkflowPaused` (for example `budget_exhausted`). It describes only the current pause episode and is cleared by resume, terminal settlement, or replan.                                        |
| Display State            | The presentation-only node state derived from the raw status: a cancelled node displays as `cancelled`, a running escalation-pending node as `escalated`, otherwise the raw status. Raw `status` and `error_class` remain available to consumers. |
| Validation Profile       | `portable` checks source-contained structure without user environment state; `environment` additionally resolves live agents, prompt assets, and models.                                                                                          |
| Runtime Admission        | The READY/WAIVED gate for a deep workflow. It is a lifecycle policy after authoring, not another name for Workflow Authoring Check.                                                                                                               |
| Delivery                 | The single DAG delivery scheduler (`DagDelivery`) that admits durable wake batches and queued agent messages to an idle parent session. It owns the in-flight reservations and the wake-first/mailbox-second order, and registers as the `dag.delivery` inbox source (priority 5, `idle_only`) on the shared per-instance `SessionInbox`, which holds the single idle subscription; the 250ms mailbox poll and 30s paused-reminder sweep remain transitional fallbacks. |
| DagMessages.changed      | The process-scoped PubSub stream of committed agent-mailbox changes (`queued`, `delivered`, `closed`). It is published after the outermost transaction commits, never on rollback, and is a notification only.                                      |

## Invariants

- Block composition is the recommended authoring path and is selected heuristically from the objective; custom Blocks/Nodes remain supported.
- Workflow Authoring Check is the only raw source-to-Prepared Workflow Graph authority used by tool actions, CLI, generation, and packaging.
- Parsing, file-only compatibility, strict action decoding, Block compilation, and profile diagnostics are not reimplemented by callers.
- `portable` validation does not load user environment catalogs. `environment` validation reads current catalogs and verifies actual model availability.
- Workflow graph creation or replacement requires a valid Prepared Workflow Graph. A rejected live mutation may still publish durable `WorkflowPaused` through the Workflow Control parking path to park the existing graph.
- The model-facing schema contains fields the model owns. Session/Project identity, admission audit state, model assignment, and other runtime-derived fields remain hidden.
- Model-facing graph actions expose only `spec_path`; graph fields live in YAML so provider tool-call serialization cannot turn a nested graph into a string.
- Legacy YAML may be adapted at the file boundary without making legacy fields valid inline input.
- Runtime Admission and Workflow Authoring Check have separate names, state, and responsibilities.
- A rejected live replan or extend is parked by `DagControl.parkRejected`, which publishes durable `WorkflowPaused` only after the failed mutation released the workflow lock. If that pause fails or races with a terminal transition, the outcome reports the actual durable status (`parked`, `already-paused`, `terminal-unchanged`, or `failed`); callers must not assume the graph is parked.
- The runtime fan-out extend fallback and the recovery-pause adoption flow call `Dag` directly. They are engine-internal scheduling decisions, not caller control requests: they deliberately bypass `DagControl`, and a declined fan-out expansion runs the writer serially without parking the workflow.
- A paused workflow gets one durable, delayed reminder per pause episode through the wake marker. A reminder never resumes, completes, or fails the workflow.
- Dependents of a reporting checkpoint must be gated on its output; authoring rejects ungated shapes at start/validate AND at replan/extend fragment actions, and the runtime replan/extend mutation seam re-checks the merged graph (exempting checkpoints already terminal in the durable graph — they are settled and immutable, the spawn-before-verdict race is past; runtime create remains deliberately unchanged). A gated checkpoint must declare `output_schema` (authoring obligation).
- Workflow and node status vocabularies each have one source (`@graphagent/schema/dag-status`), and each contains exactly the statuses that durable events can produce. Terminal sets are domain-specific; `settled` means `completed` or `skipped` only, so an `aborted` node never counts as finished progress.
- A `budget_exhausted` pause is recorded on the durable event and read model, and only a resume/step transition lifts it. The public `Dag.resume` and `Dag.step` paths consult the injectable `ResumeGuard` policy (fail-open when no policy is provided) before publishing; internal terminalization through `failUnrecoverable` deliberately bypasses the guard. `DagControl` also prechecks the guard for paused `extend`, `replan`, `recover`, and `extend_timeout` before mutating; a veto returns a rejection without parking or mutation.
- Node cancellation is identified structurally by `error_class = "cancelled"` (never by matching `error_reason` text). A cancelled node lands on the `failed` status, is marked superseded, and therefore drops out of current-revision reads and agent-failure wake attribution.
- Wake attribution excludes cancelled rows (superseded) and `budget_exhausted` failures; both are engine outcomes, not agent failures, and must not trigger replan hints.

## Conventions

- Effective worker tool profiles are documented in [tool-profiles.md](docs/tool-profiles.md).
- `config.workspace` (and a node's `workspace` override) binds DAG children to an absolute linked worktree of the same project. Relative `spec_path` and draft paths still resolve from the calling session directory because the workspace is declared inside the spec. DAG config (`dag.jsonc`), prompt assets, the report area, snapshots and child tools resolve from the node's execution directory. Without `workspace`, children keep running in the owner/session directory, including non-git projects.
- One user objective has at most one live DAG; route expansion stays inside that DAG (issue #348: a modeling convention enforced by orchestrator guidance — workflow-routing and orchestration-policy — not by the engine; `dag.create` and the workflow tool's start accept a session with a live workflow. The runtime tolerates the violation with bounded consequences: the wake model aggregates across workflows and a goal is blocked by any DAG lease. When two live DAGs share one workspace, the plan block's disjoint-write-set discipline does NOT carry across workflows — authors must keep concurrent workflows on disjoint worktrees or serialize them).

## Boundaries

- `WorkflowAuthoring` owns source interpretation and authoring diagnostics.
- `DagWorkflows` owns saved-source discovery, scope precedence, and presentation metadata; it does not decide startability.
- `Dag` owns durable lifecycle invariants, event publication, and runtime transitions for already prepared graphs.
- `DagControl` owns the shared owner check, request-to-`Dag` mapping, rejection classification, paused-entry guard precheck, automatic resume after replan/extend, and post-failure parking; `Dag` remains the only lifecycle mutation authority.
- `DagDelivery` owns parent-facing delivery admission: the wake ledger read/ack path (admission equals delivery, #321), the agent-mailbox path (confirmed only by `associate`), the in-flight reservations, and the transitional delivery timers. It registers with the shared per-instance `SessionInbox` as the `dag.delivery` source (priority 5, `idle_only`, claim = `deliver`) and the hint-only `dag.mailbox.step` step source. `DagLoop` does not subscribe to idle locally: it only wires event sources, which nudge delivery, and event sources never deliver inline.
- `DagMessages.changed` is a post-commit notification edge from the mailbox store to delivery. It carries no message body and grants no delivery authority; a missed, duplicated, or unsubscribed notification must fall back to the durable scan.
- Provider/Agent/Skill/prompt catalogs own environment facts; the authoring boundary consumes current snapshots without becoming their source of truth.
- Release/config tooling invokes the same portable authoring boundary and adds repository compatibility and packaging gates.

## Decisions

- [ADR-0001: One Workflow Authoring Check authority](docs/adr/0001-workflow-authoring-check.md)
- [ADR-0002: Parallel workspace writers with an implementation aggregator](docs/adr/0002-parallel-writers-aggregator.md)
- [ADR-0003: Reporting checkpoint gating at the authoring boundary](docs/adr/0003-reporting-checkpoint-gating.md)
- [ADR-0004: Plan-driven fan-out of implementation writers](docs/adr/0004-plan-driven-fan-out.md)
