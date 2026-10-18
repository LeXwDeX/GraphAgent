import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Location } from "@opencode-ai/core/location"
import { HookV2Conversation } from "@/hook/v2-conversation"
import { SettingsHook, type HookPayload, type TriggerContext, type TriggerResult } from "@/hook/settings"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "@/permission"
import { SessionAttention } from "@/notification/attention"

// V2 tool hooks run under the session that owns the tool call. When that
// session is a subagent (parentID set), Claude Code names the child session and
// its agent in agent_id / agent_type; the main session carries neither.

const base = (): TriggerResult => ({ additionalContexts: [], systemMessages: [] })

/** Real HookV2Conversation over a scripted SettingsHook and one persisted session record. */
function harness(session: { id: string; parentID?: string; agent?: string }) {
  const triggers: { payload: HookPayload; ctx: TriggerContext }[] = []
  const layer = HookV2Conversation.layer.pipe(
    // provideMerge keeps the mocked services ambient at run time: consumerContext
    // looks SessionStore up with serviceOption when the hook fires, not at layer
    // construction, and Layer.provide would consume it.
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(SettingsHook.Service, {
          hasEvent: () => Effect.succeed(true),
          trigger: (payload, ctx) =>
            Effect.sync(() => {
              triggers.push({ payload, ctx })
              return base()
            }),
        }),
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mock(Session.Service, { get: () => Effect.succeed({ agent: session.agent } as never) }),
        Layer.mock(SessionStore.Service, {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          get: () => Effect.succeed({ ...session, location: { directory: "/tmp/subagent-consumer" } } as never),
        }),
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
  const withRuntime = <A, E>(effect: Effect.Effect<A, E, SessionConversationHooks.Service>) =>
    effect.pipe(
      Effect.provide(layer),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Effect.provideService(Location.Service, { directory: "/tmp/subagent-consumer" } as never),
    )
  return {
    triggers,
    beforeTool: () =>
      withRuntime(
        Effect.gen(function* () {
          const hooks = yield* SessionConversationHooks.Service
          return yield* hooks.beforeTool({
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            sessionID: session.id as never,
            toolName: "write",
            toolCallID: "call_1",
            toolInput: { filePath: "a" },
          })
        }),
      ),
    afterTool: () =>
      withRuntime(
        Effect.gen(function* () {
          const hooks = yield* SessionConversationHooks.Service
          return yield* hooks.afterTool({
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            sessionID: session.id as never,
            toolName: "write",
            toolCallID: "call_1",
            toolInput: { filePath: "a" },
            output: "written",
          })
        }),
      ),
  }
}

describe("V2 subagent tool-hook identity", () => {
  test("PreToolUse inside a child session names the child session and its agent", async () => {
    const h = harness({ id: "ses_child", parentID: "ses_parent", agent: "explore" })
    await Effect.runPromise(h.beforeTool())
    expect(h.triggers.map(({ payload }) => payload.event)).toEqual(["PreToolUse"])
    expect(h.triggers[0].ctx.sessionID).toBe("ses_child")
    expect(h.triggers[0].ctx.agentID).toBe("ses_child")
    expect(h.triggers[0].ctx.agentType).toBe("explore")
  })

  test("PostToolUse inside a child session carries the same identity", async () => {
    const h = harness({ id: "ses_child", parentID: "ses_parent", agent: "explore" })
    await Effect.runPromise(h.afterTool())
    expect(h.triggers.map(({ payload }) => payload.event)).toEqual(["PostToolUse"])
    expect(h.triggers[0].ctx.agentID).toBe("ses_child")
    expect(h.triggers[0].ctx.agentType).toBe("explore")
  })

  test("a root session has no subagent identity", async () => {
    const h = harness({ id: "ses_root", agent: "build" })
    await Effect.runPromise(h.beforeTool())
    expect(h.triggers[0].ctx.sessionID).toBe("ses_root")
    expect(h.triggers[0].ctx.agentID).toBeUndefined()
  })
})
