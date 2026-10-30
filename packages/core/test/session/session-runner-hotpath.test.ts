import { describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  PreparedRequest,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigAgent } from "@opencode-ai/core/config/agent"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { FileSystem as CoreFileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Image } from "@opencode-ai/core/image"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTurnHooks } from "@opencode-ai/core/session/turn-hooks"
import { SessionCompactionHooks } from "@opencode-ai/core/session/compaction-hooks"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Location } from "@opencode-ai/core/location"
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect"
import { and, asc, eq } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "../lib/effect"

const sessionID = SessionV2.ID.make("ses_runner_hotpath")
const requests: LLMRequest[] = []
const preparedBodies: unknown[] = []
const outboundBodies: unknown[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
const prepareRequest = (request: LLMRequest) =>
  request.model.route.body.from(request).pipe(
    Effect.map(
      (body) =>
        new PreparedRequest({
          id: request.id ?? "request",
          route: request.model.route.id,
          protocol: request.model.route.protocol,
          model: request.model,
          body,
        }),
    ),
  )
const trackedPrepare = (request: LLMRequest) =>
  prepareRequest(request).pipe(Effect.tap((prepared) => Effect.sync(() => preparedBodies.push(prepared.body))))
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    // The production interface deliberately lets callers select the prepared body type; this test records unknown bodies.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    prepare: trackedPrepare as unknown as LLMClientShape["prepare"],
    stream: ((request: LLMRequest) =>
      Stream.unwrap(
        prepareRequest(request).pipe(
          Effect.map((prepared) => {
            requests.push(request)
            outboundBodies.push(prepared.body)
            if (responseStream) {
              const stream = responseStream
              responseStream = undefined
              return stream
            }
            return Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
          }),
        ),
      )) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

// Counts EventV2 usage at the service boundary so the runner's batching is observable.
const counts = { publish: 0, publishMany: 0 }
const events = Layer.effect(
  EventV2.Service,
  Effect.gen(function* () {
    const service = yield* EventV2.Service
    return EventV2.Service.of({
      ...service,
      publish: <D extends EventV2.Definition>(
        definition: D,
        data: EventV2.Data<D>,
        options?: EventV2.PublishOptions,
      ) => {
        counts.publish++
        return service.publish(definition, data, options)
      },
      publishMany: (batch: ReadonlyArray<EventV2.BatchEvent>, options?: { readonly location?: Location.Ref }) => {
        counts.publishMany++
        return service.publishMany(batch, options)
      },
    })
  }),
).pipe(Layer.provide(EventV2.defaultLayer))

// Scripted snapshots: capture returns the next queued tree ID (default "tree-1",
// i.e. an unchanged tree), files records the compared pair.
const probe = {
  captures: new Array<string | undefined>(),
  captureCalls: 0,
  filesCalls: 0,
  filesPairs: [] as string[][],
}
const snapshot = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () =>
      Effect.sync(() => {
        probe.captureCalls++
        const value = probe.captures.length > 0 ? probe.captures.shift()! : "tree-1"
        return value === undefined ? undefined : Snapshot.ID.make(value)
      }),
    files: ({ from, to }) =>
      Effect.sync(() => {
        probe.filesCalls++
        probe.filesPairs.push([String(from), String(to)])
        return []
      }),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

// The tool is gated on a Deferred so the test can inspect the durable event
// table while the side effect is running, proving Tool.Called is committed
// before execution.
const executions: string[] = []
let toolExecutionGate: Deferred.Deferred<void> | undefined
const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.void,
  ask: () => Effect.die("unused"),
  reply: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
})
const applications = ApplicationTools.layer
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, _context) =>
          Effect.gen(function* () {
            executions.push(text)
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }),
      }),
    }),
  ),
).pipe(Layer.provide(registry))
const agents = AgentV2.layer
const model = Model.make({
  id: "fake-model",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 1_000 } }),
})
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContext = SystemContextRegistry.layer
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(Project.defaultLayer))
const readBody = "read-output:" + "r".repeat(16_000)
const grepBody = "grep-output:" + "g".repeat(16_000)
const globEntries = Array.from({ length: 120 }, (_, index) =>
  CoreFileSystem.Entry.make({
    path: RelativePath.make(`generated/${String(index).padStart(3, "0")}-${"p".repeat(120)}.txt`),
    type: "file",
  }),
)
const readFileSystem = Layer.mock(ReadToolFileSystem.Service, {
  inspect: () => Effect.succeed("file" as const),
  read: () =>
    Effect.succeed(
      new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: readBody,
        mime: "text/plain",
        offset: 1,
        truncated: false,
        next: 2,
      }),
    ),
  list: () => Effect.die("unused"),
})
const mutation = Layer.mock(LocationMutation.Service, {
  resolve: ({ path }) =>
    Effect.succeed({
      canonical: `/project/${path}`,
      resource: path,
    }),
})
const image = Layer.mock(Image.Service, { normalize: () => Effect.die("unused") })
const directoryInfo: FileSystem.File.Info = {
  type: "Directory",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
}
const searchFileSystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) =>
    Effect.succeed(
      FSUtil.Service.of({
        ...fs,
        stat: () => Effect.succeed(directoryInfo),
      }),
    ),
  ),
).pipe(Layer.provide(FSUtil.defaultLayer))
const ripgrep = Layer.mock(Ripgrep.Service, {
  find: () => Effect.die("unused"),
  grep: () =>
    Effect.succeed([
      CoreFileSystem.Match.make({
        entry: CoreFileSystem.Entry.make({ path: RelativePath.make("src/result.ts"), type: "file" }),
        line: 1,
        offset: 0,
        text: grepBody,
        submatches: [],
      }),
    ]),
  glob: () => Effect.succeed(globEntries),
})
const foldingBuiltins = Layer.mergeAll(
  ReadTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(readFileSystem),
    Layer.provide(mutation),
    Layer.provide(image),
    Layer.provide(permission),
  ),
  GrepTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(mutation),
    Layer.provide(searchFileSystem),
    Layer.provide(ripgrep),
    Layer.provide(location),
    Layer.provide(permission),
  ),
  GlobTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(mutation),
    Layer.provide(ripgrep),
    Layer.provide(location),
    Layer.provide(permission),
  ),
)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
// Config documents are read lazily per turn by the runner, so tests can set
// this before a run to exercise per-agent timeout resolution.
let configEntries: Config.Entry[] = []
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(snapshot),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(registry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(referenceGuidance),
  Layer.provide(config),
)
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runner))
const sessions = SessionV2.layer.pipe(
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(events),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)
const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    events,
    SessionProjector.defaultLayer,
    SessionStore.defaultLayer,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    readFileSystem,
    mutation,
    image,
    searchFileSystem,
    ripgrep,
    foldingBuiltins,
    models,
    systemContext,
    location,
    skillGuidance,
    referenceGuidance,
    config,
    runner,
    execution,
    sessions,
  ),
)

