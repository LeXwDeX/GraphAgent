// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1026: the child-session guard on a tiny route, to pin what it costs. Routing
// has already read the addressed session row, so the guard must reuse it and add
// no lookup; only a URL spelling routing cannot parse (but the router accepts)
// makes the guard read once, from the router's decoded param.
import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { ProjectV2 } from "@graphagent/core/project"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Workspace } from "../../src/control-plane/workspace"
import {
  ChildSessionReadOnlyMiddleware,
  childSessionReadOnlyLayer,
} from "../../src/server/routes/instance/httpapi/middleware/child-session-guard"
import {
  WorkspaceRoutingMiddleware,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { NotFoundError } from "../../src/storage/storage"
import { testEffect } from "../lib/effect"

const parentID = SessionID.make("ses_guard_parent")
const childID = SessionID.make("ses_guard_child")
const topID = SessionID.make("ses_guard_top")

const info = (id: SessionID, parent?: SessionID): Session.Info => ({
  id,
  slug: "guard",
  projectID: ProjectV2.ID.make("proj_guard"),
  directory: "/guard",
  parentID: parent,
  title: "guard",
  version: "test",
  time: { created: 0, updated: 0 },
})

// Every Session.get the stack makes, routing's and the guard's alike.
const reads: string[] = []
const sessions = Layer.mock(Session.Service)({
  get: (id) =>
    Effect.suspend(() => {
      reads.push(id)
      if (id === childID) return Effect.succeed(info(childID, parentID))
      if (id === topID) return Effect.succeed(info(topID))
      return Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
    }),
})

// The real routing middleware and the real guard, in the production order:
// routing outermost, the guard inside it.
const ProbeApi = HttpApi.make("child-guard-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.post("write", "/session/:sessionID/probe", {
        params: { sessionID: SessionID },
        success: Schema.Boolean,
      }),
      HttpApiEndpoint.get("read", "/session/:sessionID/probe", {
        params: { sessionID: SessionID },
        success: Schema.Boolean,
      }),
    )
    .middleware(ChildSessionReadOnlyMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)

const serveProbe = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(
    HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
      handlers.handle("write", () => Effect.succeed(true)).handle("read", () => Effect.succeed(true)),
    ),
  ),
  Layer.provide([workspaceRoutingLayer, childSessionReadOnlyLayer]),
  Layer.provide(Layer.mock(Workspace.Service)({})),
  Layer.provide(sessions),
  HttpRouter.serve,
  Layer.build,
)

const it = testEffect(NodeHttpServer.layerTest)

afterEach(() => {
  reads.length = 0
})

const call = (method: "GET" | "POST", path: string) =>
  HttpClientRequest.make(method)(path).pipe(
    HttpClientRequest.setHeader("x-graphagent-directory", "/guard"),
    HttpClient.execute,
  )

describe("child session guard read budget", () => {
  it.live("refuses a child write on the session row routing already read", () =>
    Effect.gen(function* () {
      yield* serveProbe
      const response = yield* call("POST", `/session/${childID}/probe`)
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({ name: "ChildSessionReadOnlyError", data: { sessionID: childID } })
      expect(reads).toEqual([childID])
    }),
  )

  it.live("lets a top-level write through without a second lookup", () =>
    Effect.gen(function* () {
      yield* serveProbe
      expect((yield* call("POST", `/session/${topID}/probe`)).status).toBe(200)
      expect(reads).toEqual([topID])
    }),
  )

  it.live("never looks a session up for a read", () =>
    Effect.gen(function* () {
      yield* serveProbe
      expect((yield* call("GET", `/session/${childID}/probe`)).status).toBe(200)
      expect(reads).toEqual([childID])
    }),
  )

  it.live("reads once from the router's param when routing cannot parse the URL", () =>
    Effect.gen(function* () {
      yield* serveProbe
      // Duplicate slashes: routing's URL match fails and reads nothing; the guard
      // resolves the router's param and reads the session itself.
      const doubled = yield* call("POST", `//session/${childID}/probe`)
      expect(doubled.status).toBe(409)
      expect(reads).toEqual([childID])

      reads.length = 0
      // %-encoding: routing reads the raw (unknown) id; the guard reads the decoded one.
      const encoded = yield* call("POST", `/session/${childID.replaceAll("_", "%5F")}/probe`)
      expect(encoded.status).toBe(409)
      expect(yield* encoded.json).toMatchObject({ data: { sessionID: childID } })
      expect(reads).toEqual([childID.replaceAll("_", "%5F"), childID])
    }),
  )
})
