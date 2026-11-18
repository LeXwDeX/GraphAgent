// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the agent catalog and the config service are narrow stand-ins.
// #1158 PR3b-1: the admission seam's step, over a real Dag service and database. A workflow is created
// from a compiled compose block (compiled directly, without the authoring check, as in compose-persistence.test.ts),
// its split node is settled by hand, and `DagComposeExpansion.expand` is what the scheduler calls for the
// slot. The loop around it is covered by dag-compose-runtime.test.ts.
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { Dag, type NodeConfig, parseWorkflowConfig } from "@/dag/dag"
import { DagComposeExpansion } from "@/dag/runtime/compose-expansion"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { agent, agents, catalog, compose } from "./compose-fixtures"
import { testEffect } from "../lib/effect"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
  DagTransact.defaultLayer,
)
const dagLayer = Layer.provideMerge(Dag.layer, testLayer)
const it = testEffect(dagLayer)

const setupFKs = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make("ses_compose_expansion"),
        project_id: Project.ID.global,
        slug: "compose-expansion",
        directory: "/project",
        title: "compose expansion",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

/** A compose block `survey` (by the fan-out `surveyor`, unless `worker` says otherwise), and a node `report` that reads it. */
const route = (
  survey: Partial<ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]> = {},
  upstream = false,
  worker = "surveyor",
): NodeConfig[] => [
  ...DagCompose.compileNodes(
    DagBlocks.compileWorkflowBlocks({
      objective: "Compare three session persistence designs",
      blocks: [
        ...(upstream ? [new DagBlocks.WorkflowBlock({ id: "map", kind: "explore" })] : []),
        new DagBlocks.WorkflowBlock({
          id: "survey",
          kind: "compose",
          worker_type: worker,
          instruction: "Compare the designs",
          ...(upstream ? { depends_on: ["map"] } : {}),
          ...survey,
        }),
      ],
    }),
    catalog(),
    DagCompose.DEFAULT_LIMITS,
  ).nodes,
  {
    id: "report",
    name: "report",
    worker_type: "explore",
    depends_on: ["survey"],
    required: true,
    prompt_template: { inline: "Report on {{survey}}" },
  },
]

const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent,
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: unknown[]) => ({ rationale: "split by source", items, not_planned: [] })

const DEADLINE = () => Date.now() + 600_000

interface Setup {
  /** The composer of the block: the fan-out `surveyor`, or the recursive `mapper` whose items can be split again. */
  readonly composer?: string
  readonly maxTotalNodes?: number
  /** A block `map` that the compose block reads, settled before the split node runs. */
  readonly upstream?: boolean
  readonly reviewGate?: "standard" | "strict"
  readonly survey?: Parameters<typeof route>[0]
  readonly agents?: DagCompose.CatalogAgent[]
  readonly globalDag?: Record<string, unknown>
  /** Changes the slot the scheduler hands to the expansion, as a replan of the pending slot could. */
  readonly patchSlot?: (slot: NodeConfig) => NodeConfig
  /** Nodes of the author's own, beside the block. */
  readonly extraNodes?: NodeConfig[]
  /** How the split node settles: the plan it completed with, or a failure. */
  readonly split: { readonly plan: unknown } | { readonly failed: string }
}

/** Creates the workflow, settles the split node, and hands the test everything the scheduler would read. */
const scenario = (setup: Setup) =>
  Effect.gen(function* () {
    yield* setupFKs()
    const dag = yield* Dag.Service
    const dagID = yield* dag
      .create({
        projectID: Project.ID.global,
        sessionID: "ses_compose_expansion",
        title: "compose expansion",
        config: {
          name: "compose-expansion",
          ...(setup.maxTotalNodes !== undefined ? { max_total_nodes: setup.maxTotalNodes } : {}),
          ...(setup.reviewGate !== undefined ? { review_gate: setup.reviewGate } : {}),
          nodes: [...route(setup.survey, setup.upstream, setup.composer), ...(setup.extraNodes ?? [])],
        },
      })
      .pipe(Effect.orDie)
    if (setup.upstream) {
      yield* dag.nodeQueued(dagID, "map", DEADLINE())
      yield* dag.nodeStarted(dagID, "map", "ses_map", DEADLINE())
      yield* dag.nodeCompleted(dagID, "map", "the map")
    }
    yield* dag.nodeQueued(dagID, "survey--split", DEADLINE())
    yield* dag.nodeStarted(dagID, "survey--split", "ses_split", DEADLINE())
    if ("plan" in setup.split) yield* dag.nodeCompleted(dagID, "survey--split", JSON.stringify(setup.split.plan))
    else yield* dag.nodeFailed(dagID, "survey--split", setup.split.failed, "exec_failed")

    const read = Effect.gen(function* () {
      const workflow = yield* dag.store.getWorkflow(dagID)
      const rows = yield* dag.store.getNodes(dagID)
      const config = parseWorkflowConfig(workflow?.config ?? "")
      const row = rows.find((candidate) => candidate.id === "survey")
      return { workflow, rows, config, row }
    })
    // `slotID` is the slot as a recovery renamed it; the block's own id otherwise.
    const expand = (port: Pick<Dag.Interface, "extend" | "nodeFailed"> = dag, slotID = "survey") =>
      Effect.gen(function* () {
        const { workflow, rows, config } = yield* read
        const slot = config?.nodes.find((candidate) => candidate.id === slotID)
        const row = rows.find((candidate) => candidate.id === slotID)
        if (!slot || !row || !workflow) throw new Error("the slot is gone")
        yield* DagComposeExpansion.expand({
          port,
          agents: { list: () => Effect.succeed((setup.agents ?? agents()) as never) },
          dagID,
          slot: setup.patchSlot ? setup.patchSlot(slot) : slot,
          nodes: rows,
          graph: config?.nodes ?? [],
          attempt: { replanAttempts: row.replanAttempts, nodeSeq: row.seq, graphRev: workflow.graphRev },
        }).pipe(
          Effect.provideService(Config.Service, {
            dagGlobal: () => Effect.succeed(setup.globalDag ?? {}),
          } as never),
        )
      })
    return { dag, dagID, read, expand }
  })

const byID = (nodes: readonly NodeConfig[] | undefined) => new Map((nodes ?? []).map((node) => [node.id, node]))

