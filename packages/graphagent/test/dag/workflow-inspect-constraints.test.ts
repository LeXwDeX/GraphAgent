// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1073: `inspect status` states the constraints a later extend runs into, so
// the parent does not learn them from a rejection: how many nodes the workflow
// may still add, whether it is already terminal, and whether its graph came
// from blocks or from hand-written nodes.
import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { cleanup, control, extend, repo, run, seed, start, status, workflowID, writeSpec } from "./workflow-harness"

afterEach(cleanup)

const caller = (directory: string) => ({ session: "ses_inspect", directory })

const Status = Schema.Struct({
  constraints: Schema.Struct({
    terminal: Schema.Boolean,
    graph_form: Schema.Literals(["blocks", "nodes", "mixed"]),
    nodes: Schema.Struct({ used: Schema.Number, limit: Schema.Number, remaining: Schema.Number }),
    extend: Schema.optional(Schema.String),
  }),
})

const constraints = (text: string) => Schema.decodeUnknownSync(Status)(JSON.parse(text)).constraints

const blocksSpec = (extra: Record<string, unknown> = {}) => ({
  config: {
    name: "review-route",
    objective: "Map and review the module",
    blocks: [
      { id: "scan", kind: "explore" },
      { id: "decision", kind: "review", depends_on: ["scan"] },
    ],
    ...extra,
  },
})

const nodesSpec = {
  config: {
    name: "hand-route",
    nodes: [
      { id: "a", name: "a", worker_type: "general", depends_on: [], prompt_template: { inline: "a" } },
      { id: "b", name: "b", worker_type: "general", depends_on: ["a"], prompt_template: { inline: "b" } },
    ],
  },
}

describe("inspect status constraints", () => {
  it("reports the node quota, the live state, and the blocks form", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_inspect", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(blocksSpec()))).output)
        // scan + two review lanes + the decision.
        expect(constraints((yield* status(caller(dir), id)).output)).toEqual({
          terminal: false,
          graph_form: "blocks",
          nodes: { used: 4, limit: 100, remaining: 96 },
        })
      }),
    )
  })

  it("applies the lower of the declared cap and the default ceiling, and counts every added node", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_inspect", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(blocksSpec({ max_total_nodes: 6 })))).output)
        expect(constraints((yield* status(caller(dir), id)).output).nodes).toEqual({ used: 4, limit: 6, remaining: 2 })
        yield* extend(
          caller(dir),
          id,
          writeSpec({ objective: "One more look", blocks: [{ id: "scan-2", kind: "explore" }] }),
        )
        expect(constraints((yield* status(caller(dir), id)).output).nodes).toEqual({ used: 5, limit: 6, remaining: 1 })
      }),
    )
  })

  it("never reports a limit above the user's own cap, and a workflow's lower cap still wins", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_inspect", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(blocksSpec()))).output)
        expect(constraints((yield* status(caller(dir), id, 5)).output).nodes).toEqual({
          used: 4,
          limit: 5,
          remaining: 1,
        })
        const tighter = workflowID((yield* start(caller(dir), writeSpec(blocksSpec({ max_total_nodes: 6 })))).output)
        expect(constraints((yield* status(caller(dir), tighter, 50)).output).nodes).toEqual({
          used: 4,
          limit: 6,
          remaining: 2,
        })
        // A cap below what is already registered leaves nothing, never a negative quota.
        expect(constraints((yield* status(caller(dir), id, 3)).output).nodes).toEqual({
          used: 4,
          limit: 3,
          remaining: 0,
        })
      }),
    )
  })

  it("says nodes for a hand-written graph and mixed once the other form is added", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_inspect", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(nodesSpec))).output)
        expect(constraints((yield* status(caller(dir), id)).output).graph_form).toBe("nodes")
        yield* extend(
          caller(dir),
          id,
          writeSpec({ objective: "Add a block", blocks: [{ id: "scan", kind: "explore", depends_on: ["b"] }] }),
        )
        expect(constraints((yield* status(caller(dir), id)).output).graph_form).toBe("mixed")
      }),
    )
  })

  it("marks a terminal workflow and tells the parent how extend treats it", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_inspect", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(blocksSpec()))).output)
        yield* control(caller(dir), id, "cancel")
        const view = constraints((yield* status(caller(dir), id)).output)
        expect(view.terminal).toBe(true)
        expect(view.extend).toContain("control(recover)")
        expect(view.extend).toContain("resume_cancelled")
      }),
    )
  })

  it("leaves the extend note out while the workflow can still take work", async () => {
    const dir = repo()
    await run(
      Effect.gen(function* () {
        yield* seed([["ses_inspect", dir]])
        const id = workflowID((yield* start(caller(dir), writeSpec(blocksSpec()))).output)
        expect(constraints((yield* status(caller(dir), id)).output).extend).toBeUndefined()
      }),
    )
  })
})
