import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { computeMergedConfig, type NodeConfig, type WorkflowConfig } from "@/dag/dag"

// ============================================================================
// computeMergedConfig tests (E3: node-def persistence)
// ============================================================================

function makeNode(id: string, overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: `Node ${id}`,
    worker_type: "build",
    depends_on: [],
    required: false,
    prompt_template: { inline: `Prompt for ${id}` },
    ...overrides,
  }
}

function makeWorkflowConfig(nodes: NodeConfig[]): WorkflowConfig {
  return { name: "test-wf", max_concurrency: 4, nodes }
}

describe("computeMergedConfig", () => {
  it("adds new nodes from fragment", () => {
    const current = makeWorkflowConfig([makeNode("a"), makeNode("b")])
    const fragment = { nodes: [makeNode("c", { prompt_template: { inline: "New prompt C" } })] }
    const merged = computeMergedConfig(current, fragment, {
      cancel: [], restart: [], replace: [], add: ["c"],
    })
    expect(merged.nodes.map((n) => n.id)).toEqual(["a", "b", "c"])
    expect(merged.nodes.find((n) => n.id === "c")?.prompt_template?.inline).toBe("New prompt C")
  })

  it("removes cancelled nodes", () => {
    const current = makeWorkflowConfig([makeNode("a"), makeNode("b")])
    const merged = computeMergedConfig(current, { nodes: [] }, {
      cancel: ["b"], restart: [], replace: [], add: [],
    })
    expect(merged.nodes.map((n) => n.id)).toEqual(["a"])
  })

  it("replaces nodes with fragment definition", () => {
    const current = makeWorkflowConfig([makeNode("a", { prompt_template: { inline: "Old" } })])
    const fragment = { nodes: [makeNode("a", { prompt_template: { inline: "New" } })] }
    const merged = computeMergedConfig(current, fragment, {
      cancel: [], restart: [], replace: ["a"], add: [],
    })
    expect(merged.nodes.find((n) => n.id === "a")?.prompt_template?.inline).toBe("New")
  })

  it("restart nodes take fragment definition", () => {
    const current = makeWorkflowConfig([makeNode("a", { prompt_template: { inline: "Old" } })])
    const fragment = { nodes: [makeNode("a", { prompt_template: { inline: "Restarted prompt" } })] }
    const merged = computeMergedConfig(current, fragment, {
      cancel: [], restart: ["a"], replace: [], add: [],
    })
    expect(merged.nodes.find((n) => n.id === "a")?.prompt_template?.inline).toBe("Restarted prompt")
  })

  it("preserves surviving nodes unchanged", () => {
    const current = makeWorkflowConfig([
      makeNode("a", { prompt_template: { inline: "Unchanged" } }),
      makeNode("b"),
    ])
    const merged = computeMergedConfig(current, { nodes: [] }, {
      cancel: ["b"], restart: [], replace: [], add: [],
    })
    expect(merged.nodes.find((n) => n.id === "a")?.prompt_template?.inline).toBe("Unchanged")
  })

  it("preserves workflow-level config (name, max_concurrency, etc.)", () => {
    const current: WorkflowConfig = {
      name: "my-workflow", max_concurrency: 8, nodes: [makeNode("a")],
    }
    const merged = computeMergedConfig(current, { nodes: [] }, {
      cancel: [], restart: [], replace: [], add: [],
    })
    expect(merged.name).toBe("my-workflow")
    expect(merged.max_concurrency).toBe(8)
  })
})

// ============================================================================
// Template fail-loud tests (E5: template resolution failure)
// ============================================================================

describe("template fail-loud (integration via resolveTemplate)", () => {
  it("resolveTemplate fails on missing template id", async () => {
    const { resolveTemplate } = await import("@/dag/templates/resolve")
    const result = await Effect.runPromiseExit(
      resolveTemplate({ id: "nonexistent-template-xyz" }, "/tmp"),
    )
    // resolveTemplate should fail (not silently return node.name)
    expect(result._tag).toBe("Failure")
  })

  it("resolveTemplate succeeds on inline template", async () => {
    const { resolveTemplate } = await import("@/dag/templates/resolve")
    const result = await Effect.runPromise(
      resolveTemplate({ inline: "Hello {{name}}", input: { name: "World" } }, "/tmp"),
    )
    expect(result).toBe("Hello World")
  })
})
