import { afterEach, describe, expect } from "bun:test"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Deferred, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { FSUtil } from "@graphagent/core/fs-util"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Flag } from "@graphagent/core/flag/flag"
import { createOpencodeClient } from "@graphagent/sdk/v2"
import { validateSession } from "../../src/cli/tui/validate-session"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"

import type { Config } from "@/config/config"
import { Session as SessionNs } from "@/session/session"
import { errorMessage } from "../../src/util/error"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { Database } from "@graphagent/core/database/database"
import { httpApiLayer } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    httpApiLayer,
  ),
)

const original = {
  GRAPHAGENT_DISABLE_PRUNE: Flag.GRAPHAGENT_DISABLE_PRUNE,
  GRAPHAGENT_SERVER_PASSWORD: Flag.GRAPHAGENT_SERVER_PASSWORD,
  GRAPHAGENT_SERVER_USERNAME: Flag.GRAPHAGENT_SERVER_USERNAME,
}

type ServerPath = "default" | "raw"
type Sdk = ReturnType<typeof createOpencodeClient>
type SdkResult = { response?: Response; data?: unknown; error?: unknown }
type Captured = { status: number | undefined; data?: unknown; error?: unknown }
type ProjectFixture = { sdk: Sdk; directory: string }
type LlmProjectFixture = ProjectFixture & { llm: TestLLMServer["Service"] }
type TestServices =
  FSUtil.Service | ChildProcessSpawner.ChildProcessSpawner | InstanceStore.Service | HttpServer.HttpServer
type TestScope = Scope.Scope | TestServices

function client(
  serverPath: ServerPath,
  directory?: string,
  input?: {
    password?: string
    username?: string
    headers?: Record<string, string>
    workspaceID?: string
    onRequest?: (request: Request) => void
  },
) {
  return serverFetch(serverPath, input).pipe(
    Effect.map((fetch) =>
      createOpencodeClient({
        baseUrl: "http://localhost",
        directory,
        experimental_workspaceID: input?.workspaceID,
        headers: input?.headers,
        fetch,
      }),
    ),
  )
}

function serverFetch(
  serverPath: ServerPath,
  input?: { password?: string; username?: string; onRequest?: (request: Request) => void },
) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      void serverPath
      Flag.GRAPHAGENT_SERVER_PASSWORD = input?.password
      Flag.GRAPHAGENT_SERVER_USERNAME = input?.username
      const baseUrl = HttpServer.formatAddress(server.address)
      return Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          input?.onRequest?.(source)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
    }),
  )
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function call<T>(request: () => Promise<T>) {
  return Effect.promise(request)
}

function capture(request: () => Promise<SdkResult>) {
  return call(request).pipe(
    Effect.map((result) => ({
      status: result.response?.status,
      data: result.data,
      error: result.error,
    })),
  )
}

function captureThrown(request: () => Promise<unknown>) {
  return call(async () => {
    try {
      await request()
    } catch (error) {
      return error
    }
  })
}

function expectStatus(request: () => Promise<{ response?: Response }>, status: number) {
  return call(request).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.response?.status).toBe(status))),
    Effect.asVoid,
  )
}

function firstEvent(open: (signal: AbortSignal) => Promise<{ stream: AsyncIterator<unknown> }>) {
  return Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.flatMap((controller) =>
      Effect.acquireRelease(
        call(() => open(controller.signal)),
        (events) => call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((events) =>
          call(() => events.stream.next()).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("timed out waiting for SDK event")),
            }),
          ),
        ),
        Effect.map((result) => result.value),
      ),
    ),
  )
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function statuses(input: Record<string, Captured>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.status]))
}

function firstPartText(value: unknown) {
  return record(array(record(value).parts)[0]).text
}

function sessionTitles(value: unknown) {
  return array(value)
    .map((item) => record(item).title)
    .filter((title): title is string => typeof title === "string")
    .sort()
}

function resetState() {
  return Effect.promise(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })
}

function httpapi<A, E>(name: string, effect: Effect.Effect<A, E, TestScope>) {
  it.live(name, effect)
}

function httpapiInstance<A, E>(
  name: string,
  options: {
    serverPath: ServerPath
    git?: boolean
    config?: Partial<ConfigV1.Info>
    setup?: (dir: string) => Effect.Effect<void, E, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  it.instance(
    name,
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* options.setup?.(instance.directory) ?? Effect.void
      return yield* run({ sdk: yield* client(options.serverPath, instance.directory), directory: instance.directory })
    }),
    { git: options.git ?? true, config: { formatter: false, lsp: false, ...options.config } },
  )
}

