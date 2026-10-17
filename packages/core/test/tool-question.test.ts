import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { QuestionTool } from "@opencode-ai/core/tool/question"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_question_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let captured: QuestionV2.AskInput | undefined
let reject = false
let deny = false
const capturedInput = () => captured
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(Effect.andThen(reject ? Effect.fail(new QuestionV2.RejectedError()) : Effect.succeed([["Build"], []]))),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    interact: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const tool = QuestionTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(question))
const it = testEffect(Layer.mergeAll(permission, registry, question, tool))

const suppliedAnswers = {
  "What should happen?": "Build",
  "Which checks?": "Unit, E2E",
}
const hooks = Layer.succeed(
  SessionConversationHooks.Service,
  SessionConversationHooks.Service.of({
    admit: () => Effect.void,
    beforeTool: (input) =>
      Effect.succeed({
        toolInput: input.toolInput,
        hookInput: { answers: suppliedAnswers },
        permissionDecision: "allow" as const,
      }),
    afterTool: () => Effect.succeed({}),
  }),
)
const itHooks = testEffect(Layer.mergeAll(permission, registry, question, tool, hooks))

describe("QuestionTool", () => {
  it.effect("reports timeout without fabricating a user answer", () =>
    Effect.sync(() => {
      const output = QuestionTool.toModelOutput(
        [
          {
            question: "Choose",
            header: "Choice",
            options: [
              { label: "First (Recommended)", description: "First" },
              { label: "Second (Recommended)", description: "Second" },
            ],
            multiple: true,
          },
        ],
        [],
        true,
      )
      expect(output).toContain("The user is temporarily away from the computer and did not answer.")
      expect(output).toContain(
        "Choose the best solution yourself based on the task, existing instructions, and available evidence.",
      )
      expect(output).toContain('Question 1 fallback candidate: "First (Recommended)" (one suggested candidate).')
      expect(output).toContain("Do not repeat this question in this turn.")
      expect(output).not.toContain('fallback candidate: "Second (Recommended)"')
      expect(output).toContain("recommendation, not a restriction")
      expect(output).toContain("Silence never grants new scope")
      expect(output).not.toContain("User has answered your questions")
      const freeForm = QuestionTool.toModelOutput([{ question: "Free form", header: "Free", options: [] }], [], true)
      expect(freeForm).toContain("Question 1 has no option fallback candidate")
      expect(freeForm).toContain("does not by itself block work")
      expect(QuestionTool.toModelOutput([], [], false, true)).toContain("Do not repeat this question")
    }),
  )

  it.effect("omits a denied built-in question and terminally settles a stale call", () =>
    Effect.gen(function* () {
      captured = undefined
      deny = true
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry, [{ action: "question", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-denied", name: "question", input: { questions: [] } },
        }),
      ).toEqual({ result: { type: "error", value: "Permission denied: question" } })
      expect(capturedInput()).toBeUndefined()
      deny = false
    }),
  )

  it.effect("registers question and projects user answers without a permission assertion", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const questions = [
        {
          question: "What should happen?",
          header: "Action",
          options: [{ label: "Build", description: "Build it" }],
        },
        {
          question: "Which environment?",
          header: "Environment",
          options: [{ label: "Dev", description: "Development" }],
        },
      ]

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["question"])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: "question", input: { questions } },
        }),
      ).toEqual({
        result: {
          type: "text",
          value:
            'User has answered your questions: "What should happen?"="Build", "Which environment?"="Unanswered". You can now continue with the user\'s answers in mind.',
        },
        output: {
          structured: { answers: [["Build"], []] },
          content: [
            {
              type: "text",
              text: 'User has answered your questions: "What should happen?"="Build", "Which environment?"="Unanswered". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "question", resources: ["*"] }])
      expect(capturedInput()).toEqual({
        sessionID,
        questions,
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-question" },
      })
    }),
  )

  it.effect("does not invent tool ownership metadata without a durable registry source", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registryService = yield* ToolRegistry.Service

      yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "question", input: { questions: [] } },
      })
      expect(capturedInput()).toEqual({
        sessionID,
        questions: [],
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-question" },
      })
    }),
  )

  it.effect("returns dismissed-question guidance without fabricating an answer", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = true
      deny = false
      const registryService = yield* ToolRegistry.Service
      const result = yield* settleTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "question", input: { questions: [] } },
      })
      expect(JSON.stringify(result)).toContain("Do not repeat this question")
      expect(JSON.stringify(result)).not.toContain("User has answered")
    }),
  )

  itHooks.effect("answers with hook-supplied answers instead of opening the dialog", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      assertions.length = 0
      const registryService = yield* ToolRegistry.Service
      const questions = [
        {
          question: "What should happen?",
          header: "Action",
          options: [{ label: "Build", description: "Build it" }],
        },
        {
          question: "Which checks?",
          header: "Checks",
          options: [
            { label: "Unit", description: "Unit tests" },
            { label: "E2E", description: "End-to-end tests" },
          ],
          multiple: true,
        },
      ]

      expect(
        yield* settleTool(registryService, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: "question", input: { questions } },
        }),
      ).toEqual({
        result: {
          type: "text",
          value:
            'User has answered your questions: "What should happen?"="Build", "Which checks?"="Unit, E2E". You can now continue with the user\'s answers in mind.',
        },
        output: {
          structured: { answers: [["Build"], ["Unit", "E2E"]] },
          content: [
            {
              type: "text",
              text: 'User has answered your questions: "What should happen?"="Build", "Which checks?"="Unit, E2E". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
      })
      expect(capturedInput()).toBeUndefined()
      expect(assertions).toMatchObject([{ sessionID, action: "question", resources: ["*"] }])
    }),
  )
})
