import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandPlugin } from "@graphagent/core/plugin/command"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// The routing description is the only always-on DAG guidance. Detailed
// authoring, recovery, patterns, and policy text lives in the dag-* built-in
// skills (packages/graphagent/test/skill/dag-skills.test.ts).
describe("CommandPlugin routing", () => {
  it.effect("makes the default follow DAG mode instead of the model's own judgment", () =>
    Effect.sync(() => {
      const content = CommandPlugin.WorkflowContent.replace(/\s+/g, " ")
      expect(content).toContain("Whether orchestration is the default follows DAG mode")
      expect(content).toContain("the latest `dag_mode` runtime-context block reports")
      expect(content).toContain("When it is ON, substantive requests default to workflows")
      expect(content).toContain("when it is OFF, start one only when the user explicitly asks")
      expect(content).toContain("applies only to that request")
      expect(content).toContain("Choose direct execution, a `task` child, or a `workflow` DAG")
      expect(content).toContain("small edits, bounded debugging, and read-only questions")
      expect(content).toContain("coordination cost")
      expect(content).toContain("Explicit user instructions take precedence")
      // #1031 M3: the old "judge for yourself" and "file count" retreats are gone.
      expect(content).not.toContain("Promote to a DAG on your own judgment")
      expect(content).not.toContain("the user need not ask")
      expect(content).not.toContain("File count")
      expect(content).not.toContain("Risk can justify stronger verification without adding agents")
    }),
  )

  it.effect("carries the four action groups and the minimum route", () =>
    Effect.sync(() => {
      const routing = CommandPlugin.WorkflowContent
      expect(Buffer.byteLength(routing)).toBeLessThan(3_000)
      expect(routing).toContain("# Orchestration Router")
      for (const action of ["spec", "run", "inspect", "control"]) {
        expect(routing).toContain(`\`${action}\``)
      }
      expect(routing).toContain("spec_path")
      expect(routing).toContain("draft a structured `config`")
      expect(routing).toContain("smallest justified graph")
      expect(routing).toContain("checkpoints are gates")
      expect(routing).toContain("parks the workflow paused")
      expect(routing).toContain("one live DAG")
      expect(routing).toContain("`agent` tool")
      expect(routing).toContain("Direct execution:")
      expect(routing).toContain("One `task` child")
      expect(routing).toContain("One `workflow` DAG")
      expect(routing).toContain("not a task-category rule")
      expect(routing).toContain("one agent, direct work, or no DAG")
      expect(routing).toContain("A read-only request")
      expect(routing).toContain("`spec(list)`")
      expect(routing).toContain("never guess a route name")
    }),
  )

  it.effect("keeps routing self-contained instead of pointing at a removed guide action", () =>
    Effect.sync(() => {
      const routing = CommandPlugin.WorkflowContent
      expect(routing).not.toContain('guide(topic="blocks")')
      expect(routing).not.toContain("guide topic")
      expect(routing).not.toContain("# Orchestration Domains")
      expect(routing).not.toContain("```yaml")
      expect(routing).not.toContain("Verdict Disposal Contract")
      expect(routing).not.toContain("`lite` and `full`")
      expect(routing).not.toMatch(/load (?:the )?[`"']?orchestration-router/i)
      expect(routing).not.toContain("Do not discover, load, or apply an external Skill")
    }),
  )
})