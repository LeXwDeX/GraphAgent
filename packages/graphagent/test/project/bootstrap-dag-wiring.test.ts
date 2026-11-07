import { describe, expect } from "bun:test"
import { Dag } from "@/dag/dag"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const appLayer = LayerNode.buildLayer(
  LayerNode.group([InstanceStore.node, Dag.node, Project.node, Session.node, SessionProjector.node, Database.node]),
)
const appIt = testEffect(Layer.mergeAll(appLayer, CrossSpawnSpawner.defaultLayer))

describe("instance bootstrap DAG wiring", () => {
  appIt.live("recovers a persisted workflow when InstanceStore bootstraps the production graph", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const instances = yield* InstanceStore.Service
      const workflowID = "dag_bootstrap_recovery"
      yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const context = yield* InstanceState.context
          const session = yield* Session.Service
          const database = yield* Database.Service
          const parent = yield* session.create({ title: "bootstrap DAG wiring" })
          yield* pollWithTimeout(
            session.get(parent.id).pipe(
              Effect.as(true as const),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
            "session projection did not become visible",
          )
          // Persist a mid-flight workflow directly: a completed gate plus a
          // pending conditional that evaluates false against the gate's output.
          // dag.create would have to run the gate through a real provider to
          // reach this state; recovery only needs the durable rows (same
          // fixture shape as dag-wake-integration's recovery scenario).
          yield* database.db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .insert(WorkflowTable)
                  .values({
                    id: workflowID,
                    project_id: context.project.id as never,
                    session_id: parent.id as never,
                    directory: context.directory,
                    title: "condition false",
                    status: "running",
                    config: JSON.stringify({
                      name: "condition false",
                      nodes: [
                        {
                          id: "gate",
                          name: "gate",
                          worker_type: "build",
                          depends_on: [],
                          required: true,
                          prompt_template: { inline: "gate" },
                        },
                        {
                          id: "skip",
                          name: "skip without a model call",
                          worker_type: "reviewer",
                          depends_on: ["gate"],
                          required: true,
                          prompt_template: { inline: "unused" },
                          condition: 'gate.output == "ACCEPT"',
                        },
                      ],
                    }),
                    seq: 2,
                    wake_reported: false,
                  })
                  .run()
                yield* tx
                  .insert(WorkflowNodeTable)
                  .values([
                    {
                      id: "gate",
                      workflow_id: workflowID,
                      name: "gate",
                      worker_type: "build",
                      status: "completed",
                      required: true,
                      depends_on: [],
                      output: "REJECT",
                      wake_eligible: false,
                      wake_reported: false,
                      seq: 2,
                    },
                    {
                      id: "skip",
                      workflow_id: workflowID,
                      name: "skip without a model call",
                      worker_type: "reviewer",
                      status: "pending",
                      required: true,
                      depends_on: ["gate"],
                      wake_eligible: false,
                      wake_reported: false,
                      seq: 1,
                    },
                  ])
                  .run()
              }),
            )
            .pipe(Effect.orDie)
        }),
      )
      yield* instances.reload({ directory })
      yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const dag = yield* Dag.Service
          const result = yield* pollWithTimeout(
            Effect.gen(function* () {
              const workflow = yield* dag.store.getWorkflow(workflowID)
              const skipped = (yield* dag.store.getNodes(workflowID)).find((n) => n.id === "skip")
              if (workflow?.status !== "completed" || skipped?.status !== "skipped") return
              return { workflow, node: skipped }
            }),
            "bootstrap did not start the DAG scheduler",
            "1 second",
          )
          expect(result.workflow.status).toBe("completed")
          expect(result.node.status).toBe("skipped")
        }),
      )
    }),
  )
})