const textTurn = (id: string, text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const toolTurn: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-echo", name: "echo" }),
  LLMEvent.toolInputDelta({ id: "call-echo", name: "echo", text: '{"text":"Hi"}' }),
  LLMEvent.toolInputEnd({ id: "call-echo", name: "echo" }),
  LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "Hi" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const foldingToolTurn = (id: string, name: "read" | "grep" | "glob", input: unknown): LLMEvent[] => {
  const text = JSON.stringify(input)
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id, name }),
    LLMEvent.toolInputDelta({ id, name, text }),
    LLMEvent.toolInputEnd({ id, name }),
    LLMEvent.toolCall({ id, name, input }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  responses = undefined
  responseStream = undefined
  requests.length = 0
  preparedBodies.length = 0
  outboundBodies.length = 0
  counts.publish = 0
  counts.publishMany = 0
  probe.captures = []
  probe.captureCalls = 0
  probe.filesCalls = 0
  probe.filesPairs = []
  executions.length = 0
  toolExecutionGate = undefined
  configEntries = []
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const durableEventTypes = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()).map((event) => event.type)
  })

const stepEndedData = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, id), eq(EventTable.type, "session.next.step.ended.2")))
      .orderBy(asc(EventTable.seq))
      .all()).map((event) => event.data)
  })

// Bounded readiness poll: yields to forked fibers so they can publish the
// awaited side effect (TestClock-neutral — it does not depend on virtual
// time), and fails loudly instead of spinning forever if the side effect never
// lands. The timeout is a safety net for live runs; under TestClock the loop
// terminates via the condition once the forked fiber has run.
const waitUntil = <R>(check: Effect.Effect<boolean, never, R>, message: string) =>
  Effect.gen(function* () {
    while (!(yield* check)) yield* Effect.yieldNow
  }).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error(message)) }))

