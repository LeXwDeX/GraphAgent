// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3a: the expansion marker lives in the persisted node definition, in the
// workflow's config JSON like `fan_out` does, so no table changes for it. The
// graph the authoring check compiles is also one `Dag.create` accepts: the gate
// is a submission rule of the authoring check, not a structural one.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
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
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { catalog } from "./compose-fixtures"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
  DagTransact.defaultLayer,
)
const dagLayer = Layer.provideMerge(Dag.layer, testLayer)

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
        id: SessionID.make("ses_compose"),
        project_id: Project.ID.global,
        slug: "compose",
        directory: "/project",
        title: "compose",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

const compiled = () =>
  DagCompose.compileNodes(
    DagBlocks.compileWorkflowBlocks({
      objective: "Compare three session persistence designs",
      blocks: [
        new DagBlocks.WorkflowBlock({ id: "map", kind: "explore" }),
        new DagBlocks.WorkflowBlock({
          id: "survey",
          kind: "compose",
          worker_type: "surveyor",
          depends_on: ["map"],
          required: true,
        }),
      ],
    }),
    catalog(),
    DagCompose.DEFAULT_LIMITS,
  ).nodes

describe("a compiled compose block in the durable graph", () => {
  it("is created as it was compiled, and its definition keeps the marker", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const nodes = compiled()
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_compose",
            title: "compose",
            config: { name: "compose", nodes },
          })
          .pipe(Effect.orDie)
        const workflow = yield* dag.store.getWorkflow(dagID)
        const config = Dag.parseWorkflowConfig(workflow?.config ?? "")
        const slot = config?.nodes.find((node) => node.id === "survey")
        // The marker, the split node it names and the helper flag come back exactly as they were written.
        expect(slot?.expand).toBe("survey--split")
        expect(config?.nodes.find((node) => node.id === "survey--split")).toMatchObject({
          generated_helper: "split",
          required: false,
        })
        // Creation adds the workflow's defaults (timeout, skip_ok); everything the compiler wrote is kept as written.
        expect(config?.nodes).toMatchObject(nodes)
        // The scheduler sees an ordinary graph: the slot waits for its split node.
        const rows = yield* dag.store.getNodes(dagID)
        const byID = new Map(rows.map((row) => [row.id, row]))
        expect(byID.get("map")).toMatchObject({ dependsOn: [], required: false })
        expect(byID.get("survey--split")).toMatchObject({ dependsOn: ["map"], required: false })
        expect(byID.get("survey")).toMatchObject({ dependsOn: ["survey--split"], required: true })
        expect(rows).toHaveLength(3)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })
})
