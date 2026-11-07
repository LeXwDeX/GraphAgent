// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Narrow session mocks exercise actual graph mutation and report selection with an isolated database.
import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Dag, computeMergedConfig, parseWorkflowConfig, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { deliverReport, selectReportNode } from "@/dag/runtime/report-delivery"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const workflowID = "dag_delivery_mutation"
function node(id: string, depends_on: string[] = []): NodeConfig {
  return { id, name: id, worker_type: "build", depends_on, prompt_template: { inline: "work" }, report_to_parent: true }
}
const config = (nodes: NodeConfig[], delivery_node = "old"): WorkflowConfig => ({
  name: "mutation",
  result_protocol: "final_response",
  delivery_node,
  nodes,
})
const plan = { cancel: [], restart: [], replace: [], add: [] }

describe("delivery selection after graph mutation", () => {
  test("a former leaf gains a dependent and falls back to the result index", () => {
    const merged = computeMergedConfig(
      config([node("old")]),
      { nodes: [node("new", ["old"])] },
      {
        ...plan,
        add: ["new"],
      },
    )
    expect(merged.delivery_node).toBeUndefined()
    expect(parseWorkflowConfig(JSON.stringify(merged))?.delivery_node).toBeUndefined()
  })
  test("replacing a pending node with a downstream definition invalidates the prior leaf report", () => {
    const merged = computeMergedConfig(
      config([node("old"), node("pending")]),
      {
        nodes: [node("pending", ["old"])],
      },
      { ...plan, replace: ["pending"] },
    )
    expect(merged.delivery_node).toBeUndefined()
  })
  test("removing a selected node clears the dangling selection", () => {
    expect(
      computeMergedConfig(config([node("old")]), { nodes: [] }, { ...plan, cancel: ["old"] }).delivery_node,
    ).toBeUndefined()
  })
  test("an unchanged leaf remains selected", () => {
    expect(
      computeMergedConfig(config([node("old")]), { nodes: [node("parallel")] }, { ...plan, add: ["parallel"] })
        .delivery_node,
    ).toBe("old")
  })
  test("a previously accepted explicit non-leaf selection retains its meaning", () => {
    const current = config([node("old"), node("downstream", ["old"])])
    const merged = computeMergedConfig(current, { nodes: [node("parallel")] }, { ...plan, add: ["parallel"] })
    expect(merged.delivery_node).toBe("old")
  })
})

function services() {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const sessionProjector = SessionProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const dependencies = Layer.mergeAll(database, events, bridge, store, projector, sessionProjector)
  return Layer.merge(dependencies, Dag.layer.pipe(Layer.provide(dependencies)))
}
const it = testEffect(services())
function seed(workflowStatus: "running" | "completed" | "failed", nodeStatus: "running" | "completed" | "failed") {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const directory = process.cwd()
    yield* db.run(
      sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${directory},'[]',1,1)`,
    )
    yield* db.run(
      sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_parent','p','parent',${directory},'S','test',1,1)`,
    )
    yield* db.run(
      sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,graph_rev,completed_at,time_created,time_updated) VALUES (${workflowID},'p','ses_parent',${directory},'Mutation',${workflowStatus},${JSON.stringify(config([node("old")]))},0,1,${workflowStatus === "completed" ? 10 : null},1,10)`,
    )
    yield* db.run(
      sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,output,wake_eligible,seq,time_created,time_updated) VALUES ('old',${workflowID},'Old','build',${nodeStatus},'[]','ses_old',${JSON.stringify("old report")},1,0,1,10)`,
    )
  }).pipe(Effect.orDie)
}
const completeNode = (dag: Dag.Interface, id: string, output: string) =>
  Effect.gen(function* () {
    yield* dag.nodeQueued(workflowID, id)
    yield* dag.nodeStarted(workflowID, id, `ses_${id}`, undefined, true)
    yield* dag.nodeCompleted(workflowID, id, output)
  })

