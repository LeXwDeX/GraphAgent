// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1026 PR2: the operation-layer read-only guard. A child session (parentID !=
// null) takes input only from its parent agent, so every HTTP write that
// addresses one is refused with 409 ChildSessionReadOnlyError, except a short
// allow-list. The guard is a group-level middleware (default deny); this file
// pins the classification of every session-group write endpoint so a new one
// cannot ship unclassified, and exercises the real route tree for each.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { OpenApi } from "effect/http-api"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Database } from "@graphagent/core/database/database"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { SessionApi, SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import {
  ChildSessionReadOnlyMiddleware,
  ChildSessionWriteAllowList,
} from "../../src/server/routes/instance/httpapi/middleware/child-session-guard"
import { Session } from "@/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, httpApiLayerWith } from "./httpapi-layer"

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

// Pending permission/question requests live in memory inside the server's own
// services, so the free-text tests replace those two with doubles that hold a
// canned pending list and record what the handler passes on. The real route
// tree, middleware and Session store stay in place.
const permissionReplies: Array<{ requestID: string; reply: string; message?: string }> = []
const questionReplies: Array<{ requestID: string; answers: ReadonlyArray<ReadonlyArray<string>> }> = []
let pendingPermissions: PermissionV1.Request[] = []
let pendingQuestions: Question.Request[] = []

const permissionDouble = Layer.mock(Permission.Service)({
  list: () => Effect.sync(() => pendingPermissions),
  reply: (input) =>
    pendingPermissions.some((item) => item.id === input.requestID)
      ? Effect.sync(() => void permissionReplies.push({ ...input, requestID: String(input.requestID) }))
      : Effect.fail(new PermissionV1.NotFoundError({ requestID: input.requestID })),
})
const questionDouble = Layer.mock(Question.Service)({
  list: () => Effect.sync(() => pendingQuestions),
  reply: (input) =>
    pendingQuestions.some((item) => item.id === input.requestID)
      ? Effect.sync(() => void questionReplies.push({ ...input, requestID: String(input.requestID) }))
      : Effect.fail(new Question.NotFoundError({ requestID: input.requestID })),
})
const itInteractive = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    httpApiLayerWith([
      LayerNode.replace(Permission.node, permissionDouble),
      LayerNode.replace(Question.node, questionDouble),
    ]),
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  permissionReplies.length = 0
  questionReplies.length = 0
  pendingPermissions = []
  pendingQuestions = []
  await disposeAllInstances()
  await resetDatabase()
})

type Classification = "deny" | "allow" | "untargeted"

