import { decodeString } from "../lib/hook-json"
import path from "node:path"
import fs from "node:fs/promises"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { HookTranscript } from "@/hook/transcript"
import { TestInstance } from "../fixture/fixture"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Predicate } from "effect"
import type { Client as ClientType } from "@modelcontextprotocol/client"
import { Server, InMemoryTransport } from "@modelcontextprotocol/server"
import { AppLayer } from "@/effect/app-runtime"
import { EffectBridge } from "@/effect/bridge"
import { SessionContext } from "@/effect/session-context"
import { SessionHooks } from "@/hook/session-hooks"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Question } from "@/question"
import { MCP } from "@/mcp"
import { convertTool } from "@/mcp/catalog"
import { registerElicitationHandler } from "@/mcp/elicitation"
import { HookPermissionInterrupt } from "@/permission/hook-control"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Tool } from "ai"

const clientModule = await import(`@modelcontextprotocol/client?hook-binding=${Date.now()}`)
function isClientConstructor(value: unknown): value is typeof ClientType {
  return (
    typeof value === "function" &&
    Predicate.isObject(value.prototype) &&
    typeof value.prototype.callTool === "function" &&
    typeof value.prototype.connect === "function"
  )
}
const Client: unknown = clientModule.Client
if (!isClientConstructor(Client)) throw new Error("Invalid isolated MCP Client constructor")

const it = testEffect(AppLayer.pipe(Layer.provideMerge(SessionHooks.defaultLayer)))
const definition = { name: "pick", inputSchema: { type: "object" as const, properties: { label: { type: "string" } } } }
const options = (id: string, signal = new AbortController().signal) => ({
  toolCallId: id,
  messages: [],
  abortSignal: signal,
})
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const connect = Effect.fn("HookBindingTest.connect")(function* () {
  const bridge = yield* EffectBridge.make()
  const client = new Client(
    { name: "hook-binding-fixture", version: "0" },
    { capabilities: { elicitation: {}, roots: {} } },
  )
  const server = new Server({ name: "fixture", version: "0" }, { capabilities: { tools: {} } })
  const seen: string[] = []
  server.setRequestHandler("tools/list", async () => ({
    tools: [definition, { name: "hook", inputSchema: { type: "object", properties: {} } }],
  }))
  server.setRequestHandler("tools/call", async (request) => {
    const label = decodeString(request.params.arguments?.label ?? request.params.name)
    seen.push(label)
    if (request.params.name === "hook")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { color: "blue" } },
            }),
          },
        ],
      }
    const answer = await server.elicitInput({
      message: label,
      requestedSchema: {
        type: "object",
        properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
      },
    })
    return {
      content: [{ type: "text", text: `${label}:${answer.action}:${decodeString(answer.content?.color ?? "")}` }],
    }
  })
  registerElicitationHandler(client, bridge, "fixture")
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => Promise.all([client.close(), server.close()])).pipe(Effect.asVoid),
  )
  const [left, right] = InMemoryTransport.createLinkedPair()
  yield* Effect.promise(() => Promise.all([client.connect(left), server.connect(right)]))
  return { client, seen, callable: convertTool(definition, client) }
})

const call = (item: Tool, sessionID: string, label: string, signal?: AbortSignal) =>
  Effect.tryPromise({
    try: () => SessionContext.run(sessionID, () => Promise.resolve(item.execute!({ label }, options(label, signal)))),
    catch: (error) => error,
  })
const pending = (question: Question.Interface, sessionID: string) =>
  pollWithTimeout(
    question.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === sessionID))),
    `no Question for ${sessionID}`,
  )

