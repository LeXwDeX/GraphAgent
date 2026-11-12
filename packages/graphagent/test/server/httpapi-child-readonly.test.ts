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
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Database } from "@graphagent/core/database/database"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
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
import { httpApiLayer } from "./httpapi-layer"

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

afterEach(async () => {
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
        const encoded = child.id.replace("_", "%5F")
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
