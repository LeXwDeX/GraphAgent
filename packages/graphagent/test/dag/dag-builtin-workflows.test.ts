// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M9: the four stage specs the runtime ships in the builtin workflow
// scope. They are validated through the real authoring boundary (parse, strict
// decode, block compilation, portable profile), not as raw YAML, and under the
// strict review gate that a DAG-mode start fixes.

import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagBlocks } from "@/dag/blocks"
import { BUILTIN_WORKFLOWS } from "@/dag/builtin-workflows"
import { reportingCheckpoints, selectReportNode } from "@/dag/runtime/report-delivery"
import { DagValidation } from "@/dag/validation"
import { DagWorkflows } from "@/dag/workflows"
import { makeNodeRow } from "./fixtures"

const NAMES = ["stage-design", "stage-implement", "stage-review", "stage-understand"] as const

const authoring = WorkflowAuthoring.make()
const decodeStart = Schema.decodeUnknownSync(DagValidation.StartSpec, DagValidation.STRICT_PARSE_OPTIONS)

function prepare(name: string, content: string = BUILTIN_WORKFLOWS[name], gate?: "strict" | "standard") {
  return Effect.runPromise(
    authoring.prepare({
      action: "start",
      source: { kind: "yaml", source: `builtin://${name}`, content },
      profile: "portable",
      ...(gate ? { review_gate: gate } : {}),
    }),
  )
}

/** The decoded blocks-form start document of a stage spec. */
function graph(name: string) {
  const { config } = decodeStart(Bun.YAML.parse(BUILTIN_WORKFLOWS[name]))
  if (!("blocks" in config)) throw new Error(`${name} must use the blocks form`)
  return config
}

/** The single block of a kind; a spec that carries two is a different spec. */
function only(config: ReturnType<typeof graph>, kind: DagBlocks.WorkflowBlockKind) {
  const found = config.blocks.filter((block) => block.kind === kind)
  if (found.length !== 1) throw new Error(`expected exactly one ${kind} block, found ${found.length}`)
  return found[0]
}

async function compiled(name: string) {
  const result = await prepare(name, BUILTIN_WORKFLOWS[name], "strict")
  if (!result.prepared || result.prepared.action !== "start")
    throw new Error(`${name} did not prepare: ${JSON.stringify(result.errors)}`)
  return result.prepared
}

/** A start document built from a stage spec with config fields replaced. */
function patched(name: string, patch: Record<string, unknown>) {
  const spec = decodeStart(Bun.YAML.parse(BUILTIN_WORKFLOWS[name]))
  return JSON.stringify({ ...spec, config: { ...spec.config, ...patch } })
}

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)])
}

