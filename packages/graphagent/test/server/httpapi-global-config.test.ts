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

  // #1678: a permission rule is resolved again at every permission check, so editing it keeps the instances (and the
  // turns running in them) and only rebuilds the cached configuration.
  it.live(
    "applies a hot-read permission update without disposing instances",
    Effect.gen(function* () {
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => events.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const response = yield* request("/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: { edit: "ask" } }),
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ permission: { edit: "ask" } })

      // The disposal path is forked, so give a late event a chance to land.
      yield* Effect.sleep("100 millis")

      const updated = events.filter(isConfigUpdated)
      expect(updated).toHaveLength(1)
      const payload = updated[0] === undefined ? undefined : payloadOf(updated[0])
      expect(payload).toMatchObject({ type: "config.updated", properties: { keys: ["permission"] } })
      expect(events.some((event) => payloadOf(event)?.type === "global.disposed")).toBe(false)
      expect(events.some((event) => payloadOf(event)?.type === "server.instance.disposed")).toBe(false)

      const written = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(configDir, "graphagent.jsonc"), "utf8")),
      )
      expect(written).toMatchObject({ permission: { edit: "ask" } })
    }),
  )

  it.live(
    "applies the ordered permissions list as a hot-read key too",
    Effect.gen(function* () {
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => events.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const response = yield* request("/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: [{ action: "bash", resource: "*", effect: "deny" }] }),
      })
      expect(response.status).toBe(200)
      yield* Effect.sleep("100 millis")

      const updated = events.filter(isConfigUpdated)
      expect(updated).toHaveLength(1)
      expect(updated[0] === undefined ? undefined : payloadOf(updated[0])).toMatchObject({
        properties: { keys: ["permissions"] },
      })
      expect(events.some((event) => payloadOf(event)?.type === "global.disposed")).toBe(false)
    }),
  )

  it.live(
    "a permission edit reaches the merged configuration of a loaded directory without disposing it",
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        fs.writeFile(path.join(configDir, "graphagent.jsonc"), JSON.stringify({ permission: { edit: "allow" } })),
      )
      const project = yield* tmpdirScoped()
      const before = yield* requestInDirectory("/config", project)
      expect(before.status).toBe(200)
      expect(yield* before.json).toMatchObject({ permission: { edit: "allow" } })

      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => events.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const patch = yield* requestInDirectory("/global/config", project, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: { edit: "deny" } }),
      })
      expect(patch.status).toBe(200)

      // The directory's merged configuration was cached by the read above: the next read must rebuild it.
      const after = yield* requestInDirectory("/config", project)
      expect(after.status).toBe(200)
      expect(yield* after.json).toMatchObject({ permission: { edit: "deny" } })
      yield* Effect.sleep("100 millis")
      expect(events.some((event) => payloadOf(event)?.type === "server.instance.disposed")).toBe(false)
    }),
  )

  // The environment override outranks every file layer, a hot-read edit included.
  it.live(
    "a hot-read permission edit leaves the GRAPHAGENT_PERMISSION override in force",
    Effect.gen(function* () {
      const previous = process.env.GRAPHAGENT_PERMISSION
      process.env.GRAPHAGENT_PERMISSION = JSON.stringify({ edit: "deny" })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GRAPHAGENT_PERMISSION
          else process.env.GRAPHAGENT_PERMISSION = previous
        }),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(configDir, "graphagent.jsonc"), JSON.stringify({ permission: { edit: "allow" } })),
      )
      const project = yield* tmpdirScoped()
      expect(yield* (yield* requestInDirectory("/config", project)).json).toMatchObject({
        permission: { edit: "deny" },
      })

      const patch = yield* requestInDirectory("/global/config", project, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: { edit: "ask" } }),
      })
      expect(patch.status).toBe(200)

      // The file changed, and the merged configuration was rebuilt: the override still decides.
      expect(yield* (yield* requestInDirectory("/global/config", project)).json).toMatchObject({
        permission: { edit: "ask" },
      })
      expect(yield* (yield* requestInDirectory("/config", project)).json).toMatchObject({
        permission: { edit: "deny" },
      })
    }),
  )

  // The project layer stays above the global one: an edit made in `/config` is global, so it cannot outrank a rule the
  // project itself sets, hot-read or not.
  it.live(
    "a hot-read permission edit leaves a project rule above it",
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        fs.writeFile(path.join(configDir, "graphagent.jsonc"), JSON.stringify({ permission: { edit: "allow" } })),
      )
      const project = yield* tmpdirScoped({ config: { permission: { edit: "deny" } } })
      expect(yield* (yield* requestInDirectory("/config", project)).json).toMatchObject({
        permission: { edit: "deny" },
      })

      const patch = yield* requestInDirectory("/global/config", project, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: { edit: "ask" } }),
      })
      expect(patch.status).toBe(200)

      // The global layer now says ask; the merged view of the project still ends with the project's own deny.
      const merged = yield* (yield* requestInDirectory("/config", project)).json
      expect(merged).toMatchObject({ permission: { edit: "deny" } })
      expect(isRecord(merged) ? merged.permissions : undefined).toEqual([
        { action: "edit", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "deny" },
      ])
    }),
  )

  it.live(
    "a permission edit made together with a non-hot key keeps the disposal path",
    Effect.gen(function* () {
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => events.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const disposed = yield* waitGlobalBusEvent({
        message: "timed out waiting for instance disposal after a mixed global update",
        predicate: (event) => payloadOf(event)?.type === "global.disposed",
      }).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* request("/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: { edit: "ask" }, model: "test/model" }),
      })
      expect(response.status).toBe(200)
      yield* Fiber.join(disposed)

      expect(events.some(isConfigUpdated)).toBe(false)
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
      const projectConfig = JSON.stringify(
        { $schema: "https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json", formatter: false },
        null,
        2,
      )
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
