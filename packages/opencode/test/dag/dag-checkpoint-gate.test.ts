import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WorkflowAuthoring } from "../../src/dag/authoring"
import { resolveInputMappingChecked } from "../../src/dag/runtime/eval"
import { renderTemplate } from "../../src/dag/templates/resolve"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

// A report_to_parent (wake-eligible) checkpoint hands its verdict to the
// parent. When a dependent lacks a condition on that checkpoint's output, the
// engine spawns it the moment the checkpoint completes and the verdict can
// never act first — exactly the shape that ran a 6-stage "ultra flow" to
// completion after every decision checkpoint returned replan. Block-compiled
// graphs gate dependents on the verdict (issue #294 REJECT-checkpoint shape);
// hand-built node graphs must do the same.

function spec(config: Record<string, unknown>) {
  return { title: "checkpoint gate", config }
}

function checkpoint(id: string) {
  return {
    id,
    name: id,
    worker_type: "general",
    depends_on: [],
    report_to_parent: true,
    prompt_template: { inline: id },
    output_schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    },
  }
}

function stage(id: string, dependsOn: string[], condition?: string) {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    prompt_template: { inline: id },
    ...(condition ? { condition } : {}),
  }
}

function validate(value: unknown, directory?: string) {
  return WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed({}) }).prepare({
    action: "start",
    source: { kind: "inline", value, source: "<test>" },
    ...(directory ? { profile: "environment" as const, environment: { directory } } : {}),
  })
}

function projectDir(files: Record<string, string>) {
  return tmpdirScoped({
    init: (directory) =>
      Effect.promise(async () => {
        for (const [file, content] of Object.entries(files)) {
          const target = path.join(directory, file)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content, "utf-8")
        }
      }),
  })
}

it.effect("rejects a reporting checkpoint whose dependent is not gated on its output", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "ungated-checkpoint",
        nodes: [checkpoint("cp-design-decision"), stage("stage-development", ["cp-design-decision"])],
      }),
    )
    expect(result.valid).toBe(false)
    expect(
      result.errors.some(
        (d) => d.message.includes('"cp-design-decision"') && d.message.includes('"stage-development"'),
      ),
    ).toBe(true)
  }),
)

it.effect("accepts a dependent gated by a condition on the checkpoint output", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "gated-checkpoint",
        nodes: [
          checkpoint("cp-design-decision"),
          stage("stage-development", ["cp-design-decision"], 'cp-design-decision.output.verdict == "continue"'),
        ],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

it.effect("accepts a reporting checkpoint as a leaf", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "leaf-checkpoint",
        nodes: [stage("stage-design", []), { ...checkpoint("cp-after-design"), depends_on: ["stage-design"] }],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

it.effect("accepts an ungated dependent when the checkpoint does not report to parent", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "quiet-node",
        nodes: [{ ...checkpoint("analysis"), report_to_parent: false }, stage("summary", ["analysis"])],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

it.effect("flags ungated dependents inherited from node_defaults.report_to_parent", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "defaults-inherited",
        node_defaults: { report_to_parent: true },
        nodes: [{ ...checkpoint("cp"), report_to_parent: undefined }, stage("after", ["cp"])],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp"') && d.message.includes('"after"'))).toBe(true)
  }),
)

it.effect("flags a condition that gates a different dependency than the checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "wrong-gate",
        nodes: [
          checkpoint("cp-design-decision"),
          stage("stage-design", []),
          stage("stage-development", ["cp-design-decision", "stage-design"], 'stage-design.output.ready == "yes"'),
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(
      result.errors.some(
        (d) => d.message.includes('"cp-design-decision"') && d.message.includes('"stage-development"'),
      ),
    ).toBe(true)
  }),
)

// DAG-01 (authoring half): a checkpoint whose output a condition reads must
// declare output_schema. Without it the child completes with a raw string;
// even with the runtime's JSON normalization a prose reply resolves no
// fields, so the `.output.<field>` gate would be permanently false and the
// gated subtree silently skipped while the workflow reports COMPLETED.
it.effect("rejects a gated reporting checkpoint without output_schema", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "schemaless-gate",
        nodes: [
          { ...checkpoint("cp-decision"), output_schema: undefined },
          stage("stage-next", ["cp-decision"], 'cp-decision.output.verdict == "continue"'),
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-decision"') && d.message.includes("output_schema"))).toBe(
      true,
    )
  }),
)