function serverPathParity<A, E>(name: string, scenario: (serverPath: ServerPath) => Effect.Effect<A, E, TestScope>) {
  it.live(name, scenario("raw"))
}

function withProject<A, E, E2 = never>(
  serverPath: ServerPath,
  options: {
    git?: boolean
    config?: Partial<ConfigV1.Info>
    setup?: (dir: string) => Effect.Effect<void, E2, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({
      git: options.git ?? false,
      config: { formatter: false, lsp: false, ...options.config },
    })
    yield* options.setup?.(directory) ?? Effect.void
    return yield* run({ sdk: yield* client(serverPath, directory), directory })
  })
}

function withStandardProject<A, E>(
  serverPath: ServerPath,
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return withProject(serverPath, { setup: writeStandardFiles }, run)
}

function withFakeLlm<A, E>(serverPath: ServerPath, run: (input: LlmProjectFixture) => Effect.Effect<A, E, TestScope>) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(serverPath, { config: testProviderConfig(llm.url) }, (input) => run({ ...input, llm }))
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function withFakeLlmProject<A, E>(
  serverPath: ServerPath,
  options: { setup?: (dir: string) => Effect.Effect<void, E, TestServices> },
  run: (input: LlmProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(
      serverPath,
      {
        config: testProviderConfig(llm.url),
        setup: options.setup,
      },
      (input) => run({ ...input, llm }),
    )
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function writeStandardFiles(dir: string) {
  return FSUtil.Service.use((fs) =>
    Effect.all([
      fs.writeWithDirs(path.join(dir, "hello.txt"), "hello"),
      fs.writeWithDirs(path.join(dir, "needle.ts"), "export const needle = 'sdk-parity'\n"),
    ]).pipe(Effect.asVoid),
  )
}

function writeProjectSkill(dir: string) {
  return FSUtil.Service.use((fs) =>
    fs.writeWithDirs(
      path.join(dir, ".agents", "skills", "project-rest-skill", "SKILL.md"),
      `---
name: project-rest-skill
description: A project skill visible to REST API prompts.
---

# Project REST Skill
`,
    ),
  )
}

function seedMessage(directory: string, sessionID: string) {
  const id = SessionID.make(sessionID)
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          const message = yield* svc.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            tools: {},
          } satisfies SessionV1.User)
          const part = yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: message.id,
            type: "text",
            text: "seeded message",
          })
          return { message, part }
        }),
      ).pipe(Effect.provide(SessionNs.defaultLayer)),
    ),
  )
}

const h0Files = ["s09-h0-a.txt", "s09-h0-b.txt", "s09-h0-c.txt"] as const
const h0Markers = h0Files.map((_, index) => `s09-h0-file-${index}-marker`)
const h0FileContents = h0Files.map((_, index) =>
  Array.from({ length: 500 }, (_unused, line) => {
    const prefix = line === 0 ? h0Markers[index] : `s09-h0-${index}-${String(line).padStart(3, "0")}`
    return `${prefix}:${String(index).repeat(64)}`
  }).join("\n"),
)
const h0Recent = Array.from(
  { length: 4 },
  (_, index) => `s09-h0-protected-${index}:${" protected-context".repeat(1_200)}`,
)
const h0Prompts = {
  seed: "collect the deterministic S09 H0 duplicate reads",
  recent: Array.from({ length: 4 }, (_, index) => `preserve recent S09 H0 turn ${index}`),
  final: "send the S09 H0 capture request",
} as const

function foldingProviderConfig(url: string): Partial<ConfigV1.Info> {
  const base = testProviderConfig(url)
  const provider = base.provider.test
  return {
    ...base,
    compaction: { auto: true, dynamic: true },
    provider: {
      test: {
        ...provider,
        models: {
          ...provider.models,
          "test-model": {
            ...provider.models["test-model"],
            limit: { context: 81_920, output: 4_096 },
          },
        },
      },
    },
  }
}

function writeH0Files(dir: string) {
  return FSUtil.Service.use((fs) =>
    Effect.forEach(h0Files, (name, index) => fs.writeWithDirs(path.join(dir, name), `${h0FileContents[index]}\n`), {
      discard: true,
    }),
  )
}

function h0ReadBatch(dir: string) {
  return raw({
    chunks: [
      {
        id: "chatcmpl-s09-h0",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: h0Files.flatMap((name, index) =>
                ["source", "witness"].map((kind) => ({
                  index: index * 2 + (kind === "source" ? 0 : 1),
                  id: `call-h0-${index}-${kind}`,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ filePath: path.join(dir, name) }),
                  },
                })),
              ),
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ],
  })
}

