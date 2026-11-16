// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1073: an extend fragment gets the same checkpoint gating as a start
// document, and a rejected nodes-form fragment comes back with a correction
// that can be applied as it stands. The tool-level cases run on a real
// database with no execution loop, so the base workflow's nodes stay `pending`
// (live) the whole time: a pending reporting checkpoint is exactly the shape
// the merged-graph gate refuses ungated dependents of.
import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagControl } from "@/dag/control"
import { parseWorkflowConfig } from "@/dag/dag"
import type { NodeConfig } from "@/dag/dag"
import { DagValidation } from "@/dag/validation"
import { renderRejection } from "@/tool/workflow/mutation"
import {
  authoring,
  cleanup,
  extend,
  failureText,
  repo,
  run,
  seed,
  start,
  validate,
  workflowID,
  writeSpec,
} from "./workflow-harness"

afterEach(cleanup)

const caller = (directory: string) => ({ session: "ses_gating", directory })

/** A base workflow whose review decision is a live (pending) reporting checkpoint. */
const reviewBase = {
  config: {
    name: "review-route",
    objective: "Map and review the module",
    blocks: [
      { id: "scan", kind: "explore" },
      { id: "decision", kind: "review", depends_on: ["scan"] },
    ],
  },
}

const verdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"] } },
}

const node = (id: string, dependsOn: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  worker_type: "general",
  depends_on: dependsOn,
  prompt_template: { inline: id },
  ...extra,
})

/** A nodes-form base workflow with one live reporting checkpoint as a leaf. */
const checkpointBase = {
  config: {
    name: "checkpoint-route",
    nodes: [node("gate", [], { report_to_parent: true, output_schema: verdictSchema })],
  },
}

const RetrySignal = Schema.Struct({
  error_code: Schema.String,
  retryable: Schema.Boolean,
  suggested_fragment: Schema.optional(
    Schema.Struct({ nodes: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
})

/** The structured retry signal a rejected mutation carries. */
function retrySignal(text: string) {
  const line = text.split("\n").find((entry) => entry.startsWith("Structured retry signal"))
  if (!line) throw new Error(`no structured retry signal in:\n${text}`)
  return Schema.decodeUnknownSync(RetrySignal)(JSON.parse(line.slice(line.indexOf("{"))))
}

const storedNodes = (id: string) =>
  Effect.gen(function* () {
    const workflow = yield* (yield* DagStore.Service).getWorkflow(id)
    return parseWorkflowConfig(workflow?.config ?? "{}")?.nodes ?? []
  })

describe("blocks-form extend gating (live review decision)", () => {
  it("gates a synthesis that depends on a pending review decision exactly as start would", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gating", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(reviewBase))).output)
        const landed = yield* extend(
          caller(dir),
          id,
          writeSpec({
            objective: "Report once the review accepts",
            blocks: [{ id: "report", kind: "synthesize", depends_on: ["decision"] }],
          }),
        )
        expect(landed.title).toBe("Workflow extended: 1 nodes added")
        const report = (yield* storedNodes(id)).find((entry) => entry.id === "report")
        expect(report?.condition).toBe('decision.output.verdict == "ACCEPT"')
        expect(report?.skip_ok).toBe(true)
        // The start path binds the accepted review for a synthesis; extend does too.
        expect(report?.input_mapping).toEqual({ decision_review: "decision.output" })
      }),
    )
  })

  it("gates every block kind that depends on the live decision, not only a synthesis", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gating", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(reviewBase))).output)
        yield* extend(
          caller(dir),
          id,
          writeSpec({
            objective: "Follow the review",
            blocks: [
              { id: "follow-up", kind: "explore", depends_on: ["decision"] },
              { id: "fix", kind: "coding", depends_on: ["decision"] },
            ],
          }),
        )
        const stored = yield* storedNodes(id)
        for (const added of ["follow-up", "fix"])
          expect(stored.find((entry) => entry.id === added)?.condition).toBe('decision.output.verdict == "ACCEPT"')
      }),
    )
  })
})

