import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LLMEvent } from "@opencode-ai/llm"
import { ThinkingReplay } from "../../src/session/thinking-replay"

const user = { role: "user", content: [{ type: "text", text: "PRIVATE_PROMPT_SENTINEL" }] }
function signed(replay: ReturnType<typeof ThinkingReplay.project>, signature: string) {
  replay.bind(LLMEvent.reasoningStart({ id: signature }))
  const end = replay.bind(LLMEvent.reasoningEnd({ id: signature, providerMetadata: { anthropic: { signature } } }))
  if (end.type !== "reasoning-end") throw new Error("Missing fixture reasoning")
  return { type: "reasoning", text: "", providerMetadata: end.providerMetadata }
}

test("replay diagnostics distinguish prefix changes, chain gaps, and unknown legacy without opaque data", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "PRIVATE_SIGNATURE_FIRST")
  signed(initial, "PRIVATE_SIGNATURE_MIDDLE")
  const last = signed(initial, "PRIVATE_SIGNATURE_LAST")
  const chain = ThinkingReplay.project({ messages: [user, { role: "assistant", content: [first, last] }] })
  expect(chain.diagnostic).toMatchObject({ knownOrigins: 2, chainChanged: 1, retained: 1, newlyInvalidated: 1 })
  const prefix = ThinkingReplay.project({
    messages: [
      { ...user, content: [{ type: "text", text: "changed" }] },
      { role: "assistant", content: [first] },
    ],
  })
  expect(prefix.diagnostic).toMatchObject({ prefixChanged: 1, newlyInvalidated: 1 })
  const legacy = ThinkingReplay.project({
    messages: [
      user,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "", providerMetadata: { anthropic: { signature: "PRIVATE_LEGACY_SIGNATURE" } } },
        ],
      },
    ],
  })
  expect(legacy.diagnostic).toMatchObject({ knownOrigins: 0, unknownLegacy: 1, retained: 1, newlyInvalidated: 0 })
  expect(JSON.stringify([chain.diagnostic, prefix.diagnostic, legacy.diagnostic])).not.toContain("PRIVATE_")
  expect(Object.values(chain.diagnostic).every((value) => typeof value === "number")).toBe(true)
})

test("error diagnostics expose only static categories, validated IDs and status, including hostile getters", () => {
  const error = {
    statusCode: 400,
    responseHeaders: { "request-id": "req_safe-123", authorization: "PRIVATE_KEY" },
    responseBody: "PRIVATE_SIGNATURE bound to a different conversation PRIVATE_PROMPT",
  }
  expect(ThinkingReplay.errorDiagnostic(error)).toEqual({
    classification: "conversation_prefix_binding",
    status: 400,
    upstreamRequestID: "req_safe-123",
  })
  expect(
    ThinkingReplay.errorDiagnostic({
      message: "Invalid signature PRIVATE_SIGNATURE",
      responseHeaders: { "request-id": "unsafe\nPRIVATE_KEY" },
    }),
  ).toEqual({ classification: "signature_other", status: undefined, upstreamRequestID: undefined })
  expect(
    ThinkingReplay.errorDiagnostic({
      reason: { message: "signature PRIVATE_SIGNATURE", http: { response: { status: 400 }, requestId: "req_native" } },
    }),
  ).toEqual({ classification: "signature_other", status: 400, upstreamRequestID: "req_native" })
  const hostile = Object.defineProperty({}, "message", {
    get() {
      throw new Error("PRIVATE_GETTER")
    },
  })
  expect(ThinkingReplay.errorDiagnostic(hostile)).toEqual({ classification: "unavailable" })
  expect(JSON.stringify(ThinkingReplay.errorDiagnostic(error))).not.toContain("PRIVATE_")
})