it.effect("accepts a gated reporting checkpoint that declares output_schema", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "schema-gate",
        nodes: [
          checkpoint("cp-decision"),
          stage("stage-next", ["cp-decision"], 'cp-decision.output.verdict == "continue"'),
        ],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("output_schema"))).toEqual([])
  }),
)

it.effect("does not require output_schema on a reporting leaf checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "schemaless-leaf",
        nodes: [{ ...checkpoint("cp-final"), depends_on: [], output_schema: undefined }],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("output_schema"))).toEqual([])
  }),
)

// DAG-02: pre-fix authoring closed ALL structural diagnostics for non-start
// actions (`structural: input.action === "start"`), so a replan/extend could
// attach an ungated dependent to a reporting checkpoint and the engine would
// spawn it the moment the checkpoint completes — the checkpoint gate must
// apply to fragment actions too.
function validateReplan(fragmentGraph: Record<string, unknown>) {
  return WorkflowAuthoring.make().prepare({
    action: "replan",
    source: {
      kind: "inline",
      value: { fragment: fragmentGraph },
      source: "<test>",
    },
  })
}

function validateExtend(value: unknown) {
  return WorkflowAuthoring.make().prepare({
    action: "extend",
    source: { kind: "inline", value, source: "<test>" },
  })
}

it.effect("rejects a replan fragment whose dependent is not gated on the fragment's reporting checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validateReplan({
      name: "replan-ungated",
      nodes: [checkpoint("cp-review"), stage("stage-fix", ["cp-review"])],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-review"') && d.message.includes('"stage-fix"'))).toBe(true)
  }),
)

it.effect("rejects an extend fragment whose dependent is not gated on its reporting checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validateExtend({
      nodes: [checkpoint("cp-review"), stage("stage-fix", ["cp-review"])],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-review"') && d.message.includes('"stage-fix"'))).toBe(true)
  }),
)

