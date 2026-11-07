import { afterEach, expect } from "bun:test"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Queue } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Question } from "../../src/question"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceStore } from "../../src/project/instance-store"
import { QuestionID } from "../../src/question/schema"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
  withTmpdirInstance,
} from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"

const it = testEffect(
  Layer.mergeAll(Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)), CrossSpawnSpawner.defaultLayer),
)
const lifecycle = testEffect(
  Layer.mergeAll(
    Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)
const configured = testEffect(
  Layer.mergeAll(
    Question.layer.pipe(
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({ question_timeout: 1 }) })),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const longConfigured = testEffect(
  Layer.mergeAll(
    Question.layer.pipe(
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({ question_timeout: 600 }) })),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const askEffect = Effect.fn("QuestionTest.ask")(function* (input: {
  sessionID: SessionID
  questions: ReadonlyArray<Question.Info>
  tool?: Question.Tool
}) {
  const question = yield* Question.Service
  return yield* question.ask(input)
})

const listEffect = Question.Service.use((svc) => svc.list())

const replyEffect = Effect.fn("QuestionTest.reply")(function* (input: {
  requestID: QuestionID
  answers: ReadonlyArray<Question.Answer>
}) {
  const question = yield* Question.Service
  yield* question.reply(input)
})

const rejectEffect = Effect.fn("QuestionTest.reject")(function* (id: QuestionID) {
  const question = yield* Question.Service
  yield* question.reject(id)
})

const interactEffect = Effect.fn("QuestionTest.interact")(function* (id: QuestionID) {
  const question = yield* Question.Service
  yield* question.interact(id)
})

afterEach(async () => {
  await disposeAllInstances()
})

/** Reject all pending questions so dangling Deferred fibers don't hang the test. */
const rejectAll = Effect.gen(function* () {
  yield* Effect.forEach(yield* listEffect, (req) => rejectEffect(req.id), { discard: true })
})

const sample = [
  {
    question: "What would you like to do?",
    header: "Action",
    options: [{ label: "Continue", description: "Continue" }],
  },
]

it.effect(
  "ask - uses the default timeout and removes the request after timeout",
  Effect.gen(function* () {
    const fiber = yield* askEffect({ sessionID: SessionID.make("ses_timeout"), questions: sample }).pipe(
      Effect.forkScoped,
    )
    const pending = yield* waitForPending(1)
    expect(pending[0]?.expiresAt).toBe(60_000)
    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.seconds(60))
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.TimedOutError)
    expect(yield* listEffect).toEqual([])
  }).pipe(withTmpdirInstance({ git: true })),
)

configured.effect(
  "ask - reads the configured timeout",
  Effect.gen(function* () {
    const fiber = yield* askEffect({ sessionID: SessionID.make("ses_configured_timeout"), questions: sample }).pipe(
      Effect.forkScoped,
    )
    const pending = yield* waitForPending(1)
    expect(pending[0]?.expiresAt).toBe(1_000)
    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.seconds(1))
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.TimedOutError)
  }).pipe(withTmpdirInstance({ git: true })),
)

it.effect(
  "interact - refreshes inactivity but times out an abandoned partial answer",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_interact"),
      questions: [...sample, ...sample],
    }).pipe(Effect.forkScoped)
    const pending = yield* waitForPending(1)
    yield* interactEffect(pending[0].id)
    expect((yield* listEffect)[0]?.expiresAt).toBeUndefined()
    yield* TestClock.adjust(Duration.seconds(59))
    yield* interactEffect(pending[0].id)
    yield* TestClock.adjust(Duration.seconds(59))
    expect(yield* listEffect).toHaveLength(1)
    yield* TestClock.adjust(Duration.seconds(1))
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.TimedOutError)
    expect(yield* listEffect).toEqual([])
    expect(yield* question.reply({ requestID: pending[0].id, answers: [["Continue"]] }).pipe(Effect.flip)).toEqual(
      new Question.NotFoundError({ requestID: pending[0].id }),
    )
  }).pipe(withTmpdirInstance({ git: true })),
)

