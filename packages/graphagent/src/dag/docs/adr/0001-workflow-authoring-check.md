# ADR-0001: One Workflow Authoring Check authority

- Status: Accepted
- Date: 2026-08-11

## Context

Workflow input was interpreted independently by the provider-facing tool schema, start, validate, list/read, replan, CLI, generation, and packaging. Earlier hidden YAML authoring left the model unable to infer required fields. Exposing the complete graph as an inline tool argument fixed discoverability but introduced another failure mode: providers or models could double-serialize the nested `spec` object into a JSON string before validation. Field guidance now belongs to the on-demand workflow guides, while the model-facing action remains shallow and file-backed.

The product supports a single custom workflow, saved workflows, and heuristic Block composition. Those are source choices for one orchestration product, not separate validation systems.

## Decision

`WorkflowAuthoring` is the only raw Workflow Source to Prepared Workflow Graph boundary. It owns YAML parsing, file-only legacy normalization, action-specific strict decoding, Block compilation, portable/environment validation, stable diagnostics, and safe result caching.

All tool graph actions and offline config/release consumers call this boundary. Callers may authorize and read files or perform durable DAG mutations, but they do not reinterpret source shape or decide graph validity.

Model-facing `start`, `extend`, `control(replan)`, and `validate` accept only
`spec_path`. One-off graphs use task-local YAML files; saved workflow names use
the same field. Trusted internal consumers may still pass an in-memory source
directly to `WorkflowAuthoring` without creating a second validation path.

The provider schema exposes only author-owned fields. Runtime identity, model assignment, and persisted admission audit fields are derived or adapted behind the boundary. Portable checks are environment-free; environment checks resolve live catalogs and are not cached as content-only facts.

## Consequences

- A valid source has one compiled meaning across validate, start, extend, replan, read/list diagnostics, CI, generation, and packaging.
- Provider schema stays shallow; on-demand guides describe author-owned YAML fields without exposing runtime-owned fields.
- File-backed custom and saved workflows share one YAML validation path; internal in-memory input stays strict.
- Environment changes are observed on the next environment check.
- Durable DAG methods retain lifecycle validation as defense in depth, but do not become a second raw-source validator.

## Alternatives Considered

- Keep validators per caller: rejected because fixes and diagnostics drift across runtime and release paths.
- Publish the persisted YAML shape directly to the model: rejected because compatibility/audit/runtime fields are discoverable but not model-owned.
- Make every check environment-aware: rejected because config CI and portable assets must not depend on user-global agents, skills, prompts, or models.
- Remove low-level custom Nodes: rejected because Blocks are the recommended composition interface, not the only expressible workflow form.