for (const mode of ["default", "debug", "without-layer"] as const)
  test(`diagnostics stay off stdout/stderr on error with PRINT_LOGS=1 (${mode})`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-replay-debug-"))
    try {
      const script = path.join(directory, "capture.ts")
      const root = path.resolve(import.meta.dir, "../../../..")
      await fs.writeFile(
        script,
        `
      import { Effect, References } from ${JSON.stringify(import.meta.resolve("effect"))}
      import { Logging } from ${JSON.stringify(path.join(root, "packages/core/src/observability/logging.ts"))}
      import { Observability } from ${JSON.stringify(path.join(root, "packages/core/src/observability.ts"))}
      import { ThinkingReplay } from ${JSON.stringify(path.join(root, "packages/opencode/src/session/thinking-replay.ts"))}
      const original = { statusCode: 400, message: "PRIVATE_SIGNATURE bound to a different conversation PRIVATE_PROMPT PRIVATE_KEY" }
      const effect = Effect.fail(original).pipe(
        Effect.tapError(error => Logging.backgroundDebug("thinking replay error", { clientOperationID: "fixture-operation", scope: "llm-stream", ...ThinkingReplay.errorDiagnostic(error) })),
        Effect.catch(error => error === original ? Effect.void : Effect.die("Changed original error")),
      )
      await Effect.runPromise(${mode === "without-layer" ? 'effect.pipe(Effect.provideService(References.MinimumLogLevel, "Debug"))' : "effect.pipe(Effect.provide(Observability.layer), Effect.scoped)"})
    `,
      )
      const child = Bun.spawn([process.execPath, script], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_STATE_HOME: path.join(directory, "state"),
          OPENCODE_PRINT_LOGS: "1",
          OPENCODE_LOG_LEVEL: mode === "default" ? undefined : "DEBUG",
          OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        },
      })
      const watchdog = setTimeout(() => child.kill(), 20_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => {
        clearTimeout(watchdog)
        child.kill()
      })
      expect(code).toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toBe("")
      const file = Bun.file(path.join(directory, "data/opencode/log/opencode.log"))
      const logs = (await file.exists()) ? await file.text() : ""
      if (mode === "debug") {
        expect(logs).toContain('message="thinking replay error"')
        expect(logs).toContain("classification=conversation_prefix_binding")
        expect(logs).toContain("clientOperationID=fixture-operation")
      } else expect(logs).not.toContain("thinking replay error")
      expect(logs).not.toContain("PRIVATE_")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

test("diagnostics separate existing tombstones, compaction boundaries and changed signed blocks", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "PRIVATE_SIGNATURE")
  const project = (providerMetadata: unknown) =>
    ThinkingReplay.project({ messages: [user, { role: "assistant", content: [{ ...first, providerMetadata }] }] })
  expect(project(ThinkingReplay.invalidate(first.providerMetadata)).diagnostic).toMatchObject({
    alreadyInvalidated: 1,
    newlyInvalidated: 0,
  })
  expect(project(ThinkingReplay.forceInvalidation(first.providerMetadata)).diagnostic).toMatchObject({
    compactionInvalidated: 1,
    newlyInvalidated: 1,
  })
  expect(
    project({ ...first.providerMetadata, anthropic: { signature: "PRIVATE_CHANGED_SIGNATURE" } }).diagnostic,
  ).toMatchObject({ blockChanged: 1, prefixChanged: 0, newlyInvalidated: 1 })
})

