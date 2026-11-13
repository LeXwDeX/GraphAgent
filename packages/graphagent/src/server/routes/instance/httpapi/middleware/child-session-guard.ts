// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { ChildSessionReadOnlyError } from "../errors"
import { WorkspaceRouteContext } from "./workspace-routing"

// #1026: a child session (`parentID != null`, a task or DAG node run) only takes
// input from its parent agent. This is the operation-layer guard: over HTTP,
// every write that addresses a child session is refused with 409
// ChildSessionReadOnlyError unless it is on the allow-list below. It is declared
// on the whole session group, so an endpoint added later is denied by default.
export class ChildSessionReadOnlyMiddleware extends HttpApiMiddleware.Service<
  ChildSessionReadOnlyMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@graphagent/HttpApiChildSessionReadOnly", {
  error: ChildSessionReadOnlyError,
}) {}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Writes that stay open on a child session, keyed `${METHOD} ${endpoint.path}`
 * with the path exactly as the endpoint declares it. Everything else that is not
 * a safe method is refused. `POST /session` needs no entry: it has no target
 * session, and `parentID` is rejected by its payload schema.
 *
 * Adding an entry is a product decision. test/server/httpapi-child-readonly.test.ts
 * pins this set against its own copy of the classification.
 */
export const ChildSessionWriteAllowList: ReadonlySet<string> = new Set([
  // The user answers a child's permission request. Only fixed replies are
  // accepted: the body has no free-text field, and POST /permission/:id/reply
  // refuses `message` for child-owned requests.
  "POST /session/:sessionID/permissions/:permissionID",
  // A side question reads the history and writes nothing to the session.
  "POST /session/:sessionID/btw",
  "DELETE /session/:sessionID/btw/:btwID",
  // Client activity and background-task view lease; no typed content.
  "POST /session/:sessionID/attention",
])

/** The method + path half of the decision: may this endpoint write to a child? */
export function isChildSessionWriteAllowed(method: string, path: string) {
  return SAFE_METHODS.has(method) || ChildSessionWriteAllowList.has(`${method} ${path}`)
}

export function childSessionReadOnly(sessionID: string) {
  return new ChildSessionReadOnlyError({
    name: "ChildSessionReadOnlyError",
    data: {
      sessionID,
      message: "This is a child session and is read-only. Send input to its parent agent instead.",
    },
  })
}

/** The parent of an existing session; undefined for a top-level or unknown one. */
export const parentSessionID = (sessions: Session.Interface, sessionID: SessionID) =>
  sessions.get(sessionID).pipe(
    Effect.map((info) => info.parentID),
    Effect.catchIf(
      (error): error is NotFoundError => NotFoundError.isInstance(error),
      () => Effect.succeed(undefined),
    ),
  )

/**
 * Handler-level form of the same decision, for writes that carry the target
 * session in the payload (move-session, workspace warp) where the group
 * middleware cannot see it. An unknown session passes so the endpoint's own
 * not-found handling stays in charge.
 */
export const assertSessionWritable = Effect.fn("ChildSessionGuard.assertSessionWritable")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const parentID = yield* parentSessionID(sessions, sessionID)
  if (parentID !== undefined) yield* childSessionReadOnly(sessionID)
})

export const childSessionReadOnlyLayer = Layer.effect(
  ChildSessionReadOnlyMiddleware,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return ChildSessionReadOnlyMiddleware.of((effect, { endpoint }) =>
      Effect.gen(function* () {
        if (isChildSessionWriteAllowed(endpoint.method, endpoint.path)) return yield* effect
        // The router's decoded param is what the handler acts on. Routing's
        // URL-parsed session misses spellings the router still accepts (//,
        // case, %-encoding), so it only saves a read when it names the same id.
        const target = (yield* HttpRouter.RouteContext).params.sessionID
        if (target === undefined || !Schema.is(SessionID)(target)) return yield* effect
        const route = yield* WorkspaceRouteContext
        const parentID =
          route.session?.id === target ? route.session.parentID : yield* parentSessionID(sessions, target)
        if (parentID !== undefined) return yield* childSessionReadOnly(target)
        return yield* effect
      }),
    )
  }),
)