describe("expanding a slot through Dag.extend", () => {
  it.live("replaces the slot with the join node and adds one pending child per item, all in one write", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("code", "explore"), item("security", "auditor")]) },
      })
      yield* expand()
      const { rows, config } = yield* read
      const nodes = byID(config?.nodes)
      // Children, the join node under the slot's id, and what was there before.
      expect([...nodes.keys()].sort()).toEqual(
        ["report", "survey", "survey--code", "survey--official", "survey--security", "survey--split"].sort(),
      )
      expect(nodes.get("survey")).toMatchObject({
        depends_on: ["survey--official", "survey--code", "survey--security"],
        worker_type: "surveyor",
        workspace_writes: "deny",
      })
      expect(nodes.get("survey")?.expand).toBeUndefined()
      expect(nodes.get("survey")?.join?.items.map((entry) => entry.node)).toEqual([
        "survey--official",
        "survey--code",
        "survey--security",
      ])
      for (const id of ["survey--official", "survey--code", "survey--security"])
        expect(nodes.get(id)).toMatchObject({
          depends_on: ["survey--split"],
          workspace_writes: "deny",
          report_to_parent: false,
          // The persisted definition names the slot that generated the child, which is what a node view reads.
          expanded_from: "survey",
        })
      // The nodes the author wrote name none, the join node the slot became included.
      for (const id of ["report", "survey", "survey--split"]) expect(nodes.get(id)?.expanded_from, id).toBeUndefined()
      // The downstream binding was never touched.
      expect(nodes.get("report")?.depends_on).toEqual(["survey"])
      // The rows agree with the config, and nothing but the three children is new.
      const byRow = new Map(rows.map((row) => [row.id, row]))
      expect(rows).toHaveLength(6)
      expect(byRow.get("survey")).toMatchObject({
        status: "pending",
        dependsOn: ["survey--official", "survey--code", "survey--security"],
      })
      expect(byRow.get("survey--official")).toMatchObject({
        status: "pending",
        dependsOn: ["survey--split"],
        workerType: "researcher",
      })
      expect(byRow.get("report")?.dependsOn).toEqual(["survey"])
    }),
  )

  it.live("keeps the block's own inputs readable by the join node, which the merged graph checks for ordering", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({ upstream: true, split: { plan: plan([item("a", "explore")]) } })
      yield* expand()
      const nodes = byID((yield* read).config?.nodes)
      // `map` is upstream of the split node, so it is upstream of every child and of the join node.
      expect(nodes.get("survey")?.input_mapping).toEqual({
        map: "map",
        "survey--split": "survey--split",
        "survey--a": "survey--a",
      })
      expect(nodes.get("survey--a")?.depends_on).toEqual(["survey--split"])
      expect(nodes.get("survey--split")?.depends_on).toEqual(["map"])
    }),
  )

  it.live("lets the fallback worker read what the block read, in a graph that checks the same ordering", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({ upstream: true, split: { plan: plan([]) } })
      yield* expand()
      const nodes = byID((yield* read).config?.nodes)
      expect(nodes.get("survey--fallback")?.input_mapping).toEqual({ map: "map" })
      expect(nodes.get("survey")?.input_mapping).toEqual({
        map: "map",
        "survey--split": "survey--split",
        "survey--fallback": "survey--fallback",
      })
    }),
  )

  it.live("passes the merged graph's strict review gate: composed children are not writers", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        reviewGate: "strict",
        split: { plan: plan([item("official", "researcher"), item("code", "explore"), item("security", "auditor")]) },
      })
      yield* expand()
      const { config, rows } = yield* read
      expect(config?.review_gate).toBe("strict")
      expect(byID(config?.nodes).get("survey")?.expand).toBeUndefined()
      expect(rows).toHaveLength(6)
    }),
  )

  it.live("settles a plan that was read before a crash the same way: the same ids, no duplicate nodes", () =>
    Effect.gen(function* () {
      const { dag, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
      })
      // The process dies after reading the plan and before the extend commits: nothing is written.
      const crashing = {
        extend: () => Effect.die(new Error("process died before the extend committed")),
        nodeFailed: dag.nodeFailed,
      }
      const first = yield* Effect.exit(expand(crashing))
      expect(Exit.isFailure(first)).toBe(true)
      const before = yield* read
      expect(before.rows.map((row) => row.id).sort()).toEqual(["report", "survey", "survey--split"])
      const slot = before.config?.nodes.find((node) => node.id === "survey")
      expect(slot?.expand).toBe("survey--split")

      // What the next round plans from that persisted state is what it then writes.
      const composer = DagCompose.resolve(catalog(), "surveyor")
      if (!slot || !composer.available) throw new Error("no slot or composer")
      const planned = DagCompose.planExpansion({
        slot,
        composer: composer.composer,
        limits: DagCompose.DEFAULT_LIMITS,
        source: before.rows.find((row) => row.id === "survey--split"),
        existingNodeIDs: new Set(before.rows.map((row) => row.id)),
      })
      yield* expand()
      const after = yield* read
      expect(planned.nodes.map((node) => node.id)).toEqual(["survey--official", "survey--code", "survey"])
      expect(after.rows.map((row) => row.id).sort()).toEqual(
        ["report", "survey", "survey--code", "survey--official", "survey--split"].sort(),
      )
      expect(after.config?.nodes.find((node) => node.id === "survey")).toMatchObject({
        depends_on: ["survey--official", "survey--code"],
        join: planned.nodes.at(-1)?.join,
      })
    }),
  )

  it.live("does nothing for a round that planned against a slot that has since been reshaped", () =>
    Effect.gen(function* () {
      const { dag, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
      })
      const before = yield* read
      yield* expand()
      const committed = yield* read
      // The same attempt again, as a round that read the graph before the first one committed: the graph has
      // moved on, so the extend is refused as stale, and nothing is added, replaced or failed.
      const row = before.row
      const slot = before.config?.nodes.find((node) => node.id === "survey")
      if (!row || !slot || !before.workflow) throw new Error("the slot is gone")
      yield* DagComposeExpansion.expand({
        port: dag,
        agents: { list: () => Effect.succeed(agents() as never) },
        dagID: before.workflow.id,
        slot,
        nodes: before.rows,
        graph: before.config?.nodes ?? [],
        attempt: { replanAttempts: row.replanAttempts, nodeSeq: row.seq, graphRev: before.workflow.graphRev },
      })
      const after = yield* read
      expect(after.rows.map((node) => [node.id, node.status])).toEqual(
        committed.rows.map((node) => [node.id, node.status]),
      )
      expect(after.config).toEqual(committed.config)
    }),
  )
})

