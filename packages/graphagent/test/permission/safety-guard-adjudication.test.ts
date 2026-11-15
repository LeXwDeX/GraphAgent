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
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Dag } from "@/dag/dag"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Permission, type AskOptions } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/**
 * #1031 M7: the SafetyGuard is the production adjudicator behind the H3 seam.
 * These cases prove that an unattended run never creates a permission request,
 * that a safety hit becomes a tool error and a durable node row, and that only
 * a user-written allow bypasses the list.
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

/** #1031 M7 finding 5: Git facts are only needed by SF-4 push checks. */
const gitCalls = { branch: 0, defaultBranch: 0, remote: 0 }
const gitMock = Layer.mock(Git.Service, {
  branch: () =>
    Effect.sync(() => {
      gitCalls.branch++
      return "feat/work"
    }),
  defaultBranch: () =>
    Effect.sync(() => {
      gitCalls.defaultBranch++
      return { name: "main", ref: "main" }
    }),
  run: (args) =>
    Effect.sync(() => {
      if (args[0] === "remote") gitCalls.remote++
      return { exitCode: 0, text: () => "origin", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false }
    }),
})
const lazyPermissionLayer = Permission.layer.pipe(
  Layer.provide(database),
  Layer.provide(bridge),
  Layer.provide(SafetyGuard.layer),
  // `decide` reads Git through `serviceOption` in its caller's context, so the
  // mock must stay visible to the test body, not only to the layer build.
  Layer.provideMerge(gitMock),
)
const lazyEnv = Layer.mergeAll(lazyPermissionLayer, database, events, bridge, projector, store, dag)
const lazyIt = testEffect(lazyEnv)

const resetGitCalls = () => {
  gitCalls.branch = 0
  gitCalls.defaultBranch = 0
  gitCalls.remote = 0
}

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

const ask = (
  childSessionID: SessionID,
  input: {
    readonly permission: string
    readonly patterns: readonly string[]
    readonly metadata?: Record<string, unknown>
    readonly ruleset?: Parameters<Permission.Interface["ask"]>[0]["ruleset"]
    readonly options?: AskOptions
  },
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

const bash = (
  childSessionID: SessionID,
  command: string,
  extra: { readonly ruleset?: Parameters<Permission.Interface["ask"]>[0]["ruleset"]; readonly options?: AskOptions } = {},
) =>
  ask(childSessionID, {
    permission: "bash",
    patterns: [command],
    metadata: { command, cwd: directory, shell: "bash" },
    ...(extra.ruleset ? { ruleset: extra.ruleset } : {}),
    ...(extra.options ? { options: extra.options } : {}),
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
      const { childSessionID } = yield* makeRun("dag-sf3")
      const permission = yield* Permission.Service
      const cause = yield* expectDenied(bash(childSessionID, "rm -rf /"))
      expect(cause).toContain("dag_safety:SF-3")
      expect(cause).toContain("Do not retry this call")
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "an ordinary ask is auto-allowed and an external_directory ask never prompts either",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("dag-allow")
      const permission = yield* Permission.Service
      yield* bash(childSessionID, "echo hi")
      yield* ask(childSessionID, {
        permission: "external_directory",
        patterns: ["/opt/other/*"],
        metadata: { filepath: "/opt/other/file.txt", parentDir: "/opt/other" },
      })
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a sensitive read is denied with SF-2 and still leaves no pending request",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("dag-sf2")
      const permission = yield* Permission.Service
      const cause = yield* expectDenied(
        ask(childSessionID, { permission: "read", patterns: [".env"], metadata: {} }),
      )
      expect(cause).toContain("dag_safety:SF-2")
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a user-written allow bypasses the safety list but a default wildcard allow does not",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("dag-explicit")
      yield* bash(childSessionID, "npm publish --access public", {
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })

      const defaults = yield* expectDenied(
        bash(childSessionID, "npm publish --access public", {
          options: {
            resolveRuleset: () =>
              Effect.succeed({
                native: [],
                rules: [{ permission: "bash", pattern: "*", action: "allow" }],
                userRuleIndices: [],
              }),
          },
        }),
      )
      expect(defaults).toContain("dag_safety:SF-4")
    }),
  { git: true },
)

it.instance(
  "a task child under a DAG-on root is adjudicated; under off it still reaches the user",
  () =>
    Effect.gen(function* () {
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
      const pending = yield* bash(manual.childSessionID, "git reset --hard").pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect((yield* permission.list()).length).toBe(1)
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

      const storeService = yield* DagStore.Service
      const row = yield* storeService.getNode(dagID, "a")
      expect(row?.status).toBe("running")
      expect(row?.wakeReported).toBe(false)
      expect(row?.safetyDenials?.total).toBe(1)
      expect(row?.safetyDenials?.items[0]).toMatchObject({ ruleID: "SF-4", permission: "bash" })

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
        ask(childSessionID, {
          permission: "edit",
          patterns: ["src/a.ts"],
          metadata: {
            files: [{ type: "move", filePath: "src/a.ts", movePath: "/repo/outside/b.ts" }],
          },
        }),
      )
      expect(cause).toContain("dag_safety:SF-1")

      // A move inside the project stays allowed.
      yield* ask(childSessionID, {
        permission: "edit",
        patterns: ["src/a.ts"],
        metadata: {
          files: [{ type: "move", filePath: "src/a.ts", movePath: "src/b.ts" }],
        },
      })
    }),
  { git: true },
)

