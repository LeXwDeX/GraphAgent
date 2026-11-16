// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { PluginV2 } from "@graphagent/core/plugin"
import { Reference } from "@graphagent/core/reference"
import { AbsolutePath } from "@graphagent/core/schema"
import { afterAll, afterEach, beforeAll, expect } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { AppLayer } from "@/effect/app-runtime"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { AskAdjudicator, type Decision } from "@/permission/ask-adjudicator"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import { SessionID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * #1031 M7: the `references` directories an unattended write may reach.
 *
 * The guard resolves them the way `agent.ts` does, through the `Reference`
 * service of the instance's location, because the merged config no longer
 * knows which document declared a relative path: a user-level
 * `references: { docs: "../docs" }` is the directory beside the user config,
 * not the one beside the project.
 */

/** The user-level config lives in `<holder>/global`; `<holder>/docs` is what its `../docs` means. */
let holder = ""
const previousConfigDir = process.env.GRAPHAGENT_TEST_CONFIG_DIR

beforeAll(async () => {
  holder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "safety-references-")))
  const global = path.join(holder, "global")
  await fs.mkdir(global)
  await fs.writeFile(path.join(global, "graphagent.json"), JSON.stringify({ references: { docs: "../docs" } }))
  process.env.GRAPHAGENT_TEST_CONFIG_DIR = global
})

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
  else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previousConfigDir
  await fs.rm(holder, { recursive: true, force: true })
})

afterEach(async () => {
  await disposeAllInstances()
})

const rootSessionID = SessionID.make("ses_safety_references_root")

/** What write and edit send for a target: the pattern is relative to the worktree, the written path rides along. */
const decide = (target: string) =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const pattern = path.relative(instance.worktree, target)
    return yield* (yield* AskAdjudicator.Service).decide({
      request: { permission: "edit", patterns: [pattern], metadata: { filepath: target } },
      pattern,
      rule: { action: "ask", explicit: false },
      forced: false,
      owner: { kind: "task", toolCallID: "call_safety_references" },
      rootSessionID,
      mode: "allow",
    })
  })

const expectAllowed = (decision: Decision) => expect(decision).toBe("allow")
const expectOutside = (decision: Decision) => {
  expect(decision).not.toBe("allow")
  if (decision !== "allow") expect(decision.deny.ruleID).toBe("SF-1")
}

/** The guard behind the production location services, like `Permission.defaultLayer` builds it. */
const withLocations = testEffect(Layer.mergeAll(Config.defaultLayer, SafetyGuard.defaultLayer))

/** The guard the app graph (the HTTP server's composition) builds from its node. */
const fromNode = testEffect(Layer.mergeAll(Config.defaultLayer, LayerNode.buildLayer(SafetyGuard.node)))

/** The bare layer: no location services, so no `Reference` service to ask. */
const withoutLocations = testEffect(Layer.mergeAll(Config.defaultLayer, SafetyGuard.layer))

withLocations.instance(
  "a reference is the directory its own config document resolves, not one guessed from the project root",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      // The user-level `../docs` is beside the user config.
      expectAllowed(yield* decide(path.join(holder, "docs", "notes.md")))
      // The project root guess is not a reference at all.
      expectOutside(yield* decide(path.resolve(instance.root, "..", "docs", "notes.md")))
      // A project-level reference is anchored at the project root, like agent.ts.
      expectAllowed(yield* decide(path.resolve(instance.root, "..", "project-docs", "notes.md")))
      // Only the directories themselves: their siblings and the project's parent stay outside.
      expectOutside(yield* decide(path.join(holder, "other", "notes.md")))
      expectOutside(yield* decide(path.resolve(instance.root, "..", "notes.md")))
    }),
  { git: true, config: { references: { projectdocs: "../project-docs" } } },
)

fromNode.instance(
  "the guard the app graph builds resolves references the same way",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      expectAllowed(yield* decide(path.join(holder, "docs", "notes.md")))
      expectOutside(yield* decide(path.resolve(instance.root, "..", "docs", "notes.md")))
    }),
  { git: true },
)