describe("degrading when the plan cannot be expanded", () => {
  const fallbackOnly = (nodes: Map<string, NodeConfig>) =>
    [...nodes.keys()].filter((id) => id.startsWith("survey--") && id !== "survey--split")

  it.live(
    "falls back to one worker for a plan naming an agent that cannot be expanded, and does not fail the workflow",
    () =>
      Effect.gen(function* () {
        const { read, expand } = yield* scenario({ split: { plan: plan([item("a", "secret"), item("b", "explore")]) } })
        yield* expand()
        const { config, workflow, rows } = yield* read
        const nodes = byID(config?.nodes)
        expect(fallbackOnly(nodes)).toEqual(["survey--fallback"])
        expect(nodes.get("survey")).toMatchObject({ depends_on: ["survey--fallback"] })
        expect(nodes.get("survey")?.join?.degraded).toContain("the plan was rejected")
        expect(nodes.get("survey--fallback")).toMatchObject({ worker_type: "researcher", workspace_writes: "deny" })
        expect(["failed", "paused", "cancelled"]).not.toContain(workflow?.status)
        expect(rows.every((row) => row.status !== "failed")).toBe(true)
      }),
  )

  it.live("falls back when the plan has no items", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({ split: { plan: plan([]) } })
      yield* expand()
      const { config } = yield* read
      expect(byID(config?.nodes).get("survey")?.join?.degraded).toBe("the plan has no items")
    }),
  )

  it.live("falls back when the split node itself failed, since it is optional", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({ split: { failed: "model ran out of budget" } })
      yield* expand()
      const { config, rows } = yield* read
      expect(byID(config?.nodes).get("survey")?.join?.degraded).toBe(
        'the split node "survey--split" failed: model ran out of budget',
      )
      expect(rows.map((row) => row.id)).toContain("survey--fallback")
    }),
  )

  it.live("falls back when the plan is not one the catalog allows any more", () =>
    Effect.gen(function* () {
      // `researcher` is no longer public: the surveyor can dispatch to `explore` alone.
      const changed = agents().map((entry) =>
        entry.name === "researcher" ? agent("researcher", { contract: { visibility: "private" } }) : entry,
      )
      const survey = agent("surveyor", {
        contract: { role: "composer", compose: compose("fan_out", ["researcher", "explore"], "explore") },
      })
      const { read, expand } = yield* scenario({
        agents: [...changed.filter((entry) => entry.name !== "surveyor"), survey],
        split: { plan: plan([item("a", "researcher")]) },
      })
      yield* expand()
      const { config } = yield* read
      const nodes = byID(config?.nodes)
      expect(nodes.get("survey")?.join?.degraded).toContain("the plan was rejected")
      // The fallback is the composer's current fallback agent.
      expect(nodes.get("survey--fallback")?.worker_type).toBe("explore")
    }),
  )

  it.live("falls back when the node ceiling refuses the expanded graph, and the fallback fits", () =>
    Effect.gen(function* () {
      // split + slot + report is three nodes: one more fits, three more do not.
      const { read, expand } = yield* scenario({
        maxTotalNodes: 4,
        split: { plan: plan([item("a", "explore"), item("b", "explore"), item("c", "explore")]) },
      })
      yield* expand()
      const { config, workflow, rows } = yield* read
      const nodes = byID(config?.nodes)
      expect(fallbackOnly(nodes)).toEqual(["survey--fallback"])
      expect(nodes.get("survey")?.join?.degraded).toContain("the expanded graph was rejected")
      expect(rows).toHaveLength(4)
      // A refused expansion is a refusal, not a pause or a failure.
      expect(workflow?.status).not.toBe("paused")
      expect(rows.some((row) => row.status === "failed")).toBe(false)
    }),
  )

  it.live("fails the slot with compose_capacity when not even the fallback fits", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        maxTotalNodes: 3,
        split: { plan: plan([item("a", "explore"), item("b", "explore")]) },
      })
      yield* expand()
      const { config, workflow, row, rows } = yield* read
      // Nothing was written but the failure of the slot.
      expect(rows).toHaveLength(3)
      expect(config?.nodes.find((node) => node.id === "survey")?.expand).toBe("survey--split")
      expect(row).toMatchObject({ status: "failed", errorClass: DagComposeExpansion.CAPACITY })
      expect(row?.errorReason).toContain("Compose expansion does not fit the graph")
      expect(workflow?.status).not.toBe("paused")
    }),
  )

  it.live(
    "fails the slot as an ordinary execution failure, not a capacity one, when the write fails for another reason",
    () =>
      Effect.gen(function* () {
        const { dag, read, expand } = yield* scenario({
          split: { plan: plan([item("a", "explore"), item("b", "explore")]) },
        })
        const attempts: string[][] = []
        const broken = {
          extend: (_dagID: string, nodes: NodeConfig[]) => {
            attempts.push(nodes.map((node) => node.id))
            return Effect.fail(new Error("the store is unavailable"))
          },
          nodeFailed: dag.nodeFailed,
        }
        yield* expand(broken)
        // The plan was tried, then the one-worker fallback, and neither was written.
        expect(attempts).toEqual([
          ["survey--a", "survey--b", "survey"],
          ["survey--fallback", "survey"],
        ])
        const { row, rows } = yield* read
        expect(rows).toHaveLength(3)
        expect(row).toMatchObject({ status: "failed", errorClass: "exec_failed" })
        expect(row?.errorReason).toBe("Compose expansion failed: the store is unavailable")
      }),
  )

  it.live("falls back when the plan has more items than the subtree has room for", () =>
    Effect.gen(function* () {
      const eleven = Array.from({ length: 11 }, (_, index) => item(`i${index}`, "explore"))
      const { read, expand } = yield* scenario({
        // Only the user's global layer sets these: a project layer's `dag.compose` never gets here.
        globalDag: { compose: { max_children: 12, max_subtree_nodes: 10 } },
        split: { plan: plan(eleven) },
      })
      yield* expand()
      const { config } = yield* read
      expect(byID(config?.nodes).get("survey")?.join?.degraded).toContain("room for 10 more nodes")
    }),
  )

  it.live("reads max_children from the global config when it checks the plan again", () =>
    Effect.gen(function* () {
      const seven = Array.from({ length: 7 }, (_, index) => item(`i${index}`, "explore"))
      const roomy = yield* scenario({ globalDag: { compose: { max_children: 8 } }, split: { plan: plan(seven) } })
      yield* roomy.expand()
      const expanded = byID((yield* roomy.read).config?.nodes)
      expect(expanded.get("survey")?.join?.degraded).toBeUndefined()
      expect(expanded.get("survey")?.depends_on).toHaveLength(7)
    }),
  )

  it.live("degrades the same plan under the default max_children", () =>
    Effect.gen(function* () {
      const seven = Array.from({ length: 7 }, (_, index) => item(`i${index}`, "explore"))
      // The default is 6: the same plan is one item too many.
      const tight = yield* scenario({ split: { plan: plan(seven) } })
      yield* tight.expand()
      expect(byID((yield* tight.read).config?.nodes).get("survey")?.join?.degraded).toContain("the plan was rejected")
    }),
  )

  it.live("fails the slot with compose_unavailable when its composer cannot be used any more", () =>
    Effect.gen(function* () {
      // `explore` may write now, so the mapper-like composer below has nothing it can expand into.
      const survey = agent("surveyor", {
        contract: { role: "composer", compose: compose("fan_out", ["secret"], "secret") },
      })
      const { read, expand } = yield* scenario({
        agents: [...agents().filter((entry) => entry.name !== "surveyor"), survey],
        split: { plan: plan([item("a", "explore")]) },
      })
      yield* expand()
      const { row, rows } = yield* read
      expect(row).toMatchObject({ status: "failed", errorClass: DagComposeExpansion.UNAVAILABLE })
      expect(rows).toHaveLength(3)
    }),
  )
})

describe("a fallback id another node already holds", () => {
  // An author's node that happens to be named like the fallback child. `Dag.extend` would replace it while it is
  // pending, or keep it and hand its result to the join once it is terminal; neither is the fallback's work.
  const unrelated: NodeConfig = {
    id: "survey--fallback",
    name: "unrelated",
    worker_type: "explore",
    depends_on: [],
    prompt_template: { inline: "Unrelated work" },
  }

  it.live("fails the slot instead of degrading onto it when the plan cannot be expanded", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({ extraNodes: [unrelated], split: { plan: plan([]) } })
      yield* expand()
      const { row, rows, config } = yield* read
      expect(row?.status).toBe("failed")
      expect(row?.errorReason).toContain('"survey--fallback" already exists')
      expect(rows).toHaveLength(4)
      expect(byID(config?.nodes).get("survey--fallback")).toMatchObject({
        name: "unrelated",
        prompt_template: { inline: "Unrelated work" },
      })
    }),
  )

  it.live("fails the slot instead of degrading onto it when the expanded graph is refused", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        maxTotalNodes: 5,
        extraNodes: [unrelated],
        split: { plan: plan([item("a", "explore"), item("b", "explore")]) },
      })
      yield* expand()
      const { row, rows, config } = yield* read
      expect(row?.status).toBe("failed")
      expect(row?.errorReason).toContain('"survey--fallback" already exists')
      expect(rows).toHaveLength(4)
      expect(byID(config?.nodes).get("survey--fallback")?.name).toBe("unrelated")
    }),
  )
})

describe("an input alias in the expansion's namespace", () => {
  it.live("fails the slot rather than let the expansion overwrite the authored binding", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        upstream: true,
        patchSlot: (slot) => ({ ...slot, input_mapping: { ...slot.input_mapping, "survey--code": "map" } }),
        split: { plan: plan([item("code", "explore")]) },
      })
      yield* expand()
      const { row, rows, config } = yield* read
      expect(row?.status).toBe("failed")
      expect(row?.errorReason).toContain('input alias "survey--code" is reserved')
      expect(rows.map((candidate) => candidate.id)).not.toContain("survey--code")
      expect(byID(config?.nodes).get("survey")?.expand).toBe("survey--split")
    }),
  )
})

describe("what a required slot does when its expansion cannot be made", () => {
  it.live(
    "leaves the failure semantics to the slot: a required slot's compose_capacity failure fails its dependents",
    () =>
      Effect.gen(function* () {
        const { read, expand } = yield* scenario({
          maxTotalNodes: 3,
          survey: { required: true },
          split: { plan: plan([item("a", "explore"), item("b", "explore")]) },
        })
        yield* expand()
        const { row, config } = yield* read
        expect(row).toMatchObject({ status: "failed", errorClass: "compose_capacity", required: true })
        expect(config?.nodes.find((node) => node.id === "survey")?.required).toBe(true)
      }),
  )
})

/** What the scheduler does with a node that runs: queued, started, and then settled by its worker. */
const settle = (
  dag: Dag.Interface,
  dagID: string,
  id: string,
  outcome: { readonly output: unknown } | { readonly failed: string },
) =>
  Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, id, DEADLINE())
    yield* dag.nodeStarted(dagID, id, `ses_${id}`, DEADLINE())
    if ("output" in outcome) yield* dag.nodeCompleted(dagID, id, outcome.output)
    else yield* dag.nodeFailed(dagID, id, outcome.failed, "exec_failed")
  })

/** The join node's admission check, as the scheduler calls it for a node that has become ready. */
const admit = (dag: Dag.Interface, dagID: string, options: { node?: string; staleSeq?: boolean } = {}) =>
  Effect.gen(function* () {
    const id = options.node ?? "survey"
    const workflow = yield* dag.store.getWorkflow(dagID)
    const rows = yield* dag.store.getNodes(dagID)
    const node = parseWorkflowConfig(workflow?.config ?? "")?.nodes.find((candidate) => candidate.id === id)
    const row = rows.find((candidate) => candidate.id === id)
    if (!node || !row || !workflow) throw new Error("the node is gone")
    return yield* DagComposeExpansion.admitJoin({
      port: dag,
      dagID,
      node,
      nodes: rows,
      attempt: {
        replanAttempts: row.replanAttempts,
        nodeSeq: options.staleSeq ? row.seq + 1 : row.seq,
        graphRev: workflow.graphRev,
      },
    })
  })

