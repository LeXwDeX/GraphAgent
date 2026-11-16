// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { expect } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Dag } from "@/dag/dag"
import { AppLayer } from "@/effect/app-runtime"
import { InstanceState } from "@/effect/instance-state"
import { Permission, type AskOptions } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildPolicy } from "@/session/child/policy"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * #1031 M7: the SafetyGuard is the production adjudicator behind the H3 seam.
 * These cases prove that an unattended run never creates a permission request,
 * that a safety hit becomes a tool error and a durable node row, and that only
 * a user-written allow with a concrete pattern bypasses the list (never SF-6).
 */

const directory = "/repo/project"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = DagStore.layer.pipe(Layer.provide(database))
const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
const permissionLayer = Permission.layer.pipe(
  Layer.provide(database),
  Layer.provide(bridge),
  Layer.provide(SafetyGuard.layer),
)
const env = Layer.mergeAll(permissionLayer, database, events, bridge, projector, store, dag)
const it = testEffect(env)

/**
 * #1031 M7 finding 4: the app runtime merges Database and Permission as
 * siblings, so `Permission.defaultLayer` must provide Database itself or the
 * unattended seam sees none. Both references here are the same memoized
 * `Database.defaultLayer`, exactly like the app runtime.
 */
const productionLayer = Layer.mergeAll(Database.defaultLayer, Permission.defaultLayer)
const productionIt = testEffect(productionLayer)

/**
 * The whole production assembly. `BaseAppLayer` is not exported; `AppLayer` is
 * `BaseAppLayer` plus two hook layers, and nothing here hands `Permission` its
 * `Database` or `SafetyGuard`.
 */
const appIt = testEffect(AppLayer)

const rootSessionID = SessionID.make("ses_safety_root")

