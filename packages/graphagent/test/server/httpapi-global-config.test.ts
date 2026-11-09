// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Effect, Fiber } from "effect"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ConfigHotReload } from "@/config/hot-reload"
import { HookConfigChange } from "@/hook/config-change"
import { isRecord } from "@/util/record"
import { TestConfig } from "../fixture/config"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { httpApiLayer, httpApiLayerWith, request, requestInDirectory } from "./httpapi-layer"

// #1013 (C1 PR5): the global config PATCH writes the global layer and decides
// between hot-read application and instance disposal.
const previousConfigDir = process.env.GRAPHAGENT_TEST_CONFIG_DIR
const configDir = path.join(os.tmpdir(), `graphagent-global-config-${process.pid}`)
process.env.GRAPHAGENT_TEST_CONFIG_DIR = configDir

const it = testEffect(httpApiLayer)

// #1013 (C1 PR5): the handler maps a hook veto to a 400 without writing.
const blockedConfig = TestConfig.layer({
  updateGlobal: () => Effect.fail(new HookConfigChange.ConfigChangeBlocked({ message: "blocked by the test hook" })),
})
const blockedIt = testEffect(httpApiLayerWith([LayerNode.replace(Config.node, blockedConfig)]))

beforeEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
})

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
  else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

function payloadOf(event: GlobalEvent): Record<string, unknown> | undefined {
  return isRecord(event.payload) ? event.payload : undefined
}

function isConfigUpdated(event: GlobalEvent) {
  return payloadOf(event)?.type === ConfigHotReload.CONFIG_UPDATED_EVENT
}

describe("global config HttpApi", () => {
  it.live(
    "applies a hot-read dag update without disposing instances",
    Effect.gen(function* () {
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => events.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const response = yield* request("/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dag: { mode: "on" } }),
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ dag: { mode: "on" } })

      // The disposal path is forked, so give a late event a chance to land.
      yield* Effect.sleep("100 millis")

      const updated = events.filter(isConfigUpdated)
      expect(updated).toHaveLength(1)
      const payload = updated[0] === undefined ? undefined : payloadOf(updated[0])
      expect(payload).toMatchObject({
        type: "config.updated",
        properties: { keys: ["dag"] },
      })
      expect(events.some((event) => payloadOf(event)?.type === "global.disposed")).toBe(false)

      const written = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(configDir, "graphagent.jsonc"), "utf8")),
      )
      expect(written).toMatchObject({ dag: { mode: "on" } })
    }),
  )

  it.live(
    "keeps the disposal path for non-hot-read global keys",
    Effect.gen(function* () {
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => events.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const disposed = yield* waitGlobalBusEvent({
        message: "timed out waiting for instance disposal after a non-hot global update",
        predicate: (event) => payloadOf(event)?.type === "global.disposed",
      }).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* request("/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test/model" }),
      })
      expect(response.status).toBe(200)
      yield* Fiber.join(disposed)

      expect(events.some(isConfigUpdated)).toBe(false)
    }),
  )

  it.live(
    "writes only the global config layer",
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const project = path.join(root, "project")
      const projectFile = path.join(project, ".agents", "settings.json")
      const projectConfig = JSON.stringify({ $schema: "https://opencode.ai/config.json", formatter: false }, null, 2)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(projectFile), { recursive: true })
        await fs.writeFile(projectFile, projectConfig)
      })

      const patch = yield* requestInDirectory("/global/config", project, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dag: { mode: "on", concurrency: 3 } }),
      })
      expect(patch.status).toBe(200)
      expect(yield* patch.json).toMatchObject({ dag: { mode: "on", concurrency: 3 } })

      const globalFile = path.join(configDir, "graphagent.jsonc")
      const globalConfig = JSON.parse(yield* Effect.promise(() => fs.readFile(globalFile, "utf8")))
      expect(globalConfig).toMatchObject({ dag: { mode: "on", concurrency: 3 } })
      expect(yield* Effect.promise(() => fs.readFile(projectFile, "utf8"))).toBe(projectConfig)

      // The merged view reads the DAG policy from the global layer; the project
      // layer must keep resolving the same file it had before the write.
      const merged = yield* requestInDirectory("/config", project)
      expect(merged.status).toBe(200)
      expect(yield* merged.json).toMatchObject({ dag: { mode: "on", concurrency: 3 } })
    }),
  )

  blockedIt.live(
    "returns 400 when a hook blocks the global config change",
    Effect.gen(function* () {
      const response = yield* request("/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dag: { mode: "on" } }),
      })
      expect(response.status).toBe(400)
    }),
  )
})
