// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- test instance contexts are narrowed from their producing APIs

import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@graphagent/core/database/database"
import { FSUtil } from "@graphagent/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { ProjectTrust } from "@/project/trust"
import type { TrustEntryView } from "@/project/trust/schema"
import { hookCommand } from "../fixture/claude-hook"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * The real hook engine wired to the real ProjectTrust service. `it.instance`
 * always boots a trusted instance, so these tests build their own untrusted
 * InstanceRef and a trust store in a temporary state directory.
 */
const layerFor = (stateDirectory: string) =>
  SettingsHook.layer.pipe(
    Layer.provideMerge(SessionHooks.defaultLayer),
    Layer.provideMerge(ProjectTrust.makeLayer({ stateDirectory })),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  )

const it = testEffect(Layer.empty)

const context = (root: string): InstanceContext => ({
  directory: root,
  worktree: root,
  root,
  project: { id: "global" } as never,
})

const writeHooks = (root: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(root, ".agents"), { recursive: true })
    await fs.writeFile(path.join(root, ".agents", "hooks.json"), JSON.stringify(value))
  })

const exists = (file: string) =>
  Effect.promise(() =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false),
  )

const markerHook = (file: string, text: string) =>
  hookCommand(`await Bun.write(${JSON.stringify(file)}, ${JSON.stringify(text)})`)

const startHook = (command: string) => ({ SessionStart: [{ hooks: [{ type: "command" as const, command }] }] })

const triggerStart = (hook: SettingsHook.Interface, sessionID: string) =>
  hook.trigger({ event: "SessionStart", source: "startup" }, { sessionID, transcript: () => Effect.succeed("") })

/** Build the layer for one temp project and run `body` inside its untrusted instance. */
const withProject = <A, E, R>(
  body: (input: {
    root: string
    hooks: SettingsHook.Interface
    trust: ProjectTrust.Interface
    inInstance: <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>) => Effect.Effect<A2, E2, R2>
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hook-trust-root-")))
    const stateDirectory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hook-trust-state-")))
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(stateDirectory, { recursive: true, force: true })
      }),
    )
    const services = yield* Layer.build(layerFor(stateDirectory))
    const ctx = context(root)
    const inInstance = <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>) =>
      effect.pipe(Effect.provideService(InstanceRef, ctx))
    return yield* body({
      root,
      hooks: Context.get(services, SettingsHook.Service),
      trust: Context.get(services, ProjectTrust.Service),
      inInstance,
    })
  })

const pendingMarkers = (trust: ProjectTrust.Interface) =>
  trust.list().pipe(Effect.map((entries: TrustEntryView[]) => entries.filter((entry) => entry.state === "pending")))

