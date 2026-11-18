// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR2: what the first-batch workers and the artifact catalog change in the
// DAG's block compiler, and what they leave exactly as it was.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { AgentArtifact } from "@/agent/artifact"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { NodeConfig } from "@/dag/dag"
import { DagBlocks } from "@/dag/blocks"
import { DagValidation } from "@/dag/validation"
import { obj } from "../agent/artifact-fixtures"

const compile = (blocks: DagBlocks.WorkflowBlock[], options: DagBlocks.WorkflowBlockCompileOptions = {}) =>
  DagBlocks.compileWorkflowBlocks({ objective: "Validate the cache design", blocks }, options)

const find = (nodes: NodeConfig[], id: string) => {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`Expected a node named ${id}`)
  return node
}

const def = (id: string, extra: Partial<NodeConfig> = {}): NodeConfig => ({
  id,
  name: id,
  worker_type: "build",
  depends_on: [],
  required: true,
  prompt_template: { inline: id },
  ...extra,
})

describe("explore blocks are unchanged by the artifact catalog", () => {
  it("compiles to the same nodes as before: no output_schema, no artifact in the prompt", () => {
    const nodes = compile([
      { id: "map", kind: "explore", instruction: "Locate persistence ownership" },
      { id: "deep", kind: "explore", depends_on: ["map"], report_to_parent: true },
    ])
    expect(nodes.map((node) => node.id)).toEqual(["map", "deep"])
    for (const node of nodes) {
      expect(node).not.toHaveProperty("output_schema")
      expect(node.worker_type).toBe("explore")
      expect(node.required).toBe(false)
      expect(Object.keys(node).toSorted()).toEqual([
        "block",
        "depends_on",
        "id",
        "name",
        "prompt_template",
        "report_to_parent",
        "required",
        "worker_type",
      ])
      // Nothing about a catalog artifact reaches the prompt: no contract, no type name, no envelope field.
      for (const marker of ["OUTPUT CONTRACT", "code_findings", "not_examined"]) {
        expect(node.prompt_template.inline, marker).not.toContain(marker)
      }
    }
  })

  it("keeps the other read-only blocks free of an artifact schema as well", () => {
    const nodes = compile([
      { id: "map", kind: "explore" },
      { id: "debug", kind: "debug", depends_on: ["map"] },
    ])
    expect(nodes.filter((node) => "output_schema" in node)).toEqual([])
  })
})

describe("the prototype block", () => {
  it("defaults to the prototyper and keeps its implementation output contract", () => {
    const node = find(
      compile([{ id: "experiment", kind: "prototype", instruction: "Try the LRU variant" }]),
      "experiment",
    )
    expect(node.worker_type).toBe("prototyper")
    expect(DagBlocks.defaultBlockWorker("prototype")).toBe("prototyper")
    // The writer contract is unchanged: its output is the implementation record.
    expect(node.output_schema).toEqual(DagBlocks.IMPLEMENTATION_SCHEMA)
    expect(node.block).toBe("prototype")
    // D9 (#1158 PR4a): a writer block that leaves `required` out is required.
    expect(node.required).toBe(true)
    expect(node.report_to_parent).toBe(false)
  })

  it("leaves the coding block on the build agent and honors an explicit worker", () => {
    expect(DagBlocks.defaultBlockWorker("coding")).toBe("build")
    expect(find(compile([{ id: "impl", kind: "coding" }]), "impl").worker_type).toBe("build")
    const explicit = compile([{ id: "experiment", kind: "prototype", worker_type: "build" }])
    expect(find(explicit, "experiment").worker_type).toBe("build")
  })

  it("is a writer on the prototyper, so strict coverage still demands a bound review", () => {
    expect(DagBlocks.nonWriterWorkerOverride("prototype", "prototyper")).toBeUndefined()
    expect(DagBlocks.isWriterNode(def("p", { block: "prototype", worker_type: "prototyper" }))).toBe(true)
    const strictOptions = { review_gate: "strict" as const, acceptance: [{ id: "AC1", text: "The trace replays" }] }
    expect(() => compile([{ id: "experiment", kind: "prototype" }], strictOptions)).toThrow(
      "has no downstream review gate",
    )
    expect(() =>
      compile(
        [
          { id: "experiment", kind: "prototype" },
          { id: "check", kind: "verify", depends_on: ["experiment"] },
          { id: "decision", kind: "review", depends_on: ["check"], lenses: ["standards", "completeness"] },
        ],
        strictOptions,
      ),
    ).not.toThrow()
  })

  it("feeds the verify and diff-review bindings with fields the prototype artifact carries", () => {
    const nodes = compile([
      { id: "experiment", kind: "prototype" },
      { id: "check", kind: "verify", depends_on: ["experiment"] },
      { id: "decision", kind: "review", depends_on: ["check"] },
    ])
    const decision = find(nodes, "decision")
    const bindings = Object.entries(decision.input_mapping ?? {}).filter(([, source]) =>
      source.startsWith("experiment.output."),
    )
    // The review reads the writer's changed files and fingerprint by name.
    expect(bindings).toEqual([
      ["implementation_changed_files", "experiment.output.changed_files"],
      ["implementation_fingerprint", "experiment.output.fingerprint"],
    ])
    const bound = bindings.map(([, source]) => source.split(".")[2])

    // Both fields are in the prototype artifact's body, with the shape the writer contract gives them,
    // and the artifact's summary is the writer contract's third field.
    const schema = AgentArtifact.schema("prototype")!
    const body = obj(obj(schema.properties).body)
    for (const field of bound) expect(body.required).toContain(field)
    expect(find(nodes, "experiment").output_schema).toEqual(DagBlocks.IMPLEMENTATION_SCHEMA)
    expect(DagBlocks.IMPLEMENTATION_SCHEMA.required.map(String)).toEqual(["summary", ...bound])
    expect(schema.required).toContain("summary")

    // The compiled route passes the diff-review lifecycle check as before.
    const diagnostics = DagValidation.reviewLifecycleDiagnostics({ nodes })
    expect([...diagnostics.errors, ...diagnostics.warnings]).toEqual([])
    expect(decision.review).toMatchObject({
      phase: "diff",
      implementation_node_id: "experiment",
      verification_node_id: "check",
    })
  })
})