it.effect("accepts a replan fragment that gates its dependent on the checkpoint output", () =>
  Effect.gen(function* () {
    const result = yield* validateReplan({
      name: "replan-gated",
      nodes: [checkpoint("cp-review"), stage("stage-fix", ["cp-review"], 'cp-review.output.verdict == "continue"')],
    })
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

// Issue #887: one diagnostic per reporting checkpoint, not one per
// (checkpoint, dependent) edge. The dependent that directly depends on several
// checkpoints must not be told to add a single condition that cannot pass, and
// the redundant transitive edges it lists must be named as the first fix.
it.effect("groups ungated dependents per checkpoint and names the redundant edges first", () =>
  Effect.gen(function* () {
    const checkpoints = [
      checkpoint("cp-plan"),
      { ...checkpoint("cp-initial"), depends_on: ["cp-plan"], condition: 'cp-plan.output.verdict == "continue"' },
      {
        ...checkpoint("cp-arbitrate"),
        depends_on: ["cp-initial"],
        condition: 'cp-initial.output.verdict == "continue"',
      },
      {
        ...checkpoint("cp-repair"),
        depends_on: ["cp-arbitrate"],
        condition: 'cp-arbitrate.output.verdict == "continue"',
      },
    ]
    // final-review lists all four checkpoints; three edges are redundant
    // (reachable through cp-repair), which is what made the old per-edge hints
    // unsatisfiable. Four leaf dependents add one ungated edge per checkpoint.
    const nodes = [
      ...checkpoints,
      stage("plan-note", ["cp-plan"]),
      stage("initial-note", ["cp-initial"]),
      stage("arbitrate-note", ["cp-arbitrate"]),
      stage("repair-note", ["cp-repair"]),
      stage("final-review", ["cp-plan", "cp-initial", "cp-arbitrate", "cp-repair"]),
      ...Array.from({ length: 17 }, (_, index) =>
        stage(`hand-off-${index + 1}`, [index === 0 ? "final-review" : `hand-off-${index}`]),
      ),
    ]
    expect(nodes).toHaveLength(26)
    const result = yield* validate(spec({ name: "four-checkpoints", nodes }))
    expect(result.valid).toBe(false)
    const gateErrors = result.errors.filter((d) => d.message.startsWith("reporting checkpoint"))
    expect(gateErrors).toHaveLength(4)
    const planGate = gateErrors.find((d) => d.message.includes('"cp-plan"'))!
    expect(planGate.message).toContain('"final-review"')
    expect(planGate.message).toContain('"plan-note"')
    expect(planGate.message).toContain("not gated")
    expect(planGate.hint).toContain('"final-review -> cp-plan"')
    expect(planGate.hint).toContain('implied via "cp-initial"')
    // cp-plan is redundant for final-review, so the only satisfiable gate is the
    // one remaining checkpoint (cp-repair); never suggest gating on cp-plan.
    expect(planGate.hint).not.toContain('gate "final-review" with condition: "cp-plan.output')
    expect(planGate.hint).toContain('gate "final-review" with condition: "cp-repair.output')
    // The leaf dependent is not redundant, so its own gate is still offered.
    expect(planGate.hint).toContain('gate "plan-note" with condition: "cp-plan.output')
    // The weakening exit must name what it costs and the blocks alternative.
    expect(planGate.hint).toContain("verdict gating for every downstream node")
    expect(planGate.hint).toContain("blocks form")
  }),
)

it.effect("validates after the named redundant edges are removed and one condition remains", () =>
  Effect.gen(function* () {
    const before = yield* validate(
      spec({
        name: "redundant-checkpoints",
        nodes: [
          checkpoint("cp-a"),
          { ...checkpoint("cp-b"), depends_on: ["cp-a"], condition: 'cp-a.output.verdict == "continue"' },
          { ...checkpoint("cp-c"), depends_on: ["cp-b"], condition: 'cp-b.output.verdict == "continue"' },
          stage("final", ["cp-a", "cp-b", "cp-c"]),
          stage("hand-off", ["final"]),
        ],
      }),
    )
    expect(before.valid).toBe(false)
    const finalGate = before.errors.find((d) => d.message.includes('"cp-a"') && d.message.includes('"final"'))!
    expect(finalGate.hint).toContain('"final -> cp-a"')
    expect(finalGate.hint).toContain('"final -> cp-b"')

    const after = yield* validate(
      spec({
        name: "redundant-checkpoints-fixed",
        nodes: [
          checkpoint("cp-a"),
          { ...checkpoint("cp-b"), depends_on: ["cp-a"], condition: 'cp-a.output.verdict == "continue"' },
          { ...checkpoint("cp-c"), depends_on: ["cp-b"], condition: 'cp-b.output.verdict == "continue"' },
          stage("final", ["cp-c"], 'cp-c.output.verdict == "ACCEPT"'),
          stage("hand-off", ["final"]),
        ],
      }),
    )
    expect(after.errors).toEqual([])
  }),
)

it.effect("does not suggest a condition when non-redundant checkpoints cannot all be gated", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "independent-checkpoints",
        nodes: [checkpoint("cp-a"), checkpoint("cp-b"), stage("final", ["cp-a", "cp-b"])],
      }),
    )
    expect(result.valid).toBe(false)
    const gate = result.errors.find((d) => d.message.includes('"cp-a"') && d.message.includes('"final"'))!
    expect(gate.hint).toContain("cannot gate all of them")
    expect(gate.hint).not.toContain('gate "final" with condition: "cp-a.output')
    expect(gate.hint).not.toContain('gate "final" with condition: "cp-b.output')
  }),
)

it.effect("warns about transitively redundant depends_on edges with the reachable path", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "redundant-edges",
        nodes: [stage("a", []), stage("b", ["a"]), stage("c", ["a", "b"]), stage("d", ["b"])],
      }),
    )
    const warning = result.warnings.find((d) => d.message.includes('"c"') && d.message.includes('"a"'))!
    expect(warning.severity).toBe("warning")
    expect(warning.message).toContain("c -> b -> a")
    expect(warning.hint).toContain('"c -> a"')
    expect(result.warnings.filter((d) => d.message.includes('"d"'))).toEqual([])
    expect(result.valid).toBe(true)
  }),
)

