import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import Http from "node:http"
import path from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { eq } from "drizzle-orm"
import { FSUtil } from "@graphagent/core/fs-util"
import { Database } from "@graphagent/core/database/database"
import { ProjectV2 } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Session as SessionNs } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { EventSequenceTable } from "@graphagent/core/event/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirInstance, requireInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { WorkspaceTable } from "@graphagent/core/control-plane/workspace.sql"
import type { Target, WorkspaceAdapter, WorkspaceInfo } from "../../src/control-plane/types"
import * as Workspace from "../../src/control-plane/workspace"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Auth } from "@/auth"
import { SessionPrompt } from "@/session/prompt"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Ripgrep } from "@graphagent/core/ripgrep"

const originalEnv = {
  GRAPHAGENT_AUTH_CONTENT: process.env.GRAPHAGENT_AUTH_CONTENT,
  GRAPHAGENT_WORKSPACES: process.env.GRAPHAGENT_WORKSPACES,
  OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
}

const workspaceLayer = (experimentalWorkspaces: boolean) =>
  Workspace.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(Project.defaultLayer),
    Layer.provide(Vcs.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces })),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))),
  )

const testServerLayer = Layer.mergeAll(
  NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }),
  workspaceLayer(true),
  SessionNs.defaultLayer,
  Database.defaultLayer,
)
const it = testEffect(testServerLayer)

type RecordedCreate = {
  info: WorkspaceInfo
  env: Record<string, string | undefined>
  from?: WorkspaceInfo
}

type RecordedAdapter = {
  adapter: WorkspaceAdapter
  calls: {
    configure: WorkspaceInfo[]
    create: RecordedCreate[]
    list: number
    remove: WorkspaceInfo[]
    target: WorkspaceInfo[]
  }
}

function unique(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

function restoreEnv() {
  Object.entries(originalEnv).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }
    process.env[key] = value
  })
}

beforeEach(() => {
  restoreEnv()
  process.env.GRAPHAGENT_WORKSPACES = "true"
})

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
  restoreEnv()
  await resetDatabase()
})