describe("live-graph aware compilation (authoring)", () => {
  const liveDecision = (terminal: boolean): { definition: NodeConfig; terminal: boolean } => ({
    terminal,
    definition: {
      id: "decision",
      name: "decision",
      worker_type: "auditor",
      depends_on: [],
      report_to_parent: true,
      block: "review",
      review_arbitration: true,
      prompt_template: { inline: "decide" },
      output_schema: verdictSchema,
    },
  })
  const liveVerification = (terminal: boolean): { definition: NodeConfig; terminal: boolean } => ({
    terminal,
    definition: {
      id: "checks",
      name: "checks",
      worker_type: "auditor",
      depends_on: [],
      report_to_parent: true,
      block: "verify",
      prompt_template: { inline: "verify" },
      output_schema: { type: "object", properties: { verdict: { type: "string", enum: ["PASS", "FAIL"] } } },
    },
  })

  const prepare = (value: unknown, live: Array<{ definition: NodeConfig; terminal: boolean }>) =>
    Effect.runPromise(
      WorkflowAuthoring.make().prepare({
        action: "extend",
        source: { kind: "inline", value, source: "<test>" },
        known_dependencies: live.map((entry) => entry.definition.id),
        live_nodes: live,
      }),
    )

  const only = (result: Awaited<ReturnType<typeof prepare>>) => {
    expect(result.errors).toEqual([])
    if (result.prepared?.action !== "extend") throw new Error("expected a prepared extend")
    return result.prepared.nodes
  }

  it("leaves a dependent of an already terminal checkpoint ungated (the reopen flow keeps working)", async () => {
    const nodes = only(
      await prepare(
        {
          objective: "Repair what the review found",
          blocks: [{ id: "fix", kind: "coding", depends_on: ["decision"] }],
        },
        [liveDecision(true)],
      ),
    )
    expect(nodes.find((entry) => entry.id === "fix")?.condition).toBeUndefined()
  })

  it("gates on PASS behind a live verification gate", async () => {
    const nodes = only(
      await prepare(
        {
          objective: "Continue after the checks",
          blocks: [{ id: "notes", kind: "synthesize", depends_on: ["checks"] }],
        },
        [liveVerification(false)],
      ),
    )
    expect(nodes.find((entry) => entry.id === "notes")?.condition).toBe('checks.output.verdict == "PASS"')
  })

  it("does not invent a gate for a live checkpoint with no verdict contract", async () => {
    const quiet = liveDecision(false)
    const result = await prepare(
      { objective: "Continue", blocks: [{ id: "next", kind: "explore", depends_on: ["decision"] }] },
      [{ ...quiet, definition: { ...quiet.definition, output_schema: undefined } }],
    )
    // The merged-graph preflight names the live checkpoint; there is nothing safe to suggest.
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((entry) => entry.message.includes('"decision"') && entry.message.includes('"next"')),
    ).toBe(true)
    expect(result.errors.every((entry) => entry.suggested_fragment === undefined)).toBe(true)
  })

  it("refuses a block that depends on two live gates with one fix", async () => {
    const result = await prepare(
      { objective: "Join", blocks: [{ id: "join", kind: "synthesize", depends_on: ["decision", "checks"] }] },
      [liveDecision(false), liveVerification(false)],
    )
    expect(result.valid).toBe(false)
    expect(result.errors.map((entry) => entry.message).join("\n")).toContain("depends on multiple review gates")
  })
})

