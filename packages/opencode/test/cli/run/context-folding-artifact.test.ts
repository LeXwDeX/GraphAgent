import { describe, expect } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { cliItFor, sourceCliTarget, type CliFixture, type ResolvedCliTarget } from "../../lib/cli-process"
import { raw, reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

const sourceEnabled = process.env.OPENCODE_TEST_CONTEXT_FOLDING_SOURCE === "1"
const evidenceDir = process.env.OPENCODE_TEST_CONTEXT_FOLDING_EVIDENCE_DIR
const enabled = sourceEnabled
const cliIt = cliItFor(sourceCliTarget)

if (evidenceDir && !path.isAbsolute(evidenceDir)) {
  throw new Error(`context folding evidence directory must be absolute: ${evidenceDir}`)
}
const files = ["artifact-fold-a.txt", "artifact-fold-b.txt", "artifact-fold-c.txt"] as const
const markers = files.map((_, index) => `artifact-fold-file-${index}-marker`)
const contents = files.map((_, index) =>
  Array.from({ length: 500 }, (_unused, line) => {
    const prefix = line === 0 ? markers[index] : `artifact-fold-${index}-${String(line).padStart(3, "0")}`
    return `${prefix}:${String(index).repeat(64)}`
  }).join("\n"),
)
const recent = Array.from(
  { length: 4 },
  (_, index) => `artifact-fold-protected-${index}:${" protected-context".repeat(1_200)}`,
)
const prompts = {
  seed: "collect deterministic duplicate reads for artifact folding acceptance",
  recent: Array.from({ length: 4 }, (_, index) => `preserve recent artifact folding turn ${index}`),
  observe: "observe the artifact folding request",
  continue: "continue after the manual artifact compaction",
} as const

type Sdk = ReturnType<typeof createOpencodeClient>
type SdkResult = { response?: Response; data?: unknown; error?: unknown }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object, got ${String(value)}`)
  }
  return Object.fromEntries(Object.entries(value))
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array")
  return value
}

function sdkData(result: SdkResult) {
  if (result.error !== undefined || result.data === undefined || !result.response?.ok) {
    throw new Error(`SDK request failed (${result.response?.status ?? "unknown"}): ${JSON.stringify(result.error)}`)
  }
  return result.data
}

function sha256(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
}

function requestText(value: unknown) {
  return JSON.stringify(value)
}

function count(value: string, marker: string) {
  return value.split(marker).length - 1
}

function providerConfig(url: string, dynamic: boolean) {
  const base = testProviderConfig(url)
  const provider = base.provider.test
  return {
    ...base,
    compaction: { auto: false, dynamic, tail_turns: 0 },
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

function readBatch(directory: string) {
  return raw({
    chunks: [
      {
        id: "chatcmpl-artifact-folding",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: files.flatMap((name, index) =>
                ["source", "witness"].map((kind) => ({
                  index: index * 2 + (kind === "source" ? 0 : 1),
                  id: `call-artifact-${index}-${kind}`,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ filePath: path.join(directory, name) }),
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

type StoredTool = {
  readonly id: unknown
  readonly messageID: unknown
  readonly callID: unknown
  readonly tool: unknown
  readonly input: unknown
  readonly output: unknown
  readonly title: unknown
  readonly metadata: unknown
  readonly status: unknown
}

function storedTools(messages: unknown): StoredTool[] {
  return array(messages).flatMap((message) =>
    array(record(message).parts).flatMap((part) => {
      const item = record(part)
      if (item.type !== "tool" || item.tool !== "read") return []
      const state = record(item.state)
      if (state.status !== "completed") return []
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
        },
      ]
    }),
  )
}

function resultMap(input: unknown) {
  const results = new Map<string, string>()
  for (const message of array(record(input).messages)) {
    const item = record(message)
    if (item.role !== "tool" || typeof item.tool_call_id !== "string" || typeof item.content !== "string") continue
    if (results.has(item.tool_call_id)) throw new Error(`duplicate outbound tool result ${item.tool_call_id}`)
    results.set(item.tool_call_id, item.content)
  }
  return results
}

function prompt(sdk: Sdk, sessionID: string, text: string) {
  return Effect.promise(() =>
    sdk.session.prompt({
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text }],
    }),
  ).pipe(Effect.map(sdkData))
}

function messages(sdk: Sdk, sessionID: string) {
  return Effect.promise(() => sdk.session.messages({ sessionID })).pipe(Effect.map(sdkData))
}

function writeEvidence(
  name: string,
  input: {
    readonly target: ResolvedCliTarget
    readonly assertions: Record<string, unknown>
    readonly requests: readonly Record<string, unknown>[]
    readonly stored: StoredTool[]
  },
) {
  if (!evidenceDir) return Effect.void
  return Effect.promise(async () => {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    await chmod(evidenceDir, 0o700)
    await Bun.write(path.join(evidenceDir, `${name}.json`), JSON.stringify(input, null, 2) + "\n")
  })
}

const runArm =
  (dynamic: boolean, withManualCompaction: boolean) =>
  ({ home, llm, opencode, target: resolvedTarget }: CliFixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all(files.map((name, index) => Bun.write(path.join(home, name), `${contents[index]}\n`))),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(home, ".config/opencode/memory.jsonc"),
          JSON.stringify({ schema_version: 1, enabled: false }),
        ),
      )

      const server = yield* opencode.host({
        readyTimeoutMs: 30_000,
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig(llm.url, dynamic)) },
      })
      const sdk = createOpencodeClient({ baseUrl: server.url, directory: home })
      const health = yield* Effect.promise(() => sdk.global.health())
      expect(health.response?.status).toBe(200)

      const created = sdkData(
        yield* Effect.promise(() =>
          sdk.session.create({
            title: `Context folding artifact ${dynamic ? "enabled" : "disabled"}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        ),
      )
      const sessionID = String(record(created).id)

      yield* llm.push(readBatch(home), reply().text("artifact duplicate collection complete").stop())
      yield* prompt(sdk, sessionID, prompts.seed)
      for (let index = 0; index < recent.length; index++) {
        yield* llm.text(recent[index])
        yield* prompt(sdk, sessionID, prompts.recent[index])
      }

      const before = yield* messages(sdk, sessionID)
      const beforeTools = storedTools(before)
      expect(beforeTools).toHaveLength(files.length * 2)
      expect(new Set(beforeTools.map((tool) => tool.callID)).size).toBe(files.length * 2)
      expect(
        beforeTools.every(
          (tool) => typeof tool.output === "string" && !tool.output.includes("Duplicate tool output folded"),
        ),
      ).toBe(true)

      yield* llm.text(`artifact folding ${dynamic ? "enabled" : "disabled"} observed`)
      yield* prompt(sdk, sessionID, prompts.observe)
      const afterObserve = yield* messages(sdk, sessionID)
      expect(storedTools(afterObserve)).toEqual(beforeTools)

      const allRequests = yield* llm.inputs
      const observed = allRequests.findLast((input) => requestText(input).includes(prompts.observe))
      expect(observed).toBeDefined()
      const observedText = requestText(observed)
      const observedResults = resultMap(observed)
      const folded = [...observedResults.values()].filter((value) => value.startsWith("[Duplicate tool output folded."))
      const markerCounts = markers.map((marker) => count(observedText, marker))
      if (dynamic) {
        expect(folded).toHaveLength(files.length)
        expect(markerCounts).toEqual(markers.map(() => 1))
        for (let index = 0; index < files.length; index++) {
          expect(observedResults.get(`call-artifact-${index}-source`)).toContain(`call-artifact-${index}-witness`)
        }
      } else {
        expect(folded).toHaveLength(0)
        expect(markerCounts).toEqual(markers.map(() => 2))
        for (let index = 0; index < files.length; index++) {
          expect(observedResults.get(`call-artifact-${index}-source`)).toBe(
            observedResults.get(`call-artifact-${index}-witness`),
          )
        }
      }

      const assertions: Record<string, unknown> = {
        mode: dynamic ? "enabled" : "disabled",
        sessionID,
        providerLoopback: ["127.0.0.1", "::1", "localhost"].includes(new URL(llm.url).hostname),
        storedToolCount: beforeTools.length,
        storedHistoryHash: sha256(beforeTools),
        storedHistoryIntactAfterObservation: sha256(storedTools(afterObserve)) === sha256(beforeTools),
        foldedResults: folded.length,
        markerCounts,
      }

      if (withManualCompaction) {
        const beforeCompactionRequest = (yield* llm.inputs).length
        const summary = "artifact manual compaction summary"
        yield* llm.text(summary)
        const summarized = yield* Effect.promise(() =>
          sdk.session.summarize({
            sessionID,
            providerID: "test",
            modelID: "test-model",
            auto: false,
          }),
        )
        expect(summarized.response?.status).toBe(200)
        expect(summarized.data).toBe(true)

        const compactionRequests = (yield* llm.inputs).slice(beforeCompactionRequest)
        expect(compactionRequests).toHaveLength(1)
        const compactionText = requestText(compactionRequests[0])
        expect(compactionText).not.toContain("Duplicate tool output folded")
        for (let index = 0; index < files.length; index++) {
          expect(compactionText).toContain(markers[index])
          expect(compactionText).toContain(`call-artifact-${index}-source`)
          expect(compactionText).toContain(`call-artifact-${index}-witness`)
        }
        expect(count(compactionText, "Tool output truncated for compaction")).toBeGreaterThanOrEqual(files.length * 2)

        yield* llm.text("artifact post-compaction turn complete")
        yield* prompt(sdk, sessionID, prompts.continue)
        const finalRequests = yield* llm.inputs
        const continuation = finalRequests.findLast((input) => requestText(input).includes(prompts.continue))
        expect(continuation).toBeDefined()
        expect(requestText(continuation)).toContain(summary)
        expect(requestText(continuation)).not.toContain("Duplicate tool output folded")
        const afterCompaction = yield* messages(sdk, sessionID)
        expect(storedTools(afterCompaction)).toEqual(beforeTools)

        Object.assign(assertions, {
          manualCompactionProviderRequests: compactionRequests.length,
          manualCompactionUsedOriginalHistory: true,
          manualCompactionRequestSha256: sha256(compactionRequests[0]),
          postCompactionContinuation: true,
          storedHistoryIntactAfterCompaction: sha256(storedTools(afterCompaction)) === sha256(beforeTools),
        })
      }

      expect(assertions.providerLoopback).toBe(true)
      const requests = yield* llm.inputs
      yield* writeEvidence(dynamic ? "enabled" : "disabled", {
        target: resolvedTarget,
        assertions,
        requests,
        stored: beforeTools,
      })
    })

describe.skipIf(!enabled)("context folding in a CLI target", () => {
  cliIt.live(
    "folds duplicate history, preserves storage, and keeps manual compaction independent",
    runArm(true, true),
    180_000,
  )

  cliIt.live("keeps duplicate history unchanged when dynamic folding is disabled", runArm(false, false), 180_000)
})
