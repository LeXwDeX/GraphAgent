// Bypass Bun's process-global mock registry AND module cache. Sibling MCP
// tests register `mock.module("@modelcontextprotocol/client", ...)`
// with reduced MockClient implementations (no transport, no `callTool`);
// `mock.restore()` clears the registry, but Bun's module cache is keyed by
// specifier and retains the previously-resolved *mock instance* for that path.
// We therefore pull types from the public path via a type-only import, but at
// runtime load Client from a cache-busted specifier — a different specifier →
// a different cache entry → the real SDK Client with full callTool support.
import { afterEach, beforeEach, describe, expect, mock } from "bun:test"
import { Cause, Effect, Fiber, Layer, Exit } from "effect"
import type { Client as ClientType } from "@modelcontextprotocol/client"
import { Server, InMemoryTransport } from "@modelcontextprotocol/server"

mock.restore()
// Cache-bust the import: add a unique query string to force Bun to load a fresh
// module instance. Turbo runs tests from multiple packages in parallel, and
// other packages' `mock.module` calls can pollute the global module cache even
// after `mock.restore()`. A unique query string per import ensures we bypass
// any cached (mocked) module instances and get the real SDK Client with full
// `callTool` support.
const cacheBuster = `?bust=${Date.now()}`
const { Client } = (await import(`@modelcontextprotocol/client${cacheBuster}`)) as unknown as {
  Client: typeof ClientType
}
import { convertTool } from "@/mcp/catalog"
import { SessionContext } from "@/effect/session-context"
import { Question } from "@/question"
import { Notification } from "@/notification"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { registerElicitationHandler } from "@/mcp/elicitation"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import { disposeAllInstances, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// mcp-elicitation-notification — task 5.4: real in-memory MCP round-trip.
//
// A stub MCP `Server` exposes a tool whose handler calls `server.elicitInput(...)`,
// sending `elicitation/create` to the connected `Client`. The client has the real
// `registerElicitationHandler` wired (the same registration `watch()` performs in
// production), so the request flows: server → transport → client handler
// (`handleElicitation`) → Question service → user reply → accept → server receives
// the elicited content → `callTool` resolves.
//
// This closes the gap between the adapter unit/integration tests (which exercise
// `handleElicitation` directly) and the real SDK transport dispatch, and verifies
// the 5.4 concern end-to-end: the elicitation renders (Question surfaces), resolves
// (reply → accept), and does not corrupt the in-flight tool call. The blocking
// Question.ask during a tool call is exactly the "during a streaming turn" shape —
// an MCP tool blocks on elicitation exactly as it blocks on any slow operation.

beforeEach(() => {
  // Explicit pre-test reset. bun runs the whole suite in one process, so a
  // module-level activeSession slot left behind by a prior file would route
  // this test's elicitation to the wrong session (or none) before callTool
  // gets to set the fallback. afterEach alone only cleans up after each test.
})

afterEach(async () => {
  await disposeAllInstances()
})

const emptyResult = {
  blocked: undefined,
  permissionDecision: undefined,
  permissionDecisionReason: undefined,
  additionalContexts: [] as string[],
  systemMessages: [] as string[],
  hookSpecificOutput: undefined,
}
function recorderLayer() {
  const recorded: HookPayload[] = []
  const layer = Layer.succeed(
    SettingsHook.Service,
    SettingsHook.Service.of({
      trigger: (payload: HookPayload) => Effect.sync(() => (recorded.push(payload), { ...emptyResult })),
      list: () => Effect.succeed([]),
    }),
  )
  return { recorded, layer }
}

const rec = recorderLayer()
const env = Layer.mergeAll(
  Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
  Notification.defaultLayer,
  rec.layer,
  testInstanceStoreLayer,
)
const it = testEffect(env)

const SESSION = "ses_elicitation_transport"

/**
 * Build a stub MCP server whose only tool, "pick", elicits a color choice from
 * the user and returns the elicitation outcome as the tool result text.
 */
function makeStubServer(): Server {
  const server = new Server({ name: "elicitation-stub", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler("tools/list", async () => ({
    tools: [{ name: "pick", description: "Elicit a color choice", inputSchema: { type: "object", properties: {} } }],
  }))
  server.setRequestHandler("tools/call", async () => {
    const result = await server.elicitInput({
      message: "Pick a color",
      requestedSchema: {
        type: "object",
        properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
      },
    })
    return {
      content: [{ type: "text", text: `elicit ${result.action}: ${JSON.stringify(result.content)}` }],
    } as never
  })
  return server
}

const awaitValue = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Fiber.await(fiber)
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    return exit.value
  })

// Non-blocking snapshot of a fiber's state for timeout diagnostics: resolved
// (with its result text), failed (with the cause), or still pending. Used to
// tell a silent decline (callTool resolved with `elicit decline`) apart from a
// genuine hang (still in flight) when the surfacing poll times out.
const describeFiber = <A, E>(fiber: Fiber.Fiber<A, E>): string => {
  const exit = fiber.pollUnsafe()
  if (exit === undefined) return "pending (tool call still in flight)"
  if (Exit.isSuccess(exit)) return `resolved: ${JSON.stringify((exit.value as { content?: unknown })?.content)}`
  return `failed: ${Cause.pretty(exit.cause)}`
}

describe("mcp elicitation — real transport round-trip (5.4)", () => {
  it.instance("server elicits mid-tool-call; client surfaces, user replies, accept round-trips", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      // Build the bridge inside the test context so handleElicitation (run via
      // bridge.promise from the elicitation handler) sees Question + SettingsHook
      // + Notification.
      const bridge = yield* EffectBridge.make()

      // Real client + stub server linked by an in-memory transport pair.
      const client = new Client(
        { name: "opencode", version: "0.0.0" },
        { capabilities: { elicitation: {}, roots: {} } },
      )
      registerElicitationHandler(client, bridge)
      const server = makeStubServer()
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all([client.close(), server.close()])).pipe(Effect.catch(() => Effect.void)),
      )
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      yield* Effect.promise(() => Promise.all([client.connect(clientTransport), server.connect(serverTransport)]))

      // Exercise the real catalog binding instead of the removed global fallback.
      const before = rec.recorded.length
      const callable = convertTool({ name: "pick", inputSchema: { type: "object", properties: {} } }, client)
      const callFiber = yield* Effect.promise(() =>
        SessionContext.run(SESSION, () =>
          Promise.resolve(
            callable.execute!(
              {},
              {
                toolCallId: "transport-pick",
                messages: [],
                abortSignal: new AbortController().signal,
              },
            ),
          ),
        ),
      ).pipe(Effect.forkScoped)

      // The elicitation surfaces as a pending Question. Filter by this test's
      // SESSION so a pending question leaked from a prior file (bun runs the
      // full suite in one process) can't trip the count check; the total list
      // is retained for the timeout diagnostic below.
      let lastItems: readonly Question.Request[] = []
      const pending = yield* pollWithTimeout(
        Effect.gen(function* () {
          const items = (yield* question.list()) as readonly Question.Request[]
          lastItems = items
          const mine = items.filter((x) => String(x.sessionID) === SESSION)
          return mine.length === 1 ? mine : undefined
        }),
        "elicitation never surfaced as a Question",
        "15 seconds",
      ).pipe(
        // Self-diagnose on timeout: the callTool fiber's non-blocking poll
        // separates a silent decline (resolved with `elicit decline`) from a
        // genuine hang (still pending), and the list snapshot shows whether
        // the Question surfaced at all.
        Effect.catch(() =>
          Effect.fail(
            new Error(
              "elicitation never surfaced as a Question — " +
                `question.list()=${JSON.stringify(lastItems)}; callFiber: ${describeFiber(callFiber)}`,
            ),
          ),
        ),
      )
      expect(String(pending[0].sessionID)).toBe(SESSION)

      // Reply "green" → adapter validates, accepts, returns content to the server.
      yield* question.reply({ requestID: pending[0].id, answers: [["green"]] })
      const callResult = (yield* awaitValue(callFiber)) as { content?: Array<{ type: string; text?: string }> }

      // The server's tool received the elicited content and returned it.
      const text = callResult.content?.[0]?.text ?? ""
      expect(text).toContain("elicit accept")
      expect(text).toContain("green")

      // Elicitation + ElicitationResult hooks fired through the real transport path.
      const events = rec.recorded.slice(before)
      expect(events.filter((p) => p.event === "Elicitation")).toHaveLength(1)
      expect(
        events.filter(
          (p) =>
            p.event === "ElicitationResult" && JSON.stringify((p as { content?: unknown }).content).includes("green"),
        ),
      ).toHaveLength(1)
    }),
  )
})
