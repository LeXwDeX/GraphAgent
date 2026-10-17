import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Goal } from "../goal/goal"
import * as QuestionGuidance from "@opencode-ai/core/question-guidance"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: QuestionGuidance.description,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const goal = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))
          if (goal && (yield* goal.isTurnDriven(ctx.sessionID))) {
            return {
              title: "Autonomous turn: question unavailable",
              output:
                "Interactive questions are disabled during Goal execution. Make a reasonable decision and continue. If user input is essential, explain the blocker in your final response so the goal can pause.",
              metadata: { answers: [] },
            }
          }
          // Answers supplied by a PreToolUse hook (allow + updatedInput.answers) replace the dialog.
          const preset = ctx.extra?.hookAnswers
          if (Array.isArray(preset) && preset.length === params.questions.length) {
            const answers = preset as ReadonlyArray<Question.Answer>
            return {
              title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
              output: QuestionGuidance.answeredOutput(params.questions, answers),
              metadata: { answers },
            }
          }
          const result = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: params.questions,
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            .pipe(
              Effect.map((answers) => ({ timedOut: false as const, answers })),
              Effect.catchTag("QuestionTimedOutError", () =>
                Effect.succeed({ timedOut: true as const, answers: [] as ReadonlyArray<Question.Answer> }),
              ),
              Effect.catchTag("QuestionRejectedError", () =>
                Effect.succeed({ rejected: true as const, answers: [] as ReadonlyArray<Question.Answer> }),
              ),
            )

          if ("rejected" in result && result.rejected) {
            return {
              title: "Question dismissed",
              output: QuestionGuidance.rejectedOutput,
              metadata: { answers: result.answers },
            }
          }

          if ("timedOut" in result && result.timedOut) {
            return {
              title: "Question timed out",
              output: QuestionGuidance.timeoutOutput(params.questions),
              metadata: { answers: result.answers },
            }
          }

          const answers = result.answers

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: QuestionGuidance.answeredOutput(params.questions, answers),
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
