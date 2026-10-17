import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { Location } from "@opencode-ai/core/location"
import { HookV2Conversation } from "@/hook/v2-conversation"
import { SettingsHook, type HookPayload, type TriggerResult, type TriggerContext } from "@/hook/settings"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "@/permission"
import { SessionAttention } from "@/notification/attention"

const base = (): TriggerResult => ({ additionalContexts: [], systemMessages: [] })

/** Real HookV2Conversation layer over a scripted SettingsHook, so only the V2 aggregation is under test. */
function harness(result: (payload: HookPayload) => TriggerResult) {
  const triggers: { payload: HookPayload; ctx: TriggerContext }[] = []
  const layer = HookV2Conversation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SettingsHook.Service, {
          hasEvent: () => Effect.succeed(false),
          trigger: (payload, ctx) =>
            Effect.sync(() => {
              triggers.push({ payload, ctx })
              return result(payload)
            }),
        }),
        Layer.mock(Session.Service, {}),
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mock(InstanceStore.Service, {
          provide: (_input: unknown, effect: Effect.Effect<unknown>) => effect,
        } as never),
        Layer.mock(Permission.Service, {
          hookPolicy: () => Effect.succeed({ mode: "default", rules: [], directories: [] }),
        }),
        Layer.mock(SessionAttention.Service, {}),
      ),
    ),
  )
  const beforeTool = (input: {
    isSingle?: () => Promise<boolean>
    toolName?: string
    toolInput?: Record<string, unknown>
  }) =>
    Effect.gen(function* () {
      const hooks = yield* SessionConversationHooks.Service
      return yield* hooks.beforeTool({
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sessionID: "ses_cross_audit" as never,
        toolName: input.toolName ?? "write",
        toolCallID: "call_1",
        toolInput: input.toolInput ?? { filePath: "a" },
        isSingle: input.isSingle,
      })
    }).pipe(
      Effect.provide(layer),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Effect.provideService(Location.Service, { directory: "/tmp/cross-audit-v2" } as never),
    )
  return { triggers, beforeTool }
}

describe("V2 PreToolUse defer that cannot be honored", () => {
  test("keeps a sibling exit-2 rejection", async () => {
    const h = harness(() => ({
      ...base(),
      permissionDecision: "defer",
      blocked: { reason: "CROSS_AUDIT_EXIT2", command: "hook" },
    }))
    const result = await Effect.runPromise(h.beforeTool({ isSingle: async () => false }))
    expect(result.blocked).toBe("CROSS_AUDIT_EXIT2")
    expect(result.deferred).toBeUndefined()
  })

  test("is still honored when the batch is a single call", async () => {
    const h = harness(() => ({ ...base(), permissionDecision: "defer", blocked: { reason: "x", command: "hook" } }))
    const result = await Effect.runPromise(h.beforeTool({ isSingle: async () => true }))
    expect(result.deferred).toBe(true)
  })

  test("alone is ignored and does not become a permission verdict", async () => {
    const h = harness(() => ({ ...base(), permissionDecision: "defer", additionalContexts: ["CTX"] }))
    const result = await Effect.runPromise(h.beforeTool({ isSingle: async () => false }))
    expect(result.blocked).toBeUndefined()
    expect(result.deferred).toBeUndefined()
    expect(result.permissionDecision).toBeUndefined()
  })

  test("a deny keeps the Pre context next to its reason", async () => {
    const h = harness(() => ({
      ...base(),
      permissionDecision: "deny",
      permissionDecisionReason: "CROSS_AUDIT_DENY",
      additionalContexts: ["CROSS_AUDIT_PRE_CTX"],
    }))
    const result = await Effect.runPromise(h.beforeTool({ isSingle: async () => false }))
    expect(result.blocked).toContain("CROSS_AUDIT_DENY")
    expect(result.blocked).toContain("CROSS_AUDIT_PRE_CTX")
  })
})

describe("V2 PreToolUse AskUserQuestion answers", () => {
  const questions = [
    {
      question: "What should happen?",
      header: "Action",
      options: [{ label: "Build", description: "Build it" }],
    },
  ]
  const answers = { "What should happen?": "Build" }

  test("an allow forwards the hook-only answers next to the schema input", async () => {
    const h = harness(() => ({
      ...base(),
      permissionDecision: "allow",
      updatedInput: { questions, answers },
    }))
    const result = await Effect.runPromise(h.beforeTool({ toolName: "question", toolInput: { questions } }))
    expect(result.toolInput).toEqual({ questions })
    expect(result.hookInput).toEqual({ answers })
    expect(result.permissionDecision).toBe("allow")
  })

  test("without an allow the answers reach neither input", async () => {
    const h = harness(() => ({ ...base(), updatedInput: { questions, answers } }))
    const result = await Effect.runPromise(h.beforeTool({ toolName: "question", toolInput: { questions } }))
    expect(result.toolInput).toEqual({ questions })
    expect("hookInput" in result ? result.hookInput : undefined).toBeUndefined()
  })
})
