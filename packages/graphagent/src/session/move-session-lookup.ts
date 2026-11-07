import { MoveSession } from "@graphagent/core/control-plane/move-session"
import { AbsolutePath } from "@graphagent/core/schema"
import { Effect, Layer } from "effect"
import { Session } from "./session"

/** Bridges MoveSession's narrow lookup to the V1 session store. */
export const layer = Layer.effect(
  MoveSession.SessionLookup,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return MoveSession.SessionLookup.of({
      get: Effect.fn("MoveSessionLookup.get")(function* (sessionID) {
        const info = yield* sessions.get(sessionID).pipe(
          Effect.catchTag("NotFoundError", () => Effect.fail(new MoveSession.SessionNotFoundError({ sessionID }))),
        )
        return {
          directory: AbsolutePath.make(info.directory),
          workspaceID: info.workspaceID,
          projectID: info.projectID,
        }
      }),
    })
  }),
)

export * as MoveSessionLookup from "./move-session-lookup"