function sha256(value: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
}

function normalizedExistingHistory(messages: unknown, ids?: ReadonlySet<string>) {
  return array(messages)
    .filter((message) => {
      const id = record(record(message).info).id
      return !ids || (typeof id === "string" && ids.has(id))
    })
    .map((message) => {
      const copy = structuredClone(record(message))
      const info = record(copy.info)
      const time = record(info.time)
      delete time.consumed
      copy.info = { ...info, time }
      return copy
    })
}

function completedH0Reads(messages: unknown) {
  return array(messages).flatMap((message) =>
    array(record(message).parts).flatMap((part) => {
      const item = record(part)
      const state = record(item.state)
      if (item.type !== "tool" || item.tool !== "read" || state.status !== "completed") return []
      return [
        {
          id: item.id,
          messageID: item.messageID,
          callID: item.callID,
          tool: item.tool,
          input: state.input,
          output: state.output,
          title: state.title,
          metadata: state.metadata,
          status: state.status,
          compacted: record(state.time).compacted ?? null,
        },
      ]
    }),
  )
}

function h0ReadSettlements(messages: unknown) {
  return array(messages).flatMap((message) =>
    array(record(message).parts).flatMap((part) => {
      const item = record(part)
      if (item.type !== "tool" || item.tool !== "read") return []
      return [{ callID: item.callID, status: record(item.state).status }]
    }),
  )
}

function h0CompactionParts(messages: unknown) {
  return array(messages).flatMap((message) =>
    array(record(message).parts).filter((part) => record(part).type === "compaction"),
  )
}

function outboundH0ToolResults(outbound: unknown) {
  const results = new Map<string, string>()
  for (const message of array(record(outbound).messages)) {
    const item = record(message)
    if (item.role !== "tool" || typeof item.tool_call_id !== "string" || typeof item.content !== "string") continue
    if (results.has(item.tool_call_id)) throw new Error(`duplicate outbound tool result ${item.tool_call_id}`)
    results.set(item.tool_call_id, item.content)
  }
  return results
}