describe("nodes-form extend: suggested_fragment", () => {
  const suggestion = (text: string) => {
    const signal = retrySignal(text)
    expect(signal.retryable).toBe(true)
    if (!signal.suggested_fragment) throw new Error("expected a suggested_fragment")
    return signal.suggested_fragment
  }

  it("answers an ungated dependent of a live checkpoint with a patch that makes the fragment valid", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gating", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(checkpointBase))).output)
        const ungated = { nodes: [node("after", ["gate"])] }
        const text = yield* failureText(extend(caller(dir), id, writeSpec(ungated)))
        expect(text).toContain("Workflow extend rejected")
        expect(text).toContain('reporting checkpoint "gate" has 1 dependent that is not gated on its output')
        const fragment = suggestion(text)
        // The live checkpoint already declares its schema, so only the dependent changes.
        expect(fragment.nodes).toEqual([{ id: "after", condition: 'gate.output.verdict == "ACCEPT"' }])

        // Applying the patch lands: the rejected extend parked the workflow, and a corrected
        // extend resumes it.
        const corrected = {
          nodes: ungated.nodes.map((entry) => ({ ...entry, ...fragment.nodes.find((patch) => patch.id === entry.id) })),
        }
        const landed = yield* extend(caller(dir), id, writeSpec(corrected))
        expect(landed.title).toBe("Workflow extended: 1 nodes added")
      }),
    )
  })

  it("answers an in-fragment checkpoint with both patches, including the missing output_schema", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gating", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(reviewBase))).output)
        const fragment = {
          nodes: [node("triage", ["scan"], { report_to_parent: true }), node("act", ["triage"], { required: true })],
        }
        const text = yield* failureText(extend(caller(dir), id, writeSpec(fragment)))
        const patches = suggestion(text).nodes
        expect(patches.find((patch) => patch.id === "triage")?.output_schema).toMatchObject({
          required: ["verdict", "summary"],
          properties: { verdict: { enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"] } },
        })
        // A required dependent that is skipped on a rejected verdict must not fail the workflow.
        expect(patches.find((patch) => patch.id === "act")).toEqual({
          id: "act",
          condition: 'triage.output.verdict == "ACCEPT"',
          skip_ok: true,
        })

        const merged = fragment.nodes.map((entry) => ({ ...entry, ...patches.find((patch) => patch.id === entry.id) }))
        const result = yield* Effect.promise(() =>
          Effect.runPromise(
            authoring.prepare({
              action: "extend",
              source: { kind: "inline", value: { nodes: merged }, source: "<fixed>" },
              known_dependencies: ["scan", "decision"],
              profile: "portable",
            }),
          ),
        )
        expect(result.errors).toEqual([])
      }),
    )
  })

  it("offers no patch when the dependent already gates on another node", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gating", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(checkpointBase))).output)
        const text = yield* failureText(
          extend(
            caller(dir),
            id,
            writeSpec({
              nodes: [
                node("other", [], { output_schema: verdictSchema }),
                node("after", ["gate", "other"], { condition: 'other.output.verdict == "ACCEPT"' }),
              ],
            }),
          ),
        )
        expect(text).toContain('reporting checkpoint "gate"')
        expect(retrySignal(text).suggested_fragment).toBeUndefined()
      }),
    )
  })
})