describe("the read-only workers in the static catalogs", () => {
  it("counts the researcher and the architect as read-only profiles, like explore", () => {
    for (const worker of ["researcher", "architect", "explore"]) {
      expect(DagBlocks.isReadOnlyProfile(worker), worker).toBe(true)
      expect(DagBlocks.isWriterNode(def("n", { worker_type: worker })), worker).toBe(false)
    }
    expect(DagBlocks.isReadOnlyProfile("prototyper")).toBe(false)
    expect(DagBlocks.isWriterNode(def("n", { worker_type: "prototyper" }))).toBe(true)
    expect(DagBlocks.isWriterNode(def("n", { worker_type: "prototyper", workspace_writes: "deny" }))).toBe(false)
  })

  it("denies workspace writes to the researcher by default: it has no shell and no file tool", () => {
    expect(DagBlocks.workspaceWritesOf(undefined, "researcher")).toBe("deny")
    expect(DagBlocks.workspaceWritesOf(undefined, "prototyper")).toBe("allow")
    // The architect keeps a shell but has no file tool, so like the auditor it denies writes by default.
    expect(DagBlocks.workspaceWritesOf(undefined, "architect")).toBe("deny")
    // explore keeps a shell and still runs with writes allowed.
    expect(DagBlocks.workspaceWritesOf(undefined, "explore")).toBe("allow")
  })

  it("lets a block run on the researcher under the strict gate without a write-capable-override error", () => {
    const strictOptions = { review_gate: "strict" as const }
    expect(DagBlocks.nonWriterWorkerOverride("explore", "researcher")).toBeUndefined()
    expect(() => compile([{ id: "survey", kind: "explore", worker_type: "researcher" }], strictOptions)).not.toThrow()
    // A plan block on the architect is not an escalation either (#1158 PR6 research-to-prototype).
    expect(DagBlocks.nonWriterWorkerOverride("plan", "architect")).toBeUndefined()
    expect(() => compile([{ id: "architecture", kind: "plan", worker_type: "architect" }], strictOptions)).not.toThrow()
    // A worker that can write is still refused there.
    expect(() => compile([{ id: "survey", kind: "explore", worker_type: "prototyper" }], strictOptions)).toThrow(
      'overrides its worker to write-capable "prototyper"',
    )
  })

  it("accepts hand-written researcher and architect nodes under the strict gate, and refuses the prototyper there", async () => {
    const prepare = (worker: string) =>
      Effect.runPromise(
        WorkflowAuthoring.make().prepare({
          action: "start",
          source: {
            kind: "inline",
            value: {
              config: {
                name: "strict",
                nodes: [
                  {
                    id: "work",
                    name: "work",
                    worker_type: worker,
                    depends_on: [],
                    prompt_template: { inline: "Do it" },
                  },
                ],
                review_gate: "strict",
              },
            },
          },
          profile: "portable",
        }),
      )
    expect((await prepare("researcher")).valid).toBe(true)
    expect((await prepare("architect")).valid).toBe(true)
    const refused = await prepare("prototyper")
    expect(refused.valid).toBe(false)
    expect(refused.errors[0]?.message).toContain('node "work" is write-capable ("prototyper")')
  })
})
