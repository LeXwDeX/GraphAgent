// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { EventV2 } from "@graphagent/core/event"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { installGitShim } from "./git-shim"
import { transactLayer } from "./transact"

/**
 * The DAG layer of the tests that look at where a command starts git. While a
 * `DagTransact` transaction is open it keeps `marker` on disk, so a git shim can
 * tell whether it was started inside one.
 */
export function spiedLayer(marker: string) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const marked = Layer.effect(
    DagTransact.Service,
    Effect.gen(function* () {
      const real = yield* DagTransact.Service
      return DagTransact.Service.of({
        transact: (dagID, token, body) =>
          Effect.suspend(() => {
            writeFileSync(marker, "")
            return real
              .transact(dagID, token, body)
              .pipe(Effect.ensuring(Effect.sync(() => rmSync(marker, { force: true }))))
          }),
      })
    }),
  ).pipe(Layer.provide(transactLayer(database)))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(marked))
  return Layer.mergeAll(database, events, bridge, store, projector, dag)
}

/**
 * Records every git command the shim sees, and those that start while `marker`
 * exists (a `spiedLayer` transaction, or any critical section a test keeps the
 * marker for). `install` takes the commands to slow down by 150 ms, as a bash
 * `case` pattern list over `$*` (for example `*--git-common-dir*|*worktree*`);
 * with none, git runs at full speed.
 */
export function watchGit() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "graphagent-git-watch-"))
  const marker = path.join(directory, "transaction-open")
  const ran = path.join(directory, "ran")
  const violations = path.join(directory, "violations")
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [])
  return {
    marker,
    install: (slow?: string) =>
      installGitShim(
        [
          `echo "$SUB" >> ${JSON.stringify(ran)}`,
          `if [ -e ${JSON.stringify(marker)} ]; then echo "$SUB" >> ${JSON.stringify(violations)}; fi`,
          ...(slow === undefined ? [] : [`case "$*" in ${slow}) sleep 0.15 ;; esac`]),
        ].join("\n"),
      ),
    ran: () => lines(ran),
    insideTransaction: () => lines(violations),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}