describe("actual MCP client elicitation ownership", () => {
  it.instance("two concurrent sessions on one client receive only their own questions", () =>
    Effect.gen(function* () {
      const connection = yield* connect()
      const question = yield* Question.Service
      const firstID = SessionID.descending()
      const secondID = SessionID.descending()
      const first = yield* call(connection.callable, firstID, "first").pipe(Effect.forkScoped)
      const firstQuestion = yield* pending(question, firstID)
      const second = yield* call(connection.callable, secondID, "second").pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      expect(connection.seen).toEqual(["first"])
      expect((yield* question.list()).filter((item) => item.sessionID === secondID)).toHaveLength(0)
      yield* question.reply({ requestID: firstQuestion.id, answers: [["red"]] })
      const firstResult = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstResult)).toBe(true)
      if (Exit.isSuccess(firstResult)) expect(JSON.stringify(firstResult.value)).toContain("first:accept:red")
      const secondQuestion = yield* pending(question, secondID)
      yield* question.reply({ requestID: secondQuestion.id, answers: [["green"]] })
      const secondResult = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondResult)).toBe(true)
      if (Exit.isSuccess(secondResult)) expect(JSON.stringify(secondResult.value)).toContain("second:accept:green")
    }),
  )

  it.instance("cancelling a queued session removes only that call and releases the FIFO", () =>
    Effect.gen(function* () {
      const connection = yield* connect()
      const question = yield* Question.Service
      const firstID = SessionID.descending()
      const otherID = SessionID.descending()
      const first = yield* call(connection.callable, firstID, "first").pipe(Effect.forkScoped)
      const firstQuestion = yield* pending(question, firstID)
      const cancel = new AbortController()
      const queued = yield* call(connection.callable, otherID, "cancelled", cancel.signal).pipe(Effect.forkScoped)
      yield* Effect.sleep("10 millis")
      cancel.abort()
      expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true)
      expect(connection.seen).toEqual(["first"])
      yield* question.reply({ requestID: firstQuestion.id, answers: [["red"]] })
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
      const third = yield* call(connection.callable, otherID, "third").pipe(Effect.forkScoped)
      const thirdQuestion = yield* pending(question, otherID)
      yield* question.reply({ requestID: thirdQuestion.id, answers: [["green"]] })
      expect(Exit.isSuccess(yield* Fiber.await(third))).toBe(true)
      expect(connection.seen).toEqual(["first", "third"])
    }),
  )

  it.instance("different clients remain parallel", () =>
    Effect.gen(function* () {
      const left = yield* connect()
      const right = yield* connect()
      const question = yield* Question.Service
      const leftID = SessionID.descending()
      const rightID = SessionID.descending()
      const leftCall = yield* call(left.callable, leftID, "left").pipe(Effect.forkScoped)
      const rightCall = yield* call(right.callable, rightID, "right").pipe(Effect.forkScoped)
      const leftQuestion = yield* pending(question, leftID)
      const rightQuestion = yield* pending(question, rightID)
      expect(left.seen).toEqual(["left"])
      expect(right.seen).toEqual(["right"])
      yield* question.reply({ requestID: leftQuestion.id, answers: [["red"]] })
      yield* question.reply({ requestID: rightQuestion.id, answers: [["green"]] })
      expect(Exit.isSuccess(yield* Fiber.await(leftCall))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.await(rightCall))).toBe(true)
    }),
  )

  for (const event of ["Elicitation", "ElicitationResult"] as const) {
    it.instance(`${event} continue:false is ignored as required`, () =>
      Effect.gen(function* () {
        const connection = yield* connect()
        const question = yield* Question.Service
        const id = SessionID.descending()
        yield* (yield* SessionHooks.Service).add(id, {
          event,
          hooks: [
            {
              type: "command",
              command: `printf '%s' ${quote(JSON.stringify({ continue: false, stopReason: "fixture-stop" }))}`,
            },
          ],
        })
        const stopping = yield* call(connection.callable, id, "stopping").pipe(Effect.forkScoped)
        const request = yield* pending(question, id)
        yield* question.reply({ requestID: request.id, answers: [["red"]] })
        const stopped = yield* Fiber.await(stopping)
        expect(Exit.isFailure(stopped)).toBe(false)
        if (Exit.isFailure(stopped)) expect(Cause.squash(stopped.cause)).toBeInstanceOf(HookPermissionInterrupt)
        else expect(stopped.value.content).toEqual([{ type: "text", text: "stopping:accept:red" }])
        expect((yield* question.list()).filter((item) => item.sessionID === id)).toHaveLength(0)
        const other = SessionID.descending()
        const next = yield* call(connection.callable, other, "next").pipe(Effect.forkScoped)
        const otherRequest = yield* pending(question, other)
        yield* question.reply({ requestID: otherRequest.id, answers: [["green"]] })
        expect(Exit.isSuccess(yield* Fiber.await(next))).toBe(true)
      }),
    )
  }

  it.instance("an Elicitation mcp_tool hook can call the same client without deadlocking", () =>
    Effect.gen(function* () {
      const originalMcp = yield* MCP.Service
      const registry: Record<string, Tool> = {}
      const connection = yield* connect().pipe(
        Effect.provideService(MCP.Service, {
          ...originalMcp,
          tools: () => Effect.succeed(registry),
        }),
      )
      registry.fixture_hook = convertTool(
        { name: "hook", inputSchema: { type: "object", properties: {} } },
        connection.client,
      )
      const id = SessionID.descending()
      yield* (yield* SessionHooks.Service).add(id, {
        event: "Elicitation",
        hooks: [{ type: "mcp_tool", server: "fixture", tool: "hook", input: {} }],
      })
      const answer = yield* call(connection.callable, id, "business").pipe(Effect.timeout("3 seconds"))
      expect(JSON.stringify(answer)).toContain("business:accept:blue")
      expect(connection.seen).toEqual(["business", "hook"])
      expect((yield* (yield* Question.Service).list()).filter((item) => item.sessionID === id)).toHaveLength(0)
    }),
  )
})

it.instance("real MCP elicitation exports its bound session transcript and environment", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    const sessions = yield* Session.Service
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID: session.id,
      type: "text",
      text: "SYNTHETIC_MCP_CONTEXT",
    })
    const environment = yield* HookTranscript.environmentFile(session.id)
    yield* Effect.promise(() => fs.writeFile(environment, "export FIXTURE_MCP_CONTEXT=present\n"))
    const { directory } = yield* TestInstance
    const output = path.join(directory, "mcp-context.json")
    const script = path.join(directory, "mcp-context.ts")
    yield* Effect.promise(() =>
      fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(output)},JSON.stringify({path:i.transcript_path,rows:(await Bun.file(i.transcript_path).text()).trim().split("\\n").map(JSON.parse),mode:i.permission_mode,env:process.env.FIXTURE_MCP_CONTEXT}));process.stdout.write(JSON.stringify({continue:false,systemMessage:"IGNORED_MCP_SYSTEM",hookSpecificOutput:{hookEventName:"Elicitation",action:"accept",content:{color:"blue"}}}));`,
      ),
    )
    yield* (yield* SessionHooks.Service).add(session.id, {
      event: "Elicitation",
      hooks: [{ type: "command", command: process.execPath, args: [script] }],
    })
    const connection = yield* connect()
    expect((yield* call(connection.callable, session.id, "context")).content).toEqual([
      { type: "text", text: "context:accept:blue" },
    ])
    const seen = JSON.parse(yield* Effect.promise(() => fs.readFile(output, "utf8")))
    expect(path.isAbsolute(seen.path)).toBe(true)
    expect(seen.rows[0].message.content).toEqual([{ type: "text", text: "SYNTHETIC_MCP_CONTEXT" }])
    expect(seen.mode).toBe("default")
    expect(seen.env).toBe("present")
  }),
)