it.effect(
  "interact - caps the response phase despite continued activity",
  Effect.gen(function* () {
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_interaction_cap"),
      questions: sample,
    }).pipe(Effect.forkScoped)
    const pending = yield* waitForPending(1)
    yield* interactEffect(pending[0].id)
    for (let interval = 0; interval < 9; interval++) {
      yield* TestClock.adjust(Duration.seconds(30))
      yield* interactEffect(pending[0].id)
    }
    yield* TestClock.adjust(Duration.seconds(30))
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.TimedOutError)
    expect(yield* listEffect).toEqual([])
  }).pipe(withTmpdirInstance({ git: true })),
)

longConfigured.effect(
  "interact - observes a response cap shorter than the configured timeout",
  Effect.gen(function* () {
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_shortened_interaction_cap"),
      questions: sample,
    }).pipe(Effect.forkScoped)
    const pending = yield* waitForPending(1)
    expect(pending[0]?.expiresAt).toBe(600_000)
    yield* interactEffect(pending[0].id)
    yield* TestClock.adjust(Duration.seconds(299))
    expect(yield* listEffect).toHaveLength(1)
    yield* TestClock.adjust(Duration.seconds(1))
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* listEffect).toEqual([])
  }).pipe(withTmpdirInstance({ git: true })),
)

it.effect(
  "reply - wins before the deadline and prevents a later timeout",
  Effect.gen(function* () {
    const fiber = yield* askEffect({ sessionID: SessionID.make("ses_reply_race"), questions: sample }).pipe(
      Effect.forkScoped,
    )
    const pending = yield* waitForPending(1)
    yield* TestClock.adjust(Duration.seconds(59))
    yield* replyEffect({ requestID: pending[0].id, answers: [["Continue"]] })
    expect(yield* Fiber.join(fiber)).toEqual([["Continue"]])
    yield* TestClock.adjust(Duration.hours(1))
    expect(yield* listEffect).toEqual([])
  }).pipe(withTmpdirInstance({ git: true })),
)

it.effect(
  "ask - interruption removes the pending request and timer",
  Effect.gen(function* () {
    const fiber = yield* askEffect({ sessionID: SessionID.make("ses_abort"), questions: sample }).pipe(
      Effect.forkScoped,
    )
    yield* waitForPending(1)
    yield* Fiber.interrupt(fiber)
    expect(yield* listEffect).toEqual([])
    yield* TestClock.adjust(Duration.hours(1))
    expect(yield* listEffect).toEqual([])
  }).pipe(withTmpdirInstance({ git: true })),
)

const waitForPending = Effect.fn("QuestionTest.waitForPending")(function* (count: number) {
  const question = yield* Question.Service
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const pending = yield* question.list()
    if (pending.length === count) return pending
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

it.instance(
  "ask - remains pending until answered",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }),
  { git: true },
)

it.instance(
  "ask - adds to pending list",
  () =>
    Effect.gen(function* () {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions,
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
      yield* rejectAll
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }),
  { git: true },
)

// reply tests

it.instance(
  "reply - resolves the pending ask with answers",
  () =>
    Effect.gen(function* () {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions,
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      const requestID = pending[0].id

      yield* replyEffect({
        requestID,
        answers: [["Option 1"]],
      })

      expect(yield* Fiber.join(fiber)).toEqual([["Option 1"]])
    }),
  { git: true },
)

it.instance(
  "reply - removes from pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending.length).toBe(1)

      yield* replyEffect({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })
      yield* Fiber.join(fiber)

      const after = yield* listEffect
      expect(after.length).toBe(0)
    }),
  { git: true },
)

it.instance(
  "reply - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* replyEffect({
        requestID: QuestionID.make("que_unknown"),
        answers: [["Option 1"]],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Question.NotFoundError", requestID: "que_unknown" })
      }
    }),
  { git: true },
)

// reject tests

it.instance(
  "reject - throws RejectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      yield* rejectEffect(pending[0].id)

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("QuestionRejectedError")
    }),
  { git: true },
)

