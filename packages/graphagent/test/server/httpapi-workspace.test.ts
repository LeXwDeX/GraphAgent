import { afterEach, describe, expect, mock } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Flag } from "@graphagent/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
import { Session } from "@/session/session"
import { Database } from "@graphagent/core/database/database"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.GRAPHAGENT_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer)),
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function requestServer(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-graphagent-directory", directory)
  return Effect.promise(() => Promise.resolve(Server.Default().app.request(path, { ...init, headers })))
}

function localAdapter(directory: string): WorkspaceAdapter {
  return {
    name: "Local Test",
    description: "Create a local test workspace",
    configure(info) {
      return {
        ...info,
        name: "local-test",
        directory,
      }
    },
    async create() {
      await mkdir(directory, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "local" as const,
        directory,
      }
    },
  }
}

function listedAdapter(directory: string, type: string): WorkspaceAdapter {
  return {
    name: "Listed Test",
    description: "List a local test workspace",
    configure(info) {
      return { ...info, name: "unused", directory }
    },
    async create() {},
    async remove() {},
    list(context) {
      return [
        {
          type,
          name: "listed-test",
          branch: "listed/main",
          directory,
          extra: { listed: true },
          projectID: context?.instance?.project.id ?? missingAdapterContext(),
        },
      ]
    },
    target() {
      return {
        type: "local" as const,
        directory,
      }
    },
  }
}

function missingAdapterContext(): never {
  throw new Error("missing workspace adapter context")
}

afterEach(async () => {
  mock.restore()
  Flag.GRAPHAGENT_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("workspace HttpApi", () => {
  it.live("serves read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const [adapters, workspaces, status] = yield* Effect.all([
        request(WorkspacePaths.adapters, dir),
        request(WorkspacePaths.list, dir),
        request(WorkspacePaths.status, dir),
      ])

      expect(adapters.status).toBe(200)
      expect(yield* adapters.json).toContainEqual({
        type: "worktree",
        name: "Worktree",
        description: "Create a git worktree",
      })

      expect(workspaces.status).toBe(200)
      expect(yield* workspaces.json).toEqual([])

      expect(status.status).toBe(200)
      expect(yield* status.json).toEqual([])
    }),
  )

  it.live("serves mutation endpoints", () =>
    Effect.gen(function* () {
      Flag.GRAPHAGENT_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "local-test", localAdapter(path.join(dir, ".workspace")))

      const created = yield* request(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "local-test", branch: null }),
      })
      expect(created.status).toBe(200)
      const workspace = (yield* created.json) as Workspace.Info
      expect(workspace).toMatchObject({ type: "local-test", name: "local-test" })

      const session = yield* Session.use.create({}).pipe(provideInstance(dir))
      const warped = yield* request(WorkspacePaths.warp, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: workspace.id, sessionID: session.id }),
      })
      expect(warped.status).toBe(204)

      const removed = yield* request(WorkspacePaths.remove.replace(":id", workspace.id), dir, { method: "DELETE" })
      expect(removed.status).toBe(200)
      expect(yield* removed.json).toMatchObject({ id: workspace.id })

      const listed = yield* request(WorkspacePaths.list, dir)
      expect(listed.status).toBe(200)
      expect(yield* listed.json).toEqual([])
    }),
  )

  it.live("serves list sync endpoint", () =>
    Effect.gen(function* () {
      Flag.GRAPHAGENT_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const type = `listed-${Math.random().toString(36).slice(2)}`
      registerAdapter(project.project.id, type, listedAdapter(path.join(dir, ".listed"), type))

      const response = yield* request(WorkspacePaths.syncList, dir, { method: "POST" })

      expect(response.status).toBe(204)
      const listed = yield* request(WorkspacePaths.list, dir)
      expect(yield* listed.json).toMatchObject([
        {
          type,
          name: "listed-test",
          branch: "listed/main",
          directory: path.join(dir, ".listed"),
          extra: { listed: true },
        },
      ])
    }),
  )

  it.live("returns a declared not found error when warping into a missing workspace", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const session = yield* Session.use.create({}).pipe(provideInstance(dir))
      const workspaceID = WorkspaceV2.ID.ascending("wrk_missing_warp")

      const response = yield* request(WorkspacePaths.warp, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: workspaceID, sessionID: session.id }),
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        name: "NotFoundError",
        data: { message: `Workspace not found: ${workspaceID}` },
      })
    }),
  )

  it.live("creates workspace with the TUI payload shape", () =>
    Effect.gen(function* () {
      Flag.GRAPHAGENT_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "local-test", localAdapter(path.join(dir, ".workspace")))

      const created = yield* request(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "local-test", branch: null }),
      })

      expect(created.status).toBe(200)
      expect((yield* created.json) as Workspace.Info).toMatchObject({
        type: "local-test",
        name: "local-test",
      })
    }),
  )

  it.live("creates a real git worktree workspace via the builtin adapter", () =>
    Effect.gen(function* () {
      Flag.GRAPHAGENT_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })

      const created = yield* requestServer(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "worktree", branch: null }),
      })

      const body = yield* Effect.promise(() => created.text())
      expect({ status: created.status, body }).toMatchObject({ status: 200 })
      const workspace = JSON.parse(body) as Workspace.Info
      expect(workspace).toMatchObject({ type: "worktree" })
    }),
  )

  it.live("routes local workspace requests through the workspace target directory", () =>
    Effect.gen(function* () {
      Flag.GRAPHAGENT_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const workspaceDir = path.join(dir, ".workspace-local")
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "local-target", localAdapter(workspaceDir))
      const created = yield* request(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "local-target", branch: null }),
      })
      const workspace = (yield* created.json) as Workspace.Info

      const url = new URL(`http://localhost${InstancePaths.path}`)
      url.searchParams.set("workspace", workspace.id)

      // The retired query parameter is ignored; only the workspace header
      // routes the request through the adapter target directory.
      const ignored = yield* request(url.toString(), dir)
      expect(ignored.status).toBe(200)
      expect(yield* ignored.json).toMatchObject({ directory: dir })

      const response = yield* request(url.toString(), dir, {
        headers: { "x-graphagent-workspace": workspace.id },
      })

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ directory: workspaceDir })
      yield* request(WorkspacePaths.remove.replace(":id", workspace.id), dir, { method: "DELETE" })
    }),
  )
})