type OutboundMessage = Readonly<{ role: string; tool_call_id?: string; content?: string }>
const outboundMessages = (body: unknown): OutboundMessage[] => {
  if (typeof body !== "object" || body === null || !Object.hasOwn(body, "messages"))
    throw new Error("expected provider message body")
  const messages = Reflect.get(body, "messages")
  if (!Array.isArray(messages)) throw new Error("expected provider messages")
  return messages.map((message) => {
    if (typeof message !== "object" || message === null) throw new Error("expected provider message")
    const role = Reflect.get(message, "role")
    const toolCallID = Reflect.get(message, "tool_call_id")
    const content = Reflect.get(message, "content")
    if (typeof role !== "string") throw new Error("expected provider message role")
    if (role !== "tool") return { role }
    if (typeof toolCallID !== "string") throw new Error("invalid provider tool call ID")
    if (typeof content !== "string") throw new Error("invalid provider message content")
    return { role, tool_call_id: toolCallID, content }
  })
}

const foldingCalls = [
  { id: "call-read-source", name: "read" as const, input: { path: "notes.txt", offset: 1, limit: 200 } },
  { id: "call-read-witness", name: "read" as const, input: { path: "notes.txt", offset: 1, limit: 200 } },
  {
    id: "call-grep-source",
    name: "grep" as const,
    input: { pattern: "needle", path: "src", include: "*.ts", limit: 10 },
  },
  {
    id: "call-grep-witness",
    name: "grep" as const,
    input: { pattern: "needle", path: "src", include: "*.ts", limit: 10 },
  },
  { id: "call-glob-source", name: "glob" as const, input: { pattern: "**/*.ts", path: "src", limit: 200 } },
  { id: "call-glob-witness", name: "glob" as const, input: { pattern: "**/*.ts", path: "src", limit: 200 } },
]
const foldingCallIDs = new Set(foldingCalls.map((item) => item.id))
const selectStoredFoldingTools = (messages: readonly SessionMessage.Message[]) =>
  messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.filter(
          (part): part is SessionMessage.AssistantTool => part.type === "tool" && foldingCallIDs.has(part.id),
        )
      : [],
  )