const makeRun = (
  label: string,
  options: {
    readonly owner?: ChildOwner
    readonly permission?: ChildPermissionPolicy
    readonly parentSessionID?: SessionID
  } = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const childSessionID = SessionID.make(`ses_safety_${label}`)
      const owner = options.owner ?? { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_safety_${label}`,
        childSessionID,
        parentSessionID: options.parentSessionID ?? rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission: options.permission ?? { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return { entry, childSessionID }
    }),
    ({ entry }) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

type Rules = Parameters<Permission.Interface["ask"]>[0]["ruleset"]

interface Extra {
  readonly metadata?: Record<string, unknown>
  readonly ruleset?: Rules
  readonly options?: AskOptions
}

const ask = (
  childSessionID: SessionID,
  input: Extra & { readonly permission: string; readonly patterns: readonly string[] },
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(
      {
        sessionID: childSessionID,
        permission: input.permission,
        patterns: [...input.patterns],
        always: [],
        metadata: input.metadata ?? {},
        ruleset: input.ruleset ?? [],
      },
      input.options,
    )
  })

const call = (childSessionID: SessionID, permission: string, pattern: string, extra: Extra = {}) =>
  ask(childSessionID, { permission, patterns: [pattern], ...extra })

const bash = (childSessionID: SessionID, command: string, extra: Extra = {}) =>
  call(childSessionID, "bash", command, { metadata: { command }, ...extra })
const edit = (childSessionID: SessionID, pattern: string, extra: Extra = {}) =>
  call(childSessionID, "edit", pattern, extra)
const read = (childSessionID: SessionID, pattern: string, extra: Extra = {}) =>
  call(childSessionID, "read", pattern, extra)

/** The `external_directory` request the shell tool raises for `rm -rf /var/outside/x`. */
const shellDirectory = (childSessionID: SessionID, extra: Extra = {}) =>
  ask(childSessionID, {
    permission: "external_directory",
    patterns: ["/var/outside/*"],
    metadata: {
      command: "rm -rf /var/outside/x",
      directories: ["/var/outside"],
      patterns: ["/var/outside/*"],
      tool: "bash",
    },
    ...extra,
  })

/** Every `permission.asked` event the run publishes. */
const watchAsked = Effect.gen(function* () {
  const bridgeService = yield* EventV2Bridge.Service
  const asked: unknown[] = []
  const stop = yield* bridgeService.listen((event) => {
    if (event.type === Permission.Event.Asked.type) asked.push(event.data)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => stop)
  return asked
})

/** Root session row the task policy reads at ask time. */
const setRootDagMode = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_safety_adjudication"), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_safety_adjudication"),
        slug: "safety",
        directory: AbsolutePath.make(directory),
        title: "safety root",
        version: "0",
        dag_mode: mode,
      })
      .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
      .run()
      .pipe(Effect.orDie)
  })

const expectDenied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* effect.pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) return String(exit.cause)
    return ""
  })

it.instance(
  "an auto DAG node never prompts: a safety hit is a tool error and the workflow continues",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-sf1")
      const permission = yield* Permission.Service
      const cause = yield* expectDenied(edit(childSessionID, "/repo/outside/a.txt"))
      expect(cause).toContain("dag_safety:SF-1")
      expect(cause).toContain("Do not retry this call")
      expect(yield* permission.list()).toEqual([])
      yield* Effect.yieldNow
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "an ordinary ask is auto-allowed and nothing the guard lets through prompts",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-allow")
      const permission = yield* Permission.Service
      yield* bash(childSessionID, "echo hi")
      yield* edit(childSessionID, "src/a.ts")
      // A native tool reading outside the project raises external_directory
      // without the shell marker; its read is judged by SF-2, not here.
      yield* read(childSessionID, "../outside.txt")
      yield* ask(childSessionID, {
        permission: "external_directory",
        patterns: ["/opt/other/*"],
        metadata: { filepath: "/opt/other/file.txt", parentDir: "/opt/other" },
      })
      yield* call(childSessionID, "webfetch", "https://example.test/")
      // A user-configured `bash: ask` is settled too: the node never waits.
      yield* bash(childSessionID, "make deploy", {
        ruleset: [{ permission: "bash", pattern: "make *", action: "ask" }],
      })
      expect(yield* permission.list()).toEqual([])
      yield* Effect.yieldNow
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "SF-1 (b): a shell external_directory ask no default allow covers is denied; native and default-allowed ones pass",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-sf1b")
      const permission = yield* Permission.Service

      const cause = yield* expectDenied(shellDirectory(childSessionID))
      expect(cause).toContain("dag_safety:SF-1")

      // A default allow (temp, skill and reference directories) is not the user's.
      yield* shellDirectory(childSessionID, {
        options: {
          resolveRuleset: () =>
            Effect.succeed({
              native: [],
              rules: [{ permission: "external_directory", pattern: "/var/outside/*", action: "allow" }],
              userRuleIndices: [],
            }),
        },
      })
      // The same request from a native tool carries no marker.
      yield* ask(childSessionID, {
        permission: "external_directory",
        patterns: ["/var/outside/*"],
        metadata: { filepath: "/var/outside/x", parentDir: "/var/outside" },
      })
      expect(yield* permission.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a sensitive read is denied with SF-2 and still leaves no pending request",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-sf2")
      const permission = yield* Permission.Service
      const cause = yield* expectDenied(read(childSessionID, ".env"))
      expect(cause).toContain("dag_safety:SF-2")
      const grep = yield* expectDenied(
        call(childSessionID, "grep", "KEY", { metadata: { pattern: "KEY", path: ".ssh", include: "*.pem" } }),
      )
      expect(grep).toContain("dag_safety:SF-2")
      yield* read(childSessionID, ".env.example")
      yield* call(childSessionID, "grep", "id_rsa", { metadata: { pattern: "id_rsa", path: "src" } })
      expect(yield* permission.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "SF-3 and SF-4 deny the literal command tables and nothing around them",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-sf34")
      const permission = yield* Permission.Service
      for (const [command, rule] of [
        ["git reset --hard", "SF-3"],
        ["git push origin x --force-with-lease", "SF-3"],
        ["sudo rm x", "SF-3"],
        ["npm publish --access public", "SF-4"],
        ["docker push a/b", "SF-4"],
        ["gh pr merge 1", "SF-4"],
      ] as const) {
        const cause = yield* expectDenied(bash(childSessionID, command))
        expect(cause).toContain(`dag_safety:${rule}`)
        expect(cause).toContain(`(${command})`)
        expect(cause).toContain("Do not retry this call")
      }
      yield* bash(childSessionID, "git push origin feat/x")
      yield* bash(childSessionID, "git status")
      expect(yield* permission.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  // Fixes spec 5.4 "known gaps": change the spec before changing these.
  "bash spellings beyond the literal tables are not refused by the list",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-gaps")
      const permission = yield* Permission.Service
      for (const command of [
        "env -C child true > ../victim",
        "echo x > ../outside",
        "cat .env",
        "env X=1 git reset --hard",
        'bash -c "npm publish"',
        "git push origin main",
      ])
        yield* bash(childSessionID, command)
      expect(yield* permission.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "SF-6: a forced ask is denied, never prompted, and no allow rule lifts it",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-sf6")
      const permission = yield* Permission.Service
      // A hook `permissionDecision: "ask"` on the bash tool.
      const hook = yield* expectDenied(
        call(childSessionID, "bash", "bash", { metadata: { hookAsk: true }, options: { force: true } }),
      )
      expect(hook).toContain("dag_safety:SF-6")
      expect(hook).toContain("requires user confirmation")
      // An MCP tool the server marked `requiresUserInteraction`.
      const mcp = yield* expectDenied(
        call(childSessionID, "mcp__srv__tool", "*", {
          metadata: { requiresUserInteraction: true },
          options: { force: true },
        }),
      )
      expect(mcp).toContain("dag_safety:SF-6")
      // An explicit allow with a concrete pattern changes nothing.
      const explicit = yield* expectDenied(
        call(childSessionID, "bash", "bash", {
          metadata: { hookAsk: true },
          ruleset: [{ permission: "bash", pattern: "bash", action: "allow" }],
          options: { force: true },
        }),
      )
      expect(explicit).toContain("dag_safety:SF-6")
      // The same call unforced is an ordinary ask.
      yield* call(childSessionID, "bash", "bash", { metadata: { hookAsk: true } })
      expect(yield* permission.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "SF-6: a forced ask with no patterns is denied too, never prompted",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-sf6-empty")
      const permission = yield* Permission.Service
      // No pattern means no pass through the per-pattern loop; without its own
      // adjudication the forced flag alone would have sent this to the user.
      const cause = yield* expectDenied(
        ask(childSessionID, { permission: "bash", patterns: [], options: { force: true } }),
      )
      expect(cause).toContain("dag_safety:SF-6")
      expect(cause).toContain("requires user confirmation")
      expect(yield* permission.list()).toEqual([])
      yield* Effect.yieldNow
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a forced ask with no patterns still reaches the user when the run asks the user",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("user-sf6-empty", { permission: { ask: "user" } })
      const permission = yield* Permission.Service
      const pending = yield* ask(childSessionID, { permission: "bash", patterns: [], options: { force: true } }).pipe(
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      expect((yield* permission.list()).length).toBe(1)
      yield* pollWithTimeout(
        Effect.sync(() => (asked.length > 0 ? true : undefined)),
        "no permission.asked event",
      )
      yield* Fiber.interrupt(pending)
    }),
  { git: true },
)

it.instance(
  "only a user-written allow with a concrete pattern on the checked key lifts SF-1 to SF-5",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      const { childSessionID } = yield* makeRun("dag-explicit")
      const permission = yield* Permission.Service
      const allow = (permissionKey: string, pattern: string) => ({
        permission: permissionKey,
        pattern,
        action: "allow" as const,
      })
      const doomLoop = (extra: Extra = {}) =>
        call(childSessionID, "doom_loop", "bash", { metadata: { tool: "bash", input: {} }, ...extra })

      // A concrete bash pattern lifts SF-4 for what it covers.
      yield* bash(childSessionID, "npm publish --access public", { ruleset: [allow("bash", "npm publish*")] })
      expect(
        yield* expectDenied(bash(childSessionID, "docker push a/b", { ruleset: [allow("bash", "npm publish*")] })),
      ).toContain("dag_safety:SF-4")

      // A whole-key allow (`bash: "allow"`) or a key wildcard does not.
      expect(
        yield* expectDenied(bash(childSessionID, "git reset --hard", { ruleset: [allow("bash", "*")] })),
      ).toContain("dag_safety:SF-3")
      expect(
        yield* expectDenied(bash(childSessionID, "git reset --hard", { ruleset: [allow("*", "git reset*")] })),
      ).toContain("dag_safety:SF-3")

      // The edit key lifts SF-1 (a) for that path only.
      yield* edit(childSessionID, "/opt/outside/a.txt", { ruleset: [allow("edit", "/opt/outside/*")] })
      expect(
        yield* expectDenied(
          edit(childSessionID, "/opt/elsewhere/b.txt", { ruleset: [allow("edit", "/opt/outside/*")] }),
        ),
      ).toContain("dag_safety:SF-1")
      // An allow on another key (external_directory) does not lift an edit.
      expect(
        yield* expectDenied(
          edit(childSessionID, "/opt/outside/a.txt", { ruleset: [allow("external_directory", "/opt/outside/*")] }),
        ),
      ).toContain("dag_safety:SF-1")

      // A sensitive read needs an allow on the read key.
      yield* read(childSessionID, ".env", { ruleset: [allow("read", ".env")] })
      expect(yield* expectDenied(read(childSessionID, ".env", { ruleset: [allow("bash", ".env")] }))).toContain(
        "dag_safety:SF-2",
      )

      // SF-5: only a concrete doom_loop allow lifts it.
      expect(yield* expectDenied(doomLoop())).toContain("dag_safety:SF-5")
      expect(yield* expectDenied(doomLoop({ ruleset: [allow("doom_loop", "*")] }))).toContain("dag_safety:SF-5")
      yield* doomLoop({ ruleset: [allow("doom_loop", "bash")] })

      // Role and default allows are not the user's, even with a concrete pattern.
      const resolved = (userRuleIndices: readonly number[]): AskOptions => ({
        resolveRuleset: () => Effect.succeed({ native: [], rules: [allow("bash", "npm publish*")], userRuleIndices }),
      })
      expect(yield* expectDenied(bash(childSessionID, "npm publish", { options: resolved([]) }))).toContain(
        "dag_safety:SF-4",
      )
      yield* bash(childSessionID, "npm publish", { options: resolved([0]) })

      expect(yield* permission.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a task child under a DAG-on root is adjudicated; under off it still reaches the user",
  () =>
    Effect.gen(function* () {
      const asked = yield* watchAsked
      yield* setRootDagMode("on")
      const auto = yield* makeRun("task-on", {
        owner: { kind: "task", toolCallID: "call_on" },
        permission: { ask: "root-dag-mode" },
      })
      const cause = yield* expectDenied(bash(auto.childSessionID, "git reset --hard"))
      expect(cause).toContain("dag_safety:SF-3")

      yield* setRootDagMode("off")
      const manual = yield* makeRun("task-off", {
        owner: { kind: "task", toolCallID: "call_off" },
        permission: { ask: "root-dag-mode" },
      })
      const permission = yield* Permission.Service
      expect(asked).toEqual([])
      const pending = yield* bash(manual.childSessionID, "git reset --hard").pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect((yield* permission.list()).length).toBe(1)
      // The control: the same listener does see a real ask.
      yield* pollWithTimeout(
        Effect.sync(() => (asked.length > 0 ? true : undefined)),
        "no permission.asked event",
      )
      yield* Fiber.interrupt(pending)
    }),
  { git: true },
)

it.instance(
  "a denied node call is recorded on the node row without changing its lifecycle",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: Project.ID.make("prj_safety_adjudication"),
          worktree: AbsolutePath.make(directory),
          sandboxes: [],
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: rootSessionID,
          project_id: Project.ID.make("prj_safety_adjudication"),
          slug: "safety",
          directory: AbsolutePath.make(directory),
          title: "safety root",
          version: "0",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const dagService = yield* Dag.Service
      const dagID = yield* dagService.create({
        projectID: "prj_safety_adjudication",
        sessionID: rootSessionID,
        title: "safety denied",
        config: {
          name: "safety denied",
          nodes: [
            {
              id: "a",
              name: "a",
              worker_type: "build",
              depends_on: [],
              required: true,
              prompt_template: { inline: "a" },
            },
          ],
        },
      })
      const childSessionID = SessionID.make("ses_safety_node_a")
      yield* dagService.nodeQueued(dagID, "a")
      yield* dagService.nodeStarted(dagID, "a", childSessionID, Date.now() + 60_000, true)

      // The run must belong to the same child session the node row names.
      const entry = ChildRegistry.create({
        id: "crun_safety_node_a_real",
        childSessionID,
        parentSessionID: rootSessionID,
        ownerKind: "dag_node",
        ownerKey: { kind: "dag_node", workflowID: dagID, nodeID: "a", attempt: 0 },
        permission: { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)

      const cause = yield* expectDenied(bash(childSessionID, "docker push registry.test/app:1"))
      expect(cause).toContain("dag_safety:SF-4")
      // A forced ask is a denial too, and is recorded like the others.
      const forced = yield* expectDenied(
        call(childSessionID, "bash", "bash", { metadata: { hookAsk: true }, options: { force: true } }),
      )
      expect(forced).toContain("dag_safety:SF-6")

      const storeService = yield* DagStore.Service
      const row = yield* storeService.getNode(dagID, "a")
      expect(row?.status).toBe("running")
      expect(row?.wakeReported).toBe(false)
      expect(row?.safetyDenials?.total).toBe(2)
      expect(row?.safetyDenials?.items[0]).toMatchObject({ ruleID: "SF-4", permission: "bash" })
      expect(row?.safetyDenials?.items[1]).toMatchObject({ ruleID: "SF-6", permission: "bash" })

      ChildRegistry.end(entry, { type: "completed" })
      ChildRegistry.release(entry)
    }),
  { git: true },
)

it.instance(
  "denies an apply_patch move whose destination leaves the project",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("move-out")
      const cause = yield* expectDenied(
        edit(childSessionID, "src/a.ts", {
          metadata: { files: [{ type: "move", filePath: "src/a.ts", movePath: "/repo/outside/b.ts" }] },
        }),
      )
      expect(cause).toContain("dag_safety:SF-1")

      // A move inside the project stays allowed.
      yield* edit(childSessionID, "src/a.ts", {
        metadata: { files: [{ type: "move", filePath: "src/a.ts", movePath: "src/b.ts" }] },
      })
    }),
  { git: true },
)

it.instance(
  "denies an edit that leaves the project through a symlinked directory, resolving the link before `..`",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("symlink")
      const directory = yield* InstanceState.directory
      const outside = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "safety-outside-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })))
      yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "link"), "dir"))

      const direct = yield* expectDenied(edit(childSessionID, "link/victim.txt"))
      expect(direct).toContain("dag_safety:SF-1")
      // A new file below the symlinked directory is the same escape.
      const nested = yield* expectDenied(edit(childSessionID, "link/nested/new.txt"))
      expect(nested).toContain("dag_safety:SF-1")
      // Lexically inside and really inside stays writable.
      yield* edit(childSessionID, "new-file.txt")
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "real")))
      yield* edit(childSessionID, "real/file.txt")
      yield* Effect.promise(() => fs.symlink(path.join(directory, "real"), path.join(directory, "inlink"), "dir"))
      yield* edit(childSessionID, "inlink/file.txt")

      // `viaChild` points at `<outside>/child`, so `viaChild/..` is the outside
      // directory itself; folding `..` lexically would stay in the project.
      yield* Effect.promise(() => fs.mkdir(path.join(outside, "child")))
      yield* Effect.promise(() => fs.symlink(path.join(outside, "child"), path.join(directory, "viaChild"), "dir"))
      const dotdot = yield* expectDenied(edit(childSessionID, "viaChild/../victim"))
      expect(dotdot).toContain("dag_safety:SF-1")
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "sub")))
      yield* edit(childSessionID, "sub/../inside")
    }),
  { git: true },
)

it.instance(
  "denies reading a sensitive file through a symlink",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("read-symlink")
      const directory = yield* InstanceState.directory
      const home = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "safety-home-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(home, { recursive: true, force: true })))
      // A stand-in for `~/.ssh/id_rsa`.
      yield* Effect.promise(() => fs.mkdir(path.join(home, ".ssh")))
      yield* Effect.promise(() => fs.writeFile(path.join(home, ".ssh", "id_rsa"), "PRIVATE"))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, ".env"), "SECRET=1"))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "notes.txt"), "hello"))
      yield* Effect.promise(() => fs.symlink(".env", path.join(directory, "public.txt")))
      yield* Effect.promise(() => fs.symlink(path.join(home, ".ssh", "id_rsa"), path.join(directory, "key.txt")))
      yield* Effect.promise(() => fs.symlink(path.join(home, ".ssh"), path.join(directory, "docs"), "dir"))
      yield* Effect.promise(() => fs.symlink("notes.txt", path.join(directory, "alias.txt")))

      // The literal name of the link is harmless; its real target is not.
      expect(yield* expectDenied(read(childSessionID, "public.txt"))).toContain("dag_safety:SF-2")
      expect(yield* expectDenied(read(childSessionID, "key.txt"))).toContain("dag_safety:SF-2")
      // A searched path that is a link to a credential directory.
      expect(
        yield* expectDenied(call(childSessionID, "grep", "x", { metadata: { pattern: "x", path: "docs" } })),
      ).toContain("dag_safety:SF-2")
      expect(
        yield* expectDenied(call(childSessionID, "glob", "*", { metadata: { pattern: "*", path: "docs" } })),
      ).toContain("dag_safety:SF-2")

      // Ordinary files and links to ordinary files stay readable.
      yield* read(childSessionID, "notes.txt")
      yield* read(childSessionID, "alias.txt")
      yield* call(childSessionID, "grep", "x", { metadata: { pattern: "x", path: "." } })
    }),
  { git: true },
)

productionIt.instance(
  "the production Permission layer resolves a DAG-on task child to auto and guards it",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* setRootDagMode("on")
      const auto = yield* makeRun("prod-task-on", {
        owner: { kind: "task", toolCallID: "call_prod_on" },
        permission: { ask: "root-dag-mode" },
      })
      // The policy resolves through the Database the permission layer was
      // built with, not one handed in beside it.
      const subject = yield* ChildPolicy.askOf(db)(auto.childSessionID)
      expect(Option.getOrUndefined(subject)?.ask).toBe("auto")

      const permission = yield* Permission.Service
      // Without its own Database the layer resolves this child to "user" and
      // the ask waits for a dialog; the timeout turns that regression into a
      // fast, explicit failure instead of a test timeout.
      const outcome = yield* edit(auto.childSessionID, "/repo/outside/a.txt").pipe(
        Effect.exit,
        Effect.timeoutOption("2 seconds"),
      )
      expect(Option.isSome(outcome)).toBe(true)
      if (Option.isSome(outcome)) {
        expect(Exit.isFailure(outcome.value)).toBe(true)
        if (Exit.isFailure(outcome.value)) expect(String(outcome.value.cause)).toContain("dag_safety:SF-1")
      }
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)

appIt.instance(
  "the full app assembly resolves a DAG-on task child to auto, denies an outside edit and leaves no request",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const asked = yield* watchAsked
      yield* setRootDagMode("on")
      const auto = yield* makeRun("app-task-on", {
        owner: { kind: "task", toolCallID: "call_app_on" },
        permission: { ask: "root-dag-mode" },
      })
      const subject = yield* ChildPolicy.askOf(db)(auto.childSessionID)
      expect(Option.getOrUndefined(subject)?.ask).toBe("auto")

      const permission = yield* Permission.Service
      const outcome = yield* edit(auto.childSessionID, "/repo/outside/a.txt").pipe(
        Effect.exit,
        Effect.timeoutOption("5 seconds"),
      )
      expect(Option.isSome(outcome)).toBe(true)
      if (Option.isSome(outcome)) {
        expect(Exit.isFailure(outcome.value)).toBe(true)
        if (Exit.isFailure(outcome.value)) expect(String(outcome.value.cause)).toContain("dag_safety:SF-1")
      }
      expect(yield* permission.list()).toEqual([])
      yield* Effect.yieldNow
      expect(asked).toEqual([])
    }),
  { git: true },
)
