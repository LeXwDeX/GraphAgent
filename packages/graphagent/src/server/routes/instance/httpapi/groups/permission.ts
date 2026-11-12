import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Permission } from "@/permission"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError, PermissionNotFoundError } from "../errors"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/permission"
const ReplyPayload = Schema.Struct({
  reply: PermissionV1.Reply,
  message: Schema.optional(Schema.String),
})

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: described(Schema.Array(PermissionV1.Request), "List of pending permissions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: PermissionV1.ID },
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, InvalidRequestError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Respond to permission request",
            description:
              "Approve or deny a permission request from the AI assistant. A request raised by a child session accepts only a fixed reply: a `message` is refused with 400.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "permission",
          description: "Experimental HttpApi permission routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
