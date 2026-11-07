import { expect } from "bun:test"
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import { createOpencodeClient } from "@graphagent/sdk/v2"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "path"
import {
  materializeBodiesV3,
  V3_MAX_PROVIDER_REQUESTS,
  V3_TASKS,
  V3_TASK_IDS,
  V3_WINDOW,
  type V3TaskID,
  type V3ToolGroup,
  type V3ToolOperation,
} from "../../../../docs/continuation-2026-09-20/s09/scripts/task-spec-v3"
import { cliIt } from "../lib/cli-process"
import { raw, reply, type Item, type TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

type Sdk = ReturnType<typeof createOpencodeClient>
type Arm = "enabled" | "disabled"
type Host = Readonly<{ url: string; logs: string[]; stop: () => Promise<void> }>

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function providerConfig(url: string): Partial<ConfigV1.Info> {
  const config = testProviderConfig(url)
  config.provider.test.models["test-model"].limit = {
    context: V3_WINDOW.contextLimit,
    output: V3_WINDOW.outputReserve,
  }
  return { ...config, compaction: { auto: true, dynamic: true } }
}

function callID(task: V3TaskID, prompt: number, group: number, operation: number, item: V3ToolOperation) {
  if (item.kind === "read" && item.role) return `call-v3-${task.slice(0, 2)}-${item.role}`
  return `call-v3-${task.slice(0, 2)}-${prompt}-${group}-${operation}`
}

function inputFor(directory: string, operation: V3ToolOperation) {
  switch (operation.kind) {
    case "read":
      return { filePath: path.join(directory, operation.path) }
    case "edit":
      return {
        filePath: path.join(directory, operation.path),
        oldString: operation.oldString,
        newString: operation.newString,
      }
    case "grep":
      return { pattern: operation.pattern, path: path.join(directory, operation.path) }
    case "bash":
      return { command: operation.command, workdir: directory }
  }
  throw new Error(`unsupported v3 operation: ${JSON.stringify(operation satisfies never)}`)
}

function groupReply(task: V3TaskID, prompt: number, group: number, directory: string, operations: V3ToolGroup): Item {
  return raw({
    chunks: [
      {
        id: `chatcmpl-v3-${task}-${prompt}-${group}`,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: operations.map((operation, index) => ({
                index,
                id: callID(task, prompt, group, index, operation),
                type: "function",
                function: { name: operation.kind, arguments: JSON.stringify(inputFor(directory, operation)) },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ],
  })
}

function lastWord(value: string) {
  return value.trim().split(/\s+/).at(-1) ?? ""
}

function finalAnswer(task: V3TaskID, prompt: number, bodies: ReadonlyMap<string, string>) {
  if (task === "t1-read-then-edit" && prompt === 1) return `retries=7; ${lastWord(bodies.get("filler/f02.txt") ?? "")}`
  if (task === "t4-return-earlier") {
    const lines = ["p2/x.txt", "p2/y.txt"].reduce(
      (total, file) => total + (bodies.get(file)?.split("\n").length ?? 0),
      0,
    )
    return `GATE-CODE-5521; ${lines}`
  }
  const planned = V3_TASKS[task].prompts[prompt]
  if (!planned) throw new Error(`missing v3 prompt ${task}:${prompt}`)
  return planned.answer
}

function completedTools(messages: unknown) {
  return array(messages).flatMap((message) =>
    array(record(message).parts).flatMap((part) => {
      const item = record(part)
      const state = record(item.state)
      if (item.type !== "tool" || state.status !== "completed") return []
      return [
        {
          callID: String(item.callID),
          tool: String(item.tool),
          output: state.output,
          metadata: record(state.metadata),
          compacted: record(state.time).compacted,
          stored: structuredClone(item),
        },
      ]
    }),
  )
}

function outboundResults(body: unknown) {
  const results = new Map<string, string>()
  for (const message of array(record(body).messages)) {
    const item = record(message)
    if (item.role !== "tool" || typeof item.tool_call_id !== "string" || typeof item.content !== "string") continue
    results.set(item.tool_call_id, item.content)
  }
  return results
}

async function prompt(sdk: Sdk, sessionID: string, text: string) {
  const result = await sdk.session.prompt({
    sessionID,
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text }],
  })
  expect(result.response?.status).toBe(200)
}

function isolatedEnv(home: string, config: Partial<ConfigV1.Info>, arm: Arm) {
  return {
    ...process.env,
    GRAPHAGENT_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(config),
    GRAPHAGENT_DISABLE_PROJECT_CONFIG: "1",
    GRAPHAGENT_DISABLE_MODELS_FETCH: "1",
    GRAPHAGENT_AUTH_CONTENT: "{}",
    GRAPHAGENT_DISABLE_PRUNE: arm === "disabled" ? "1" : "0",
    GRAPHAGENT_PRINT_LOGS: "1",
    GRAPHAGENT_LOG_LEVEL: "INFO",
  }
}

async function drain(stream: ReadableStream<Uint8Array>, chunks: string[], onText?: (text: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    const text = decoder.decode(item.value, { stream: true })
    chunks.push(text)
    onText?.(text)
  }
}

function startHost(home: string, config: Partial<ConfigV1.Info>, arm: Arm) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      // `opencode serve` was removed with the remote server surface; the
      // maintained source host entrypoint starts the same HttpApi app.
      const child = Bun.spawn(
        [process.execPath, "run", "--conditions=browser", path.join(import.meta.dir, "../lib/server-host.ts")],
        {
          cwd: home,
          env: isolatedEnv(home, config, arm),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stdout: string[] = []
      const logs: string[] = []
      let buffered = ""
      let resolveReady!: (url: string) => void
      let rejectReady!: (error: Error) => void
      const ready = new Promise<string>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const stdoutDrain = drain(child.stdout, stdout, (text) => {
        buffered += text
        const match = buffered.match(/listening on (http:\/\/[^\s]+)/)
        if (match?.[1]) resolveReady(match[1])
      })
      const stderrDrain = drain(child.stderr, logs)
      void child.exited.then((code) => {
        if (code !== 0) rejectReady(new Error(`qualification host exited ${code}: ${logs.join("").slice(-2000)}`))
      })
      const url = await Promise.race([
        ready,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`qualification host startup timeout: ${logs.join("").slice(-2000)}`)),
            30_000,
          ),
        ),
      ])
      return {
        url,
        logs,
        stop: async () => {
          child.kill()
          await child.exited
          await Promise.all([stdoutDrain, stderrDrain])
        },
      } satisfies Host
    }),
    (host) => Effect.promise(host.stop).pipe(Effect.ignore),
  )
}

