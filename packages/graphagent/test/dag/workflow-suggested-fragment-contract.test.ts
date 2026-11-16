// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1073: the contract of `suggested_fragment`. It covers only simple repairs: the
// patches edit the checkpoint and the nodes they gate, and change the meaning of
// no other node. A gate makes the gated nodes skippable, and a skipped node
// cascades to every node whose dependencies are all skipped; if one of those is
// required and not `skip_ok`, the workflow fails on the rejected branch. The
// patch is therefore offered only when every node a rejected verdict would skip
// is already optional or `skip_ok`, and otherwise the hint names the nodes the
// caller must change. The cases run the engine's own scheduler and completion
// rule on the rejected branch instead of restating them.
import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { WorkflowRuntime } from "@graphagent/core/dag/core/scheduling"
import { WorkflowAuthoring } from "@/dag/authoring"
import { requiredCompletionGaps } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { evaluateCondition } from "@/dag/runtime/eval"
import { DagValidation } from "@/dag/validation"
import { cleanup, extend, failureText, repo, run, seed, start, workflowID, writeSpec } from "./workflow-harness"

afterEach(cleanup)

const node = (id: string, dependsOn: string[], extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    worker_type: "general",
    depends_on: dependsOn,
    prompt_template: { inline: id },
    ...extra,
  }) as NodeConfig

const verdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"] } },
}

/** An optional reporting checkpoint with no output contract. */
const gate = () => node("gate", [], { report_to_parent: true })

const ACCEPT = 'gate.output.verdict == "ACCEPT"'

const gateDiagnostic = (diagnostics: readonly DagValidation.Diagnostic[]) =>
  diagnostics.find((entry) => entry.message.includes("not gated on its output"))

/** Merge the patches of every diagnostic into the nodes by id, as the retry signal tells the caller to. */
function apply(nodes: readonly NodeConfig[], diagnostics: readonly DagValidation.Diagnostic[]): NodeConfig[] {
  const patches = new Map<string, Record<string, unknown>>()
  for (const entry of diagnostics)
    for (const patch of entry.suggested_fragment?.nodes ?? [])
      patches.set(String(patch.id), { ...patches.get(String(patch.id)), ...patch })
  return nodes.map((entry) => (patches.has(entry.id) ? ({ ...entry, ...patches.get(entry.id) } as NodeConfig) : entry))
}

/**
 * The completion gaps left when the checkpoint completes with a rejecting
 * verdict. New required work is strict by default (`skip_ok: false`, as node
 * normalization does); the scheduler skips every node whose condition is false
 * and cascades to every node whose dependencies are all skipped; the
 * completion rule then judges what is left.
 */
function gapsAfterRejection(nodes: readonly NodeConfig[], rejecting: readonly string[] = ["gate"]): string[] {
  const normalized = nodes.map((entry) => {
    const required = entry.required ?? false
    return { ...entry, required, ...(required && entry.skip_ok === undefined ? { skip_ok: false } : {}) }
  })
  const scheduler = new WorkflowRuntime(
    normalized.map((entry) => ({
      id: entry.id,
      dependsOn: entry.depends_on,
      required: entry.required,
      status: "pending" as const,
    })),
    16,
  )
  const finished = new Map<string, "completed" | "skipped">()
  const outputs = new Map<string, unknown>()
  for (let round = 0; round < 50 && !scheduler.isComplete(); round++) {
    for (const id of scheduler.getCascadeSkipNodes()) {
      scheduler.markSkipped(id)
      finished.set(id, "skipped")
    }
    for (const id of scheduler.getReadyNodes()) {
      const definition = normalized.find((entry) => entry.id === id)!
      const readable = Object.fromEntries(
        definition.depends_on.filter((dep) => outputs.has(dep)).map((dep) => [dep, { output: outputs.get(dep) }]),
      )
      const verdict = evaluateCondition(definition.condition, readable)
      if (verdict.ok && !verdict.value) {
        scheduler.markSkipped(id)
        finished.set(id, "skipped")
        continue
      }
      scheduler.markSatisfied(id)
      finished.set(id, "completed")
      outputs.set(id, rejecting.includes(id) ? { verdict: "REJECT", summary: "not this way" } : "done")
    }
  }
  const config: WorkflowConfig = { name: "rejected-branch", nodes: normalized }
  return requiredCompletionGaps(
    config,
    normalized.map((entry) => ({
      id: entry.id,
      status: finished.get(entry.id) ?? "pending",
      required: entry.required,
      output: outputs.get(entry.id),
      errorReason: null,
    })),
  )
}

