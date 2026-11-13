import { MoveSession } from "@graphagent/core/control-plane/move-session"
import { ClientSessions } from "@/session/client-sessions"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { RootHttpApi } from "../api"
import { ApiMoveSessionError, MoveSessionPayload } from "../groups/control-plane"
import { assertSessionWritable } from "../middleware/child-session-guard"

export const controlPlaneHandlers = HttpApiBuilder.group(RootHttpApi, "controlPlane", (handlers) =>
  Effect.gen(function* () {
    const service = yield* MoveSession.Service
    const sessions = yield* Session.Service

    const moveSession = Effect.fn("ControlPlaneHttpApi.moveSession")(function* (ctx: {
      payload: typeof MoveSessionPayload.Type
    }) {
      // #1026: the session is in the payload, out of the session group's reach.
      yield* assertSessionWritable(sessions, ctx.payload.sessionID)
      yield* service.moveSession(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiMoveSessionError({
              name: "MoveSessionError",
              data: { message: message(error) },
            }),
        ),
      )
      ClientSessions.move({
        sessionID: ctx.payload.sessionID,
        directory: ctx.payload.destination.directory,
      })
    })

    return handlers.handle("moveSession", moveSession)
  }),
)

function message(error: MoveSession.Error) {
  if (error instanceof MoveSession.SessionNotFoundError) return `Session not found: ${error.sessionID}`
  if (error instanceof MoveSession.DestinationProjectMismatchError)
    return "Destination directory belongs to another project"
  if (error instanceof MoveSession.ApplyChangesError)
    return `Unable to apply your changes in the destination directory. The files may conflict with existing changes.`
  return error.message
}