function logField(line: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = line.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|([^\\s]+))`))
  return match?.[1] ?? match?.[2]
}

function foldingDiagnostics(logs: readonly string[]) {
  return logs
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.includes('message="context folding"'))
    .map((line) => ({
      purpose: logField(line, "requestPurpose"),
      enabled: logField(line, "enabled"),
      applied: logField(line, "applied"),
      foldedOutputs: logField(line, "foldedOutputs"),
      targetTokens: logField(line, "targetTokens"),
      estimatedBefore: logField(line, "estimatedBefore"),
      estimatedSavings: logField(line, "estimatedSavings"),
      overBudget: logField(line, "overBudget"),
      skipReason: logField(line, "skipReason"),
    }))
}

function runArm(input: { task: V3TaskID; arm: Arm; llm: TestLLMServer["Service"]; home: string }) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* input.llm.reset
      const spec = V3_TASKS[input.task]
      const bodies = materializeBodiesV3(input.task)
      const directory = path.join(input.home, `workspace-${input.task}-${input.arm}`)
      yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true })
        for (const [file, body] of bodies) {
          const target = path.join(directory, file)
          await mkdir(path.dirname(target), { recursive: true })
          await Bun.write(target, body)
        }
      })
      const host = yield* startHost(input.home, providerConfig(input.llm.url), input.arm)
      const sdk = createOpencodeClient({ baseUrl: host.url, directory })
      const created = yield* Effect.promise(() =>
        sdk.session.create({
          title: `S09 v3 ${input.task} ${input.arm}`,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )
      expect(created.response?.status).toBe(200)
      const sessionID = String(record(created.data).id)
      let sourceBefore: unknown

      for (let promptIndex = 0; promptIndex < spec.prompts.length; promptIndex++) {
        const planned = spec.prompts[promptIndex]
        if (!planned) throw new Error(`missing v3 prompt ${input.task}:${promptIndex}`)
        yield* input.llm.push(
          ...planned.groups.map((group, groupIndex) =>
            groupReply(input.task, promptIndex, groupIndex, directory, group),
          ),
          reply()
            .text(finalAnswer(input.task, promptIndex, bodies))
            .stop(),
        )
        yield* Effect.promise(() => prompt(sdk, sessionID, planned.text))
        if (promptIndex === 0) {
          const snapshot = yield* Effect.promise(() => sdk.session.messages({ sessionID }))
          const sourceID = `call-v3-${input.task.slice(0, 2)}-source`
          sourceBefore = completedTools(snapshot.data).find((item) => item.callID === sourceID)?.stored
          expect(sourceBefore).toBeDefined()
        }
      }

      const listed = yield* Effect.promise(() => sdk.session.messages({ sessionID }))
      expect(listed.response?.status).toBe(200)
      const tools = completedTools(listed.data)
      const sourceID = `call-v3-${input.task.slice(0, 2)}-source`
      const witnessID = `call-v3-${input.task.slice(0, 2)}-witness`
      const source = tools.find((item) => item.callID === sourceID)
      const witness = tools.find((item) => item.callID === witnessID)
      expect(source).toBeDefined()
      expect(witness).toBeDefined()
      expect(JSON.stringify(source?.stored)).toBe(JSON.stringify(sourceBefore))
      expect(source?.tool).toBe("read")
      expect(witness?.tool).toBe("read")
      expect(source?.output).toBe(witness?.output)
      expect(source?.metadata.truncated).toBe(false)
      expect(witness?.metadata.truncated).toBe(false)
      expect(source?.metadata.loaded).toEqual([])
      expect(witness?.metadata.loaded).toEqual([])
      expect(source?.metadata.contextFoldingInstructions).toBe("none")
      expect(witness?.metadata.contextFoldingInstructions).toBe("none")
      expect(source?.compacted).toBeUndefined()
      expect(witness?.compacted).toBeUndefined()
      expect(
        array(listed.data)
          .flatMap((message) => array(record(message).parts))
          .some((part) => record(part).type === "compaction"),
      ).toBe(false)

      const providerInputs = yield* input.llm.inputs
      expect(providerInputs).toHaveLength(spec.expectedProviderRequests)
      expect(providerInputs.length).toBeLessThanOrEqual(V3_MAX_PROVIDER_REQUESTS)
      expect(providerInputs.every((body) => body.model === "test-model")).toBe(true)
      const requestResults = providerInputs.map(outboundResults)
      const coPresent = requestResults.filter((results) => results.has(sourceID) && results.has(witnessID))
      expect(coPresent.length).toBeGreaterThan(0)
      if (input.arm === "enabled") {
        const designated = coPresent.find(
          (results) =>
            results.get(sourceID)?.startsWith("[Duplicate tool output folded.") &&
            results.get(witnessID) === witness?.output,
        )
        expect(designated).toBeDefined()
        expect(designated?.get(sourceID)).toContain(witnessID)
      } else {
        expect(
          coPresent.every(
            (results) => results.get(sourceID) === source?.output && results.get(witnessID) === witness?.output,
          ),
        ).toBe(true)
        expect(
          requestResults
            .flatMap((results) => [...results.values()])
            .some((value) => value.startsWith("[Duplicate tool output folded.")),
        ).toBe(false)
      }

      yield* Effect.sleep("100 millis")
      const conversations = foldingDiagnostics(host.logs).filter((item) => item.purpose === "conversation")
      expect(conversations).toHaveLength(spec.expectedProviderRequests)
      if (input.arm === "enabled") {
        const applied = conversations.find(
          (item) =>
            item.applied === "true" &&
            item.targetTokens === "54476" &&
            Number(item.estimatedSavings) >= 512 &&
            Number(item.foldedOutputs) >= 1,
        )
        expect(applied).toBeDefined()
        expect(Number(applied?.estimatedBefore)).toBeGreaterThan(V3_WINDOW.targetTokens)
        // Diagnostic overBudget is post-projection: false means the selected
        // replacement brought this request to or below the target.
        expect(applied?.overBudget).toBe("false")
        expect(applied?.skipReason).toBe("none")
      } else {
        expect(conversations.every((item) => item.enabled === "false" && item.applied === "false")).toBe(true)
      }
      return { requests: providerInputs.length }
    }),
  )
}

cliIt.live(
  "qualifies S09 v3 designated sources through the real host with a loopback provider",
  ({ llm, home }) =>
    Effect.gen(function* () {
      for (const task of V3_TASK_IDS) {
        const enabled = yield* runArm({ task, arm: "enabled", llm, home })
        const disabled = yield* runArm({ task, arm: "disabled", llm, home })
        expect(enabled.requests).toBe(disabled.requests)
      }
    }),
  240_000,
)