describe("the join node's admission check over a real Dag service", () => {
  it.live("fails a join node whose required item has no result with compose_required_missing, and only that node", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("security", "auditor")]) },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--official", { output: "official says" })
      // The block is optional, so the child of its required item is optional too: its failure does not fail the workflow.
      yield* settle(dag, dagID, "survey--security", { failed: "the audit crashed" })
      expect((yield* read).workflow?.status).toBe("running")
      expect(yield* admit(dag, dagID)).toBe(false)
      const { rows, workflow } = yield* read
      const byRow = new Map(rows.map((row) => [row.id, row]))
      expect(byRow.get("survey")).toMatchObject({
        status: "failed",
        errorClass: "compose_required_missing",
        childSessionId: null,
        required: false,
      })
      expect(byRow.get("survey")?.errorReason).toContain('"security" (survey--security: failed)')
      expect(byRow.get("survey")?.errorReason).not.toContain('"official"')
      // The failure is the join node's alone: its dependent waits for the scheduler, and the workflow carries on.
      expect(byRow.get("report")?.status).toBe("pending")
      expect(workflow?.status).toBe("running")
    }),
  )

  it.live("lets a join node through when only items that may be left out have no result, and writes nothing", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("security", "auditor")]) },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--official", { failed: "the source was unreachable" })
      yield* settle(dag, dagID, "survey--security", { output: "security says" })
      const before = yield* read
      expect(yield* admit(dag, dagID)).toBe(true)
      expect((yield* read).rows).toEqual(before.rows)
    }),
  )

  it.live("fails a join node none of whose children has a result with compose_no_results", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--official", { failed: "the source was unreachable" })
      yield* settle(dag, dagID, "survey--code", { failed: "the search timed out" })
      expect(yield* admit(dag, dagID)).toBe(false)
      const row = (yield* read).rows.find((candidate) => candidate.id === "survey")
      expect(row).toMatchObject({ status: "failed", errorClass: "compose_no_results" })
      expect(row?.errorReason).toContain("survey--official: failed")
      expect(row?.errorReason).toContain("survey--code: failed")
    }),
  )

  it.live("fails the join node of a degraded expansion when its fallback worker has no result", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ split: { plan: plan([]) } })
      yield* expand()
      yield* settle(dag, dagID, "survey--fallback", { failed: "the worker gave up" })
      expect(yield* admit(dag, dagID)).toBe(false)
      const row = (yield* read).rows.find((candidate) => candidate.id === "survey")
      expect(row).toMatchObject({ status: "failed", errorClass: "compose_no_results" })
      expect(row?.errorReason).toContain("the fallback worker produced no result")
    }),
  )

  it.live("takes a required join node's failure for the workflow's: a required block fails its dependents", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        survey: { required: true },
        split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
      })
      yield* expand()
      // Skippable items of a required block are optional children: the scheduler lets the join node become ready.
      yield* settle(dag, dagID, "survey--official", { failed: "the source was unreachable" })
      yield* settle(dag, dagID, "survey--code", { failed: "the search timed out" })
      expect(yield* admit(dag, dagID)).toBe(false)
      const { rows } = yield* read
      expect(rows.find((candidate) => candidate.id === "survey")).toMatchObject({
        status: "failed",
        errorClass: "compose_no_results",
        required: true,
      })
    }),
  )

  it.live("leaves a join node pending, and does not let it run, when the attempt it checked has gone stale", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--official", { failed: "the source was unreachable" })
      yield* settle(dag, dagID, "survey--code", { failed: "the search timed out" })
      // A round that read the node before a parent's replan reshaped it: the refusal is not written.
      expect(yield* admit(dag, dagID, { staleSeq: true })).toBe(false)
      expect((yield* read).rows.find((candidate) => candidate.id === "survey")).toMatchObject({
        status: "pending",
        errorClass: null,
      })
    }),
  )

  it.live("has nothing to check on a node that is no join node", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ split: { plan: plan([item("official", "researcher")]) } })
      yield* expand()
      const before = yield* read
      expect(yield* admit(dag, dagID, { node: "report" })).toBe(true)
      expect((yield* read).rows).toEqual(before.rows)
    }),
  )
})

/** Stops the run the way a failure of the workflow does, and recovers the nodes; the plan says what was replaced. */
const stopAndRecover = (dag: Dag.Interface, dagID: string, nodeIDs: string[]) =>
  Effect.gen(function* () {
    yield* dag.fail(dagID, "the run was stopped")
    const workflow = yield* dag.store.getWorkflow(dagID)
    if (!workflow) throw new Error("the workflow is gone")
    const recovered = yield* dag.recover(dagID, { nodeIDs, expectedGraphRev: workflow.graphRev })
    const attempt = (logical: string) => {
      const found = recovered.replacements.find((entry) => entry.logical === logical)
      if (!found) throw new Error(`${logical} was not replaced`)
      return found.current
    }
    return { recovered, attempt }
  })

describe("recovering a compose node over a real Dag service", () => {
  it.live(
    "reads the plan of the recovered split node: the slot is pointed at it and expands instead of degrading",
    () =>
      Effect.gen(function* () {
        // The split node failed and the run was stopped before the slot was expanded. The block reads `map` for itself.
        const { dag, dagID, read, expand } = yield* scenario({ upstream: true, split: { failed: "the model gave up" } })
        const { attempt } = yield* stopAndRecover(dag, dagID, ["survey--split"])
        const splitID = attempt("survey--split")
        const slotID = attempt("survey")
        expect(byID((yield* read).config?.nodes).get(slotID)?.expand).toBe(splitID)

        yield* settle(dag, dagID, splitID, {
          output: JSON.stringify(plan([item("official", "researcher"), item("code", "explore")])),
        })
        yield* expand(dag, slotID)
        const { config, rows } = yield* read
        const nodes = byID(config?.nodes)
        const joinNode = nodes.get(slotID)
        // Read against the failed attempt, which is what the slot named before, the plan would have been "the split node failed".
        expect(joinNode?.join?.degraded).toBeUndefined()
        expect(joinNode?.join?.plan).toBe(splitID)
        expect(joinNode?.join?.items.map((entry) => entry.node)).toEqual([`${slotID}--official`, `${slotID}--code`])
        for (const entry of joinNode?.join?.items ?? []) expect(nodes.get(entry.node)?.depends_on).toEqual([splitID])
        expect(rows.find((row) => row.id === slotID)?.dependsOn).toEqual([`${slotID}--official`, `${slotID}--code`])
        // The recovered slot is a slot of its own namespace: its expansion binds the nodes it made under their ids,
        // beside the input the block reads for itself.
        expect(joinNode?.input_mapping).toEqual({
          map: "map",
          [splitID]: splitID,
          [`${slotID}--official`]: `${slotID}--official`,
          [`${slotID}--code`]: `${slotID}--code`,
        })
      }),
  )

  it.live("points the join node at the recovered child, so its check reads the attempt that counts", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("security", "auditor")]) },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--official", { output: "official says" })
      yield* settle(dag, dagID, "survey--security", { failed: "the audit crashed" })
      const { attempt } = yield* stopAndRecover(dag, dagID, ["survey--security"])
      const childID = attempt("survey--security")
      const joinID = attempt("survey")
      const joinNode = byID((yield* read).config?.nodes).get(joinID)
      expect(joinNode?.join?.items.map((entry) => entry.node)).toEqual(["survey--official", childID])
      expect(joinNode?.depends_on).toEqual(["survey--official", childID])
      // The keys it reads its inputs under name the same attempts, and no key is left for the one that was replaced.
      expect(joinNode?.input_mapping).toEqual({
        "survey--split": "survey--split",
        "survey--official": "survey--official",
        [childID]: childID,
      })

      // The recovered child produces its result: the recovered join node finds it where the failed attempt was.
      yield* settle(dag, dagID, childID, { output: "security says" })
      expect(yield* admit(dag, dagID, { node: joinID })).toBe(true)
      expect((yield* dag.store.getNode(dagID, joinID))?.status).toBe("pending")
    }),
  )

  it.live("points the join node at every recovered attempt when the split node is recovered", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
      })
      yield* expand()
      const { attempt } = yield* stopAndRecover(dag, dagID, ["survey--split"])
      const joinNode = byID((yield* read).config?.nodes).get(attempt("survey"))
      expect(joinNode?.join?.plan).toBe(attempt("survey--split"))
      expect(joinNode?.join?.items.map((entry) => entry.node)).toEqual([
        attempt("survey--official"),
        attempt("survey--code"),
      ])
      // Everything the join node reads is a row of the current graph, under a key of the same name.
      const current = new Set((yield* dag.store.getCurrentNodes(dagID)).map((row) => row.id))
      const ids = [joinNode?.join?.plan ?? "", ...(joinNode?.join?.items.map((entry) => entry.node) ?? [])]
      for (const id of ids) expect(current.has(id), id).toBe(true)
      expect(joinNode?.input_mapping).toEqual(Object.fromEntries(ids.map((id) => [id, id])))
    }),
  )

  it.live(
    "does not read a superseded attempt: with the old child's failure left in place, the join node still runs",
    () =>
      Effect.gen(function* () {
        const { dag, dagID, expand } = yield* scenario({
          split: { plan: plan([item("official", "researcher"), item("code", "explore")]) },
        })
        yield* expand()
        yield* settle(dag, dagID, "survey--official", { failed: "the source was unreachable" })
        yield* settle(dag, dagID, "survey--code", { failed: "the search timed out" })
        const { attempt } = yield* stopAndRecover(dag, dagID, ["survey--official", "survey--code"])
        yield* settle(dag, dagID, attempt("survey--official"), { output: "official says" })
        yield* settle(dag, dagID, attempt("survey--code"), { failed: "the search timed out again" })
        // The superseded attempts failed too, but only the recovered ones count: one has a result.
        expect((yield* dag.store.getNode(dagID, "survey--official"))?.status).toBe("failed")
        expect(yield* admit(dag, dagID, { node: attempt("survey") })).toBe(true)
      }),
  )
})