// The reviewed classification of every non-GET endpoint in the session group,
// keyed `${METHOD} ${path}`. "deny": 409 for a child session. "allow": stays
// open on a child. "untargeted": has no target session. Writing it out here,
// apart from the guard's own allow-list, is the point: moving an endpoint
// between sets, or adding one, has to change both places.
const classification: Record<string, Classification> = {
  // prompt-like writes
  "POST /session/:sessionID/message": "deny",
  "POST /session/:sessionID/prompt_async": "deny",
  "POST /session/:sessionID/command": "deny",
  "POST /session/:sessionID/shell": "deny",
  "POST /session/:sessionID/resume": "deny",
  "POST /session/:sessionID/init": "deny",
  "POST /session/:sessionID/summarize": "deny",
  "POST /session/:sessionID/model": "deny",
  // history and revert
  "POST /session/:sessionID/revert": "deny",
  "POST /session/:sessionID/unrevert": "deny",
  "DELETE /session/:sessionID/message/:messageID": "deny",
  "DELETE /session/:sessionID/message/:messageID/part/:partID": "deny",
  "PATCH /session/:sessionID/message/:messageID/part/:partID": "deny",
  "PATCH /session/:sessionID/message/:messageID/queued": "deny",
  "DELETE /session/:sessionID/message/:messageID/queued": "deny",
  // lifecycle of the session itself
  "PATCH /session/:sessionID": "deny",
  "DELETE /session/:sessionID": "deny",
  "POST /session/:sessionID/fork": "deny",
  "POST /session/:sessionID/abort": "deny",
  // session-scoped hooks
  "POST /session/:sessionID/hook": "deny",
  "DELETE /session/:sessionID/hook/:hookID": "deny",
  "POST /session/:sessionID/hook/:hookID/cancel": "deny",
  // open on a child
  "POST /session/:sessionID/permissions/:permissionID": "allow",
  "POST /session/:sessionID/btw": "allow",
  "DELETE /session/:sessionID/btw/:btwID": "allow",
  "POST /session/:sessionID/attention": "allow",
  // no session in the path: creates a new top-level session
  "POST /session": "untargeted",
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const endpoints = Object.values(SessionApi.groups.session.endpoints)
const writeKey = (endpoint: { method: string; path: string }) => `${endpoint.method} ${endpoint.path}`
const writes = endpoints.filter((endpoint) => !SAFE_METHODS.has(endpoint.method))
const withClassification = (kind: Classification) =>
  writes.filter((endpoint) => classification[writeKey(endpoint)] === kind)

const dummyParams: Record<string, string> = {
  messageID: MessageID.ascending(),
  partID: PartID.ascending(),
  permissionID: "per_childreadonly",
  hookID: "hook_childreadonly",
  btwID: "btw_childreadonly",
}

function pathFor(path: string, sessionID: string) {
  return path.replace(/:(\w+)/g, (_match, name: string) =>
    name === "sessionID" ? sessionID : (dummyParams[name] ?? name),
  )
}

function call(directory: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-graphagent-directory": directory }
  if (body !== undefined) headers["content-type"] = "application/json"
  return HttpClientRequest.fromWeb(
    new Request(new URL(path, "http://localhost"), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ).pipe(HttpClientRequest.setUrl(path), HttpClient.execute)
}

const family = Effect.gen(function* () {
  const test = yield* TestInstance
  const parent = yield* Session.use.create({ title: "parent" })
  const child = yield* Session.use.create({ title: "child", parentID: parent.id })
  return { directory: test.directory, parent, child }
})

describe("child session read-only guard", () => {
  it.effect("classifies every session-group write endpoint", () =>
    Effect.sync(() => {
      const seen = writes.map(writeKey).sort()
      expect(seen).toEqual(Object.keys(classification).sort())
      // The guard's allow-list is exactly the "allow" rows: widening it fails here.
      expect([...ChildSessionWriteAllowList].sort()).toEqual(withClassification("allow").map(writeKey).sort())
      // The group middleware sees the target only as the `:sessionID` path param.
      // A write that names its session elsewhere (payload) would slip past it, so
      // it may not be filed as guarded: it needs its own handler-level check.
      for (const endpoint of writes) {
        expect([writeKey(endpoint), endpoint.path.includes(":sessionID")]).toEqual([
          writeKey(endpoint),
          classification[writeKey(endpoint)] !== "untargeted",
        ])
      }
    }),
  )

  it.effect("declares the guard on every endpoint of the session group", () =>
    Effect.sync(() => {
      for (const endpoint of endpoints) {
        expect([endpoint.identifier, endpoint.middlewares.has(ChildSessionReadOnlyMiddleware)]).toEqual([
          endpoint.identifier,
          true,
        ])
      }
    }),
  )

  it.effect("documents the 409 on exactly the writes the guard can refuse", () =>
    Effect.sync(() => {
      const documented: string[] = []
      for (const [path, item] of Object.entries(record(OpenApi.fromApi(PublicApi).paths))) {
        for (const [method, operation] of Object.entries(record(item))) {
          const conflict = record(record(record(operation).responses)["409"])
          if (JSON.stringify(conflict).includes("#/components/schemas/ChildSessionReadOnlyError"))
            documented.push(`${method.toUpperCase()} ${path}`)
        }
      }
      const denied = withClassification("deny").map((endpoint) =>
        writeKey({ method: endpoint.method, path: endpoint.path.replace(/:(\w+)/g, "{$1}") }),
      )
      // Reads, the allow-listed writes and creation have no target to refuse; the
      // session group's shared middleware must not leak its 409 onto them.
      expect(documented.sort()).toEqual(
        [
          ...denied,
          "POST /experimental/session/{sessionID}/background",
          "POST /experimental/workspace/warp",
          "POST /experimental/control-plane/move-session",
        ].sort(),
      )
    }),
  )

  it.instance(
    "refuses every denied write on a child session with 409 and the declared shape",
    () =>
      Effect.gen(function* () {
        const { directory, child } = yield* family
        for (const endpoint of withClassification("deny")) {
          const response = yield* call(directory, endpoint.method, pathFor(endpoint.path, child.id), {})
          const body = yield* response.json
          expect([writeKey(endpoint), response.status]).toEqual([writeKey(endpoint), 409])
          expect(body).toEqual({
            name: "ChildSessionReadOnlyError",
            data: { sessionID: child.id, message: expect.any(String) },
          })
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "leaves the allow-listed writes open on a child session",
    () =>
      Effect.gen(function* () {
        const { directory, child } = yield* family
        for (const endpoint of withClassification("allow")) {
          const response = yield* call(directory, endpoint.method, pathFor(endpoint.path, child.id), {})
          expect([writeKey(endpoint), response.status === 409]).toEqual([writeKey(endpoint), false])
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps reads and top-level writes working",
    () =>
      Effect.gen(function* () {
        const { directory, parent, child } = yield* family
        expect((yield* call(directory, "GET", pathFor(SessionPaths.get, child.id))).status).toBe(200)
        expect((yield* call(directory, "GET", pathFor(SessionPaths.messages, child.id))).status).toBe(200)
        expect((yield* call(directory, "GET", pathFor(SessionPaths.children, parent.id))).status).toBe(200)
        const rename = yield* call(directory, "PATCH", pathFor(SessionPaths.update, parent.id), { title: "renamed" })
        expect(rename.status).toBe(200)
        // A session that does not exist is still the handler's 404, not the guard's 409.
        const missing = yield* call(directory, "PATCH", pathFor(SessionPaths.update, "ses_missing_child_guard"), {
          title: "x",
        })
        expect(missing.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "refuses a child session under every spelling of its URL the router accepts",
    () =>
      Effect.gen(function* () {
        const { directory, child } = yield* family
        // The router normalizes duplicate slashes, case and %-encoding before it
        // matches, and the handler acts on the decoded param. The guard follows
        // the same param, so none of these slips past a URL-parsed lookup.
        const encoded = child.id.replaceAll("_", "%5F")
        const variants = [
          `/session/${child.id}/message/`,
          `//session/${child.id}/message`,
          `/session//${child.id}/message`,
          `/SESSION/${child.id}/MESSAGE`,
          `/session/${encoded}/message`,
        ]
        for (const variant of variants) {
          const response = yield* call(directory, "POST", variant, {})
          expect([variant, response.status]).toEqual([variant, 409])
          expect(yield* response.json).toMatchObject({
            name: "ChildSessionReadOnlyError",
            data: { sessionID: child.id },
          })
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "refuses promptAsync on a child synchronously, before anything is queued",
    () =>
      Effect.gen(function* () {
        const { directory, child } = yield* family
        const response = yield* call(directory, "POST", pathFor(SessionPaths.promptAsync, child.id), {
          agent: "build",
          parts: [{ type: "text", text: "do something" }],
        })
        // 409, not the 204 a forked handler would have returned.
        expect(response.status).toBe(409)
        expect(yield* Session.use.messages({ sessionID: child.id })).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects parentID on session create and still creates top-level sessions",
    () =>
      Effect.gen(function* () {
        const { directory, parent } = yield* family
        const rejected = yield* call(directory, "POST", SessionPaths.create, { parentID: parent.id, title: "smuggled" })
        expect(rejected.status).toBe(400)
        // Rejected, not stripped into a top-level session.
        expect((yield* Session.use.children(parent.id)).map((item) => item.title)).toEqual(["child"])

        const created = yield* call(directory, "POST", SessionPaths.create, { title: "top level" })
        expect(created.status).toBe(200)
        expect(yield* created.json).toMatchObject({ title: "top level" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "guards the experimental routes that address a session outside the group",
    () =>
      Effect.gen(function* () {
        const { directory, parent, child } = yield* family
        const background = "/experimental/session/:sessionID/background"
        const refused = yield* call(directory, "POST", pathFor(background, child.id))
        expect(refused.status).toBe(409)
        expect(yield* refused.json).toMatchObject({ name: "ChildSessionReadOnlyError", data: { sessionID: child.id } })
        expect((yield* call(directory, "POST", pathFor(background, parent.id))).status).toBe(200)

        // The workspace warp names its session in the payload.
        const warp = yield* call(directory, "POST", "/experimental/workspace/warp", { id: null, sessionID: child.id })
        expect(warp.status).toBe(409)
        expect(yield* warp.json).toMatchObject({ name: "ChildSessionReadOnlyError", data: { sessionID: child.id } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

// A reply's free text (a rejection `message`, a custom answer) becomes the child
// agent's tool result, so for a request raised by a child session the server
// takes only a fixed choice. Which session raised the request is read from the
// service's pending record.
describe("free text on replies to child-session requests", () => {
  const permissionRequest = (id: string, sessionID: Session.Info["id"]): PermissionV1.Request => ({
    id: PermissionV1.ID.make(id),
    sessionID,
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    always: [],
  })
  const questionRequest = (id: string, sessionID: Session.Info["id"]): Question.Request => ({
    id: QuestionID.make(id),
    sessionID,
    questions: [
      {
        question: "Proceed?",
        header: "Proceed",
        options: [
          { label: "Yes", description: "go" },
          { label: "No", description: "stop" },
        ],
      },
      {
        question: "Which?",
        header: "Which",
        options: [{ label: "A", description: "a" }],
        multiple: true,
      },
    ],
  })

  itInteractive.instance(
    "refuses a permission message on a child's request and passes everything else",
    () =>
      Effect.gen(function* () {
        const { directory, parent, child } = yield* family
        pendingPermissions = [
          permissionRequest("per_child_free_text", child.id),
          permissionRequest("per_top_free_text", parent.id),
        ]
        const reply = (id: string, body: unknown) => call(directory, "POST", `/permission/${id}/reply`, body)

        const refused = yield* reply("per_child_free_text", { reply: "reject", message: "do it differently" })
        expect(refused.status).toBe(400)
        expect(yield* refused.json).toMatchObject({
          name: "InvalidRequestError",
          data: { field: "message", message: expect.any(String) },
        })
        expect(permissionReplies).toEqual([])

        // The fixed reply goes through, with or without an empty message.
        expect((yield* reply("per_child_free_text", { reply: "reject" })).status).toBe(200)
        expect(permissionReplies).toEqual([{ requestID: "per_child_free_text", reply: "reject" }])

        // A top-level session's request still takes feedback.
        const top = yield* reply("per_top_free_text", { reply: "reject", message: "use the other branch" })
        expect(top.status).toBe(200)
        expect(permissionReplies.at(-1)).toEqual({
          requestID: "per_top_free_text",
          reply: "reject",
          message: "use the other branch",
        })

        // An unknown request is still the service's 404.
        const unknown = yield* reply("per_unknown_free_text", { reply: "reject", message: "x" })
        expect(unknown.status).toBe(404)
        expect(yield* unknown.json).toMatchObject({ name: "PermissionNotFoundError" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  itInteractive.instance(
    "refuses a custom question answer on a child's request and accepts offered options",
    () =>
      Effect.gen(function* () {
        const { directory, parent, child } = yield* family
        pendingQuestions = [
          questionRequest("que_child_free_text", child.id),
          questionRequest("que_top_free_text", parent.id),
        ]
        const reply = (id: string, answers: unknown) => call(directory, "POST", `/question/${id}/reply`, { answers })

        const custom = yield* reply("que_child_free_text", [["Yes"], ["something else"]])
        expect(custom.status).toBe(400)
        expect(yield* custom.json).toMatchObject({
          name: "InvalidRequestError",
          data: { field: "answers", message: expect.any(String) },
        })
        // An answer beyond the offered questions has no options to match either.
        expect((yield* reply("que_child_free_text", [["Yes"], ["A"], ["extra"]])).status).toBe(400)
        expect(questionReplies).toEqual([])

        expect((yield* reply("que_child_free_text", [["Yes"], ["A"]])).status).toBe(200)
        expect(questionReplies).toEqual([{ requestID: "que_child_free_text", answers: [["Yes"], ["A"]] }])

        // A top-level session's question still takes a custom answer.
        expect((yield* reply("que_top_free_text", [["anything"], []])).status).toBe(200)
        expect(questionReplies.at(-1)).toEqual({ requestID: "que_top_free_text", answers: [["anything"], []] })

        const unknown = yield* reply("que_unknown_free_text", [["whatever"]])
        expect(unknown.status).toBe(404)
        expect(yield* unknown.json).toMatchObject({ name: "QuestionNotFoundError" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