withoutLocations.instance(
  "without the location services no reference is a root, and none is rebuilt from the project root",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      expectOutside(yield* decide(path.join(holder, "docs", "notes.md")))
      expectOutside(yield* decide(path.resolve(instance.root, "..", "docs", "notes.md")))
      expectOutside(yield* decide(path.resolve(instance.root, "..", "project-docs", "notes.md")))
      // The project itself is not affected.
      expectAllowed(yield* decide(path.join(instance.directory, "notes.md")))
    }),
  { git: true, config: { references: { projectdocs: "../project-docs" } } },
)

/**
 * A guard whose location services answer with `list`: the `Reference` service
 * of a git source lists the materialized cache path, which no config text
 * contains.
 */
const fakeLocations = (wait: Effect.Effect<void>, list: Effect.Effect<Reference.Info[]>) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the fake location layer exposes only the two services the guard reads.
  Layer.succeed(LocationServiceMap, {
    get: () =>
      Layer.mergeAll(
        Layer.mock(PluginV2.Service, { wait: () => wait }),
        Layer.mock(Reference.Service, { list: () => list }),
      ),
  } as never)

const guardWith = (wait: Effect.Effect<void>, list: Effect.Effect<Reference.Info[]>) =>
  testEffect(Layer.mergeAll(Config.defaultLayer, SafetyGuard.layer.pipe(Layer.provide(fakeLocations(wait, list)))))

const cachePath = () => path.join(holder, "repos", "acme", "widgets")
const gitReference = () =>
  new Reference.Info({
    name: "widgets",
    path: AbsolutePath.make(cachePath()),
    source: Reference.GitSource.make({ type: "git", repository: "github.com/acme/widgets" }),
  })

guardWith(
  Effect.void,
  Effect.suspend(() => Effect.succeed([gitReference()])),
).instance(
  "takes the paths the Reference service lists as roots, a materialized git cache included",
  () =>
    Effect.gen(function* () {
      expectAllowed(yield* decide(path.join(cachePath(), "README.md")))
      expectOutside(yield* decide(path.join(holder, "repos", "acme", "other", "README.md")))
    }),
  { git: true },
)

guardWith(Effect.void, Effect.die(new Error("reference cache unavailable"))).instance(
  "a Reference service that fails leaves no root and does not fail the decision",
  () =>
    Effect.gen(function* () {
      expectOutside(yield* decide(path.join(cachePath(), "README.md")))
    }),
  { git: true },
)

guardWith(Effect.die(new Error("core/config-reference failed to load")), Effect.succeed([])).instance(
  "a config-reference plugin that failed to load leaves no root and does not fail the decision",
  () =>
    Effect.gen(function* () {
      expectOutside(yield* decide(path.join(cachePath(), "README.md")))
    }),
  { git: true },
)

/** The whole production assembly: nothing here hands the guard its location services but the app's own wiring. */
const appIt = testEffect(AppLayer)

appIt.instance(
  "the full app assembly lets an unattended child write into a global reference and nowhere beside it",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const permission = yield* Permission.Service
      const childSessionID = SessionID.make("ses_safety_references_app")
      const owner = { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: "crun_safety_references_app",
        childSessionID,
        parentSessionID: rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission: { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ChildRegistry.end(entry, { type: "completed" })
          ChildRegistry.release(entry)
        }),
      )

      const write = (target: string) =>
        permission.ask({
          sessionID: childSessionID,
          permission: "edit",
          patterns: [path.relative(instance.worktree, target)],
          always: [],
          metadata: { filepath: target },
          ruleset: [],
        })
      yield* write(path.join(holder, "docs", "notes.md"))
      const guess = yield* write(path.resolve(instance.root, "..", "docs", "notes.md")).pipe(Effect.exit)
      expect(Exit.isFailure(guess)).toBe(true)
      expect(String(Exit.isFailure(guess) ? guess.cause : "")).toContain("dag_safety:SF-1")
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)