describe("what a replan may do to the marks of a compose node over a real Dag service", () => {
  it.live("refuses a replacement of the join node that drops its join record, and changes nothing", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ split: { plan: plan([item("official", "researcher")]) } })
      yield* expand()
      const before = yield* read
      const joinNode = byID(before.config?.nodes).get("survey")
      if (!joinNode) throw new Error("the join node is gone")
      const { join: _join, ...restated } = joinNode
      const failure = yield* dag.extend(dagID, [restated]).pipe(Effect.flip)
      expect(failure.message).toContain('Node "survey" carries join')
      expect(failure.message).toContain("cannot change or clear it")
      const after = yield* read
      expect(after.config).toEqual(before.config)
      expect(after.workflow?.graphRev).toBe(before.workflow?.graphRev)
    }),
  )

  it.live("lets a replacement that keeps the join record as it is through", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ split: { plan: plan([item("official", "researcher")]) } })
      yield* expand()
      const joinNode = byID((yield* read).config?.nodes).get("survey")
      if (!joinNode) throw new Error("the join node is gone")
      const result = yield* dag.extend(dagID, [{ ...joinNode, name: "survey: joined" }])
      expect(result.replace).toContain("survey")
      const after = byID((yield* read).config?.nodes).get("survey")
      expect(after?.name).toBe("survey: joined")
      expect(after?.join).toEqual(joinNode.join)
    }),
  )

  it.live("refuses a replacement of a slot that has not been expanded and lacks its marker", () =>
    Effect.gen(function* () {
      const { dag, dagID, read } = yield* scenario({ split: { plan: plan([item("official", "researcher")]) } })
      const before = yield* read
      const slot = byID(before.config?.nodes).get("survey")
      if (!slot?.expand) throw new Error("the slot is gone")
      const { expand: _expand, ...restated } = slot
      const failure = yield* dag.extend(dagID, [restated]).pipe(Effect.flip)
      expect(failure.message).toContain('Node "survey" carries expand')
      expect((yield* read).config).toEqual(before.config)
    }),
  )

  it.live("holds a running join node by the admitted-field guard, and a restart of it by the compose one", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ split: { plan: plan([item("official", "researcher")]) } })
      yield* expand()
      yield* settle(dag, dagID, "survey--official", { output: "official says" })
      yield* dag.nodeQueued(dagID, "survey", DEADLINE())
      yield* dag.nodeStarted(dagID, "survey", "ses_survey", DEADLINE())
      const before = yield* read
      const joinNode = byID(before.config?.nodes).get("survey")
      if (!joinNode) throw new Error("the join node is gone")
      const { join: _join, ...restated } = joinNode
      const held = yield* dag.extend(dagID, [restated]).pipe(Effect.flip)
      expect(held.message).toContain("changes admitted execution fields without restart: join")
      const restarted = yield* dag.extend(dagID, [{ ...restated, restart: true }]).pipe(Effect.flip)
      expect(restarted.message).toContain('Node "survey" carries join')
      expect((yield* read).config).toEqual(before.config)
    }),
  )
})

// #1158 PR3b-2: an item of a recursive composer that asks to be split again becomes a nested split node and a nested
// slot, and the slot is expanded the same way, by the same function, once its own split node has settled.
const nestedPlan = plan([item("big", "explore", { split: true }), item("small", "explore")])
const leaves = plan([item("leaf1", "explore"), item("leaf2", "explore")])

const generated = (config: { nodes: readonly NodeConfig[] } | undefined) =>
  (config?.nodes ?? []).filter((node) => node.compose_subtree !== undefined)

/** Where the plan of a node sits in the graph a scheduling round would read now. */
const positionFor = (
  state: { config: ReturnType<typeof parseWorkflowConfig>; rows: readonly DagStore.NodeRow[] },
  id: string,
  limits: DagCompose.Limits = DagCompose.DEFAULT_LIMITS,
) => {
  const slot = state.config?.nodes.find((node) => node.id === id)
  if (!slot) throw new Error(`no node ${id}`)
  return DagComposeExpansion.positionIn(slot, state.config?.nodes ?? [], state.rows, limits)
}

