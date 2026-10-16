import { markPermissionRewrite } from "./permission-rewrite"
export * as QuestionTool from "./question"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import * as QuestionGuidance from "../question-guidance"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "question"

export const description = QuestionGuidance.description

export const Input = Schema.Struct({
  questions: Schema.Array(QuestionV2.Prompt).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(QuestionV2.Answer),
  timedOut: Schema.Boolean.pipe(Schema.optional),
  rejected: Schema.Boolean.pipe(Schema.optional),
})
export type Output = typeof Output.Type

export const toModelOutput = (
  questions: ReadonlyArray<QuestionV2.Prompt>,
  answers: ReadonlyArray<QuestionV2.Answer>,
  timedOut?: boolean,
  rejected?: boolean,
) => {
  if (rejected) return QuestionGuidance.rejectedOutput
  if (timedOut) return QuestionGuidance.timeoutOutput(questions)
  return QuestionGuidance.answeredOutput(questions, answers)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: markPermissionRewrite(
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              { type: "text", text: toModelOutput(input.questions, output.answers, output.timedOut, output.rejected) },
            ],
            execute: (input, context) =>
              permission
                .assert({
                  action: "question",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.mapError(() => new ToolFailure({ message: "Permission denied: question" })),
                  Effect.andThen(
                    question
                      .ask({
                        sessionID: context.sessionID,
                        questions: input.questions,
                        tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                      })
                      .pipe(
                        Effect.map((answers) => ({ answers })),
                        Effect.catchTag("QuestionV2.TimedOutError", () =>
                          Effect.succeed({ answers: [], timedOut: true as const }),
                        ),
                        Effect.catchTag("QuestionV2.RejectedError", () =>
                          Effect.succeed({ answers: [], rejected: true as const }),
                        ),
                        Effect.orDie,
                      ),
                  ),
                ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
