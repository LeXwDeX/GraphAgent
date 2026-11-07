import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
import { Goal } from "@/goal/goal"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const timeoutIt = testEffect(
  Layer.mergeAll(
    Layer.succeed(
      Question.Service,
      Question.Service.of({
        ask: () => Effect.fail(new Question.TimedOutError()),
        reply: () => Effect.die("unused"),
        reject: () => Effect.die("unused"),
        interact: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
      }),
    ),
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const rejectedIt = testEffect(
  Layer.mergeAll(
    Layer.succeed(
      Question.Service,
      Question.Service.of({
        ask: () => Effect.fail(new Question.RejectedError()),
        reply: () => Effect.die("unused"),
        reject: () => Effect.die("unused"),
        interact: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
      }),
    ),
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("tool.question", () => {
  rejectedIt.instance(
    "reports dismissal to the model without treating it as consent",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* QuestionTool).init()
        const result = yield* tool.execute({ questions: [] }, ctx)
        expect(result.title).toBe("Question dismissed")
        expect(result.output).toContain("Do not repeat this question")
        expect(result.output).toContain("without answering")
        expect(result.metadata).toMatchObject({ answers: [] })
      }),
    { git: true },
  )

  timeoutIt.instance(
    "reports timeout without fabricating a user answer",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* QuestionTool).init()
        const result = yield* tool.execute(
          {
            questions: [
              {
                question: "What should happen?",
                header: "Action",
                options: [{ label: "Continue", description: "Continue independently" }],
              },
            ],
          },
          ctx,
        )
        expect(result.title).toBe("Question timed out")
        expect(result.output).toContain("The user is temporarily away from the computer and did not answer.")
        expect(result.output).toContain(
          "Choose the best solution yourself based on the task, existing instructions, and available evidence.",
        )
        expect(result.output).toContain('fallback candidate: "Continue"')
        expect(result.output).toContain("recommendation, not a restriction")
        expect(result.output).toContain("Silence never grants new scope")
        expect(result.output).toContain("does not by itself block work")
        expect(result.metadata).toMatchObject({ answers: [] })
      }),
    { git: true },
  )

  it.instance("should successfully execute with valid question parameters", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite color?",
          header: "Color",
          options: [
            { label: "Red", description: "The color of passion" },
            { label: "Blue", description: "The color of sky" },
          ],
          multiple: false,
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
    }),
  )

  it.instance("should now pass with a header longer than 12 but less than 30 chars", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})

it.instance("question reads Goal from the execution context, not registry construction", () =>
  Effect.gen(function* () {
    // This test layer intentionally has no Goal at tool construction time.
    const tool = yield* (yield* QuestionTool).init()
    const questions = yield* Question.Service
    const result = yield* tool
      .execute({ questions: [] }, ctx)
      .pipe(
        Effect.provide(Layer.mock(Goal.Service, { isTurnDriven: () => Effect.succeed(true) })),
        Effect.timeout("2 seconds"),
      )
    expect(result.output).toContain("Interactive questions are disabled")
    expect(yield* questions.list()).toHaveLength(0)
  }),
)