describe("project hook trust gate", () => {
  it.live("every pending hook is filtered from the chain and never executes", () =>
    withProject(({ root, hooks, trust, inInstance }) =>
      Effect.gen(function* () {
        const marker = path.join(root, "pending.txt")
        yield* writeHooks(root, startHook(markerHook(marker, "ran")))

        const entries = yield* inInstance(pendingMarkers(trust))
        expect(entries).toHaveLength(1)
        expect(yield* inInstance(hooks.list())).toEqual([])

        yield* inInstance(triggerStart(hooks, "sess-trust-pending"))
        expect(yield* exists(marker)).toBe(false)
        expect((yield* inInstance(trust.skipped())).map((entry) => entry.category)).toEqual(["hook"])
      }),
    ),
  )

  it.live("a partial decision executes only trusted entries and records the rest as skipped", () =>
    withProject(({ root, hooks, trust, inInstance }) =>
      Effect.gen(function* () {
        const trustedMarker = path.join(root, "trusted.txt")
        const pendingMarker = path.join(root, "pending.txt")
        yield* writeHooks(root, {
          SessionStart: [
            { hooks: [{ type: "command", command: markerHook(trustedMarker, "trusted") }] },
            { hooks: [{ type: "command", command: markerHook(pendingMarker, "pending") }] },
          ],
        })

        const entries = yield* inInstance(pendingMarkers(trust))
        expect(entries).toHaveLength(2)
        yield* inInstance(trust.decide([{ id: entries[0].id, state: "trusted" }]))
        yield* inInstance(
          pollWithTimeout(
            hooks.list().pipe(Effect.map((list) => (list.length === 1 ? list : undefined))),
            "the trust decision did not re-filter the hook chain",
          ),
        )

        yield* inInstance(triggerStart(hooks, "sess-trust-partial"))
        expect(yield* exists(trustedMarker)).toBe(true)
        expect(yield* exists(pendingMarker)).toBe(false)
        expect((yield* inInstance(trust.skipped())).map((entry) => entry.id)).toEqual([entries[1].id])
      }),
    ),
  )

  it.live("a hook added while running stays inexecutable until it is trusted", () =>
    withProject(({ root, hooks, trust, inInstance }) =>
      Effect.gen(function* () {
        const firstMarker = path.join(root, "first.txt")
        const secondMarker = path.join(root, "second.txt")
        yield* writeHooks(root, startHook(markerHook(firstMarker, "first")))
        const entries = yield* inInstance(pendingMarkers(trust))
        yield* inInstance(trust.decide([{ id: entries[0].id, state: "trusted" }]))
        yield* inInstance(
          pollWithTimeout(
            hooks.list().pipe(Effect.map((list) => (list.length === 1 ? list : undefined))),
            "the initial trusted hook was not loaded",
          ),
        )

        // Replace the trusted hook with a new untrusted one. The watcher must
        // reload the candidate chain, and loadGated must filter the new command
        // before it is committed.
        yield* writeHooks(root, startHook(markerHook(secondMarker, "second")))
        yield* inInstance(
          pollWithTimeout(
            hooks.list().pipe(Effect.map((list) => (list.length === 0 ? true : undefined))),
            "the hot reload did not filter the untrusted hook before committing",
          ),
        )
        yield* inInstance(triggerStart(hooks, "sess-trust-hot-reload"))
        expect(yield* exists(secondMarker)).toBe(false)

        const added = yield* inInstance(pendingMarkers(trust))
        expect(added).toHaveLength(1)
        yield* inInstance(trust.decide([{ id: added[0].id, state: "trusted" }]))
        yield* inInstance(
          pollWithTimeout(
            hooks.list().pipe(Effect.map((list) => (list.length === 1 ? list : undefined))),
            "the newly trusted hook was not registered",
          ),
        )
        yield* inInstance(triggerStart(hooks, "sess-trust-hot-reload"))
        expect(yield* exists(secondMarker)).toBe(true)
      }),
    ),
  )

  it.live("revoking a trusted hook removes it from the executable chain immediately", () =>
    withProject(({ root, hooks, trust, inInstance }) =>
      Effect.gen(function* () {
        const marker = path.join(root, "revoked.txt")
        yield* writeHooks(root, startHook(markerHook(marker, "first")))
        const entries = yield* inInstance(pendingMarkers(trust))
        yield* inInstance(trust.decide([{ id: entries[0].id, state: "trusted" }]))
        yield* inInstance(
          pollWithTimeout(
            hooks.list().pipe(Effect.map((list) => (list.length === 1 ? list : undefined))),
            "the trusted hook was not loaded",
          ),
        )
        yield* inInstance(triggerStart(hooks, "sess-trust-revoke"))
        expect(yield* exists(marker)).toBe(true)
        yield* Effect.promise(() => fs.rm(marker))
        yield* inInstance(trust.decide([{ id: entries[0].id, state: "revoked" }]))
        yield* inInstance(
          pollWithTimeout(
            hooks.list().pipe(Effect.map((list) => (list.length === 0 ? true : undefined))),
            "revocation did not remove the hook from the chain",
          ),
        )
        yield* inInstance(triggerStart(hooks, "sess-trust-revoke"))
        expect(yield* exists(marker)).toBe(false)
        expect((yield* inInstance(trust.skipped())).map((entry) => entry.id)).toEqual([entries[0].id])
      }),
    ),
  )
})