describe("where else the repair is offered", () => {
  it("spec validate returns the patch for an ungated checkpoint in a start document", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_gating", dir]])
        const file = writeSpec({
          config: {
            name: "ungated-start",
            nodes: [
              node("gate", [], { report_to_parent: true, output_schema: verdictSchema }),
              node("after", ["gate"]),
            ],
          },
        })
        const validation = yield* validate({ session: "ses_gating", directory: dir }, file)
        expect(validation.title).toContain("failed")
        const report = Schema.decodeUnknownSync(
          Schema.Struct({
            errors: Schema.Array(
              Schema.Struct({
                suggested_fragment: Schema.optional(Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })),
              }),
            ),
          }),
        )(JSON.parse(validation.output))
        expect(report.errors.map((error) => error.suggested_fragment?.nodes)).toEqual([
          [{ id: "after", condition: 'gate.output.verdict == "ACCEPT"' }],
        ])
      }),
    )
  })

  it("the runtime seam's own rejection renders the same retry signal", () => {
    // `Dag._replan` fails with the diagnostics of the merged-graph check; the
    // tool renders them with the signal, so a fix is offered whichever layer refuses.
    const diagnostics = DagValidation.checkpointGateDiagnostics(
      [
        node("gate", [], { report_to_parent: true, output_schema: verdictSchema }) as NodeConfig,
        node("after", ["gate"]) as NodeConfig,
      ],
      undefined,
      { requireOutputSchema: false, patchableIds: new Set(["after"]) },
    )
    const rejection = new DagControl.ControlInvalid({
      status: "paused",
      message: "Invalid workflow config: reporting checkpoint ...",
      diagnostics,
    })
    const text = renderRejection(rejection)
    expect(text).toStartWith("Invalid workflow config: reporting checkpoint ...")
    expect(retrySignal(text).suggested_fragment?.nodes).toEqual([
      { id: "after", condition: 'gate.output.verdict == "ACCEPT"' },
    ])
    // A rejection that is not a gate failure adds nothing.
    expect(
      renderRejection(new DagControl.ControlInvalid({ status: "paused", message: "other", diagnostics: [] })),
    ).toBe("other")
  })

  it("a blocks document is told about block-level choices, not about a condition it cannot write", async () => {
    const result = await Effect.runPromise(
      WorkflowAuthoring.make().prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            config: {
              name: "blocks-checkpoint",
              objective: "x",
              blocks: [
                { id: "findings", kind: "synthesize" },
                { id: "act", kind: "coding", depends_on: ["findings"] },
              ],
            },
          },
          source: "<test>",
        },
      }),
    )
    expect(result.valid).toBe(false)
    const [error] = result.errors
    expect(error.message).toContain('reporting checkpoint "findings" has 1 dependent that is not gated on its output')
    expect(error.hint).toContain("Blocks cannot carry a condition")
    expect(error.hint).toContain("Put a review block between")
    expect(error.hint).not.toContain("output_schema")
    expect(error.suggested_fragment).toBeUndefined()
  })
})

describe("blocks and nodes in one document", () => {
  const prepare = (
    action: "start" | "extend",
    value: unknown,
    live?: Array<{ definition: NodeConfig; terminal: boolean }>,
  ) =>
    Effect.runPromise(
      WorkflowAuthoring.make().prepare({
        action,
        source: { kind: "inline", value, source: "<mixed>" },
        ...(live ? { live_nodes: live } : {}),
      }),
    )

  it("reports one diagnostic with one fix instead of four union errors", async () => {
    const result = await prepare("extend", {
      objective: "Add a wave",
      blocks: [{ id: "scan-2", kind: "explore" }],
      nodes: [node("hand", [])],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    const [error] = result.errors
    expect(error.message).toBe('the graph defines both "blocks" and "nodes"; a graph has exactly one source')
    expect(error.hint).toContain('Keep "blocks" and remove "nodes"')
    expect(error.hint).toContain("a second extend")
  })

  it("keeps the form the live workflow already uses", async () => {
    const live = {
      terminal: false,
      definition: { ...node("gate", []), block: "explore" as const },
    }
    const nodesWorkflow = { terminal: false, definition: node("gate", []) }
    const mixed = { objective: "Add a wave", blocks: [{ id: "scan-2", kind: "explore" }], nodes: [node("hand", [])] }
    expect((await prepare("extend", mixed, [live])).errors[0].hint).toContain('Keep "blocks" and remove "nodes"')
    expect((await prepare("extend", mixed, [nodesWorkflow])).errors[0].hint).toContain(
      'Keep "nodes" and remove "blocks"',
    )
  })

  it("asks only for the empty key to be deleted when the other one is empty", async () => {
    const result = await prepare("start", {
      config: { name: "mixed", objective: "x", blocks: [{ id: "scan", kind: "explore" }], nodes: [] },
    })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].hint).toContain('Delete the empty "nodes" key')
  })
})