const seedFoldedCoreHistory = Effect.fn("test.seedFoldedCoreHistory")(function* (session: SessionV2.Interface) {
  // Duplicate-output folding is opt-in since v1.0.93; this helper measures it.
  configEntries = [
    new Config.Document({
      type: "document",
      info: new Config.Info({ compaction: new ConfigCompaction.Info({ dynamic: true }) }),
    }),
  ]
  yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Record one side effect" }), resume: false })
  responses = [toolTurn, textTurn("side-effect-done", "recorded")]
  yield* session.resume(sessionID)
  expect(executions).toEqual(["Hi"])

  for (const [index, item] of foldingCalls.entries()) {
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: `Run ${item.name} ${index}` }),
      resume: false,
    })
    responses = [foldingToolTurn(item.id, item.name, item.input), textTurn(`tool-done-${index}`, "done")]
    yield* session.resume(sessionID)
  }

  const filler = "recent-context:" + "z".repeat(55_000)
  for (let index = 0; index < 4; index++) {
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Keep context ${index}` }), resume: false })
    response = textTurn(`recent-${index}`, `${filler}:${index}`)
    responses = undefined
    yield* session.resume(sessionID)
  }

  const storedBefore = selectStoredFoldingTools(yield* session.context(sessionID))
  expect(storedBefore).toHaveLength(6)
  expect(storedBefore[0]).toMatchObject({
    id: "call-read-source",
    name: "read",
    state: {
      status: "completed",
      input: { path: "notes.txt", offset: 1, limit: 200 },
      structured: {
        type: "text-page",
        content: readBody,
        mime: "text/plain",
        offset: 1,
        truncated: false,
        next: 2,
      },
    },
  })
  const durableBefore = JSON.stringify(storedBefore)

  yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Observe folded history" }), resume: false })
  response = textTurn("folded-observation", "complete")
  requests.length = 0
  preparedBodies.length = 0
  outboundBodies.length = 0
  yield* session.resume(sessionID)

  expect(requests).toHaveLength(1)
  expect(preparedBodies).toHaveLength(2)
  expect(outboundBodies).toHaveLength(1)
  expect(JSON.stringify(selectStoredFoldingTools(yield* session.context(sessionID)))).toBe(durableBefore)

  const messages = outboundMessages(outboundBodies[0])
  const result = (id: string) =>
    messages.find((message) => message.role === "tool" && message.tool_call_id === id)?.content
  const placeholder = (witness: string) =>
    `[Duplicate tool output folded. Identical full output is retained in later tool call ${JSON.stringify(witness)}.]`
  const readSource: unknown = JSON.parse(result("call-read-source") ?? "null")
  const readWitness: unknown = JSON.parse(result("call-read-witness") ?? "null")
  expect(readSource).toEqual({
    type: "text-page",
    content: placeholder("call-read-witness"),
    mime: "text/plain",
    offset: 1,
    truncated: false,
    next: 2,
  })
  expect(readWitness).toEqual({
    type: "text-page",
    content: readBody,
    mime: "text/plain",
    offset: 1,
    truncated: false,
    next: 2,
  })
  expect(result("call-grep-source")).toBe(placeholder("call-grep-witness"))
  expect(result("call-grep-witness")).toContain(grepBody)
  expect(result("call-glob-source")).toBe(placeholder("call-glob-witness"))
  expect(result("call-glob-witness")).toContain("/project/src/generated/000-")

  return { durableBefore }
})

const expectBoundedOriginalCoreSummary = (request: LLMRequest) => {
  const body = JSON.stringify(request.messages)
  expect(body).not.toContain("Duplicate tool output folded")
  expect((body.match(/read-output:/g) ?? []).length).toBeGreaterThanOrEqual(2)
  expect((body.match(/grep-output:/g) ?? []).length).toBeGreaterThanOrEqual(2)
  expect((body.match(/generated\/000-/g) ?? []).length).toBeGreaterThanOrEqual(2)
  expect((body.match(/\[truncated\]/g) ?? []).length).toBeGreaterThanOrEqual(4)
}

describe("SessionRunnerLLM hot path", () => {
  it.effect("cancelling an actual V2 run clears attention without reporting idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Synthetic pending request" }), resume: false })
      responseStream = Stream.never
      const states: string[] = []
      const hooks = SessionTurnHooks.Service.of({
        state: (_id, status) =>
          Effect.sync(() => {
            states.push(status)
          }),
        displayMode: (_id, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: () => Effect.succeed({}),
        stop: () => Effect.succeed({}),
        stopFailure: () => Effect.void,
      })
      const run = yield* runner
        .run({ sessionID, force: true })
        .pipe(Effect.provideService(SessionTurnHooks.Service, hooks), Effect.forkScoped)
      yield* waitUntil(
        Effect.sync(() => requests.length === 1),
        "provider stream not started",
      )
      yield* Fiber.interrupt(run)
      expect(states).toEqual(["busy", "cancelled"])
    }),
  )

  it.effect("passes the submitted message id into conversation-hook admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const admitted: Array<Parameters<SessionConversationHooks.Interface["admit"]>[0]> = []
      const hooks = SessionConversationHooks.Service.of({
        admit: (input) =>
          Effect.sync(() => {
            admitted.push(input)
          }),
        beforeTool: (input) => Effect.succeed({ toolInput: input.toolInput }),
        afterTool: () => Effect.succeed({}),
      })
      const messageID = SessionMessage.ID.make("msg_submitted_prompt")
      yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Admit me", hookMode: "noninteractive" }),
          resume: false,
        })
        .pipe(Effect.provideService(SessionConversationHooks.Service, hooks))
      expect(admitted).toHaveLength(1)
      expect(admitted[0]?.sessionID).toBe(sessionID)
      expect(admitted[0]?.messageID).toBe(messageID)
      expect(admitted[0]?.prompt.text).toBe("Admit me")
    }),
  )

  it.effect("continues a V2 Stop block through a durable synthetic prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      responses = [textTurn("first", "One"), textTurn("second", "Two")]
      const stopCalls: Array<{ active: boolean; text?: string }> = []
      const states: string[] = []
      const hooks = SessionTurnHooks.Service.of({
        state: (_id, status) =>
          Effect.sync(() => {
            states.push(status)
          }),
        displayMode: (_sessionID, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: () => Effect.succeed({}),
        stop: (input) =>
          Effect.sync(() => {
            stopCalls.push({ active: input.stopHookActive, text: input.lastAssistantMessage })
            return stopCalls.length === 1 ? { continueWith: "Hook says continue" } : {}
          }),
        stopFailure: () => Effect.void,
      })
      yield* runner.run({ sessionID, force: true }).pipe(Effect.provideService(SessionTurnHooks.Service, hooks))
      expect(stopCalls).toEqual([
        { active: false, text: "One" },
        { active: true, text: "Two" },
      ])
      expect(states).toEqual(["busy", "idle"])
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain("Hook says continue")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Start" },
        { type: "assistant", content: [{ type: "text", text: "One" }] },
        { type: "user", text: "Hook says continue" },
        { type: "assistant", content: [{ type: "text", text: "Two" }] },
      ])
    }),
  )

  it.effect("caps repeated V2 Stop continuations at eight", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      responses = Array.from({ length: 9 }, (_, index) => textTurn(`stop-${index}`, `Answer ${index}`))
      const flags: boolean[] = []
      const states: string[] = []
      const hooks = SessionTurnHooks.Service.of({
        state: (_id, status) =>
          Effect.sync(() => {
            states.push(status)
          }),
        displayMode: (_sessionID, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: () => Effect.succeed({}),
        stop: (input) =>
          Effect.sync(() => {
            flags.push(input.stopHookActive)
            return { continueWith: "Again" }
          }),
        stopFailure: () => Effect.void,
      })
      yield* runner.run({ sessionID, force: true }).pipe(Effect.provideService(SessionTurnHooks.Service, hooks))
      expect(states).toEqual(["busy", "idle"])
      expect(requests).toHaveLength(9)
      expect(flags).toEqual([false, true, true, true, true, true, true, true, true])
      expect((yield* session.context(sessionID)).filter((message) => message.type === "user")).toHaveLength(9)
    }),
  )

  it.effect("resets the consecutive Stop cap after a tool call without losing stop_hook_active", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      responses = [
        ...Array.from({ length: 8 }, (_, index) => textTurn(`before-tool-${index}`, `Answer ${index}`)),
        toolTurn,
        textTurn("after-tool-one", "After tool"),
        textTurn("after-tool-two", "Final"),
      ]
      const flags: boolean[] = []
      const hooks = SessionTurnHooks.Service.of({
        displayMode: (_sessionID, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: () => Effect.succeed({}),
        stop: (input) =>
          Effect.sync(() => {
            flags.push(input.stopHookActive)
            return { continueWith: flags.length <= 9 ? "Again" : undefined }
          }),
        stopFailure: () => Effect.void,
      })
      yield* runner.run({ sessionID, force: true }).pipe(Effect.provideService(SessionTurnHooks.Service, hooks))
      expect(requests).toHaveLength(11)
      expect(flags).toEqual([false, true, true, true, true, true, true, true, true, true])
    }),
  )

  it.effect("routes a provider-error event to StopFailure rather than Stop", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      response = [LLMEvent.providerError({ message: "private-provider-failure" })]
      const calls: string[] = []
      const hooks = SessionTurnHooks.Service.of({
        displayMode: (_sessionID, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: () => Effect.succeed({}),
        stop: () =>
          Effect.sync(() => {
            calls.push("Stop")
            return {}
          }),
        stopFailure: (input) =>
          Effect.sync(() => {
            const error = input.error
            if (
              typeof error !== "object" ||
              error === null ||
              !("message" in error) ||
              typeof error.message !== "string"
            )
              throw new Error("Provider error missing message")
            calls.push(`StopFailure:${error.message}:${input.displayedError}`)
          }),
      })
      yield* runner.run({ sessionID, force: true }).pipe(Effect.provideService(SessionTurnHooks.Service, hooks))
      expect(calls).toEqual(["StopFailure:private-provider-failure:private-provider-failure"])
    }),
  )

  it.effect("feeds PostToolBatch context into the next V2 model request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run echo" }), resume: false })
      responses = [toolTurn, textTurn("after-batch", "Done")]
      const batches: Array<Parameters<SessionTurnHooks.Interface["postToolBatch"]>[0]> = []
      const hooks = SessionTurnHooks.Service.of({
        displayMode: (_sessionID, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: (input) =>
          Effect.sync(() => {
            batches.push(input)
            return { additionalContext: "Batch feedback" }
          }),
        stop: () => Effect.succeed({}),
        stopFailure: () => Effect.void,
      })
      yield* runner.run({ sessionID, force: true }).pipe(Effect.provideService(SessionTurnHooks.Service, hooks))
      expect(batches).toHaveLength(1)
      expect(batches[0]?.toolCalls[0]).toMatchObject({
        toolName: "echo",
        toolUseID: "call-echo",
        toolInput: { text: "Hi" },
      })
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain("Batch feedback")
    }),
  )

  it.effect("defers one raw tool call and resumes its original ID before the next model request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run echo", hookMode: "noninteractive" }),
        resume: false,
      })
      responses = [toolTurn, textTurn("after-defer", "Completed")]
      let attempts = 0
      const hooks = SessionConversationHooks.Service.of({
        admit: () => Effect.void,
        beforeTool: (input) =>
          Effect.sync(() => {
            attempts++
            return attempts === 1 ? { toolInput: input.toolInput, deferred: true } : { toolInput: { text: "Changed" } }
          }),
        afterTool: () => Effect.succeed({}),
      })
      const resumedBatches: Array<Parameters<SessionTurnHooks.Interface["postToolBatch"]>[0]> = []
      const turnHooks = SessionTurnHooks.Service.of({
        displayMode: (_sessionID, mode) => Effect.succeed({ enabled: false, mode }),
        display: (input) => Effect.succeed(input.delta),
        postToolBatch: (input) =>
          Effect.sync(() => {
            resumedBatches.push(input)
            return { additionalContext: "RESUMED_BATCH_CONTEXT" }
          }),
        stop: () => Effect.succeed({}),
        stopFailure: () => Effect.void,
      })
      const run = () =>
        runner
          .run({ sessionID, force: true })
          .pipe(
            Effect.provideService(SessionConversationHooks.Service, hooks),
            Effect.provideService(SessionTurnHooks.Service, turnHooks),
          )
      yield* run()
      expect(requests).toHaveLength(1)
      expect(executions).toEqual([])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "tool_deferred",
          content: [
            { type: "tool", id: "call-echo", state: { status: "running", deferred: true, input: { text: "Hi" } } },
          ],
        },
      ])
      expect(
        (yield* durableEventTypes(sessionID)).filter((type) => type === "session.next.tool.success.1"),
      ).toHaveLength(0)

      const agentService = yield* AgentV2.Service
      yield* agentService.transform((draft) =>
        draft.update(AgentV2.defaultID, (agent) => {
          agent.permissions = [{ action: "echo", resource: "*", effect: "deny" }]
        }),
      )
      yield* run()
      expect(attempts).toBe(1)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "tool_deferred_unavailable",
          content: [{ type: "tool", id: "call-echo", state: { status: "running", deferred: true } }],
        },
      ])
      yield* agentService.transform((draft) =>
        draft.update(AgentV2.defaultID, (agent) => {
          agent.permissions = []
        }),
      )

      yield* run()
      expect(attempts).toBe(2)
      expect(executions).toEqual(["Changed"])
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain("Changed")
      expect(JSON.stringify(requests[1]?.messages)).toContain("RESUMED_BATCH_CONTEXT")
      expect(resumedBatches).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-echo", state: { status: "completed", input: { text: "Changed" } } }],
        },
        { type: "user", text: "RESUMED_BATCH_CONTEXT" },
        { type: "assistant", content: [{ type: "text", text: "Completed" }] },
      ])
      const types = yield* durableEventTypes(sessionID)
      expect(types).toContain("session.next.tool.deferred.1")
      expect(types).toContain("session.next.tool.resuming.1")
      expect(types).toContain("session.next.tool.input.replaced.1")
    }),
  )

  it.effect("folds duplicate built-in read, grep, and glob outputs only in the final outbound request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { durableBefore } = yield* seedFoldedCoreHistory(session)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: `Trigger actual automatic compaction ${"a".repeat(80_000)}` }),
        resume: false,
      })
      responses = [
        textTurn("automatic-summary", "## Goal\n- Preserve folded history"),
        textTurn("post-compaction", "continued"),
      ]
      requests.length = 0
      preparedBodies.length = 0
      outboundBodies.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expectBoundedOriginalCoreSummary(requests[0])
      expect(JSON.stringify(outboundBodies[1])).toContain("## Goal\\n- Preserve folded history")
      expect(JSON.stringify(outboundBodies[1])).not.toContain("Duplicate tool output folded")
      expect(JSON.stringify(selectStoredFoldingTools(yield* session.messages({ sessionID, order: "asc" })))).toBe(
        durableBefore,
      )
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Preserve folded history" },
        { type: "assistant", finish: "stop" },
      ])
      expect(executions).toEqual(["Hi"])
    }),
  )

  it.effect("does not run PostCompact when the automatic summary fails or is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* seedFoldedCoreHistory(session)
      let before = 0
      let after = 0
      const hooks = SessionCompactionHooks.Service.of({
        before: () => Effect.sync(() => ({ blocked: (++before, false) })),
        after: () =>
          Effect.sync(() => {
            after++
            return {}
          }),
      })
      const run = () =>
        runner.run({ sessionID, force: true }).pipe(Effect.provideService(SessionCompactionHooks.Service, hooks))
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: `Summary failure ${"x".repeat(80_000)}` }),
        resume: false,
      })
      responses = [[LLMEvent.providerError({ message: "summary failed" })], textTurn("fallback", "FALLBACK")]
      requests.length = 0
      yield* run()
      expect(before).toBe(1)
      expect(after).toBe(0)
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: `Interrupt summary ${"y".repeat(8_000)}` }),
        resume: false,
      })
      requests.length = 0
      responseStream = Stream.never
      const fiber = yield* run().pipe(Effect.forkChild)
      yield* waitUntil(
        Effect.sync(() => requests.length >= 1),
        "summary stream never started",
      )
      yield* Fiber.interrupt(fiber)
      expect(after).toBe(0)
      expect(
        (yield* session.context(sessionID)).some((message) => message.type === "compaction" && !!message.summary),
      ).toBe(false)
    }),
  )

  it.effect("bounds a second provider overflow after summarizing the original folded history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { durableBefore } = yield* seedFoldedCoreHistory(session)
      const overflow = () => [
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Trigger bounded overflow recovery" }),
        resume: false,
      })
      responses = [overflow(), textTurn("overflow-summary", "## Goal\n- Preserve folded overflow history"), overflow()]
      requests.length = 0
      preparedBodies.length = 0
      outboundBodies.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(JSON.stringify(outboundBodies[0])).toContain("Duplicate tool output folded")
      expectBoundedOriginalCoreSummary(requests[1])
      expect(JSON.stringify(outboundBodies[2])).toContain("## Goal\\n- Preserve folded overflow history")
      expect(JSON.stringify(outboundBodies[2])).not.toContain("Duplicate tool output folded")
      expect(JSON.stringify(selectStoredFoldingTools(yield* session.messages({ sessionID, order: "asc" })))).toBe(
        durableBefore,
      )
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Preserve folded overflow history" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
      expect(executions).toEqual(["Hi"])
    }),
  )

  it.effect("batches durable publishes and preserves order across incremental turns", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      counts.publish = 0
      counts.publishMany = 0
      yield* session.resume(sessionID)

      // Text turn: one batch per flush boundary (Text.Started; Text.Ended;
      // Step.Ended) instead of one transaction per durable event; only the
      // live delta goes through the single-event publish path.
      expect(counts.publishMany).toBe(3)
      expect(counts.publish).toBe(2)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      responses = [toolTurn, textTurn("text-done", "Done")]
      counts.publish = 0
      counts.publishMany = 0
      const gate = yield* Deferred.make<void>()
      toolExecutionGate = gate
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* waitUntil(
        Effect.sync(() => executions.length >= 1),
        "echo tool never started",
      )
      const { db } = yield* Database.Service
      const committed = (yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.type, "session.next.tool.called.1"))
        .all()
        .pipe(Effect.orDie)).length

      // Tool.Called was durably committed before the side effect started.
      expect(committed).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(run)

      // Tool turn: 3 batches (step+input start, input-end+called flushed before
      // execution, tool success + step ended) plus 3 batches for the
      // continuation text turn; the tool input delta and text delta are the only
      // live publishes.
      expect(counts.publishMany).toBe(6)
      expect(counts.publish).toBe(3)

      // Incremental history is equivalent to the full read: each turn's request
      // carries the complete prior conversation.
      expect(requests).toHaveLength(3)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[2]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "First" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Hello" }] },
        { type: "user", text: "Second" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-echo", name: "echo", state: { status: "completed" } }],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])

      // Durable event sequence matches the pre-batching order (prompt admission
      // events are published by the session layer, not the runner).
      const types = yield* durableEventTypes(sessionID)
      const runnerEvents = types.filter((type) => !type.includes("prompt"))
      expect(runnerEvents).toEqual([
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
        "session.next.step.started.1",
        "session.next.tool.input.started.1",
        "session.next.tool.input.ended.1",
        "session.next.tool.called.1",
        "session.next.tool.success.1",
        "session.next.step.ended.2",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])

      // Unchanged tree: every step reuses the previous tree ID and the diff
      // computation is skipped (files is the empty diff of identical trees).
      expect(probe.filesCalls).toBe(0)
      const ended = yield* stepEndedData(sessionID)
      expect(ended).toHaveLength(3)
      for (const data of ended) {
        expect(data.snapshot).toBe("tree-1")
        expect(data.files).toEqual([])
      }
    }),
  )

  it.effect("resets the history cursor after compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const eventService = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* eventService.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* eventService.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0
      response = textTurn("text-second", "Again")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      const userTexts = requests[0].messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          message.content
            .filter((content): content is { type: "text"; text: string } => content.type === "text")
            .map((content) => content.text),
        )
      expect(userTexts[0]).toContain("<conversation-checkpoint>")
      expect(userTexts[0]).toContain("summary")
      expect(userTexts[1]).toBe("Second")
      // The compaction moved the read window: pre-compaction messages are gone
      // from the request, proving the cursor reset re-read from the compaction.
      expect(userTexts.join(" ")).not.toContain("First")
    }),
  )

  it.effect("reuses snapshot IDs and skips unchanged-tree diffs across steps", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      yield* session.resume(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      response = textTurn("text-second", "Again")
      yield* session.resume(sessionID)

      expect(probe.captureCalls).toBe(4)
      expect(probe.filesCalls).toBe(0)
      const ended = yield* stepEndedData(sessionID)
      expect(ended.map((data) => data.snapshot)).toEqual(["tree-1", "tree-1"])
      expect(ended.map((data) => data.files)).toEqual([[], []])
    }),
  )

  it.effect("computes real files for a changed tree", () =>
    Effect.gen(function* () {
      yield* setup
      probe.captures = ["tree-1", "tree-2"]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      yield* session.resume(sessionID)

      expect(probe.filesCalls).toBe(1)
      expect(probe.filesPairs).toEqual([["tree-1", "tree-2"]])
      const [ended] = yield* stepEndedData(sessionID)
      expect(ended.snapshot).toBe("tree-2")
      expect(ended.files).toEqual([])
    }),
  )

  it.effect("fails a hung provider turn through the provider failure path after the deadline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      responseStream = Stream.never
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* waitUntil(
        Effect.sync(() => requests.length >= 1),
        "provider stream never started",
      )
      yield* TestClock.adjust(Duration.minutes(11))
      const exit = yield* Fiber.await(run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(LLMError)
        if (error instanceof LLMError) {
          expect(error.reason._tag).toBe("Transport")
          if (error.reason._tag === "Transport") {
            expect(error.reason.message).toBe("Provider turn timed out")
            expect(error.reason.kind).toBe("Timeout")
          }
        }
      }
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "First" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider turn timed out" } },
      ])
    }),
  )

  it.effect("applies the configured agent timeout and bounds a hung tool wait", () =>
    Effect.gen(function* () {
      yield* setup
      // 1-second turn deadline via the `agents.build.timeout` config field
      // (seconds); the DAG-default mirror is 10 minutes when unset.
      configEntries = [
        new Config.Document({ type: "document", info: { agents: { build: new ConfigAgent.Info({ timeout: 1 }) } } }),
      ]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = toolTurn
      const gate = yield* Deferred.make<void>()
      toolExecutionGate = gate
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* waitUntil(
        Effect.sync(() => requests.length >= 1),
        "provider stream never started",
      )
      expect(Duration.toSeconds(requests[0].http!.timeout!)).toBe(1)
      // The tool call started and is stuck on the never-released gate; the
      // provider stream itself has finished (only the tool wait remains).
      yield* waitUntil(
        Effect.sync(() => executions.length >= 1),
        "echo tool never started",
      )
      yield* TestClock.adjust(Duration.seconds(2))
      const exit = yield* Fiber.await(run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(LLMError)
        if (error instanceof LLMError) {
          expect(error.reason._tag).toBe("Transport")
          if (error.reason._tag === "Transport") {
            expect(error.reason.message).toBe("Tool execution timed out")
            expect(error.reason.kind).toBe("Timeout")
          }
        }
      }
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "First" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution failed: SessionRunner.stream: Tool execution timed out",
                },
              },
            },
          ],
        },
      ])
    }),
  )
})