lazyIt.instance(
  "resolves Git facts only for a git push",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("lazy-git")
      resetGitCalls()
      yield* ask(childSessionID, { permission: "read", patterns: ["src/a.ts"], metadata: {} })
      yield* ask(childSessionID, {
        permission: "edit",
        patterns: ["src/a.ts"],
        metadata: { files: [{ type: "move", filePath: "src/a.ts", movePath: "src/b.ts" }] },
      })
      yield* bash(childSessionID, "git status")
      // An explicit user allow settles the pattern before SF-4 needs facts.
      yield* bash(childSessionID, "git push origin main", {
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(gitCalls).toEqual({ branch: 0, defaultBranch: 0, remote: 0 })

      const cause = yield* expectDenied(bash(childSessionID, "git push origin main"))
      expect(cause).toContain("dag_safety:SF-4")
      expect(gitCalls.branch).toBeGreaterThan(0)
      expect(gitCalls.defaultBranch).toBeGreaterThan(0)
      expect(gitCalls.remote).toBeGreaterThan(0)
    }),
  { git: true },
)

it.instance(
  "denies a write that leaves the project through a symlinked directory",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("symlink")
      const directory = yield* InstanceState.directory
      const outside = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "safety-outside-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })))
      yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "link"), "dir"))
      const edit = (relative: string) =>
        ask(childSessionID, { permission: "edit", patterns: [relative], metadata: {} })

      const direct = yield* expectDenied(edit("link/victim.txt"))
      expect(direct).toContain("dag_safety:SF-1")
      // A new file below the symlinked directory is the same escape.
      const nested = yield* expectDenied(edit("link/nested/new.txt"))
      expect(nested).toContain("dag_safety:SF-1")
      // Lexically inside and really inside stays writable.
      yield* edit("new-file.txt")
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "real")))
      yield* edit("real/file.txt")
      yield* Effect.promise(() => fs.symlink(path.join(directory, "real"), path.join(directory, "inlink"), "dir"))
      yield* edit("inlink/file.txt")

      // Bash writes take the same path.
      const bashCause = yield* expectDenied(
        ask(childSessionID, {
          permission: "bash",
          patterns: ["tee link/from-bash.txt"],
          metadata: { command: "tee link/from-bash.txt", cwd: directory, shell: "bash" },
        }),
      )
      expect(bashCause).toContain("dag_safety:SF-1")
    }),
  { git: true },
)

it.instance(
  "denies reading a sensitive file through a symlink",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("read-symlink")
      const directory = yield* InstanceState.directory
      const bashRun = (command: string) =>
        ask(childSessionID, {
          permission: "bash",
          patterns: [command],
          metadata: { command, cwd: directory, shell: "bash" },
        })
      const read = (pattern: string) => ask(childSessionID, { permission: "read", patterns: [pattern], metadata: {} })
      yield* Effect.promise(() => fs.writeFile(path.join(directory, ".env"), "SECRET=1"))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "notes.txt"), "hello"))
      yield* Effect.promise(() => fs.symlink(".env", path.join(directory, "public.txt")))
      yield* Effect.promise(() => fs.symlink("notes.txt", path.join(directory, "alias.txt")))

      // The literal name of the link is harmless; its real target is not.
      const native = yield* expectDenied(read("public.txt"))
      expect(native).toContain("dag_safety:SF-2")
      const cat = yield* expectDenied(bashRun("cat public.txt"))
      expect(cat).toContain("dag_safety:SF-2")
      const redirected = yield* expectDenied(bashRun("cat < public.txt"))
      expect(redirected).toContain("dag_safety:SF-2")

      // Ordinary files and links to ordinary files stay readable.
      yield* read("notes.txt")
      yield* read("alias.txt")
      yield* bashRun("cat notes.txt")
      yield* bashRun("cat alias.txt")
    }),
  { git: true },
)

it.instance(
  "a cd to a missing directory keeps the cwd uncertain",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("failed-cd")
      const directory = yield* InstanceState.directory
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "existing-child")))
      const run = (command: string) =>
        ask(childSessionID, {
          permission: "bash",
          patterns: [command],
          metadata: { command, cwd: directory, shell: "bash" },
        })

      // The child directory exists, so `../victim` lands inside the project.
      yield* run("cd existing-child; printf x > ../victim")
      // A missing child leaves bash in the project root; trusting the new cwd
      // would wrongly allow the project-outside `../victim`.
      const missing = yield* expectDenied(run("cd missing-child; printf x > ../victim"))
      expect(missing).toContain("dag_safety:SF-1")
      // An existing absolute cd is honored; an unproven one is not.
      const absolute = yield* expectDenied(run(`cd ${directory}; printf x > ../victim`))
      expect(absolute).toContain("dag_safety:SF-1")
      const unproven = yield* expectDenied(run(`cd ${directory}/missing; printf x > ./inside.txt`))
      expect(unproven).toContain("dag_safety:SF-1")
    }),
  { git: true },
)