it.effect("keeps implicit prompt bindings executable when the checkpoint repair removes redundant edges", () =>
  Effect.gen(function* () {
    const nodes = [
      checkpoint("a"),
      { ...checkpoint("b"), depends_on: ["a"], condition: 'a.output.verdict == "continue"' },
      { ...stage("final", ["a", "b"]), prompt_template: { inline: "Compare {{a}} with {{b}}" } },
      stage("hand-off", ["final"]),
    ]
    const before = yield* validate(spec({ name: "binding-checkpoints", nodes }))
    expect(before.valid).toBe(false)
    const gate = before.errors.find((d) => d.message.includes('"a"') && d.message.includes('"final"'))!
    expect(gate.hint).toContain('"final -> a"')
    expect(gate.hint).toContain('gate "final" with condition: "b.output')
    expect(gate.hint).toContain('input_mapping {"a":"a","b":"b"}')

    // Applying only the removal and the gate loses {{a}}: the mapping repair in
    // the hint is required, not decorative.
    const removalOnly = yield* validate(
      spec({
        name: "binding-checkpoints-removal-only",
        nodes: [
          checkpoint("a"),
          { ...checkpoint("b"), depends_on: ["a"], condition: 'a.output.verdict == "continue"' },
          {
            ...stage("final", ["b"], 'b.output.verdict == "ACCEPT"'),
            prompt_template: { inline: "Compare {{a}} with {{b}}" },
          },
          stage("hand-off", ["final"]),
        ],
      }),
    )
    expect(removalOnly.errors.some((d) => d.message.includes('unbound variable "{{a}}"'))).toBe(true)

    const after = yield* validate(
      spec({
        name: "binding-checkpoints-fixed",
        nodes: [
          checkpoint("a"),
          { ...checkpoint("b"), depends_on: ["a"], condition: 'a.output.verdict == "continue"' },
          {
            ...stage("final", ["b"], 'b.output.verdict == "ACCEPT"'),
            prompt_template: { inline: "Compare {{a}} with {{b}}" },
            input_mapping: { a: "a", b: "b" },
          },
          stage("hand-off", ["final"]),
        ],
      }),
    )
    expect(after.errors).toEqual([])
  }),
)

it.effect("keeps implicit prompt bindings executable after removing a redundant edge", () =>
  Effect.gen(function* () {
    const before = yield* validate(
      spec({
        name: "redundant-prompt-bindings",
        nodes: [
          stage("a", []),
          stage("b", ["a"]),
          { ...stage("c", ["a", "b"]), prompt_template: { inline: "Compare {{a}} with {{b}}" } },
        ],
      }),
    )
    expect(before.valid).toBe(true)
    const warning = before.warnings.find((d) => d.message.includes('"c"') && d.message.includes('"a"'))!
    expect(warning.hint).toContain('"c -> a"')
    expect(warning.hint).toContain('input_mapping {"a":"a","b":"b"}')

    const removalOnly = yield* validate(
      spec({
        name: "redundant-prompt-bindings-removal-only",
        nodes: [
          stage("a", []),
          stage("b", ["a"]),
          { ...stage("c", ["b"]), prompt_template: { inline: "Compare {{a}} with {{b}}" } },
        ],
      }),
    )
    expect(removalOnly.errors.some((d) => d.message.includes('unbound variable "{{a}}"'))).toBe(true)

    const after = yield* validate(
      spec({
        name: "redundant-prompt-bindings-fixed",
        nodes: [
          stage("a", []),
          stage("b", ["a"]),
          {
            ...stage("c", ["b"]),
            prompt_template: { inline: "Compare {{a}} with {{b}}" },
            input_mapping: { a: "a", b: "b" },
          },
        ],
      }),
    )
    expect(after.errors).toEqual([])
    expect(after.warnings.filter((d) => d.message.includes('"c"'))).toEqual([])
  }),
)

it.effect("does not repeat the binding repair when a static input or explicit mapping already binds it", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "redundant-edges-explicit-bindings",
        nodes: [
          stage("a", []),
          stage("b", ["a"]),
          {
            ...stage("c", ["a", "b"]),
            prompt_template: { inline: "Use {{a}}" },
            input_mapping: { a: "a" },
          },
          {
            ...stage("d", ["a", "b"]),
            prompt_template: { inline: "Use {{a}}", input: { a: "fixed" } },
          },
        ],
      }),
    )
    expect(result.valid).toBe(true)
    for (const id of ["c", "d"]) {
      const warning = result.warnings.find(
        (warning) => warning.message.includes(`"${id}"`) && warning.message.includes('"a"'),
      )!
      expect(warning.hint).toContain(`"${id} -> a"`)
      expect(warning.hint).not.toContain("input_mapping {")
    }

    const after = yield* validate(
      spec({
        name: "redundant-edges-explicit-bindings-fixed",
        nodes: [
          stage("a", []),
          stage("b", ["a"]),
          {
            ...stage("c", ["b"]),
            prompt_template: { inline: "Use {{a}}" },
            input_mapping: { a: "a" },
          },
          {
            ...stage("d", ["b"]),
            prompt_template: { inline: "Use {{a}}", input: { a: "fixed" } },
          },
        ],
      }),
    )
    expect(after.errors).toEqual([])
  }),
)