describe("a patch is withheld when a rejected verdict would skip a node it does not edit", () => {
  it("names the required descendant of a gated required node, and the gate alone does fail the workflow", () => {
    const nodes = [gate(), node("act", ["gate"], { required: true }), node("finish", ["act"], { required: true })]
    // What the previous round's patch did: gate and mark only the gated node. The rejected
    // verdict skips act, the skip cascades to finish, and finish was never allowed to be skipped.
    const gatedOnly = nodes.map((entry) =>
      entry.id === "act" ? ({ ...entry, condition: ACCEPT, skip_ok: true } as NodeConfig) : entry,
    )
    expect(gapsAfterRejection(gatedOnly)).toEqual([expect.stringContaining("finish")])

    const diagnostic = gateDiagnostic(DagValidation.checkpointGateDiagnostics(nodes))
    expect(diagnostic).toBeDefined()
    expect(diagnostic?.suggested_fragment).toBeUndefined()
    expect(diagnostic?.hint).toContain("`finish`")
    expect(diagnostic?.hint).toContain("skip_ok: true")
    expect(diagnostic?.hint).toContain("required: false")
  })

  it("follows the cascade through an optional node to the required one behind it", () => {
    const nodes = [
      gate(),
      node("act", ["gate"], { required: true }),
      node("mid", ["act"], { required: false }),
      node("finish", ["mid"], { required: true }),
    ]
    const diagnostic = gateDiagnostic(DagValidation.checkpointGateDiagnostics(nodes))
    expect(diagnostic?.suggested_fragment).toBeUndefined()
    expect(diagnostic?.hint).toContain("`finish`")
    expect(diagnostic?.hint).not.toContain("`mid`")
  })

  it("counts a join of two gated nodes: both are skipped, so the join cascades", () => {
    const nodes = [
      gate(),
      node("left", ["gate"]),
      node("right", ["gate"]),
      node("join", ["left", "right"], { required: true }),
    ]
    const diagnostic = gateDiagnostic(DagValidation.checkpointGateDiagnostics(nodes))
    expect(diagnostic?.suggested_fragment).toBeUndefined()
    expect(diagnostic?.hint).toContain("`join`")
  })

  it("leaves a deliberate skip_ok: false on a gated node to the caller", () => {
    const nodes = [gate(), node("act", ["gate"], { required: true, skip_ok: false })]
    const diagnostic = gateDiagnostic(DagValidation.checkpointGateDiagnostics(nodes))
    expect(diagnostic?.suggested_fragment).toBeUndefined()
    expect(diagnostic?.hint).toContain("`act`")
  })

  // The patches of every checkpoint are applied together, and each checkpoint may
  // reject. Each repair looks safe on its own here, because the join still has a
  // dependency that runs; with both rejecting, the join has none.
  it("judges all the checkpoints together: two rejections can skip a join each repair alone leaves running", () => {
    const nodes = [
      gate(),
      node("gate2", [], { report_to_parent: true }),
      node("x", ["gate"]),
      node("y", ["gate2"]),
      node("z", ["x", "y"], { required: true }),
    ]
    const diagnostics = DagValidation.checkpointGateDiagnostics(nodes).filter((entry) =>
      entry.message.includes("not gated on its output"),
    )
    expect(diagnostics).toHaveLength(2)
    for (const entry of diagnostics) {
      expect(entry.suggested_fragment).toBeUndefined()
      expect(entry.hint).toContain("`z`")
    }
    // The gating each repair would have added, applied together, and both checkpoints rejecting.
    const gated = nodes.map((entry) =>
      entry.id === "x"
        ? ({ ...entry, condition: ACCEPT } as NodeConfig)
        : entry.id === "y"
          ? ({ ...entry, condition: 'gate2.output.verdict == "ACCEPT"' } as NodeConfig)
          : entry,
    )
    expect(gapsAfterRejection(gated, ["gate", "gate2"])).toEqual([expect.stringContaining("z")])
  })

  it("names only what the repair makes fail: a skip hazard already in the fragment is not charged to it", () => {
    const declared = () => node("gate", [], { report_to_parent: true, output_schema: verdictSchema })
    // `ok` is required, not skip_ok, and gated: a rejection already skips it, with or without the repair.
    const existing = node("ok", ["gate"], { required: true, condition: 'gate.output.verdict == "REVISE"' })
    const alone = [declared(), existing, node("loose", ["gate"], { required: false })]
    expect(gateDiagnostic(DagValidation.checkpointGateDiagnostics(alone))?.suggested_fragment?.nodes).toEqual([
      { id: "loose", condition: ACCEPT },
    ])

    // Once `loose` can be skipped too, `final` has no dependency left that runs: that is the repair's doing.
    const joined = [...alone, node("final", ["ok", "loose"], { required: true })]
    const diagnostic = gateDiagnostic(DagValidation.checkpointGateDiagnostics(joined))
    expect(diagnostic?.suggested_fragment).toBeUndefined()
    expect(diagnostic?.hint).toContain("`final`")
    expect(diagnostic?.hint).not.toContain("`ok`")
  })

  it("applies the same contract to a fragment that follows a live checkpoint", async () => {
    const live = {
      terminal: false,
      definition: node("gate", [], { report_to_parent: true, output_schema: verdictSchema }),
    }
    const prepare = (nodes: unknown[]) =>
      Effect.runPromise(
        WorkflowAuthoring.make().prepare({
          action: "extend",
          source: { kind: "inline", value: { nodes }, source: "<t>" },
          known_dependencies: ["gate"],
          live_nodes: [live],
        }),
      )
    const chain = await prepare([
      node("act", ["gate"], { required: true }),
      node("finish", ["act"], { required: true }),
    ])
    const withheld = gateDiagnostic(chain.errors)
    expect(withheld?.suggested_fragment).toBeUndefined()
    expect(withheld?.hint).toContain("`finish`")

    const optional = await prepare([
      node("act", ["gate"], { required: true }),
      node("finish", ["act"], { required: false }),
    ])
    expect(gateDiagnostic(optional.errors)?.suggested_fragment?.nodes).toEqual([
      { id: "act", condition: ACCEPT, skip_ok: true },
    ])
  })
})

