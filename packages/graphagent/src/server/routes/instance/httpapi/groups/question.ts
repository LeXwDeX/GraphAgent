import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError, QuestionNotFoundError } from "../errors"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/question"
const ReplyPayload = Schema.Struct({
  answers: Schema.Array(Question.Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
})

export const QuestionApi = HttpApi.make("question")
  .add(
    HttpApiGroup.make("question")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: described(Schema.Array(Question.Request), "List of pending questions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.list",
            summary: "List pending questions",
            description: "Get all pending question requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: QuestionID },
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Question answered successfully"),
          error: [HttpApiError.BadRequest, InvalidRequestError, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reply",
            summary: "Reply to question request",
            description:
              "Provide answers to a question request from the AI assistant. A request raised by a child session accepts only its offered options: a custom answer is refused with 400.",
          }),
        ),
        HttpApiEndpoint.post("reject", `${root}/:requestID/reject`, {
          params: { requestID: QuestionID },
          success: described(Schema.Boolean, "Question rejected successfully"),
          error: [HttpApiError.BadRequest, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reject",
            summary: "Reject question request",
            description: "Reject a question request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("interact", `${root}/:requestID/interact`, {
          params: { requestID: QuestionID },
          success: described(Schema.Boolean, "Question timeout cancelled successfully"),
          error: [HttpApiError.BadRequest, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.interact",
            summary: "Interact with question request",
            description: "Cancel the timeout after a user selects an option or focuses the custom answer input.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "question",
          description: "Question routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