async function initGitRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true })
  await $`git init`.cwd(dir).quiet()
  await $`git config core.fsmonitor false`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git config user.email "test@opencode.test"`.cwd(dir).quiet()
  await $`git config user.name "Test"`.cwd(dir).quiet()
  await fs.writeFile(path.join(dir, "tracked.txt"), "base\n")
  await $`git add tracked.txt`.cwd(dir).quiet()
  await $`git commit -m "base"`.cwd(dir).quiet()
}

function expectExitContains(exit: Exit.Exit<unknown, unknown>, ...messages: string[]) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  for (const message of messages) expect(String(exit.cause)).toContain(message)
}

function recordedAdapter(input: {
  target: (info: WorkspaceInfo) => Target | Promise<Target>
  configure?: (info: WorkspaceInfo) => WorkspaceInfo | Promise<WorkspaceInfo>
  create?: (info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo) => Promise<void>
  list?: () => Omit<WorkspaceInfo, "id">[] | Promise<Omit<WorkspaceInfo, "id">[]>
  remove?: (info: WorkspaceInfo) => Promise<void>
}): RecordedAdapter {
  const calls: RecordedAdapter["calls"] = {
    configure: [],
    create: [],
    list: 0,
    remove: [],
    target: [],
  }

  return {
    calls,
    adapter: {
      name: "recorded",
      description: "recorded",
      configure(info) {
        calls.configure.push(structuredClone(info))
        return input.configure?.(info) ?? info
      },
      async create(info, env, from) {
        calls.create.push({
          info: structuredClone(info),
          env: { ...env },
          from: from ? structuredClone(from) : undefined,
        })
        await input.create?.(info, env, from)
      },
      ...(input.list
        ? {
            async list() {
              calls.list += 1
              return input.list?.() ?? []
            },
          }
        : {}),
      async remove(info) {
        calls.remove.push(structuredClone(info))
        await input.remove?.(info)
      },
      target(info) {
        calls.target.push(structuredClone(info))
        return input.target(info)
      },
    },
  }
}

function localAdapter(dir: string, input?: { createDir?: boolean; remove?: (info: WorkspaceInfo) => Promise<void> }) {
  return recordedAdapter({
    configure(info) {
      return { ...info, directory: dir }
    },
    async create() {
      if (input?.createDir === false) return
      await fs.mkdir(dir, { recursive: true })
    },
    remove: input?.remove,
    target() {
      return { type: "local", directory: dir }
    },
  })
}

function workspaceInfo(projectID: ProjectV2.ID, type: string, input?: Partial<Workspace.Info>): Workspace.Info {
  return {
    id: input?.id ?? WorkspaceV2.ID.ascending(),
    type,
    name: input?.name ?? unique("workspace"),
    branch: input?.branch ?? null,
    directory: input?.directory ?? null,
    extra: input?.extra ?? null,
    projectID,
    timeUsed: input?.timeUsed ?? Date.now(),
  }
}

function insertWorkspace(info: Workspace.Info) {
  return Database.Service.use(({ db }) =>
    db
      .insert(WorkspaceTable)
      .values({
        id: info.id,
        type: info.type,
        branch: info.branch,
        name: info.name,
        directory: info.directory,
        extra: info.extra,
        project_id: info.projectID,
        time_used: info.timeUsed,
      })
      .run()
      .pipe(Effect.orDie),
  )
}

function insertProject(id: ProjectV2.ID, worktree: string) {
  return Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({
        id,
        worktree: AbsolutePath.make(worktree),
        vcs: null,
        name: null,
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie),
  )
}

function attachSessionToWorkspace(sessionID: SessionID, workspaceID: WorkspaceV2.ID) {
  return Database.Service.use(({ db }) =>
    db
      .update(SessionTable)
      .set({ workspace_id: workspaceID })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie),
  )
}

function sessionSequenceOwner(sessionID: SessionID) {
  return Database.Service.use(({ db }) =>
    db
      .select({ ownerID: EventSequenceTable.owner_id })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.ownerID),
      ),
  )
}

describe("workspace schemas and exports", () => {
  test("keeps the historical event type names", () => {
    expect(Workspace.Event.Ready.type).toBe("workspace.ready")
    expect(Workspace.Event.Failed.type).toBe("workspace.failed")
    expect(Workspace.Event.Status.type).toBe("workspace.status")
  })

  test("validates create input with workspace id, project id, branch, type, and extra", () => {
    const input = {
      id: WorkspaceV2.ID.ascending("wrk_schema_create"),
      type: "worktree",
      branch: "feature/schema",
      projectID: ProjectV2.ID.make("project-schema"),
      extra: { nested: true },
    }

    const decode = Schema.decodeUnknownSync(Workspace.CreateInput)
    expect(decode(input)).toEqual(input)
    expect(() => decode({ ...input, id: 1 })).toThrow()
    expect(() => decode({ ...input, branch: 1 })).toThrow()
  })
})

describe("workspace CRUD", () => {
  it.instance(
    "get returns undefined for a missing workspace",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Service
        expect(yield* workspace.get(WorkspaceV2.ID.ascending("wrk_missing_get"))).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "list maps database rows, filters by project, and sorts by id",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const otherProjectID = ProjectV2.ID.make("project-other")
        yield* insertProject(otherProjectID, "/tmp/other")
        const a = workspaceInfo(instance.project.id, "manual", {
          id: WorkspaceV2.ID.ascending("wrk_a_list"),
          branch: "a",
          directory: "/a",
          extra: { a: true },
        })
        const b = workspaceInfo(instance.project.id, "manual", {
          id: WorkspaceV2.ID.ascending("wrk_b_list"),
          branch: "b",
          directory: "/b",
          extra: ["b"],
        })
        const other = workspaceInfo(otherProjectID, "manual", { id: WorkspaceV2.ID.ascending("wrk_c_list") })
        yield* insertWorkspace(b)
        yield* insertWorkspace(other)
        yield* insertWorkspace(a)

        expect(yield* workspace.list(instance.project)).toEqual([a, b])
      }),
    { git: true },
  )

  it.instance(
    "create configures, persists, creates, starts local sync, and passes environment",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        process.env.GRAPHAGENT_AUTH_CONTENT = JSON.stringify({ test: { type: "api", key: "secret" } })
        process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=otel"
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.test"
        process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=opencode-test"

        const workspaceID = WorkspaceV2.ID.ascending("wrk_create_local")
        const type = unique("create-local")
        const targetDir = path.join(instance.directory, "created-local")
        const recorded = recordedAdapter({
          configure(info) {
            return {
              ...info,
              branch: "configured-branch",
              name: "Configured Name",
              directory: targetDir,
              extra: { configured: true },
            }
          },
          async create() {
            await fs.mkdir(targetDir, { recursive: true })
          },
          target() {
            return { type: "local", directory: targetDir }
          },
        })
        registerAdapter(instance.project.id, type, recorded.adapter)

        const info = yield* workspace.create({
          id: workspaceID,
          type,
          branch: null,
          projectID: instance.project.id,
          extra: null,
        })

        expect(info).toEqual({
          id: workspaceID,
          type,
          branch: "configured-branch",
          name: "Configured Name",
          directory: targetDir,
          extra: { configured: true },
          projectID: instance.project.id,
          timeUsed: info.timeUsed,
        })
        expect(yield* workspace.get(workspaceID)).toEqual(info)
        expect(yield* workspace.list(instance.project)).toEqual([info])
        expect(recorded.calls.configure).toHaveLength(1)
        expect(recorded.calls.configure[0]).toMatchObject({ id: workspaceID, type, directory: null })
        expect(recorded.calls.create).toHaveLength(1)
        expect(recorded.calls.create[0].info).toEqual({
          id: workspaceID,
          type,
          branch: "configured-branch",
          name: "Configured Name",
          directory: targetDir,
          extra: { configured: true },
          projectID: instance.project.id,
        })
        expect(JSON.parse(recorded.calls.create[0].env.GRAPHAGENT_AUTH_CONTENT ?? "{}")).toEqual({
          test: { type: "api", key: "secret" },
        })
        expect(recorded.calls.create[0].env.OTEL_EXPORTER_OTLP_HEADERS).toBe("authorization=otel")
        expect(recorded.calls.create[0].env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otel.test")
        expect(recorded.calls.create[0].env.OTEL_RESOURCE_ATTRIBUTES).toBe("service.name=opencode-test")
        expect((yield* workspace.status()).find((item) => item.workspaceID === workspaceID)?.status).toBe("connected")

        yield* workspace.remove(workspaceID)
        expect((yield* workspace.status()).find((item) => item.workspaceID === workspaceID)?.status).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "create propagates configure failures and does not insert a workspace",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const type = unique("configure-failure")
        registerAdapter(
          instance.project.id,
          type,
          recordedAdapter({
            configure() {
              throw new Error("configure exploded")
            },
            target() {
              return { type: "local", directory: "/unused" }
            },
          }).adapter,
        )

        expectExitContains(
          yield* Effect.exit(workspace.create({ type, branch: null, projectID: instance.project.id, extra: null })),
          "configure exploded",
        )
        expect(yield* workspace.list(instance.project)).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "create leaves the inserted row when adapter create fails",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const type = unique("create-failure")
        const recorded = recordedAdapter({
          async create() {
            throw new Error("create exploded")
          },
          target() {
            return { type: "local", directory: "/unused" }
          },
        })
        registerAdapter(instance.project.id, type, recorded.adapter)

        expectExitContains(
          yield* Effect.exit(
            workspace.create({ type, branch: "branch", projectID: instance.project.id, extra: { x: 1 } }),
          ),
          "create exploded",
        )

        const rows = yield* workspace.list(instance.project)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ type, branch: "branch", extra: { x: 1 } })
        expect(recorded.calls.target).toHaveLength(0)
        yield* workspace.remove(rows[0].id)
      }),
    { git: true },
  )

  it.instance(
    "create returns after a local workspace reports error",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const type = unique("local-error")
        const missing = path.join(instance.directory, "missing-local-target")
        const recorded = localAdapter(missing, { createDir: false })
        registerAdapter(instance.project.id, type, recorded.adapter)

        const info = yield* workspace.create({ type, branch: null, projectID: instance.project.id, extra: null })

        expect(info.directory).toBe(missing)
        expect((yield* workspace.status()).find((item) => item.workspaceID === info.id)?.status).toBe("error")
        yield* workspace.remove(info.id)
      }),
    { git: true },
  )

  it.instance(
    "syncList registers adapter-listed workspaces that are missing by name",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const type = unique("list-sync")
        const existing = workspaceInfo(instance.project.id, type, {
          id: WorkspaceV2.ID.ascending("wrk_list_sync_existing"),
          name: "existing",
          directory: path.join(instance.directory, "existing"),
        })
        yield* insertWorkspace(existing)

        const discovered = {
          type,
          name: "discovered",
          branch: "feature/discovered",
          directory: path.join(instance.directory, "discovered"),
          extra: { source: "adapter" },
          projectID: instance.project.id,
        }
        const recorded = recordedAdapter({
          list() {
            return [
              {
                type,
                name: existing.name,
                branch: "ignored",
                directory: path.join(instance.directory, "ignored"),
                extra: null,
                projectID: instance.project.id,
              },
              discovered,
            ]
          },
          target(info) {
            return { type: "local", directory: info.directory ?? instance.directory }
          },
        })
        registerAdapter(instance.project.id, type, recorded.adapter)

        yield* workspace.syncList(instance.project)
        const synced = (yield* workspace.list(instance.project)).filter((item) => item.name === discovered.name)

        expect(synced).toHaveLength(1)
        expect(synced[0]).toMatchObject(discovered)
        expect(synced[0]?.id).toStartWith("wrk_")
        expect(yield* workspace.list(instance.project)).toEqual(expect.arrayContaining([existing, synced[0]]))
        expect(recorded.calls.list).toBe(1)
        expect(recorded.calls.configure).toHaveLength(0)
        expect(recorded.calls.create).toHaveLength(0)
        expect(recorded.calls.target).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "syncList calls every registered adapter with a list method",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const typeA = unique("list-sync-a")
        const typeB = unique("list-sync-b")
        const adapterA = recordedAdapter({
          list() {
            return [
              {
                type: typeA,
                name: "adapter-a",
                branch: null,
                directory: path.join(instance.directory, "adapter-a"),
                extra: null,
                projectID: instance.project.id,
              },
            ]
          },
          target(info) {
            return { type: "local", directory: info.directory ?? instance.directory }
          },
        })
        const adapterB = recordedAdapter({
          list() {
            return [
              {
                type: typeB,
                name: "adapter-b",
                branch: null,
                directory: path.join(instance.directory, "adapter-b"),
                extra: null,
                projectID: instance.project.id,
              },
            ]
          },
          target(info) {
            return { type: "local", directory: info.directory ?? instance.directory }
          },
        })
        const noList = recordedAdapter({
          target() {
            return { type: "local", directory: instance.directory }
          },
        })
        registerAdapter(instance.project.id, typeA, adapterA.adapter)
        registerAdapter(instance.project.id, typeB, adapterB.adapter)
        registerAdapter(instance.project.id, unique("list-sync-none"), noList.adapter)

        yield* workspace.syncList(instance.project)
        const synced = yield* workspace.list(instance.project)

        expect(
          synced
            .filter((item) => item.type === typeA || item.type === typeB)
            .map((item) => item.name)
            .toSorted(),
        ).toEqual(["adapter-a", "adapter-b"])
        expect(adapterA.calls.list).toBe(1)
        expect(adapterB.calls.list).toBe(1)
        expect(noList.calls.list).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "remove returns undefined for a missing workspace",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Service
        expect(yield* workspace.remove(WorkspaceV2.ID.ascending("wrk_missing_remove"))).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "remove deletes the workspace, associated sessions, adapter resources, and status",
    () => {
      return Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const sessionSvc = yield* SessionNs.Service
        const type = unique("remove-local")
        const recorded = localAdapter(path.join(dir, "remove-local"))
        registerAdapter(instance.project.id, type, recorded.adapter)
        const info = yield* workspace.create({ type, branch: null, projectID: instance.project.id, extra: null })
        const one = yield* sessionSvc.create({})
        const two = yield* sessionSvc.create({})
        yield* attachSessionToWorkspace(one.id, info.id)
        yield* attachSessionToWorkspace(two.id, info.id)

        const removed = yield* workspace.remove(info.id)

        expect(removed).toEqual(info)
        expect(yield* workspace.get(info.id)).toBeUndefined()
        expect(recorded.calls.remove).toEqual([info])
        expect((yield* workspace.status()).find((item) => item.workspaceID === info.id)?.status).toBeUndefined()
        const { db } = yield* Database.Service
        expect(
          yield* db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(eq(SessionTable.workspace_id, info.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
      })
    },
    { git: true },
  )

  it.instance(
    "remove still deletes the row when the adapter cannot remove resources",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const type = unique("remove-throws")
        const info = workspaceInfo(instance.project.id, type, { id: WorkspaceV2.ID.ascending("wrk_remove_throws") })
        registerAdapter(
          instance.project.id,
          type,
          recordedAdapter({
            async remove() {
              throw new Error("remove exploded")
            },
            target() {
              return { type: "local", directory: "/unused" }
            },
          }).adapter,
        )
        yield* insertWorkspace(info)

        expect(yield* workspace.remove(info.id)).toEqual(info)
        expect(yield* workspace.get(info.id)).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "sessionWarp moves a session into a local workspace and claims ownership",
    () => {
      return Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const sessionSvc = yield* SessionNs.Service
        const previousType = unique("warp-prev-local")
        const targetType = unique("warp-target-local")
        const previous = workspaceInfo(instance.project.id, previousType)
        const target = workspaceInfo(instance.project.id, targetType)
        yield* insertWorkspace(previous)
        yield* insertWorkspace(target)
        registerAdapter(instance.project.id, previousType, localAdapter(path.join(dir, "warp-prev-local")).adapter)
        registerAdapter(instance.project.id, targetType, localAdapter(path.join(dir, "warp-target-local")).adapter)
        const session = yield* sessionSvc.create({})
        yield* attachSessionToWorkspace(session.id, previous.id)

        yield* workspace.sessionWarp({ workspaceID: target.id, sessionID: session.id })

        const { db } = yield* Database.Service
        expect(
          (yield* db
            .select({ workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, session.id))
            .get()
            .pipe(Effect.orDie))?.workspaceID,
        ).toBe(target.id)
        expect(yield* sessionSequenceOwner(session.id)).toBe(target.id)
      })
    },
    { git: true },
  )

  it.instance(
    "sessionWarp applies source workspace patch to local target workspace",
    () => {
      return Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const sessionSvc = yield* SessionNs.Service
        const previousType = unique("warp-patch-prev-local")
        const targetType = unique("warp-patch-target-local")
        const previousDir = path.join(dir, "warp-patch-prev-local")
        const targetDir = path.join(dir, "warp-patch-target-local")
        yield* Effect.promise(() => initGitRepo(previousDir))
        yield* Effect.promise(() => initGitRepo(targetDir))
        yield* Effect.promise(() => fs.writeFile(path.join(previousDir, "tracked.txt"), "changed\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(previousDir, "new.txt"), "new\n"))

        const previous = workspaceInfo(instance.project.id, previousType)
        const target = workspaceInfo(instance.project.id, targetType)
        yield* insertWorkspace(previous)
        yield* insertWorkspace(target)
        registerAdapter(instance.project.id, previousType, localAdapter(previousDir, { createDir: false }).adapter)
        registerAdapter(instance.project.id, targetType, localAdapter(targetDir, { createDir: false }).adapter)
        const session = yield* sessionSvc.create({})
        yield* attachSessionToWorkspace(session.id, previous.id)

        yield* workspace.sessionWarp({ workspaceID: target.id, sessionID: session.id, copyChanges: true })

        expect(yield* Effect.promise(() => fs.readFile(path.join(targetDir, "tracked.txt"), "utf8"))).toBe("changed\n")
        expect(yield* Effect.promise(() => fs.readFile(path.join(targetDir, "new.txt"), "utf8"))).toBe("new\n")
      })
    },
    { git: true },
  )

  it.instance(
    "sessionWarp detaches a session to the local project and claims project ownership",
    () => {
      return Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const instance = yield* requireInstance
        const workspace = yield* Workspace.Service
        const sessionSvc = yield* SessionNs.Service
        const previousType = unique("warp-detach-local")
        const previous = workspaceInfo(instance.project.id, previousType)
        yield* insertWorkspace(previous)
        registerAdapter(instance.project.id, previousType, localAdapter(path.join(dir, "warp-detach-local")).adapter)
        const session = yield* sessionSvc.create({})
        yield* attachSessionToWorkspace(session.id, previous.id)

        yield* workspace.sessionWarp({ workspaceID: null, sessionID: session.id })

        const { db } = yield* Database.Service
        expect(
          (yield* db
            .select({ workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, session.id))
            .get()
            .pipe(Effect.orDie))?.workspaceID,
        ).toBeNull()
        expect(yield* sessionSequenceOwner(session.id)).toBe(instance.project.id)
      })
    },
    { git: true },
  )

  const itCrossInstance = process.platform === "win32" ? it.instance.skip : it.instance
  itCrossInstance(
    "sessionWarp detaches to the source project when invoked from a workspace instance",
    () =>
      Effect.gen(function* () {
        const instance = yield* requireInstance
        const projectID = instance.project.id
        const workspace = yield* Workspace.Service
        const sessionSvc = yield* SessionNs.Service
        const previousType = unique("warp-detach-workspace-instance")
        const previous = workspaceInfo(projectID, previousType)
        yield* insertWorkspace(previous)
        const session = yield* sessionSvc.create({})
        yield* attachSessionToWorkspace(session.id, previous.id)

        const workspaceProjectID = yield* provideTmpdirInstance(
          (workspaceDir) =>
            Effect.gen(function* () {
              registerAdapter(projectID, previousType, localAdapter(workspaceDir, { createDir: false }).adapter)
              const workspaceCtx = yield* requireInstance
              expect(workspaceCtx.project.id).not.toBe(projectID)
              yield* workspace.sessionWarp({ workspaceID: null, sessionID: session.id })
              return workspaceCtx.project.id
            }),
          { git: true },
        )

        const { db } = yield* Database.Service
        expect(
          (yield* db
            .select({ workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, session.id))
            .get()
            .pipe(Effect.orDie))?.workspaceID,
        ).toBeNull()
        expect(yield* sessionSequenceOwner(session.id)).toBe(projectID)
        expect(yield* sessionSequenceOwner(session.id)).not.toBe(workspaceProjectID)
      }),
    { git: true },
  )
})
