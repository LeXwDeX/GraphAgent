// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { DagMessages } from "../../src/dag/messages"

const [filename, action] = process.argv.slice(2)
const database = Database.layerFromPath(filename)
const services = Layer.merge(database, DagMessages.layer.pipe(Layer.provide(database)))
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const messages = yield* DagMessages.Service
    const { db } = yield* Database.Service
    const caller = { projectID: "p", directory: process.cwd(), sessionID: action === "send" ? "parent" : "child" }
    if (action === "nudge") return yield* messages.claimResultNudge(caller, 0)
    if (action === "send")
      return yield* messages.send(caller, {
        workflowID: "wf",
        nodeID: "n",
        attemptID: DagMessages.nodeAttemptID("child", 0),
        idempotencyKey: "racer",
        content: "arrived",
      })
    return yield* messages.guard(
      caller,
      { workflowID: "wf", nodeID: "n", attemptID: DagMessages.nodeAttemptID("child", 0) },
      db
        .run(sql`UPDATE workflow_node SET status = 'completed' WHERE workflow_id = 'wf' AND id = 'n'`)
        .pipe(Effect.orDie),
    )
  }).pipe(Effect.provide(services), Effect.scoped),
)
process.stdout.write(JSON.stringify(result))