it.live(
  "additive reopen delivers a new result index containing the new episode instead of copying the old report",
  () =>
    Effect.gen(function* () {
      yield* seed("completed", "completed")
      const dag = yield* Dag.Service
      const bridge = yield* EventV2Bridge.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const readParts = () =>
        db
          .select()
          .from(PartTable)
          .pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  ({
                    ...row.data,
                    id: row.id,
                    sessionID: row.session_id,
                    messageID: row.message_id,
                  }) as SessionV1.Part,
              ),
            ),
          )
      const sessions = {
        get: () => Effect.succeed({ id: "ses_parent", agent: "build" }),
        messages: () =>
          Effect.gen(function* () {
            const rows = yield* db.select().from(MessageTable)
            const parts = yield* readParts()
            return rows.map((row) => ({
              info: { ...row.data, id: row.id, sessionID: row.session_id } as SessionV1.Info,
              parts: parts.filter((part) => part.messageID === row.id),
            }))
          }),
        getPart: (input: { partID: string }) =>
          db
            .select()
            .from(PartTable)
            .where(eq(PartTable.id, input.partID as never))
            .pipe(
              Effect.map((rows) =>
                rows[0]
                  ? ({
                      ...rows[0].data,
                      id: rows[0].id,
                      sessionID: rows[0].session_id,
                      messageID: rows[0].message_id,
                    } as SessionV1.Part)
                  : undefined,
              ),
            ),
      } as unknown as Session.Interface
      const deliver = () =>
        Effect.gen(function* () {
          const workflow = (yield* dag.store.getWorkflow(workflowID))!
          const nodes = yield* dag.store.getCurrentNodes(workflowID)
          return yield* deliverReport({
            workflow,
            store: dag.store,
            sessions,
            events,
            directory: process.cwd(),
            batch: { nodes, workflows: [workflow] },
          })
        })
      expect(yield* deliver()).toBe(true)
      yield* dag.extend(workflowID, [node("new", ["old"])])
      const reopened = (yield* dag.store.getWorkflow(workflowID))!
      expect(reopened.status).toBe("running")
      expect(parseWorkflowConfig(reopened.config)?.delivery_node).toBeUndefined()
      yield* completeNode(dag, "new", "new report")
      yield* bridge.publish(DagEvent.WorkflowCompleted, {
        dagID: Dag.ID.make(workflowID),
        durationMs: 0,
        timestamp: yield* DateTime.now,
      })
      expect(yield* deliver()).toBe(true)
      const answers = (yield* readParts()).filter(
        (part): part is SessionV1.TextPart => part.type === "text" && part.metadata?.dag_delivery?.kind === "answer",
      )
      expect(answers).toHaveLength(2)
      expect(answers[0].text).toBe("old report")
      expect(answers[1].text).toContain(`node_id="new"`)
      expect(answers[1].text).not.toBe("old report")
      expect(answers[1].metadata?.dag_delivery?.graph_rev).toBe(reopened.graphRev)
    }),
)

it.live("recovery remaps a selected report to its exact replacement attempt", () =>
  Effect.gen(function* () {
    yield* seed("failed", "failed")
    const dag = yield* Dag.Service
    const workflow = (yield* dag.store.getWorkflow(workflowID))!
    const recovered = yield* dag.recover(workflowID, { nodeIDs: ["old"], expectedGraphRev: workflow.graphRev })
    const replacement = recovered.replacements.find((node) => node.previous === "old")!.current
    const currentConfig = parseWorkflowConfig((yield* dag.store.getWorkflow(workflowID))!.config)!
    expect(currentConfig.delivery_node).toBe(replacement)
    yield* completeNode(dag, replacement, "recovered report")
    const report = selectReportNode(currentConfig, yield* dag.store.getCurrentNodes(workflowID))
    expect(report).toMatchObject({ id: replacement, status: "completed", output: "recovered report" })
    expect((yield* dag.store.getNode(workflowID, "old"))?.superseded).toBe(true)
  }),
)