describe("a nested plan through Dag.extend", () => {
  it.live(
    "writes a two-level expansion: the first plan nests, and the nested slot becomes the join node of its own plan",
    () =>
      Effect.gen(function* () {
        const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
        yield* expand()
        const first = yield* read
        const nested = byID(first.config?.nodes)
        expect([...nested.keys()].sort()).toEqual(
          ["report", "survey", "survey--big", "survey--big--split", "survey--small", "survey--split"].sort(),
        )
        // The nested pair was generated by the slot whose plan listed the item, as the item's sibling was.
        expect(nested.get("survey--big--split")).toMatchObject({
          depends_on: ["survey--split"],
          generated_helper: "split",
          compose_subtree: { root: "survey", depth: 2 },
          expanded_from: "survey",
        })
        expect(nested.get("survey--big")).toMatchObject({
          depends_on: ["survey--big--split"],
          expand: "survey--big--split",
          compose_subtree: { root: "survey", depth: 2 },
          expanded_from: "survey",
        })
        expect(nested.get("survey--small")?.expanded_from).toBe("survey")
        // The join node above waits for the nested slot and nothing of its split node.
        expect(nested.get("survey")?.depends_on).toEqual(["survey--big", "survey--small"])
        const rows = new Map(first.rows.map((row) => [row.id, row]))
        expect(first.rows).toHaveLength(6)
        expect(rows.get("survey--big--split")).toMatchObject({
          status: "pending",
          dependsOn: ["survey--split"],
          workerType: "mapper",
          required: false,
        })
        expect(rows.get("survey--big")).toMatchObject({
          status: "pending",
          dependsOn: ["survey--big--split"],
          workerType: "mapper",
        })

        // Its split node runs and settles; the slot is then expanded the same way, into the join node of its own plan.
        yield* settle(dag, dagID, "survey--big--split", { output: JSON.stringify(leaves) })
        yield* expand(dag, "survey--big")
        const second = yield* read
        const all = byID(second.config?.nodes)
        expect([...all.keys()].sort()).toEqual([...nested.keys(), "survey--big--leaf1", "survey--big--leaf2"].sort())
        expect(all.get("survey--big")?.expand).toBeUndefined()
        // The nested slot kept the slot that generated it when it became a join node; its own children name it.
        expect(all.get("survey--big")).toMatchObject({
          depends_on: ["survey--big--leaf1", "survey--big--leaf2"],
          compose_subtree: { root: "survey", depth: 2 },
          expanded_from: "survey",
          join: {
            plan: "survey--big--split",
            items: [
              { id: "leaf1", node: "survey--big--leaf1", agent: "explore", required: false },
              { id: "leaf2", node: "survey--big--leaf2", agent: "explore", required: false },
            ],
          },
        })
        for (const id of ["survey--big--leaf1", "survey--big--leaf2"])
          expect(all.get(id), id).toMatchObject({
            depends_on: ["survey--big--split"],
            workspace_writes: "deny",
            report_to_parent: false,
            compose_subtree: { root: "survey", depth: 2 },
            expanded_from: "survey--big",
          })
        // What binds to the nested slot is unchanged, and the join node above still records it as a nested item.
        expect(all.get("survey")?.depends_on).toEqual(["survey--big", "survey--small"])
        expect(all.get("survey")?.join?.items[0]).toMatchObject({ node: "survey--big", nested: true })
        expect(second.rows).toHaveLength(8)
        expect(new Map(second.rows.map((row) => [row.id, row])).get("survey--big")).toMatchObject({
          status: "pending",
          dependsOn: ["survey--big--leaf1", "survey--big--leaf2"],
        })
      }),
  )

  it.live("settles a nested plan that was read before a crash the same way: the same ids and definitions", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      yield* settle(dag, dagID, "survey--big--split", { output: JSON.stringify(leaves) })
      // The process dies after reading the nested plan and before the extend commits: nothing is written.
      const crashing = {
        extend: () => Effect.die(new Error("process died before the extend committed")),
        nodeFailed: dag.nodeFailed,
      }
      expect(Exit.isFailure(yield* Effect.exit(expand(crashing, "survey--big")))).toBe(true)
      const before = yield* read
      expect(before.rows).toHaveLength(6)
      expect(byID(before.config?.nodes).get("survey--big")?.expand).toBe("survey--big--split")

      // What the next round plans from that persisted state is what it then writes, and planning twice agrees.
      const composer = DagCompose.resolve(catalog(), "mapper")
      const slot = byID(before.config?.nodes).get("survey--big")
      if (!slot || !composer.available) throw new Error("no slot or composer")
      const plan = () =>
        DagCompose.planExpansion({
          slot,
          composer: composer.composer,
          limits: DagCompose.DEFAULT_LIMITS,
          source: before.rows.find((row) => row.id === "survey--big--split"),
          existingNodeIDs: new Set(before.rows.map((row) => row.id)),
          position: positionFor(before, "survey--big"),
        })
      const planned = plan()
      expect(plan()).toEqual(planned)
      yield* expand(dag, "survey--big")
      const written = byID((yield* read).config?.nodes)
      expect(planned.nodes.map((node) => node.id)).toEqual(["survey--big--leaf1", "survey--big--leaf2", "survey--big"])
      // Creation adds the workflow's defaults to a definition; everything the plan wrote is kept as it was planned.
      for (const node of planned.nodes) expect(written.get(node.id), node.id).toMatchObject(node)
    }),
  )

  it.live("fails the join node above when a required nested item has no result, which it reads as a missing item", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        composer: "mapper",
        split: { plan: plan([item("big", "explore", { split: true, required: true }), item("small", "explore")]) },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--big--split", { output: JSON.stringify(leaves) })
      yield* expand(dag, "survey--big")
      yield* settle(dag, dagID, "survey--small", { output: "small says" })
      yield* settle(dag, dagID, "survey--big--leaf1", { failed: "the search timed out" })
      yield* settle(dag, dagID, "survey--big--leaf2", { failed: "the source was unreachable" })
      // The nested join finds nothing among its own children, and fails before any model is asked...
      expect(yield* admit(dag, dagID, { node: "survey--big" })).toBe(false)
      const { rows } = yield* read
      expect(rows.find((row) => row.id === "survey--big")).toMatchObject({
        status: "failed",
        errorClass: "compose_no_results",
        // The block is optional, so is its nested slot: the failure is the nested join's alone.
        required: false,
      })
      // ... and the join node above, whose item is required, reads that as the item missing.
      expect(yield* admit(dag, dagID)).toBe(false)
      const above = (yield* read).rows.find((row) => row.id === "survey")
      expect(above).toMatchObject({ status: "failed", errorClass: "compose_required_missing" })
      expect(above?.errorReason).toContain('"big" (survey--big: failed)')
    }),
  )
})

describe("a nested plan the graph has no room for", () => {
  // split + slot + report is three nodes; the first plan adds the nested split node, the nested slot and `small`
  // (the slot's place becomes the join node): six. The nested plan then adds two workers, or one fallback worker.
  const settledNested = (maxTotalNodes: number) =>
    Effect.gen(function* () {
      const scene = yield* scenario({ composer: "mapper", maxTotalNodes, split: { plan: nestedPlan } })
      yield* scene.expand()
      yield* settle(scene.dag, scene.dagID, "survey--big--split", { output: JSON.stringify(leaves) })
      return scene
    })

  it.live(
    "falls back to one worker for the nested slot when the node ceiling refuses its plan and the fallback fits",
    () =>
      Effect.gen(function* () {
        const { dag, read, expand } = yield* settledNested(7)
        yield* expand(dag, "survey--big")
        const { config, workflow, rows } = yield* read
        const nodes = byID(config?.nodes)
        expect(nodes.get("survey--big")?.join?.degraded).toContain("the expanded graph was rejected")
        expect(nodes.get("survey--big")?.depends_on).toEqual(["survey--big--fallback"])
        expect(nodes.get("survey--big--fallback")?.compose_subtree).toEqual({ root: "survey", depth: 2 })
        // The fallback worker was generated by the nested slot that degraded, which is a generated node itself.
        expect(nodes.get("survey--big--fallback")?.expanded_from).toBe("survey--big")
        expect(nodes.get("survey--big")?.expanded_from).toBe("survey")
        expect(rows).toHaveLength(7)
        // A refusal is not a failure of the workflow, nor a pause.
        expect(workflow?.status).not.toBe("paused")
        expect(rows.some((row) => row.status === "failed")).toBe(false)
      }),
  )

  it.live("fails the nested slot with compose_capacity when not even the fallback fits, and only that node", () =>
    Effect.gen(function* () {
      const { dag, read, expand } = yield* settledNested(6)
      yield* expand(dag, "survey--big")
      const { config, workflow, rows } = yield* read
      expect(rows).toHaveLength(6)
      expect(byID(config?.nodes).get("survey--big")?.expand).toBe("survey--big--split")
      // The slot is optional, as its item is: the join node above is not told the workflow failed.
      expect(rows.find((row) => row.id === "survey--big")).toMatchObject({
        status: "failed",
        errorClass: DagComposeExpansion.CAPACITY,
        required: false,
      })
      expect(rows.filter((row) => row.status === "failed")).toHaveLength(1)
      expect(workflow?.status).toBe("running")
    }),
  )

  it.live("fails the nested slot with compose_unavailable when its composer cannot be used any more", () =>
    Effect.gen(function* () {
      // The catalog is read at every expansion: by the time the nested plan is expanded `explore` is private, so the
      // mapper has nothing left to expand into, and no fallback worker either.
      let catalog = agents()
      const { dag, dagID, read, expand } = yield* scenario({
        composer: "mapper",
        get agents() {
          return catalog
        },
        split: { plan: nestedPlan },
      })
      yield* expand()
      catalog = catalog.map((entry) =>
        entry.name === "explore" ? agent("explore", { contract: { visibility: "private" } }) : entry,
      )
      yield* settle(dag, dagID, "survey--big--split", { output: JSON.stringify(leaves) })
      yield* expand(dag, "survey--big")
      const { rows, workflow } = yield* read
      expect(rows).toHaveLength(6)
      expect(rows.find((row) => row.id === "survey--big")).toMatchObject({
        status: "failed",
        errorClass: DagComposeExpansion.UNAVAILABLE,
        required: false,
      })
      expect(workflow?.status).toBe("running")
    }),
  )

  it.live("passes the merged graph's strict review gate at both levels: nested nodes are not writers", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({
        composer: "mapper",
        reviewGate: "strict",
        split: { plan: nestedPlan },
      })
      yield* expand()
      yield* settle(dag, dagID, "survey--big--split", { output: JSON.stringify(leaves) })
      yield* expand(dag, "survey--big")
      const { config, rows } = yield* read
      expect(config?.review_gate).toBe("strict")
      expect(byID(config?.nodes).get("survey--big")?.expand).toBeUndefined()
      expect(byID(config?.nodes).get("survey--big")?.join?.items).toHaveLength(2)
      expect(rows).toHaveLength(8)
    }),
  )
})

