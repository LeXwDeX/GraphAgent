import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, PermissionNotFoundError } from "../errors"
import { parentSessionID } from "../middleware/child-session-guard"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const sessions = yield* Session.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      // #1026: a rejection `message` becomes the child's tool result, so a
      // child-owned request takes only a fixed reply. The request's session is
      // read from the pending record; an unknown request falls through to 404.
      if (ctx.payload.message) {
        const request = (yield* svc.list()).find((item) => item.id === ctx.params.requestID)
        if (request && (yield* parentSessionID(sessions, request.sessionID)) !== undefined)
          return yield* new InvalidRequestError({
            name: "InvalidRequestError",
            data: {
              message: "A permission request from a child session accepts only a fixed reply, not a message.",
              field: "message",
            },
          })
      }
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                name: "PermissionNotFoundError",
                data: {
                  requestID: String(error.requestID),
                  message: `Permission request not found: ${error.requestID}`,
                },
              }),
            ),
          ),
        )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
