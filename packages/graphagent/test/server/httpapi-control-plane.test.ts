import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { MoveSession } from "@graphagent/core/control-plane/move-session"
import { AbsolutePath } from "@graphagent/core/schema"
import { ProjectV2 } from "@graphagent/core/project"
import { SessionSchema } from "@graphagent/core/session/schema"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Session } from "../../src/session/session"
import { NotFoundError } from "../../src/storage/storage"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const input = MoveSession.Input.make({
  sessionID: SessionSchema.ID.make("ses_move"),
  destination: { directory: AbsolutePath.make("/destination") },
  moveChanges: true,
})
const called = Ref.makeUnsafe<MoveSession.Input | undefined>(undefined)

// #1026: move-session carries the session in its payload, so the handler asks
// the session store whether it is a child. "ses_move" is unknown to the store
// (the move service itself is mocked); "ses_move_child" has a parent.
const childInput = MoveSession.Input.make({ ...input, sessionID: SessionSchema.ID.make("ses_move_child") })
const childInfo: Session.Info = {
  id: childInput.sessionID,
  slug: "child",
  projectID: ProjectV2.ID.make("proj_move"),
  directory: "/source",
  parentID: SessionSchema.ID.make("ses_move_parent"),
  title: "child",
  version: "test",
  time: { created: 0, updated: 0 },
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide(schemaErrorLayer),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.mock(MoveSession.Service)({
      moveSession: (value) => Ref.set(called, value),
    }),
  ),
  Layer.provide(
    Layer.mock(Session.Service)({
      get: (id) =>
        id === childInfo.id
          ? Effect.succeed(childInfo)
          : Effect.fail(new NotFoundError({ message: `Session not found: ${id}` })),
    }),
  ),
)
const it = testEffect(apiLayer)

describe("control-plane HttpApi", () => {
  it.live("moves a session through the root control-plane route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(called)).toEqual(input)
    }),
  )

  it.live("refuses to move a child session with 409 before the move service runs", () =>
    Effect.gen(function* () {
      yield* Ref.set(called, undefined)
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(childInput)),
        HttpClient.execute,
      )

      expect(response.status).toBe(409)
      expect(yield* response.json).toEqual({
        name: "ChildSessionReadOnlyError",
        data: { sessionID: childInput.sessionID, message: expect.any(String) },
      })
      expect(yield* Ref.get(called)).toBeUndefined()
    }),
  )
})