it.instance(
  "reject - removes from pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending.length).toBe(1)

      yield* rejectEffect(pending[0].id)
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")

      const after = yield* listEffect
      expect(after.length).toBe(0)
    }),
  { git: true },
)

it.instance(
  "reject - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* rejectEffect(QuestionID.make("que_unknown")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Question.NotFoundError", requestID: "que_unknown" })
      }
    }),
  { git: true },
)

// multiple questions tests

it.instance(
  "ask - handles multiple questions",
  () =>
    Effect.gen(function* () {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions,
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)

      yield* replyEffect({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      expect(yield* Fiber.join(fiber)).toEqual([["Build"], ["Dev"]])
    }),
  { git: true },
)

// list tests

it.instance(
  "list - returns all pending requests",
  () =>
    Effect.gen(function* () {
      const fiber1 = yield* askEffect({
        sessionID: SessionID.make("ses_test1"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      }).pipe(Effect.forkScoped)

      const fiber2 = yield* askEffect({
        sessionID: SessionID.make("ses_test2"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(2)
      expect(pending.length).toBe(2)
      yield* rejectAll
      expect((yield* Fiber.await(fiber1))._tag).toBe("Failure")
      expect((yield* Fiber.await(fiber2))._tag).toBe("Failure")
    }),
  { git: true },
)

it.instance(
  "list - returns empty when no pending",
  () =>
    Effect.gen(function* () {
      const pending = yield* listEffect
      expect(pending.length).toBe(0)
    }),
  { git: true },
)

lifecycle.live("questions stay isolated by directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })

    const fiber1 = yield* askEffect({
      sessionID: SessionID.make("ses_one"),
      questions: [
        {
          question: "Question 1?",
          header: "Q1",
          options: [{ label: "A", description: "A" }],
        },
      ],
    }).pipe(provideInstance(one), Effect.forkScoped)

    const fiber2 = yield* askEffect({
      sessionID: SessionID.make("ses_two"),
      questions: [
        {
          question: "Question 2?",
          header: "Q2",
          options: [{ label: "B", description: "B" }],
        },
      ],
    }).pipe(provideInstance(two), Effect.forkScoped)

    const onePending = yield* waitForPending(1).pipe(provideInstance(one))
    const twoPending = yield* waitForPending(1).pipe(provideInstance(two))

    expect(onePending.length).toBe(1)
    expect(twoPending.length).toBe(1)
    expect(onePending[0].sessionID).toBe(SessionID.make("ses_one"))
    expect(twoPending[0].sessionID).toBe(SessionID.make("ses_two"))

    yield* rejectEffect(onePending[0].id).pipe(provideInstance(one))
    yield* rejectEffect(twoPending[0].id).pipe(provideInstance(two))

    expect((yield* Fiber.await(fiber1))._tag).toBe("Failure")
    expect((yield* Fiber.await(fiber2))._tag).toBe("Failure")
  }),
)

lifecycle.live("pending question rejects on instance dispose", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_dispose"),
      questions: [
        {
          question: "Dispose me?",
          header: "Dispose",
          options: [{ label: "Yes", description: "Yes" }],
        },
      ],
    }).pipe(provideInstance(dir), Effect.forkScoped)

    expect(yield* waitForPending(1).pipe(provideInstance(dir))).toHaveLength(1)
    const ctx = yield* Effect.gen(function* () {
      return yield* InstanceRef
    }).pipe(provideInstance(dir))
    if (!ctx) return yield* Effect.die(new Error("missing test instance"))
    yield* InstanceStore.Service.use((store) => store.dispose(ctx))

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
  }),
)

lifecycle.live("pending question rejects on instance reload", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_reload"),
      questions: [
        {
          question: "Reload me?",
          header: "Reload",
          options: [{ label: "Yes", description: "Yes" }],
        },
      ],
    }).pipe(provideInstance(dir), Effect.forkScoped)

    expect(yield* waitForPending(1).pipe(provideInstance(dir))).toHaveLength(1)
    yield* InstanceStore.Service.use((store) => store.reload({ directory: dir }))

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
  }),
)