it.effect("repairs named-template bindings when a redundant edge is removed", () =>
  Effect.gen(function* () {
    const directory = yield* projectDir({ ".opencode/dag-prompts/shared.md": "Compare {{a}} with {{b}}" })
    const before = yield* validate(
      spec({
        name: "named-template-bindings",
        nodes: [stage("a", []), stage("b", ["a"]), { ...stage("c", ["a", "b"]), prompt_template: { id: "shared" } }],
      }),
      directory,
    )
    const warning = before.warnings.find((d) => d.message.includes('"c"') && d.message.includes('"a"'))!
    expect(warning.hint).toContain('"c -> a"')
    expect(warning.hint).toContain('input_mapping {"a":"a","b":"b"}')

    // The asset content is unknown to the advisory, so removing the edge
    // without the mapping leaves {{a}} unbound once the asset is resolved.
    const removalOnly = yield* validate(
      spec({
        name: "named-template-bindings-removal-only",
        nodes: [stage("a", []), stage("b", ["a"]), { ...stage("c", ["b"]), prompt_template: { id: "shared" } }],
      }),
      directory,
    )
    expect(removalOnly.errors.some((d) => d.message.includes('unbound variable "{{a}}"'))).toBe(true)

    const repaired = yield* validate(
      spec({
        name: "named-template-bindings-fixed",
        nodes: [
          stage("a", []),
          stage("b", ["a"]),
          {
            ...stage("c", ["b"]),
            prompt_template: { id: "shared" },
            input_mapping: { a: "a", b: "b" },
          },
        ],
      }),
      directory,
    )
    expect(repaired.errors).toEqual([])

    const mapped = resolveInputMappingChecked({ a: "a", b: "b" }, (id) => ({
      found: true,
      output: id === "a" ? "A" : "B",
    }))
    if (!mapped.ok) throw new Error(mapped.error)
    const rendered = yield* renderTemplate({ id: "shared" }, directory, mapped.value)
    expect(rendered.text).toBe("Compare A with B")
  }),
)

it.effect("repairs named-template bindings in the checkpoint fix without overriding static input", () =>
  Effect.gen(function* () {
    const directory = yield* projectDir({ ".opencode/dag-prompts/shared.md": "Compare {{a}} with {{b}}" })
    const before = yield* validate(
      spec({
        name: "named-template-checkpoint",
        nodes: [
          checkpoint("a"),
          { ...checkpoint("b"), depends_on: ["a"], condition: 'a.output.verdict == "continue"' },
          { ...stage("final", ["a", "b"]), prompt_template: { id: "shared", input: { b: "fixed" } } },
          stage("hand-off", ["final"]),
        ],
      }),
      directory,
    )
    expect(before.valid).toBe(false)
    const gate = before.errors.find((d) => d.message.includes('"a"') && d.message.includes('"final"'))!
    expect(gate.hint).toContain('"final -> a"')
    expect(gate.hint).toContain('input_mapping {"a":"a"}')
    expect(gate.hint).not.toContain('"b":"b"')

    const repaired = yield* validate(
      spec({
        name: "named-template-checkpoint-fixed",
        nodes: [
          checkpoint("a"),
          { ...checkpoint("b"), depends_on: ["a"], condition: 'a.output.verdict == "continue"' },
          {
            ...stage("final", ["b"], 'b.output.verdict == "ACCEPT"'),
            prompt_template: { id: "shared", input: { b: "fixed" } },
            input_mapping: { a: "a" },
          },
          stage("hand-off", ["final"]),
        ],
      }),
      directory,
    )
    expect(repaired.errors).toEqual([])

    // Static prompt input wins over the dynamic mapping at render time, so the
    // repair must not replace it with a mapping for the same name.
    const mapped = resolveInputMappingChecked({ a: "a" }, () => ({ found: true, output: "A" }))
    if (!mapped.ok) throw new Error(mapped.error)
    const rendered = yield* renderTemplate({ id: "shared", input: { b: "fixed" } }, directory, mapped.value)
    expect(rendered.text).toBe("Compare A with fixed")
  }),
)