describe("the room that siblings share", () => {
  // The smallest quota the user's config accepts is 10 nodes.
  const tight = { compose: { max_subtree_nodes: 10 } }

  it.live(
    "gives the first nested slot to be expanded the room it asks for, and degrades the next one that does not fit",
    () =>
      Effect.gen(function* () {
        const { dag, dagID, read, expand } = yield* scenario({
          composer: "mapper",
          globalDag: tight,
          split: {
            plan: plan([
              item("a", "explore", { split: true }),
              item("b", "explore", { split: true }),
              item("c", "explore"),
            ]),
          },
        })
        const limit = { ...DagCompose.DEFAULT_LIMITS, maxSubtreeNodes: 10 }
        yield* expand()
        const four = ["a1", "a2", "a3", "a4"].map((id) => item(id, "explore"))
        yield* settle(dag, dagID, "survey--a--split", { output: JSON.stringify(plan(four)) })
        yield* settle(dag, dagID, "survey--b--split", {
          output: JSON.stringify(plan([item("b1", "explore"), item("b2", "explore")])),
        })
        // Three items and two nested split nodes are written: 5 of the 10. `b` keeps a node for itself, which leaves 4.
        expect(positionFor(yield* read, "survey--a", limit)).toEqual({ depth: 2, remainingNodes: 4 })
        yield* expand(dag, "survey--a")
        // `a` took its four items. `b` finds one node left, which is not enough for its two.
        expect(positionFor(yield* read, "survey--b", limit)).toEqual({ depth: 2, remainingNodes: 1 })
        yield* expand(dag, "survey--b")
        const { config } = yield* read
        const nodes = byID(config?.nodes)
        expect(nodes.get("survey--a")?.join?.degraded).toBeUndefined()
        expect(nodes.get("survey--a")?.depends_on).toEqual([
          "survey--a--a1",
          "survey--a--a2",
          "survey--a--a3",
          "survey--a--a4",
        ])
        expect(nodes.get("survey--b")?.join?.degraded).toContain("room for 1 more nodes")
        expect(nodes.get("survey--b")?.depends_on).toEqual(["survey--b--fallback"])
        // The fallback fits because its place was kept: the subtree is exactly as large as its quota, not larger.
        expect(generated(config)).toHaveLength(10)
      }),
  )

  it.live("runs an item as one worker when the items before it took the room, and says so where the workers read", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        composer: "mapper",
        globalDag: { compose: { max_children: 12, max_subtree_nodes: 10 } },
        // Eight items leave 2 of the 10: one nested plan is paid for, and `a` is served before `b`.
        split: {
          plan: plan([
            item("a", "explore", { split: true }),
            item("b", "explore", { split: true }),
            ...["c", "d", "e", "f", "g", "h"].map((id) => item(id, "explore")),
          ]),
        },
      })
      yield* expand()
      const { config } = yield* read
      const nodes = byID(config?.nodes)
      expect(nodes.get("survey--a")?.expand).toBe("survey--a--split")
      expect(nodes.has("survey--b--split")).toBe(false)
      expect(nodes.get("survey--b")?.expand).toBeUndefined()
      const reason = "the subtree has no room left for a nested plan under dag.compose.max_subtree_nodes 10"
      expect(nodes.get("survey--b")?.prompt_template.inline).toContain(reason)
      expect(nodes.get("survey")?.join?.items.find((entry) => entry.id === "b")).toMatchObject({ unsplit: reason })
      expect(nodes.get("survey")?.prompt_template.inline).toContain(reason)
      // Eight items and one nested split node: nine of the ten.
      expect(generated(config)).toHaveLength(9)
    }),
  )

  it.live("runs every split item as one worker when the block may not go deeper", () =>
    Effect.gen(function* () {
      const { read, expand } = yield* scenario({
        composer: "mapper",
        globalDag: { compose: { max_depth: 1 } },
        split: { plan: nestedPlan },
      })
      yield* expand()
      const nodes = byID((yield* read).config?.nodes)
      expect([...nodes.keys()].filter((id) => id.endsWith("--split"))).toEqual(["survey--split"])
      expect(nodes.get("survey")?.join?.items.map((entry) => entry.unsplit?.slice(0, 40))).toEqual([
        "the expansion is already as deep as dag.",
        undefined,
      ])
    }),
  )
})

describe("a nested slot that was cancelled before it was expanded", () => {
  const split = plan([
    item("a", "explore", { split: true }),
    item("b", "explore", { split: true }),
    item("c", "explore"),
  ])

  it.live("is not expanded by a round that read it before the cancellation, though its split node settled", () =>
    Effect.gen(function* () {
      const { dag, dagID, read } = yield* scenario({ composer: "mapper", split: { plan: split } })
      yield* DagComposeExpansion.expand({
        port: dag,
        agents: { list: () => Effect.succeed(agents() as never) },
        dagID,
        slot: byID((yield* read).config?.nodes).get("survey")!,
        nodes: (yield* read).rows,
        graph: (yield* read).config?.nodes ?? [],
        attempt: {
          replanAttempts: (yield* read).row!.replanAttempts,
          nodeSeq: (yield* read).row!.seq,
          graphRev: (yield* read).workflow!.graphRev,
        },
      })
      yield* settle(dag, dagID, "survey--a--split", { output: JSON.stringify(leaves) })
      // The round reads the slot as pending, with its plan.
      const stale = yield* read
      const row = stale.rows.find((candidate) => candidate.id === "survey--a")
      const slot = byID(stale.config?.nodes).get("survey--a")
      if (!row || !slot || !stale.workflow) throw new Error("the slot is gone")
      // Then the parent cancels it (control.cancel_node).
      yield* dag.nodeCancelled(dagID, "survey--a", "not needed")
      const cancelled = yield* read
      yield* DagComposeExpansion.expand({
        port: dag,
        agents: { list: () => Effect.succeed(agents() as never) },
        dagID,
        slot,
        nodes: stale.rows,
        graph: stale.config?.nodes ?? [],
        attempt: { replanAttempts: row.replanAttempts, nodeSeq: row.seq, graphRev: stale.workflow.graphRev },
      })
      const after = yield* read
      expect(after.rows.map((node) => [node.id, node.status])).toEqual(
        cancelled.rows.map((node) => [node.id, node.status]),
      )
      expect(after.config).toEqual(cancelled.config)
      expect(after.rows.map((node) => node.id)).not.toContain("survey--a--leaf1")
    }),
  )

  it.live("no longer keeps the room set aside for its plan, though the node it is stays in the graph", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: split } })
      yield* expand()
      // Five nodes are written and `a` keeps one for its plan: 40 - 5 - 1 for `b`.
      expect(positionFor(yield* read, "survey--b").remainingNodes).toBe(34)
      yield* dag.nodeCancelled(dagID, "survey--a", "not needed")
      // A control cancellation ends the attempt and leaves the row in the current revision: it is still one of the five.
      expect((yield* read).rows.find((row) => row.id === "survey--a")).toMatchObject({
        status: "failed",
        errorClass: "cancelled",
        superseded: false,
      })
      expect(positionFor(yield* read, "survey--b").remainingNodes).toBe(35)
    }),
  )
})