for (const runtime of ["sdk", "native"] as const)
  test(`actual ${runtime} provider failure stays in background diagnostics without changing its result`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-replay-provider-error-"))
    try {
      const root = path.resolve(import.meta.dir, "../../../..")
      const script = path.join(directory, "provider-error.ts")
      await fs.writeFile(
        script,
        `
      import { Effect, Stream, Exit, Cause } from ${JSON.stringify(import.meta.resolve("effect"))}
      import { AppRuntime } from ${JSON.stringify(path.join(root, "packages/opencode/src/effect/app-runtime.ts"))}
      import { InstanceStore } from ${JSON.stringify(path.join(root, "packages/opencode/src/project/instance-store.ts"))}
      import { Provider } from ${JSON.stringify(path.join(root, "packages/opencode/src/provider/provider.ts"))}
      import { ProviderV2 } from ${JSON.stringify(path.join(root, "packages/core/src/provider.ts"))}
      import { ModelV2 } from ${JSON.stringify(path.join(root, "packages/core/src/model.ts"))}
      import { LLM } from ${JSON.stringify(path.join(root, "packages/opencode/src/session/llm.ts"))}
      let calls = 0
      const message = "PRIVATE_SIGNATURE bound to a different conversation PRIVATE_PROMPT PRIVATE_KEY"
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
        calls++
        return ${runtime === "native" ? 'new Response(`event: error\\ndata: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } })}\\n\\n`, { headers: { "content-type": "text/event-stream" } })' : 'Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400, headers: { "request-id": "req_fixture_error" } })'}
      } })
      const directory = ${JSON.stringify(directory)}
      await Bun.write(directory + "/opencode.json", JSON.stringify({ enabled_providers: ["fixture"], provider: { fixture: { npm: "@ai-sdk/anthropic", options: { apiKey: "PRIVATE_FIXTURE_KEY", baseURL: server.url.origin + "/v1" }, models: { "claude-haiku-5-5": { name: "Synthetic Haiku", limit: { context: 100000, output: 2048 } } } } } }))
      try {
        await AppRuntime.runPromise(InstanceStore.Service.use(store => store.provide({ directory }, Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("fixture"), ModelV2.ID.make("claude-haiku-5-5"))
          const llm = yield* LLM.Service
          const exit = yield* llm.stream({ sessionID: "ses_diagnostic", user: { id: "msg_diagnostic", sessionID: "ses_diagnostic", role: "user", time: { created: 0 }, agent: "build", model: { providerID: model.providerID, modelID: model.id } }, model, agent: { name: "build", mode: "primary", options: {}, permission: [] }, system: ["Synthetic fixture"], messages: [{ role: "user", content: "PRIVATE_PROMPT" }], tools: {}, retries: 0 }).pipe(Stream.runCollect, Effect.exit)
          ${runtime === "native" ? 'if (!Exit.isSuccess(exit) || !exit.value.some(event => event.type === "provider-error" && event.message.includes("PRIVATE_SIGNATURE"))) throw new Error("Native provider-error event changed")' : 'const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined; if (!failure || typeof failure !== "object" || failure.statusCode !== 400 || !String(failure.responseBody).includes("PRIVATE_SIGNATURE")) throw new Error("SDK provider failure changed")'}
        }))))
        if (calls !== 1) throw new Error("Unexpected fixture request count")
      } finally { await AppRuntime.dispose(); server.stop(true) }
    `,
      )
      const child = Bun.spawn([process.execPath, script], {
        cwd: path.join(root, "packages/opencode"),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENCODE_TEST_HOME: directory,
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_STATE_HOME: path.join(directory, "state"),
          OPENCODE_PRINT_LOGS: "1",
          OPENCODE_LOG_LEVEL: "DEBUG",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_EXPERIMENTAL_NATIVE_LLM: runtime === "native" ? "1" : undefined,
          OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        },
      })
      const watchdog = setTimeout(() => child.kill(), 20_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => {
        clearTimeout(watchdog)
        child.kill()
      })
      expect(code).toBe(0)
      expect(stdout).not.toContain("PRIVATE_")
      expect(stderr).not.toContain("PRIVATE_")
      expect(stdout + stderr).not.toContain("thinking replay error")
      expect(stdout + stderr).not.toContain("stream error")
      const logs = await Bun.file(path.join(directory, "data/opencode/log/opencode.log")).text()
      const diagnostic = logs.split("\n").filter((line) => line.includes('message="thinking replay'))
      expect(
        diagnostic.some(
          (line) =>
            line.includes('message="thinking replay error"') &&
            line.includes("classification=conversation_prefix_binding"),
        ),
      ).toBe(true)
      expect(
        diagnostic.some((line) =>
          line.includes("errorChannel=" + (runtime === "native" ? "provider-event" : "sdk-onError")),
        ),
      ).toBe(true)
      expect(diagnostic.join("\n")).not.toContain("PRIVATE_")
      const identities = new Set(diagnostic.map((line) => /clientOperationID=([^ ]+)/.exec(line)?.[1]))
      expect(identities.size).toBe(1)
      expect([...identities][0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(
        diagnostic
          .filter((line) => line.includes('message="thinking replay error"'))
          .every((line) => !line.includes("projectionSeq=")),
      ).toBe(true)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 30000)
