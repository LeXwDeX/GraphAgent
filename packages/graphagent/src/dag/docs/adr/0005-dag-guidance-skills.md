# ADR-0005: DAG guidance as built-in skills

- Status: Accepted
- Date: 2026-11-14

## Context

The workflow tool converged to four action groups (`spec`, `run`, `inspect`,
`control`), and the `guide` action was removed. The always-on routing text
(`workflow-routing.md`) stays small, but the detailed authoring, recovery,
pattern, and policy guidance still needs to reach the model on demand.

That guidance used to be delivered three ways: inline `guide(topic=...)`
constants in `packages/core/src/plugin/command.ts`, an explicitly registered
`/dag-auto` command template, and a separate `create-dag-workflow` skill. Two of
those delivery paths no longer match the tool surface, and the source documents
(workflow.md, workflow-blocks.md, orchestration-policy.md,
orchestration-domains.md, dag-auto.txt) total roughly 93 KB. The guide topics
also grew cross-references (`guide(topic="blocks")`) that pointed at an action
that no longer exists.

## Decision

Register six built-in skills in
`packages/graphagent/src/skill/builtin/index.ts`:

| Skill | Source material | Budget |
| --- | --- | --- |
| `dag-auto` | dag-auto prompt + saved-workflow authoring + lifecycle/design principles | 8 KB |
| `dag-blocks` | composable block authoring contract | 8 KB |
| `dag-nodes` | saved-workflow resolution, node inputs/model selection, prompt templates, budgets, workspace discipline, node fields | 10 KB |
| `dag-recovery` | adaptive replanning, failure triage, crash recovery, replan protocol, verdict disposal, checkpoints, bounded repair | 12 KB |
| `dag-patterns` | collaboration patterns + cross-domain composition | 8 KB |
| `dag-policy` | model tiers, depth, ownership, communication, deep admission, roles, profiles, review lifecycle, gates | 10 KB |

The compiled bodies total at most 56 KB (about 40% smaller than the source
documents). Behavioral rules and the checkpoint-gating, rejected-mutation
parking, and pause-reminder invariants are preserved; only repetition and
verbose examples were compressed. Cross-references name the skill to load
(`skill dag-*`) instead of the removed guide action.

`dag-auto` is not hidden, so the skill registry promotes it to a `source:
"skill"` `/dag-auto` command and the explicit command registration is deleted.
The command template is the skill body, which carries no `$ARGUMENTS`; the
command expander appends invocation arguments after the body (the closing
"Request" section notes this). The other five skills are `hidden: true`: the
model can load them by name, but they get no same-name slash command.

Static skill bodies cannot interpolate a project ID, so the old
`${dag_specs}` substitution is replaced by a generic description of the XDG
workflow-artifacts area and by referring to the `spec(draft)` result's
`spec_path`. Paths use the merged layout: project `.agents/workflows/`,
prompt assets in `workflows/prompts/`, and the `dag` section of
`.agents/settings.json`.

## Consequences

- The five hidden skills remain visible to the model: they appear in
  `available_skills`, the HTTP skill list, and the TUI skill list. Every
  request carries six additional skill descriptions; the on-demand bodies are
  paid only when loaded.
- `hidden` only suppresses the same-name slash command. A user-defined command
  or disk skill named `dag-auto` still shadows the built-in, because configured
  commands register before skill promotion.
- The TUI slash-command completion excludes `source: "skill"` entries upstream,
  so `/dag-auto` no longer appears in the `/` menu. Typing `/dag-auto <task>`
  still works: the server parses the payload and resolves the command from the
  skill-promoted registry. This was accepted rather than widening the TUI
  filter to every visible skill; argument completion never existed for
  `/dag-auto`.
- `packages/core/src/plugin/command.ts` keeps only the always-on
  `WorkflowContent` routing export; the guide constants, guide topic documents,
  and `renderDagAutoContent`/`dagSpecsArea` helpers are deleted.
- Guidance drift is bounded by tests: per-file and total byte budgets, a
  `guide(topic=...)` absence check, and content assertions that now live next
  to the skill registry (`test/skill/dag-skills.test.ts`).