import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { Database } from "@graphagent/core/database/database"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRouteContext,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { resetDatabase } from "../fixture/db"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await resetDatabase()
      }),
    )
  }),
)

const workspaceLayer = workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true })

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    NodeHttpServer.layerTest,
    NodeServices.layer,
    Database.defaultLayer,
    Project.defaultLayer,
    workspaceLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

const workspaceRoutingTestLayer = workspaceRoutingLayer

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createWorkspace = (input: { projectID: Project.Info["id"]; type: string; adapter: WorkspaceAdapter }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, input.adapter)
      const workspace = yield* Workspace.Service
      return yield* workspace.create({
        type: input.type,
        branch: null,
        extra: null,
        projectID: input.projectID,
      })
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  createWorkspace({
    projectID: input.projectID,
    type: input.type,
    adapter: localAdapter(input.directory),
  })

const ProbeResult = Schema.Struct({
  directory: Schema.String,
  workspaceID: Schema.optional(Schema.String),
})

const ProbeApi = HttpApi.make("workspace-routing-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("get", "/probe", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.patch("patch", "/probe", { query: WorkspaceRoutingQuery, success: Schema.Boolean }),
      HttpApiEndpoint.get("session", "/session", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.get("workspace", WorkspacePaths.list, {
        query: WorkspaceRoutingQuery,
        success: ProbeResult,
      }),
    )
    .middleware(WorkspaceRoutingMiddleware),
)

const routeContextResponse = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  return { directory: route.directory, workspaceID: route.workspaceID }
})

const probeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("get", () => routeContextResponse)
    .handle("patch", () => Effect.succeed(false))
    .handle("session", () => routeContextResponse)
    .handle("workspace", () => routeContextResponse),
)

const serveProbe = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(probeHandlers),
  Layer.provide(workspaceRoutingTestLayer),
  Layer.provide(Layer.mock(Session.Service)({})),
  HttpRouter.serve,
  Layer.build,
)

describe("HttpApi workspace routing middleware", () => {
  it.live("returns a missing workspace response for unknown workspace ids", () =>
    Effect.gen(function* () {
      const workspaceID = WorkspaceV2.ID.ascending("wrk_missing")
      // If the middleware resolves the workspace first, this handler is never
      // reached and the response should be the middleware error response.
      yield* serveProbe

      const response = yield* HttpClient.get(`/probe?workspace=${workspaceID}`)

      expect(response.status).toBe(500)
      expect(yield* response.text).toBe(`Workspace not found: ${workspaceID}`)
    }),
  )

  it.live("keeps control-plane routes local even when workspace is selected", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)

      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "control-plane-target",
        directory: workspaceDir,
      })

      // GET /session is a control-plane route: it lists sessions for the main
      // process and should not be redirected into the selected workspace target.
      yield* serveProbe

      const response = yield* HttpClient.get(`/session?workspace=${workspace.id}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ directory: process.cwd(), workspaceID: workspace.id })
    }),
  )

  it.live("keeps workspace control routes local even when workspace is selected", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "workspace-control-plane-target",
        directory: workspaceDir,
      })

      // Workspace CRUD/status routes manage the control plane itself. Selecting
      // a workspace should preserve the selected id for handlers, but must not
      // swap the route context to the workspace target directory.
      yield* serveProbe

      const response = yield* HttpClient.get(`${WorkspacePaths.list}?workspace=${workspace.id}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ directory: process.cwd(), workspaceID: workspace.id })
    }),
  )

  it.live("uses directory query/header fallback when no workspace is selected", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const queryDir = path.join(dir, "query-target")
      const headerDir = path.join(dir, "header-target")
      yield* serveProbe

      // Without a selected workspace, the middleware falls back to request
      // directory hints before using the process cwd.
      const queryResponse = yield* HttpClient.get(`/probe?directory=${encodeURIComponent(queryDir)}`)
      const headerResponse = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-graphagent-directory", headerDir),
        HttpClient.execute,
      )

      expect(queryResponse.status).toBe(200)
      expect(yield* queryResponse.json).toEqual({ directory: queryDir, workspaceID: null })
      expect(headerResponse.status).toBe(200)
      expect(yield* headerResponse.json).toEqual({ directory: headerDir, workspaceID: null })
    }),
  )

  it.live("routes local workspace requests through WorkspaceRouteContext", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)

      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "local-target",
        directory: workspaceDir,
      })

      yield* serveProbe

      // /probe is not a control-plane route, so selecting a local workspace
      // should swap the route context to the workspace target directory.
      const response = yield* HttpClient.get(`/probe?workspace=${workspace.id}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        directory: workspaceDir,
        workspaceID: workspace.id,
      })
    }),
  )
})
