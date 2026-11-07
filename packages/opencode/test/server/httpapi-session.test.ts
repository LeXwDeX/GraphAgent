import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/http"
import { layerWebSocketConstructorGlobal } from "effect/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect } from "../lib/effect"

const originalWorkspaces = Flag.GRAPHAGENT_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

function createPendingAssistant(sessionID: SessionIDType, parentID: MessageID) {
  return Session.Service.pipe(
    Effect.flatMap((svc) =>
      svc.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID,
        sessionID,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now() },
      }),
    ),
  )
}

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
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.GRAPHAGENT_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("uses the persisted session directory for prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const sessionDirectory = yield* tmpdirScoped({ git: true, config })
      const requestDirectory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "directory regression" }).pipe(
        provideInstanceEffect(sessionDirectory),
      )

      const response = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "which directory?" }],
          }),
        },
      )

      expect(response.status).toBe(200)
      yield* responseJson(response)

      const messages = yield* Session.use
        .messages({ sessionID: session.id })
        .pipe(provideInstanceEffect(sessionDirectory), Effect.orDie)
      const assistant = messages.find((message) => message.info.role === "assistant")
      expect(assistant?.info.role === "assistant" ? assistant.info.path : undefined).toEqual({
        cwd: sessionDirectory,
        root: sessionDirectory,
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.GRAPHAGENT_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-opencode-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir }), Effect.provide(Session.defaultLayer)),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "maps queued message validation and conflicts to declared HTTP errors",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "queued message errors" })
        const first = yield* createTextMessage(session.id, "first")
        const pending = yield* createPendingAssistant(session.id, first.info.id)
        const queued = yield* createTextMessage(session.id, "queued")
        const route = pathFor(SessionPaths.queuedMessage, { sessionID: session.id, messageID: queued.info.id })
        const expected = {
          partID: queued.part.id,
          expectedText: queued.part.text,
          expectedPartIDs: [queued.part.id],
        }

        const malformed = yield* request(route, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...expected, expectedPartIDs: undefined, text: "edited" }),
        })
        expect(malformed.status).toBe(400)

        const missing = yield* request(
          pathFor(SessionPaths.queuedMessage, { sessionID: session.id, messageID: MessageID.ascending() }),
          { method: "DELETE", headers, body: JSON.stringify(expected) },
        )
        expect(missing.status).toBe(404)

        const invalid = yield* request(
          pathFor(SessionPaths.queuedMessage, { sessionID: session.id, messageID: pending.id }),
          { method: "DELETE", headers, body: JSON.stringify(expected) },
        )
        expect(invalid.status).toBe(400)

        const removable = yield* createTextMessage(session.id, "edit then delete")
        const removableRoute = pathFor(SessionPaths.queuedMessage, {
          sessionID: session.id,
          messageID: removable.info.id,
        })
        const removableExpected = {
          partID: removable.part.id,
          expectedText: removable.part.text,
          expectedPartIDs: [removable.part.id],
        }
        const edited = yield* request(removableRoute, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...removableExpected, text: "edited before delete" }),
        })
        expect(edited.status).toBe(200)
        const removed = yield* request(removableRoute, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ ...removableExpected, expectedText: "edited before delete" }),
        })
        expect(removed.status).toBe(200)

        const sessions = yield* Session.Service
        yield* sessions.updateMessage({ ...queued.info, time: { ...queued.info.time, consumed: Date.now() } })
        const conflict = yield* request(route, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...expected, text: "edited" }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toMatchObject({
          _tag: "ConflictError",
          resource: "already_consumed",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects stale queued message snapshots without overwriting text or attachments",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "queued message stale" })
        const first = yield* createTextMessage(session.id, "first")
        yield* createPendingAssistant(session.id, first.info.id)
        const queued = yield* createTextMessage(session.id, "queued")
        const route = pathFor(SessionPaths.queuedMessage, { sessionID: session.id, messageID: queued.info.id })
        const expected = {
          partID: queued.part.id,
          expectedText: queued.part.text,
          expectedPartIDs: [queued.part.id],
        }
        const sessions = yield* Session.Service
        yield* sessions.updatePart({ ...queued.part, text: "changed elsewhere" })
        const file = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: queued.info.id,
          type: "file",
          mime: "text/plain",
          filename: "new.txt",
          url: "data:text/plain,new",
        })

        const staleEdit = yield* request(route, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...expected, text: "overwritten" }),
        })
        expect(staleEdit.status).toBe(409)

        const staleDelete = yield* request(route, {
          method: "DELETE",
          headers,
          body: JSON.stringify(expected),
        })
        expect(staleDelete.status).toBe(409)

        const current = (yield* sessions.messages({ sessionID: session.id })).find(
          (message) => message.info.id === queued.info.id,
        )
        expect(current?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ id: file.id })]))
        expect(current?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "changed elsewhere" })]))
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
