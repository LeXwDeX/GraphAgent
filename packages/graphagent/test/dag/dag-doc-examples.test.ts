// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1560, #1567: DAG mode starts every workflow under the strict review gate, so
// the start-file examples that the user guide and the dag-auto, dag-blocks and
// dag-patterns skills hand to a model must pass under it as well as as authored.
// The cases parse every YAML fence of each text, keep the ones that are start
// documents (a top-level `config`), and validate each under both gates, so an
// example that only a standard start would accept fails here instead of in a
// DAG-mode session.
// #1582: a live extend or replan fragment is checked against the workflow's frozen gate, which DAG mode fixes to
// strict, so the dag-blocks fragment examples are validated under it as well. `authoring.prepare` runs no structural
// validation for a non-start action, so the review lifecycle that Dag.replan re-runs on the merged graph (a diff
// review must feed a required final gate) is applied to the prepared nodes here.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagValidation } from "@/dag/validation"
import { BUILTIN_SKILLS } from "@/skill/builtin"
import { isRecord } from "@/util/record"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const guide = await Bun.file(path.resolve(import.meta.dir, "../../../../docs/dag-workflows.md")).text()
const skill = (name: string) => BUILTIN_SKILLS.find((item) => item.name === name)?.content ?? ""

/** The start documents among one markdown text's YAML fences, named by `config.name`. */
const startExamples = (markdown: string) =>
  [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].flatMap((match) => {
    const content = match[1]
    const value: unknown = Bun.YAML.parse(content)
    return isRecord(value) && isRecord(value.config) ? [{ name: String(value.config.name), content }] : []
  })

const authoring = WorkflowAuthoring.make()

const judge = (content: string, gate: "authored" | "strict") =>
  authoring.prepare({
    action: "start",
    source: { kind: "yaml", source: "example.yaml", content },
    profile: "portable",
    // An example that declares inputs is judged with samples, like a template.
    template: { kind: "sample" },
    ...(gate === "strict" ? { review_gate: "strict" as const } : {}),
  })

describe.each([
  ["docs/dag-workflows.md", guide],
  ["the dag-auto skill", skill("dag-auto")],
  ["the dag-blocks skill", skill("dag-blocks")],
  ["the dag-patterns skill", skill("dag-patterns")],
])("start examples in %s", (_name, markdown) => {
  const examples = startExamples(markdown)

  test("has at least one start example to check", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  for (const gate of ["authored", "strict"] as const) {
    it.effect(`passes validation under the ${gate} gate`, () =>
      Effect.gen(function* () {
        const failures: string[] = []
        for (const { name, content } of examples) {
          const result = yield* judge(content, gate)
          failures.push(...result.errors.map((error) => `${name} ${error.path}: ${error.message}`))
        }
        expect(failures).toEqual([])
      }),
    )
  }
})

/** The YAML fences under one `###` heading of a markdown text, up to the next heading. */
const sectionExamples = (markdown: string, heading: string) => {
  const from = markdown.indexOf(`### ${heading}`)
  if (from === -1) return []
  const rest = markdown.slice(from + 1)
  const next = rest.search(/\n#{2,3} /)
  const section = next === -1 ? rest : rest.slice(0, next)
  return [...section.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")
}

describe.each([
  ["extend", "Extend file"],
  ["replan", "Replan file"],
] as const)("%s examples in the dag-blocks skill", (action, heading) => {
  const examples = sectionExamples(skill("dag-blocks"), heading)

  test("has at least one fragment example to check", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  it.effect("passes validation and the review lifecycle under the strict gate", () =>
    Effect.gen(function* () {
      const failures: string[] = []
      for (const content of examples) {
        const result = yield* authoring.prepare({
          action,
          source: { kind: "yaml", source: `${action}.yaml`, content },
          profile: "portable",
          review_gate: "strict",
          acceptance: [{ id: "AC1", text: "sample" }],
        })
        failures.push(...result.errors.map((error) => `${action} ${error.path}: ${error.message}`))
        if (!result.prepared) {
          failures.push(`${action}: the example produced no prepared graph`)
          continue
        }
        const lifecycle = DagValidation.reviewLifecycleDiagnostics({
          review_gate: "strict",
          nodes: result.prepared.nodes,
        })
        failures.push(...lifecycle.errors.map((error) => `${action} ${error.path}: ${error.message}`))
      }
      expect(failures).toEqual([])
    }),
  )
})