function h0Arm(input: { sdk: Sdk; llm: TestLLMServer["Service"]; directory: string; enabled: boolean }) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Flag.GRAPHAGENT_DISABLE_PRUNE
      Flag.GRAPHAGENT_DISABLE_PRUNE = !input.enabled
      return previous
    }),
    () =>
      Effect.gen(function* () {
        const firstProviderRequest = yield* input.llm.calls
        yield* input.llm.push(h0ReadBatch(input.directory), reply().text("s09 h0 seed complete").stop())

        const created = yield* capture(() =>
          input.sdk.session.create({
            title: "S09 H0",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        expect(created.status).toBe(200)
        const sessionID = String(record(created.data).id)
        const seed = yield* capture(() =>
          input.sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: h0Prompts.seed }],
          }),
        )
        expect(seed.status).toBe(200)

        for (let index = 0; index < h0Recent.length; index++) {
          yield* input.llm.text(h0Recent[index]!)
          const recent = yield* capture(() =>
            input.sdk.session.prompt({
              sessionID,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: h0Prompts.recent[index]! }],
            }),
          )
          expect(recent.status).toBe(200)
        }

        const before = yield* capture(() => input.sdk.session.messages({ sessionID }))
        expect(before.status).toBe(200)
        const beforeHistory = normalizedExistingHistory(before.data)
        const beforeIDs = new Set(
          beforeHistory.map((message) => record(message.info).id).filter((id): id is string => typeof id === "string"),
        )
        const beforeTools = completedH0Reads(beforeHistory)
        const beforeSettlements = h0ReadSettlements(beforeHistory)
        const beforeCompactions = h0CompactionParts(beforeHistory)
        expect(beforeTools).toHaveLength(h0Files.length * 2)
        expect(new Set(beforeTools.map((tool) => tool.callID)).size).toBe(h0Files.length * 2)
        expect(beforeSettlements).toEqual(beforeTools.map((tool) => ({ callID: tool.callID, status: "completed" })))
        expect(beforeCompactions).toHaveLength(0)

        yield* input.llm.text("s09 h0 capture accepted")
        const final = yield* capture(() =>
          input.sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: h0Prompts.final }],
          }),
        )
        expect(final.status).toBe(200)

        const after = yield* capture(() => input.sdk.session.messages({ sessionID }))
        expect(after.status).toBe(200)
        const afterExistingHistory = normalizedExistingHistory(after.data, beforeIDs)
        const afterTools = completedH0Reads(afterExistingHistory)
        const afterAllSettlements = h0ReadSettlements(after.data)
        const afterCompactions = h0CompactionParts(after.data)
        const providerInputs = (yield* input.llm.inputs).slice(firstProviderRequest)
        const outbound = providerInputs.at(-1) ?? {}
        const wire = JSON.stringify(outbound)
        const outboundResults = outboundH0ToolResults(outbound)
        const foldedOutputs = [...outboundResults.values()].filter((value) =>
          value.startsWith("[Duplicate tool output folded."),
        ).length
        const originalHistoryHash = sha256(beforeHistory)
        const afterHistoryHash = sha256(afterExistingHistory)
        const sourceWitnessHash = sha256(beforeTools)
        const afterSourceWitnessHash = sha256(afterTools)
        const markerCounts = h0Markers.map((marker) => wire.split(marker).length - 1)
        const recentIntact = h0Recent.every((text) => wire.includes(text))
        const resultChecks = h0Files.map((_, index) => {
          const sourceID = `call-h0-${index}-source`
          const witnessID = `call-h0-${index}-witness`
          const storedSource = beforeTools.find((tool) => tool.callID === sourceID)?.output
          const storedWitness = beforeTools.find((tool) => tool.callID === witnessID)?.output
          const outboundSource = outboundResults.get(sourceID)
          const outboundWitness = outboundResults.get(witnessID)
          return {
            sourceID,
            witnessID,
            storedExact: typeof storedSource === "string" && storedSource === storedWitness,
            sourceFolded:
              typeof outboundSource === "string" &&
              outboundSource.startsWith("[Duplicate tool output folded.") &&
              outboundSource.includes(witnessID),
            sourceUnchanged: typeof outboundSource === "string" && outboundSource === storedSource,
            witnessIntact: typeof outboundWitness === "string" && outboundWitness === storedWitness,
            storedOutputHash: sha256(storedWitness),
            outboundWitnessHash: sha256(outboundWitness),
          }
        })
        const privateCaptureDir = process.env.S09_H0_PRIVATE_CAPTURE_DIR
        if (privateCaptureDir) {
          const arm = input.enabled ? "enabled" : "disabled"
          yield* Effect.promise(() => Bun.write(path.join(privateCaptureDir, `${arm}-outbound.json`), wire))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(privateCaptureDir, `${arm}-preassert.json`),
              JSON.stringify(
                {
                  arm,
                  providerRequests: providerInputs.length,
                  serializedRequestBytes: Buffer.byteLength(wire),
                  foldedOutputs,
                  markerCounts,
                  recentIntact,
                  resultChecks,
                  afterAllSettlements,
                  toolMetadata: beforeTools.map((tool) => ({
                    callID: tool.callID,
                    outputBytes: typeof tool.output === "string" ? Buffer.byteLength(tool.output) : null,
                    outputHash: sha256(tool.output),
                    metadata: tool.metadata,
                    compacted: tool.compacted,
                  })),
                },
                null,
                2,
              ),
            ),
          )
        }

        expect(afterExistingHistory).toHaveLength(beforeHistory.length)
        expect(afterTools).toHaveLength(beforeTools.length)
        expect(afterAllSettlements).toEqual(beforeSettlements)
        expect(new Set(afterAllSettlements.map((tool) => tool.callID)).size).toBe(beforeSettlements.length)
        expect(afterHistoryHash).toBe(originalHistoryHash)
        expect(afterSourceWitnessHash).toBe(sourceWitnessHash)
        expect(afterTools.every((tool) => tool.compacted === null)).toBe(true)
        expect(afterCompactions).toHaveLength(0)
        expect(providerInputs).toHaveLength(7)
        expect(recentIntact).toBe(true)
        expect(resultChecks.every((result) => result.storedExact && result.witnessIntact)).toBe(true)
        if (input.enabled) {
          expect(foldedOutputs).toBe(h0Files.length)
          expect(markerCounts).toEqual(h0Markers.map(() => 1))
          expect(resultChecks.every((result) => result.sourceFolded)).toBe(true)
        } else {
          expect(foldedOutputs).toBe(0)
          expect(markerCounts).toEqual(h0Markers.map(() => 2))
          expect(resultChecks.every((result) => result.sourceUnchanged)).toBe(true)
        }

        return {
          arm: input.enabled ? "enabled" : "disabled",
          hostStatus: final.status,
          providerRequests: providerInputs.length,
          foldedOutputs,
          serializedRequestBytes: Buffer.byteLength(wire),
          originalHistoryHash,
          sourceWitnessHash,
          originalHistoryIntact: afterHistoryHash === originalHistoryHash,
          sourceWitnessIntact: afterSourceWitnessHash === sourceWitnessHash,
          protectedRecentIntact: recentIntact,
          exactWitnesses: resultChecks.filter((result) => result.witnessIntact).length,
          exactSourcesUnchanged: resultChecks.filter((result) => result.sourceUnchanged).length,
          exactSourcesFolded: resultChecks.filter((result) => result.sourceFolded).length,
          completedReadToolsBefore: beforeTools.length,
          completedReadToolsAfter: afterTools.length,
          completeHistoryReadSettlements: afterAllSettlements.length,
          unexpectedCompactedTools: afterTools.filter((tool) => tool.compacted !== null).length,
          compactionParts: afterCompactions.length,
        }
      }),
    (previous) => Effect.sync(() => void (Flag.GRAPHAGENT_DISABLE_PRUNE = previous)),
  )
}

