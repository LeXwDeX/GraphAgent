import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, QuestionNotFoundError } from "../errors"
import { parentSessionID } from "../middleware/child-session-guard"

// A custom answer is any label that is not one of the offered options of the
// question it answers.
const hasCustomAnswer = (request: Question.Request, answers: ReadonlyArray<Question.Answer>) =>
  answers.some((answer, index) => {
    const offered = new Set((request.questions[index]?.options ?? []).map((option) => option.label))
    return answer.some((label) => !offered.has(label))
  })

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const sessions = yield* Session.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      // #1026: a custom answer becomes the child's tool result, so a
      // child-owned request takes only its offered options. The session is read
      // only when an answer is not an option; an unknown request falls through
      // to 404.
      const request = (yield* svc.list()).find((item) => item.id === ctx.params.requestID)
      if (
        request &&
        hasCustomAnswer(request, ctx.payload.answers) &&
        (yield* parentSessionID(sessions, request.sessionID)) !== undefined
      )
        return yield* new InvalidRequestError({
          name: "InvalidRequestError",
          data: {
            message: "A question from a child session accepts only its offered options, not a custom answer.",
            field: "answers",
          },
        })
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                name: "QuestionNotFoundError",
                data: {
                  requestID: String(error.requestID),
                  message: `Question request not found: ${error.requestID}`,
                },
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              name: "QuestionNotFoundError",
              data: {
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              },
            }),
          ),
        ),
      )
      return true
    })

    const interact = Effect.fn("QuestionHttpApi.interact")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* svc.interact(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              name: "QuestionNotFoundError",
              data: {
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              },
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject).handle("interact", interact)
  }),
)
