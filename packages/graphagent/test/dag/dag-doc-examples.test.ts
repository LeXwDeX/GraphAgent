// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1560, #1567: DAG mode starts every workflow under the strict review gate, so
// the start-file examples that the user guide and the dag-auto, dag-blocks and
// dag-patterns skills hand to a model must pass under it as well as as authored.
// The cases parse every YAML fence of each text, keep the ones that are start
// documents (a top-level `config`), and validate each under both gates, so an
// example that only a standard start would accept fails here instead of in a
// DAG-mode session.
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import { BUILTIN_SKILLS } from "@/skill/builtin"
import { isRecord } from "@/util/record"

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
  Effect.runPromise(
    authoring.prepare({
      action: "start",
      source: { kind: "yaml", source: "example.yaml", content },
      profile: "portable",
      // An example that declares inputs is judged with samples, like a template.
      template: { kind: "sample" },
      ...(gate === "strict" ? { review_gate: "strict" as const } : {}),
    }),
  )

describe.each([
  ["docs/dag-workflows.md", guide],
  ["the dag-auto skill", skill("dag-auto")],
  ["the dag-blocks skill", skill("dag-blocks")],
  ["the dag-patterns skill", skill("dag-patterns")],
])("start examples in %s", (_name, markdown) => {
  const examples = startExamples(markdown)

  it("has at least one start example to check", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  for (const gate of ["authored", "strict"] as const) {
    it(`passes validation under the ${gate} gate`, async () => {
      const failures: string[] = []
      for (const { name, content } of examples) {
        const result = await judge(content, gate)
        failures.push(...result.errors.map((error) => `${name} ${error.path}: ${error.message}`))
      }
      expect(failures).toEqual([])
    })
  }
})
