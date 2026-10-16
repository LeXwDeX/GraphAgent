import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Scope } from "effect"
import { HookStartContext } from "@/hook/start-context"
import { SettingsHook } from "@/hook/settings"
import { SessionPrompt } from "@/session/prompt"
import { SessionCompaction } from "@/session/compaction"
import { SessionShare } from "@/share/session"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// AppLayer wiring (src/effect/app-runtime.ts) lists HookStartContext.defaultLayer only as a
// sibling inside a Layer.mergeAll group. Siblings cannot see each other at build time, so every
// producer that resolves HookStartContext with Effect.serviceOption (task.ts SubagentStart via
// ToolRegistry, SessionCompaction SessionStart(compact), SessionShare SessionStart(startup)) must
// provide HookStartContext.defaultLayer itself. The runtime shares one memoMap, so providing the
// SAME layer reference yields the SAME instance that SessionPrompt drains at admission.
// The HTTP server graph (LayerNode.buildLayer) shares by node identity instead: each producer
// lists HookStartContext.node. This file probes the defaultLayer (AppLayer) composition only.

// Probe: build `producer` in a fresh MemoMap, then ask the MemoMap for HookStartContext.defaultLayer.
// If the producer's dependency chain already memoized that exact layer, the fallback `build` is
// never called. If it was not provided, the probe has to build it (fallback runs) -> not wired.
const wiredIntoChain = (producer: Layer.Layer<never, unknown, never>): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const memoMap = Layer.makeMemoMapUnsafe()
    const scope = yield* Scope.Scope
    yield* Layer.buildWithMemoMap(producer, memoMap, scope).pipe(Effect.orDie)
    let builtByProbe = false
    yield* memoMap.getOrElseMemoize(HookStartContext.defaultLayer, scope, () =>
      Effect.sync(() => {
        builtByProbe = true
        return Context.empty() as Context.Context<HookStartContext.Service>
      }),
    )
    return !builtByProbe
  })

describe("HookStartContext production wiring", () => {
  test("probe sanity: a layer that does not provide it is reported as not wired", async () => {
    const bare = Layer.succeed(SettingsHook.Service, SettingsHook.Service.of({ trigger: () => Effect.die("x"), list: () => Effect.succeed([]) }))
    expect(await Effect.runPromise(Effect.scoped(wiredIntoChain(bare)))).toBe(false)
  })

  test("SessionPrompt.defaultLayer (the consumer) provides it", async () => {
    expect(await Effect.runPromise(Effect.scoped(wiredIntoChain(SessionPrompt.defaultLayer)))).toBe(true)
    await disposeAllInstances()
  })

  for (const [name, producer] of [
    ["ToolRegistry.defaultLayer (task.ts SubagentStart)", ToolRegistry.defaultLayer],
    ["SessionCompaction.defaultLayer (SessionStart compact)", SessionCompaction.defaultLayer],
    ["SessionShare.defaultLayer (SessionStart startup)", SessionShare.defaultLayer],
  ] as const) {
    test(`${name} provides the shared HookStartContext layer`, async () => {
      expect(await Effect.runPromise(Effect.scoped(wiredIntoChain(producer)))).toBe(true)
      await disposeAllInstances()
    })
  }
})

// Behavioural check in a production-shaped composition: producer + HookStartContext as siblings of
// one mergeAll (as in app-runtime), SettingsHook ambient via provideMerge. A context appended by
// SessionShare must be visible through the sibling-exposed service the prompt layer would drain.
const hook = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.succeed({
        additionalContexts: payload.event === "SessionStart" ? ["STARTUP_CTX"] : [],
        systemMessages: [],
      }),
    list: () => Effect.succeed([]),
  }),
)
const it = testEffect(
  Layer.mergeAll(SessionShare.defaultLayer, HookStartContext.defaultLayer, Session.defaultLayer).pipe(
    Layer.provideMerge(hook),
  ),
)

describe("HookStartContext shared instance", () => {
  it.instance("SessionShare.create queues SessionStart(startup) context into the exposed service", () =>
    Effect.gen(function* () {
      const share = yield* SessionShare.Service
      const startCtx = yield* HookStartContext.Service
      const created = yield* share.create({ title: "wired" })
      expect(yield* startCtx.consume(created.id)).toEqual(["STARTUP_CTX"])
    }),
  )
})
