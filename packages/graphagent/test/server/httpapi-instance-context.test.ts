import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import * as Socket from "effect/socket/Socket"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { registerAdapter } from "../../src/control-plane/adapters"
import { Ripgrep } from "@graphagent/core/ripgrep"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { InstanceLayer } from "../../src/project/instance-layer"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { AfterResponse, afterResponseMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { waitGlobalBusEvent } from "./global-bus"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)

const workspaceLayer = workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true })

// Type-level stand-in only: the real request-scoped service is injected by
// afterResponseMiddleware. A runtime stub would be captured by
// HttpApiBuilder's build-time context, which shadows per-request services.
const afterResponseTypeOnly = Layer.empty as unknown as Layer.Layer<AfterResponse.Service>

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    NodeHttpServer.layerTest,
    NodeServices.layer,
    InstanceLayer.layer,
    Project.defaultLayer,
    workspaceLayer,
    afterResponseTypeOnly,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

const instanceContextTestLayer = Layer.mergeAll(
  instanceContextLayer,
  workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
)

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

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
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

const probeInstanceContext = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return {
    directory: instance?.directory,
    worktree: instance?.worktree,
    projectID: instance?.project.id,
    workspaceID,
  }
})

const ProbeResult = Schema.Struct({
  directory: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
  projectID: Schema.optional(Schema.String),
  workspaceID: Schema.optional(Schema.String),
})

const ProbeApi = HttpApi.make("instance-context-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("get", "/probe", { success: ProbeResult }),
      HttpApiEndpoint.get("session", "/session", { success: ProbeResult }),
      HttpApiEndpoint.post("dispose", "/dispose-probe", { success: Schema.Boolean }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)

const probeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("get", () => probeInstanceContext)
    .handle("session", () => probeInstanceContext)
    .handle(
      "dispose",
      Effect.fn("InstanceContextProbe.dispose")(function* () {
        const instance = yield* InstanceRef
        if (!instance) return false
        yield* (yield* AfterResponse.Service).dispose(instance)
        return true
      }),
    ),
)

const probeRoutes = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(probeHandlers),
  Layer.provide(instanceContextTestLayer),
  Layer.provide(Layer.mock(Session.Service)({})),
)

const serveProbe = () => probeRoutes.pipe(HttpRouter.serve, Layer.build)

const waitDisposedEvent = waitGlobalBusEvent({
  message: "timed out waiting for instance disposal",
  predicate: (event) => event.payload.type === "server.instance.disposed",
}).pipe(Effect.map((event) => ({ directory: event.directory, workspace: event.workspace })))

const serveDisposeProbe = () =>
  HttpRouter.serve(probeRoutes, {
    middleware: afterResponseMiddleware,
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.build)

describe("HttpApi instance context middleware", () => {
  it.live("provides instance context from the routed directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      yield* serveProbe()

      const response = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-graphagent-directory", dir),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        directory: dir,
        worktree: dir,
        projectID: project.project.id,
        workspaceID: null,
      })
    }),
  )

  it.live("falls back to the raw directory when URI decoding fails", () =>
    Effect.gen(function* () {
      yield* serveProbe()

      const response = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-graphagent-directory", "%E0%A4%A"),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: path.join(process.cwd(), "%E0%A4%A"),
      })
    }),
  )

  it.live("provides selected workspace id on control-plane routes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-workspace-ref",
        directory: workspaceDir,
      })
      yield* serveProbe()

      const response = yield* HttpClientRequest.get("/session").pipe(
        HttpClientRequest.setHeader("x-graphagent-directory", dir),
        HttpClientRequest.setHeader("x-graphagent-workspace", workspace.id),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: dir,
        workspaceID: workspace.id,
      })
    }),
  )

  it.live("uses workspace routing output instead of raw directory hints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-routing-output",
        directory: workspaceDir,
      })
      yield* serveProbe()

      const response = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-graphagent-directory", dir),
        HttpClientRequest.setHeader("x-graphagent-workspace", workspace.id),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: workspaceDir,
        workspaceID: workspace.id,
      })
    }),
  )

  it.live("preserves selected workspace id on instance disposal events", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-dispose-event",
        directory: workspaceDir,
      })
      yield* serveDisposeProbe()
      const disposed = yield* waitDisposedEvent.pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* HttpClientRequest.post("/dispose-probe").pipe(
        HttpClientRequest.setHeader("x-graphagent-workspace", workspace.id),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      expect(yield* Fiber.join(disposed)).toEqual({ directory: workspaceDir, workspace: workspace.id })
    }),
  )
})