afterEach(async () => {
  Flag.GRAPHAGENT_DISABLE_PRUNE = original.GRAPHAGENT_DISABLE_PRUNE
  Flag.GRAPHAGENT_SERVER_PASSWORD = original.GRAPHAGENT_SERVER_PASSWORD
  Flag.GRAPHAGENT_SERVER_USERNAME = original.GRAPHAGENT_SERVER_USERNAME
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi SDK", () => {
  httpapi(
    "uses the generated SDK for global and control routes",
    Effect.gen(function* () {
      const sdk = yield* client("raw")
      const health = yield* call(() => sdk.global.health())
      const log = yield* call(() => sdk.app.log({ service: "httpapi-sdk-test", level: "info", message: "hello" }))

      expect(health.response?.status).toBe(200)
      expect(health.data).toMatchObject({ healthy: true })
      expect(yield* firstEvent((signal) => sdk.global.event({ signal }))).toMatchObject({
        payload: { type: "server.connected" },
      })
      expect(log.response?.status).toBe(200)
      expect(log.data).toBe(true)
      yield* expectStatus(() => sdk.auth.set({ providerID: "test" }), 400)
    }),
  )

  httpapiInstance(
    "uses the generated SDK for safe instance routes",
    { serverPath: "raw", git: false, setup: writeStandardFiles },
    ({ sdk }) =>
      Effect.gen(function* () {
        const file = yield* call(() => sdk.file.read({ path: "hello.txt" }))
        const session = yield* call(() => sdk.session.create({ title: "sdk" }))
        const listed = yield* call(() => sdk.session.list({ roots: true, limit: 10 }))

        expect(file.response?.status).toBe(200)
        expect(file.data).toMatchObject({ content: "hello" })
        expect(session.response?.status).toBe(200)
        expect(session.data).toMatchObject({ title: "sdk" })
        expect(listed.response?.status).toBe(200)
        expect(listed.data?.map((item) => item.id)).toContain(session.data?.id)

        yield* Effect.all([
          expectStatus(() => sdk.project.current(), 200),
          expectStatus(() => sdk.config.get(), 200),
          expectStatus(() => sdk.config.providers(), 200),
          expectStatus(() => sdk.find.files({ query: "hello", limit: 10 }), 200),
        ])
      }),
  )

  httpapi(
    "routes configured SDK directory and workspace for v2 location GETs",
    withProject("raw", { setup: writeStandardFiles }, ({ directory }) =>
      Effect.gen(function* () {
        const workspaceID = "wrk_sdk"
        let request: Request | undefined
        const sdk = yield* client("raw", directory, {
          workspaceID,
          onRequest: (value) => (request = value),
        })
        const found = yield* pollWithTimeout(
          call(() => sdk.v2.fs.find({ query: "hello", type: "file" })).pipe(
            Effect.map((result) => (result.data?.data.length ? result : undefined)),
          ),
          "SDK file search index was not ready",
        )
        const url = new URL(request!.url)

        expect(found.response?.status).toBe(200)
        // The fuzzy file index may also return other project files (for example
        // graphagent.json), so assert the expected hit instead of an exact set.
        expect(found.data?.data).toContainEqual({ path: "hello.txt", type: "file" })
        expect(url.searchParams.get("directory")).toBe(directory)
        expect(url.searchParams.get("workspace")).toBe(workspaceID)
        expect(url.searchParams.get("location[directory]")).toBe(directory)
        expect(url.searchParams.get("location[workspace]")).toBe(workspaceID)
        expect(request!.headers.has("x-graphagent-directory")).toBe(false)
        expect(request!.headers.has("x-graphagent-workspace")).toBe(false)
      }),
    ),
  )

  serverPathParity("matches generated SDK global and control behavior", (serverPath) =>
    Effect.gen(function* () {
      const sdk = yield* client(serverPath)
      const health = yield* capture(() => sdk.global.health())
      const log = yield* capture(() => sdk.app.log({ service: "sdk-parity", level: "info", message: "hello" }))
      const invalidAuth = yield* capture(() => sdk.auth.set({ providerID: "test" }))

      return {
        statuses: statuses({ health, log, invalidAuth }),
        health: record(health.data).healthy,
        log: log.data,
      }
    }),
  )

  serverPathParity("matches generated SDK global event stream", (serverPath) =>
    Effect.gen(function* () {
      const sdk = yield* client(serverPath)
      const event = yield* firstEvent((signal) => sdk.global.event({ signal }))
      return { type: record(record(event).payload).type }
    }),
  )

  serverPathParity("matches generated SDK instance event stream", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      firstEvent((signal) => sdk.event.subscribe(undefined, { signal })).pipe(
        Effect.map((event) => ({ type: record(record(event).payload).type })),
      ),
    ),
  )

  serverPathParity("matches generated SDK missing session errors", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const sessionID = "ses_missing"
        const expected = {
          name: "NotFoundError",
          data: { message: `Session not found: ${sessionID}` },
        }
        const missing = yield* capture(() => sdk.session.get({ sessionID }))
        const thrown = yield* captureThrown(() => sdk.session.get({ sessionID }, { throwOnError: true }))

        // Result-tuple path: error body is preserved as-is so existing
        // consumers reading `result.error.name` / `JSON.stringify(error)`
        // keep working byte-for-byte.
        expect(missing.error).toEqual(expected)
        // throwOnError path: SDK wraps the body in a real Error with the
        // server's message, with the original parsed body preserved under
        // `.cause.body`.
        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe(expected.data.message)
        expect(((thrown as Error).cause as { body: unknown }).body).toEqual(expected)
        return {
          status: missing.status,
          error: missing.error,
          thrown,
        }
      }),
    ),
  )

  serverPathParity("formats missing session validation errors for -s", (serverPath) =>
    withStandardProject(serverPath, ({ directory }) =>
      Effect.gen(function* () {
        const sessionID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
        const fetch = yield* serverFetch(serverPath)
        const thrown = yield* captureThrown(() =>
          validateSession({
            url: "http://localhost",
            directory,
            sessionID,
            fetch,
          }),
        )
        expect(errorMessage(thrown)).toBe(`Session not found: ${sessionID}`)
        return errorMessage(thrown)
      }),
    ),
  )

  httpapiInstance(
    "uses generated SDK basic auth behavior",
    { serverPath: "raw", setup: writeStandardFiles },
    ({ directory }) =>
      Effect.gen(function* () {
        const missingSdk = yield* client("raw", directory, { password: "secret" })
        const missing = yield* capture(() => missingSdk.file.read({ path: "hello.txt" }))
        const badSdk = yield* client("raw", directory, {
          password: "secret",
          headers: { authorization: authorization("opencode", "wrong") },
        })
        const bad = yield* capture(() => badSdk.file.read({ path: "hello.txt" }))
        const goodSdk = yield* client("raw", directory, {
          password: "secret",
          headers: { authorization: authorization("opencode", "secret") },
        })
        const good = yield* capture(() => goodSdk.file.read({ path: "hello.txt" }))

        return {
          statuses: statuses({ missing, bad, good }),
          content: record(good.data).content,
        }
      }),
  )

  serverPathParity("matches generated SDK instance read routes", (serverPath) =>
    withProject(serverPath, { git: true, setup: writeStandardFiles }, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const project = yield* capture(() => sdk.project.current())
        const projects = yield* capture(() => sdk.project.list())
        const paths = yield* capture(() => sdk.path.get())
        const config = yield* capture(() => sdk.config.get())
        const providers = yield* capture(() => sdk.config.providers())
        const file = yield* capture(() => sdk.file.read({ path: "hello.txt" }))
        const files = yield* capture(() => sdk.file.list({ path: "." }))
        const fileStatus = yield* capture(() => sdk.file.status())
        const findFiles = yield* capture(() => sdk.find.files({ query: "hello", limit: 10 }))
        const findText = yield* capture(() => sdk.find.text({ pattern: "sdk-parity" }))
        const agents = yield* capture(() => sdk.app.agents())
        const skills = yield* capture(() => sdk.app.skills())
        const tools = yield* capture(() => sdk.tool.ids())
        const vcs = yield* capture(() => sdk.vcs.get())
        const formatter = yield* capture(() => sdk.formatter.status())
        const lsp = yield* capture(() => sdk.lsp.status())

        return {
          statuses: statuses({
            project,
            projects,
            paths,
            config,
            providers,
            file,
            files,
            fileStatus,
            findFiles,
            findText,
            agents,
            skills,
            tools,
            vcs,
            formatter,
            lsp,
          }),
          project: { worktreeSelected: record(project.data).worktree === directory },
          paths: { directorySelected: record(paths.data).directory === directory },
          file: record(file.data).content,
          hasProject: array(projects.data).length > 0,
          foundFile: JSON.stringify(findFiles.data).includes("hello.txt"),
          foundText: JSON.stringify(findText.data ?? null).includes("sdk-parity"),
          listedFile: JSON.stringify(files.data).includes("hello.txt"),
          vcs: { hasBranch: typeof record(vcs.data).branch === "string" },
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK session lifecycle routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const parent = yield* capture(() => sdk.session.create({ title: "parent" }))
        const parentID = String(record(parent.data).id)
        const child = yield* capture(() => sdk.session.create({ title: "child", parentID }))
        const childID = String(record(child.data).id)
        const get = yield* capture(() => sdk.session.get({ sessionID: parentID }))
        const update = yield* capture(() => sdk.session.update({ sessionID: parentID, title: "renamed" }))
        const roots = yield* capture(() => sdk.session.list({ roots: true, limit: 10 }))
        const all = yield* capture(() => sdk.session.list({ roots: false, limit: 10 }))
        const children = yield* capture(() => sdk.session.children({ sessionID: parentID }))
        const todo = yield* capture(() => sdk.session.todo({ sessionID: parentID }))
        const status = yield* capture(() => sdk.session.status())
        const messages = yield* capture(() => sdk.session.messages({ sessionID: parentID }))
        const missingGet = yield* capture(() => sdk.session.get({ sessionID: "ses_missing" }))
        const missingMessages = yield* capture(() => sdk.session.messages({ sessionID: "ses_missing", limit: 2 }))
        const invalidCursor = yield* capture(() =>
          sdk.session.messages({ sessionID: parentID, limit: 2, before: "bad" }),
        )
        const deleted = yield* capture(() => sdk.session.delete({ sessionID: childID }))
        const getDeleted = yield* capture(() => sdk.session.get({ sessionID: childID }))

        return {
          statuses: statuses({
            parent,
            child,
            get,
            update,
            roots,
            all,
            children,
            todo,
            status,
            messages,
            missingGet,
            missingMessages,
            invalidCursor,
            deleted,
            getDeleted,
          }),
          getTitle: record(get.data).title,
          updatedTitle: record(update.data).title,
          rootTitles: sessionTitles(roots.data),
          allTitles: sessionTitles(all.data),
          childCount: array(children.data).length,
          todoCount: array(todo.data).length,
          messageCount: array(messages.data).length,
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK session message and part routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "messages" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)
        const list = yield* capture(() => sdk.session.messages({ sessionID }))
        const page = yield* capture(() => sdk.session.messages({ sessionID, limit: 1 }))
        const message = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partUpdate = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated message" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        const updated = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partDelete = yield* capture(() =>
          sdk.part.delete({ sessionID, messageID: seeded.message.id, partID: seeded.part.id }),
        )
        const withoutPart = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const deleteMessage = yield* capture(() =>
          sdk.session.deleteMessage({ sessionID, messageID: seeded.message.id }),
        )
        const missingMessage = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))

        return {
          statuses: statuses({
            session,
            list,
            page,
            message,
            partUpdate,
            updated,
            partDelete,
            withoutPart,
            deleteMessage,
            missingMessage,
          }),
          listCount: array(list.data).length,
          pageCount: array(page.data).length,
          initialText: firstPartText(message.data),
          updatedText: firstPartText(updated.data),
          partCountAfterDelete: array(record(withoutPart.data).parts).length,
        }
      }),
    ),
  )

  // Regression: EventV2 must publish on the same ProjectBus the /event handler
  // subscribes to, AND the /event stream must forward handler ALS/context into the
  // body-pump fiber. Drives the full SDK → /event → Session.updatePart → sync.run →
  // bus.publish → SDK subscriber path. Goes red if either the publisher uses a
  // different bus instance (Bug 2 / pre-#27825) or the stream loses context (Bug 1 /
  // pre-#27425).
  serverPathParity("streams sync-backed part updates to /event subscribers", (serverPath) =>
    withStandardProject(serverPath, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "sync-backed part event" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)

        const controller = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
        const events = yield* call(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
        yield* Effect.addFinalizer(() =>
          call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
        )

        const ready = yield* Deferred.make<void>()
        const received = yield* Deferred.make<unknown>()

        yield* call(async () => {
          for await (const event of events.stream) {
            const payload = record(event).payload ?? event
            const type = record(payload).type
            if (type === "server.connected") {
              Deferred.doneUnsafe(ready, Effect.void)
              continue
            }
            if (type === MessageV2.Event.PartUpdated.type) {
              Deferred.doneUnsafe(received, Effect.succeed(payload))
              return
            }
          }
        }).pipe(Effect.forkScoped)

        yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for /event server.connected", "2 seconds")

        const updated = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated via sync" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        expect(updated.status).toBe(200)

        const event = yield* awaitWithTimeout(
          Deferred.await(received),
          "timed out waiting for message.part.updated bus payload over /event",
          "5 seconds",
        )
        const properties = record(record(event).properties)
        expect(record(properties.part)).toMatchObject({ id: seeded.part.id, type: "text" })
        return { type: record(event).type, partType: record(properties.part).type }
      }),
    ),
  )

  serverPathParity("matches generated SDK prompt no-reply routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "prompt" }))
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        )
        const asyncPrompt = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "async hello" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))

        return {
          statuses: statuses({ session, prompt, asyncPrompt, messages }),
          promptRole: record(record(prompt.data).info).role,
          messageCount: array(messages.data).length,
          messageTexts: array(messages.data)
            .flatMap((item) => array(record(item).parts))
            .map((part) => record(part).text)
            .filter((text): text is string => typeof text === "string")
            .sort(),
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK prompt streaming through fake LLM", (serverPath) =>
    withFakeLlm(serverPath, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("fake world", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "llm prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello llm" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))
        const inputs = yield* llm.inputs

        return {
          statuses: statuses({ session, prompt, messages }),
          calls: inputs.length,
          requestedModel: inputs[0]?.model,
          responseText: JSON.stringify(prompt.data).includes("fake world"),
          persistedText: JSON.stringify(messages.data).includes("fake world"),
          userText: JSON.stringify(messages.data).includes("hello llm"),
        }
      }),
    ),
  )

  serverPathParity("proves S09 H0 folding through the real host and local provider", (serverPath) =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const result = yield* withProject(
        serverPath,
        { config: foldingProviderConfig(llm.url), setup: writeH0Files },
        ({ sdk, directory }) =>
          Effect.gen(function* () {
            const enabled = yield* h0Arm({ sdk, llm, directory, enabled: true })
            const disabled = yield* h0Arm({ sdk, llm, directory, enabled: false })
            expect(enabled.serializedRequestBytes).toBeLessThan(disabled.serializedRequestBytes)
            return { enabled, disabled }
          }),
      )

      const providerUrl = new URL(llm.url)
      expect(["127.0.0.1", "::1", "localhost"]).toContain(providerUrl.hostname)
      const evidence = {
        schemaVersion: 1,
        candidateSha: process.env.S09_CANDIDATE_SHA ?? "unknown",
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        configuredWindow: { context: 81_920, outputReserve: 4_096 },
        transport: { hostHttp: true, providerHttp: true, providerLoopback: true },
        fixtureHash: sha256({
          files: h0Files,
          contents: h0FileContents,
          recent: h0Recent,
          prompts: h0Prompts,
        }),
        ...result,
      }
      const evidencePath = process.env.S09_H0_EVIDENCE
      if (evidencePath) yield* Effect.promise(() => Bun.write(evidencePath, JSON.stringify(evidence, null, 2)))
    }).pipe(Effect.provide(TestLLMServer.layer)),
  )

  httpapi(
    "includes project skills in REST API prompt context",
    withFakeLlmProject("default", { setup: writeProjectSkill }, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("skill context ok", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "project skill prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello skill context" }],
          }),
        )
        const inputs = yield* llm.inputs

        expect(session.status).toBe(200)
        expect(prompt.status).toBe(200)
        expect(JSON.stringify(inputs[0])).toContain("project-rest-skill")
      }),
    ),
  )

  serverPathParity("matches generated SDK project git initialization", (serverPath) =>
    withProject(serverPath, {}, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const before = yield* capture(() => sdk.project.current())
        const init = yield* capture(() => sdk.project.initGit())
        const after = yield* capture(() => sdk.project.current())

        return {
          statuses: statuses({ before, init, after }),
          before: {
            vcs: record(before.data).vcs ?? null,
            worktree: record(before.data).worktree,
          },
          init: {
            vcs: record(init.data).vcs,
            worktreeSelected: record(init.data).worktree === directory,
          },
          after: {
            vcs: record(after.data).vcs,
            worktreeSelected: record(after.data).worktree === directory,
          },
        }
      }),
    ),
  )
})
