import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandPlugin } from "@graphagent/core/plugin/command"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// The routing description is the only always-on DAG guidance. Detailed
// authoring, recovery, patterns, and policy text lives in the dag-* built-in
// skills (packages/graphagent/test/skill/dag-skills.test.ts).
describe("CommandPlugin routing", () => {
  it.effect("lets the model choose orchestration by benefit rather than task category", () =>
    Effect.sync(() => {
      const content = CommandPlugin.WorkflowContent.replace(/\s+/g, " ")
      expect(content).toContain("Choose direct execution, a `task` child, or a `workflow` DAG")
      expect(content).toContain("Small edits, bounded debugging, and read-only questions")
      expect(content).toContain("coordination cost")
      expect(content).toContain("Explicit user instructions take precedence")
      expect(content).toContain("No routing checklist is needed for routine direct work")
      expect(content).toContain("Promote to a DAG on your own judgment; the user need not ask.")
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
      expect(routing).toContain("including project source and tests")
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