describe("builtin stage specs", () => {
  it("ships exactly the four stage specs under bare library names", () => {
    expect(Object.keys(BUILTIN_WORKFLOWS).sort()).toEqual([...NAMES])
    for (const name of NAMES) expect(DagWorkflows.isName(name)).toBe(true)
  })

  for (const name of NAMES) {
    describe(name, () => {
      it("is a blocks-form start spec named after its library entry and fixed to the strict gate", () => {
        const config = graph(name)
        expect(config.name).toBe(name)
        expect(config.review_gate).toBe("strict")
        expect(Bun.YAML.parse(BUILTIN_WORKFLOWS[name])).toMatchObject({ title: expect.stringContaining("Stage:") })
      })

      it("passes the strict gate with no errors and no warnings", async () => {
        const forced = await prepare(name, BUILTIN_WORKFLOWS[name], "strict")
        expect(forced.errors).toEqual([])
        expect(forced.warnings).toEqual([])
        expect(forced.valid).toBe(true)

        // Authored as strict: the library listing validates it the same way.
        const authored = await prepare(name)
        expect(authored.valid).toBe(true)
        expect(authored.warnings).toEqual([])
        expect(authored.prepared?.action === "start" ? authored.prepared.config.review_gate : undefined).toBe("strict")
      })

      it("pins no model on the spec or any compiled node", async () => {
        expect(keysDeep(Bun.YAML.parse(BUILTIN_WORKFLOWS[name]))).not.toContain("model")
        const prepared = await compiled(name)
        for (const node of prepared.nodes) expect(node.model).toBeUndefined()
        expect(prepared.config.node_defaults?.model).toBeUndefined()
      })

      it("keeps every reviewing, verifying, and synthesizing node on a read-only worker", async () => {
        const prepared = await compiled(name)
        for (const node of prepared.nodes) {
          if (node.block === "coding" || node.block === "prototype") continue
          expect(DagBlocks.isReadOnlyProfile(node.worker_type)).toBe(true)
        }
      })

      // A stage hands over to the parent, which reads its result before it
      // starts the next one. The delivery rule gives the parent a completion
      // turn only when a reporting checkpoint other than an ordinary delivery
      // leaf finished, or when no delivery node produced a final answer.
      it("ends with a parent turn instead of a display-only report", async () => {
        const prepared = await compiled(name)
        const finished = prepared.nodes.map((node) =>
          makeNodeRow({
            id: node.id,
            status: "completed",
            dependsOn: node.depends_on,
            wakeEligible: node.report_to_parent === true,
          }),
        )
        const needsTurn =
          reportingCheckpoints(prepared.config, finished).length > 0 ||
          selectReportNode(prepared.config, finished) === undefined
        expect(needsTurn).toBe(true)
      })
    })
  }

  describe("stage-understand", () => {
    it("maps from independent angles, synthesizes the stage artifact, and attacks it with a skeptic", async () => {
      const config = graph("stage-understand")
      const explores = config.blocks.filter((block) => block.kind === "explore")
      expect(explores.length).toBeGreaterThanOrEqual(2)
      expect(new Set(explores.map((block) => block.instruction)).size).toBe(explores.length)
      for (const block of explores) expect(block.depends_on ?? []).toEqual([])

      const synthesis = only(config, "synthesize")
      expect(synthesis.depends_on).toEqual(explores.map((block) => block.id))
      expect(config.delivery_node).toBe(synthesis.id)
      for (const section of ["ACCEPTANCE", "CONSTRAINTS", "UNKNOWNS"]) expect(synthesis.instruction).toContain(section)

      const review = only(config, "review")
      expect(review.depends_on).toEqual([synthesis.id])
      expect(review.lenses).toContain("completeness")
      expect(review.skeptics ?? 0).toBeGreaterThanOrEqual(1)
    })

    it("compiles to a read-only graph: three maps, one synthesis, two lenses, one skeptic, one decision", async () => {
      const prepared = await compiled("stage-understand")
      expect(prepared.nodes.map((node) => node.id)).toEqual([
        "code-map",
        "behavior-map",
        "risk-map",
        "understanding",
        "understanding-review--intent",
        "understanding-review--completeness",
        "understanding-review--skeptic-1",
        "understanding-review",
      ])
      expect(prepared.nodes.some((node) => DagBlocks.isWriterNode(node))).toBe(false)
      expect(prepared.config.acceptance?.map((item) => item.id)).toEqual(["AC1", "AC2", "AC3"])
    })
  })

  describe("stage-design", () => {
    it("runs independent options in parallel from one context and judges them in a single synthesis", async () => {
      const config = graph("stage-design")
      const options = config.blocks.filter((block) => block.kind === "plan")
      expect(options.length).toBeGreaterThanOrEqual(2)
      expect(new Set(options.map((block) => block.instruction)).size).toBe(options.length)
      // Anonymous labels: the node id must not reveal the stance the option was given.
      for (const block of options) expect(block.id).toMatch(/^option-[a-z]$/)
      expect(new Set(options.map((block) => (block.depends_on ?? []).join(","))).size).toBe(1)

      const judgment = only(config, "synthesize")
      expect(judgment.depends_on).toEqual(options.map((block) => block.id))
      for (const part of ["1 to 5", "anonymous", "evidence", "SELECTED", "SCORES", "REJECTED"])
        expect(judgment.instruction).toContain(part)

      // A skeptic attacks the selected design before the parent builds on it.
      const review = only(config, "review")
      expect(review.depends_on).toEqual([judgment.id])
      expect(review.lenses).toContain("completeness")
      expect(review.skeptics ?? 0).toBeGreaterThanOrEqual(1)
      expect(config.delivery_node).toBe(judgment.id)
    })

    it("compiles to a read-only graph: an auditor judges the options and a skeptic review follows", async () => {
      const prepared = await compiled("stage-design")
      expect(prepared.nodes.map((node) => [node.id, node.worker_type])).toEqual([
        ["design-context", "explore"],
        ["option-a", "plan"],
        ["option-b", "plan"],
        ["option-c", "plan"],
        ["judgment", "auditor"],
        ["design-review--intent", "auditor"],
        ["design-review--completeness", "auditor"],
        ["design-review--skeptic-1", "auditor"],
        ["design-review", "auditor"],
      ])
      expect(prepared.nodes.some((node) => DagBlocks.isWriterNode(node))).toBe(false)
      expect(prepared.config.delivery_node).toBe("judgment")
      expect(prepared.config.acceptance?.map((item) => item.id)).toEqual(["AC1", "AC2", "AC3"])
    })
  })

  describe("stage-implement", () => {
    it("runs explore, a fan-out plan, coding, verify, a strict review, and a report in order", async () => {
      const config = graph("stage-implement")
      expect(config.blocks.map((block) => [block.id, block.kind, block.depends_on ?? []])).toEqual([
        ["map", "explore", []],
        ["plan", "plan", ["map"]],
        ["coding", "coding", ["plan"]],
        ["verify", "verify", ["coding"]],
        ["review", "review", ["verify"]],
        ["report", "synthesize", ["review"]],
      ])
      expect(only(config, "coding").fan_out).toBe("plan")

      const review = only(config, "review")
      for (const lens of ["standards", "intent", "completeness"] as const) expect(review.lenses).toContain(lens)
      expect(review.skeptics ?? 0).toBeGreaterThanOrEqual(1)

      const acceptance = config.acceptance ?? []
      expect(acceptance.length).toBeGreaterThanOrEqual(1)
      expect(acceptance.length).toBeLessThanOrEqual(50)
      expect(new Set(acceptance.map((item) => item.id)).size).toBe(acceptance.length)
    })

    it("compiles to a graph whose only writer is the coding block, reviewed against its fingerprint", async () => {
      const prepared = await compiled("stage-implement")
      expect(prepared.nodes.filter((node) => DagBlocks.isWriterNode(node)).map((node) => node.id)).toEqual(["coding"])
      const decision = prepared.nodes.find((node) => node.id === "review")
      expect(decision).toMatchObject({
        required: true,
        skip_ok: false,
        review: { phase: "diff", implementation_node_id: "coding", verification_node_id: "verify" },
      })
      expect(prepared.nodes.find((node) => node.id === "report")?.condition).toBe('review.output.verdict == "ACCEPT"')
      expect(prepared.config.delivery_node).toBe("report")
    })
  })

  describe("stage-review", () => {
    it("reviews a pinned change with the completeness lens and at least two skeptics, and never fixes", async () => {
      const config = graph("stage-review")
      expect(config.blocks.map((block) => block.kind)).toEqual(["explore", "verify", "review"])
      // An unresolvable fixed point must end the review instead of reviewing something else.
      expect(only(config, "explore").required).toBe(true)
      const review = only(config, "review")
      expect(review.lenses).toContain("completeness")
      expect(review.skeptics ?? 0).toBeGreaterThanOrEqual(2)
      expect(config.blocks.some((block) => block.kind === "coding" || block.kind === "prototype")).toBe(false)
      expect((config.acceptance ?? []).length).toBeGreaterThanOrEqual(1)
    })

    it("compiles to a read-only graph whose decision is the only reporting checkpoint", async () => {
      const prepared = await compiled("stage-review")
      expect(prepared.nodes.map((node) => node.id)).toEqual([
        "pin",
        "checks",
        "review--standards",
        "review--intent",
        "review--completeness",
        "review--tests",
        "review--skeptic-1",
        "review--skeptic-2",
        "review",
      ])
      expect(prepared.nodes.some((node) => DagBlocks.isWriterNode(node))).toBe(false)
      // No delivery node on purpose: the decision, not a display-only report,
      // is what the parent acts on.
      expect(prepared.config.delivery_node).toBeUndefined()
      expect(prepared.nodes.filter((node) => node.report_to_parent === true).map((node) => node.id)).toEqual(["review"])
    })
  })

  describe("the strict gate really judges these specs", () => {
    it("rejects stage-implement without acceptance items", async () => {
      const result = await prepare("stage-implement", patched("stage-implement", { acceptance: undefined }), "strict")
      expect(result.valid).toBe(false)
      expect(result.errors.map((error) => error.message).join("\n")).toContain("config.acceptance")
    })

    it("rejects stage-review once its review drops the completeness lens", async () => {
      const original = BUILTIN_WORKFLOWS["stage-review"]
      const dropped = original.replace(
        "lenses: [standards, intent, completeness, tests]",
        "lenses: [standards, intent, tests]",
      )
      // Guard the edit: a spec that no longer carries this exact line needs the test updated.
      expect(dropped).not.toBe(original)
      const result = await prepare("stage-review", dropped, "strict")
      expect(result.valid).toBe(false)
      expect(result.errors.map((error) => error.message).join("\n")).toContain("completeness lens")
    })
  })
})