describe("a nested plan after a recovery", () => {
  it.live("keeps its depth and its place in the subtree, and expands under the id its slot has now", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      const before = yield* read
      const beforeCount = generated(before.config).length
      const { attempt } = yield* stopAndRecover(dag, dagID, ["survey--big--split"])
      const slotID = attempt("survey--big")
      const splitID = attempt("survey--big--split")
      const recovered = yield* read
      const slot = byID(recovered.config?.nodes).get(slotID)
      // The mark follows the node it is on; its root is a key, not a reference to a node that was replaced.
      expect(slot).toMatchObject({ expand: splitID, compose_subtree: { root: "survey", depth: 2 } })
      // The slot that generated it was replaced too, and the slot's definition names the one that counts now.
      expect(slot?.expanded_from).toBe(attempt("survey"))
      // The replaced attempts left the config: the subtree is as large as it was, and the slot is as deep.
      expect(generated(recovered.config)).toHaveLength(beforeCount)
      const position = positionFor(recovered, slotID)
      expect(position).toEqual({ depth: 2, remainingNodes: positionFor(before, "survey--big").remainingNodes })
      // Even a graph that still lists the replaced definitions counts what the rows say is current, once.
      expect(
        DagComposeExpansion.positionIn(
          byID(recovered.config?.nodes).get(slotID)!,
          [...(before.config?.nodes ?? []), ...(recovered.config?.nodes ?? [])],
          recovered.rows,
          DagCompose.DEFAULT_LIMITS,
        ),
      ).toEqual(position)

      yield* settle(dag, dagID, splitID, { output: JSON.stringify(leaves) })
      yield* expand(dag, slotID)
      const done = yield* read
      const nodes = byID(done.config?.nodes)
      expect(nodes.get(slotID)?.join?.items.map((entry) => entry.node)).toEqual([
        `${slotID}--leaf1`,
        `${slotID}--leaf2`,
      ])
      expect(nodes.get(`${slotID}--leaf1`)?.compose_subtree).toEqual({ root: "survey", depth: 2 })
      // What it expands into names it by the id it has now.
      expect(nodes.get(`${slotID}--leaf1`)?.expanded_from).toBe(slotID)
      expect(nodes.get(`${slotID}--leaf2`)?.expanded_from).toBe(slotID)
      // Every node of the subtree is there once, and the replaced attempts are not read again.
      const ids = (done.config?.nodes ?? []).map((node) => node.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(generated(done.config)).toHaveLength(beforeCount + 2)
    }),
  )

  it.live("points the join node above at a recovered nested join, which reads the recovered child it was missing", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      yield* settle(dag, dagID, "survey--big--split", { output: JSON.stringify(leaves) })
      yield* expand(dag, "survey--big")
      yield* settle(dag, dagID, "survey--small", { output: "small says" })
      yield* settle(dag, dagID, "survey--big--leaf1", { output: "leaf1 says" })
      yield* settle(dag, dagID, "survey--big--leaf2", { failed: "the search timed out" })
      const before = yield* read
      const { attempt } = yield* stopAndRecover(dag, dagID, ["survey--big--leaf2"])
      const leafID = attempt("survey--big--leaf2")
      const innerID = attempt("survey--big")
      const outerID = attempt("survey")
      const recovered = yield* read
      const nodes = byID(recovered.config?.nodes)
      // The nested join reads the recovered leaf where the failed one was, and is still part of the same subtree.
      expect(nodes.get(innerID)).toMatchObject({
        depends_on: ["survey--big--leaf1", leafID],
        compose_subtree: { root: "survey", depth: 2 },
        join: { plan: "survey--big--split" },
      })
      expect(nodes.get(innerID)?.join?.items.map((entry) => entry.node)).toEqual(["survey--big--leaf1", leafID])
      // Every node an expansion generated names the slot that generated it as it is now. The ones recovery reused
      // (the sibling item, the nested split node, the leaf that completed) follow the slots it renamed; the ones it
      // replaced were renamed along with the slot that generated them.
      expect(nodes.get(innerID)?.expanded_from).toBe(outerID)
      expect(nodes.get("survey--small")?.expanded_from).toBe(outerID)
      expect(nodes.get("survey--big--split")?.expanded_from).toBe(outerID)
      expect(nodes.get("survey--big--leaf1")?.expanded_from).toBe(innerID)
      expect(nodes.get(leafID)?.expanded_from).toBe(innerID)
      expect(nodes.get(outerID)?.expanded_from).toBeUndefined()
      // The definitions the recovery started from are untouched, and no node names a slot that is not in the graph.
      expect(byID(before.config?.nodes).get("survey--small")?.expanded_from).toBe("survey")
      for (const node of recovered.config?.nodes ?? [])
        if (node.expanded_from !== undefined) expect(nodes.has(node.expanded_from), node.id).toBe(true)
      // The join node above reads the recovered nested join as its item, and the item is still a nested one.
      expect(nodes.get(outerID)?.depends_on).toEqual([innerID, "survey--small"])
      expect(nodes.get(outerID)?.join?.items[0]).toMatchObject({ id: "big", node: innerID, nested: true })
      expect(nodes.get(outerID)?.input_mapping).toMatchObject({ [innerID]: innerID })
      expect(nodes.get(outerID)?.input_mapping).not.toHaveProperty("survey--big")
      expect(nodes.get(outerID)?.prompt_template.inline).toContain(`"${innerID}": item "big", split again`)
      // Nothing was added to the subtree: every node the recovery replaced was replaced by one.
      expect(generated(recovered.config)).toHaveLength(generated(before.config).length)
    }),
  )
})

describe("what a replan may do to the subtree mark of a node", () => {
  it.live("refuses a replacement of a pending nested slot that drops its subtree, and changes nothing", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      const before = yield* read
      const slot = byID(before.config?.nodes).get("survey--big")
      if (!slot) throw new Error("the nested slot is gone")
      const { compose_subtree: _mark, ...restated } = slot
      const failure = yield* dag.extend(dagID, [restated]).pipe(Effect.flip)
      expect(failure.message).toContain('Node "survey--big" carries compose_subtree')
      expect((yield* read).config).toEqual(before.config)
    }),
  )

  it.live("refuses a replacement of a pending worker that changes its subtree, and lets an unchanged one through", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      const worker = byID((yield* read).config?.nodes).get("survey--small")
      if (!worker) throw new Error("the worker is gone")
      const moved = yield* dag
        .extend(dagID, [{ ...worker, compose_subtree: { root: "elsewhere", depth: 1 } }])
        .pipe(Effect.flip)
      expect(moved.message).toContain('Node "survey--small" carries compose_subtree')
      yield* dag.extend(dagID, [{ ...worker, name: "small, renamed" }])
      expect(byID((yield* read).config?.nodes).get("survey--small")).toMatchObject({
        name: "small, renamed",
        compose_subtree: { root: "survey", depth: 1 },
      })
    }),
  )
})

describe("what a replan may do to the slot that generated a node", () => {
  it.live("refuses a replacement of a pending nested slot that drops it, and changes nothing", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      const before = yield* read
      const slot = byID(before.config?.nodes).get("survey--big")
      if (slot?.expanded_from !== "survey") throw new Error("the nested slot does not name the slot that generated it")
      const { expanded_from: _from, ...restated } = slot
      const failure = yield* dag.extend(dagID, [restated]).pipe(Effect.flip)
      expect(failure.message).toContain('Node "survey--big" carries expanded_from')
      expect((yield* read).config).toEqual(before.config)
    }),
  )

  it.live("refuses a replacement of a pending worker that names another slot, and lets an unchanged one through", () =>
    Effect.gen(function* () {
      const { dag, dagID, read, expand } = yield* scenario({ composer: "mapper", split: { plan: nestedPlan } })
      yield* expand()
      const before = yield* read
      const worker = byID(before.config?.nodes).get("survey--small")
      if (!worker) throw new Error("the worker is gone")
      const moved = yield* dag.extend(dagID, [{ ...worker, expanded_from: "elsewhere" }]).pipe(Effect.flip)
      expect(moved.message).toContain('Node "survey--small" carries expanded_from')
      expect((yield* read).config).toEqual(before.config)
      yield* dag.extend(dagID, [{ ...worker, name: "small, renamed" }])
      expect(byID((yield* read).config?.nodes).get("survey--small")).toMatchObject({
        name: "small, renamed",
        expanded_from: "survey",
      })
    }),
  )
})