describe("a patch that is offered leaves the rejected branch completable", () => {
  const simple: Array<[string, NodeConfig[]]> = [
    ["a gated leaf", [gate(), node("act", ["gate"], { required: true })]],
    [
      "a descendant that is optional",
      [gate(), node("act", ["gate"], { required: true }), node("finish", ["act"], { required: false })],
    ],
    [
      "a descendant that is already skip_ok",
      [gate(), node("act", ["gate"], { required: true }), node("finish", ["act"], { required: true, skip_ok: true })],
    ],
    [
      "a chain of optional and skip_ok descendants",
      [
        gate(),
        node("act", ["gate"], { required: true }),
        node("mid", ["act"], { required: false }),
        node("finish", ["mid"], { required: true, skip_ok: true }),
      ],
    ],
    [
      // finish also waits on a node the rejected verdict does not skip, so it runs on a placeholder input.
      "a descendant with a fan-in the rejection does not skip",
      [
        gate(),
        node("act", ["gate"], { required: true }),
        node("other", [], { required: true }),
        node("finish", ["act", "other"], { required: true }),
      ],
    ],
  ]

  for (const [name, nodes] of simple) {
    it(`${name}: the patch resolves the gate and the rejected branch has no completion gap`, () => {
      const diagnostics = DagValidation.checkpointGateDiagnostics(nodes)
      const patched = apply(nodes, diagnostics)
      expect(gateDiagnostic(diagnostics)?.suggested_fragment, "the patch is offered").toBeDefined()
      expect(DagValidation.checkpointGateDiagnostics(patched)).toEqual([])
      expect(gapsAfterRejection(patched)).toEqual([])
    })
  }

  it("also holds with a verdict contract the checkpoint already declares", () => {
    const nodes = [
      node("gate", [], { report_to_parent: true, output_schema: verdictSchema }),
      node("act", ["gate"], { required: true }),
      node("finish", ["act"], { required: false }),
    ]
    const diagnostics = DagValidation.checkpointGateDiagnostics(nodes)
    const patched = apply(nodes, diagnostics)
    expect(gateDiagnostic(diagnostics)?.suggested_fragment?.nodes.map((patch) => patch.id)).toEqual(["act"])
    expect(DagValidation.checkpointGateDiagnostics(patched)).toEqual([])
    expect(gapsAfterRejection(patched)).toEqual([])
  })

  it("never edits a node outside the checkpoint and the nodes it gates", () => {
    for (const [, nodes] of simple) {
      const diagnostics = DagValidation.checkpointGateDiagnostics(nodes)
      const gated = new Set(nodes.filter((entry) => entry.depends_on.includes("gate")).map((entry) => entry.id))
      for (const patch of diagnostics.flatMap((entry) => entry.suggested_fragment?.nodes ?? []))
        expect(gated.has(String(patch.id)) || patch.id === "gate", String(patch.id)).toBe(true)
    }
  })
})

describe("the contract at the tool", () => {
  const base = {
    config: {
      name: "checkpoint-route",
      nodes: [node("gate", [], { report_to_parent: true, output_schema: verdictSchema })],
    },
  }
  const Signal = Schema.Struct({
    error_code: Schema.String,
    suggested_fragment: Schema.optional(Schema.Unknown),
  })

  it("rejects the chain without a patch, says so, and accepts the fragment the hint describes", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_contract", dir]])
        const caller = { session: "ses_contract", directory: dir }
        const id = workflowID((yield* start(caller, writeSpec(base))).output)
        const chain = {
          nodes: [node("act", ["gate"], { required: true }), node("finish", ["act"], { required: true })],
        }
        const text = yield* failureText(extend(caller, id, writeSpec(chain)))
        expect(text).toContain("Structured retry signal (no mechanical fix applies")
        expect(text).toContain("`finish`")
        const line = text.split("\n").find((entry) => entry.startsWith("Structured retry signal"))!
        expect(
          Schema.decodeUnknownSync(Signal)(JSON.parse(line.slice(line.indexOf("{")))).suggested_fragment,
        ).toBeUndefined()

        // The caller does what the hint says: finish may be skipped, and act is gated.
        const fixed = {
          nodes: [
            node("act", ["gate"], { required: true, skip_ok: true, condition: ACCEPT }),
            node("finish", ["act"], { required: true, skip_ok: true }),
          ],
        }
        expect((yield* extend(caller, id, writeSpec(fixed))).title).toBe("Workflow extended: 2 nodes added")
      }),
    )
  })
})
