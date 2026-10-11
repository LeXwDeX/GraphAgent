// Live acceptance for final_response DAG delivery through the installed CLI.
// Opt in with OPENCODE_DAG_LIVE_CONFIG=<config path> (or `1` to use the
// standard user config). The provider config is read only into memory and is
// passed to the isolated child process as OPENCODE_CONFIG_CONTENT.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { artifactCliTarget, resolveCliTarget, verifyCliTarget, withCliFixture } from "../lib/cli-process"

type RecordValue = Record<string, unknown>
type ModelCandidate = {
  providerID: string
  modelID: string
  provider: RecordValue
}

const liveConfigSetting = process.env.OPENCODE_DAG_LIVE_CONFIG
const liveEnabled = Boolean(liveConfigSetting)
const cliTarget = artifactCliTarget("/usr/local/bin/opencode")
const candidateModelIDs = ["qwen-max", "glm", "deepseek"] as const
const selectedModelSetting = process.env.OPENCODE_DAG_LIVE_MODELS
const schemaToken = "LIVE_DAG_SCHEMA_PROOF_71C8"
const plainAnswer = "LIVE_DAG_FINAL_RAW_4F2A"
const deliveryMetaKey = "dag_delivery"

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error("expected JSON object")
  return value
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected JSON array")
  return value
}

function stringField(value: RecordValue, key: string): string {
  const result = value[key]
  if (typeof result !== "string") throw new Error(`expected ${key} to be a string`)
  return result
}

function liveConfigPath(): string {
  if (liveConfigSetting === "1" || liveConfigSetting === "true")
    return path.join(os.homedir(), ".config/opencode/opencode.json")
  return liveConfigSetting!
}

async function readModelCandidates(configPath: string): Promise<ModelCandidate[]> {
  let config: RecordValue
  try {
    config = record(JSON.parse(await readFile(configPath, "utf8")))
  } catch {
    throw new Error("OPENCODE_DAG_LIVE_CONFIG must name a readable JSON opencode config")
  }
  const providers = record(config.provider ?? {})
  const result: ModelCandidate[] = []
  const selected = selectedModelSetting
    ? new Set(
        selectedModelSetting
          .split(/[|,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : new Set(candidateModelIDs)
  const requested = candidateModelIDs.filter((modelID) => selected.has(modelID))
  if (requested.length === 0) throw new Error("OPENCODE_DAG_LIVE_MODELS must select qwen-max, glm, or deepseek")
  for (const modelID of requested) {
    for (const [providerID, rawProvider] of Object.entries(providers)) {
      const provider = record(rawProvider)
      const models = record(provider.models ?? {})
      if (Object.hasOwn(models, modelID)) result.push({ providerID, modelID, provider })
    }
  }
  if (result.length === 0) throw new Error("live config has no qwen-max, glm, or deepseek model")
  return result
}

async function requestJson(
  baseURL: string,
  directory: string,
  route: string,
  input: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(new URL(route, baseURL), {
    method: input.method ?? "GET",
    headers: {
      "x-opencode-directory": directory,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${input.method ?? "GET"} ${route} failed with status ${response.status}`)
  }
  if (response.status === 204) return undefined
  try {
    return await response.json()
  } catch {
    throw new Error(`HTTP ${input.method ?? "GET"} ${route} returned invalid JSON`)
  }
}

function providerUnavailable(reason: string): boolean {
  return /\b(401|403|404|408|429|5\d\d)\b|quota|rate.?limit|unauthor|api.?key|fetch failed|network|ECONN|timed? ?out|temporarily unavailable/i.test(
    reason,
  )
}

function deliveryMeta(part: RecordValue): RecordValue | undefined {
  const metadata = part.metadata
  if (!isRecord(metadata)) return undefined
  const value = metadata[deliveryMetaKey]
  return isRecord(value) ? value : undefined
}

function visibleText(message: RecordValue): string {
  return list(message.parts)
    .map(record)
    .filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
}

async function waitForWorkflow(
  baseURL: string,
  directory: string,
  workflowID: string,
  timeoutMs: number,
): Promise<{ detail: RecordValue; nodes: RecordValue[]; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs
  let detail: RecordValue = {}
  let nodes: RecordValue[] = []
  while (Date.now() < deadline) {
    detail = record(await requestJson(baseURL, directory, `/dag/${encodeURIComponent(workflowID)}`))
    nodes = list(await requestJson(baseURL, directory, `/dag/${encodeURIComponent(workflowID)}/nodes`)).map(record)
    const status = stringField(detail, "status")
    if (status === "completed" || status === "failed" || status === "cancelled")
      return { detail, nodes, timedOut: false }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return { detail, nodes, timedOut: true }
}

async function waitForParentMessages(
  baseURL: string,
  directory: string,
  sessionID: string,
  predicate: (messages: RecordValue[]) => boolean,
  timeoutMs: number,
): Promise<RecordValue[]> {
  const deadline = Date.now() + timeoutMs
  let messages: RecordValue[] = []
  while (Date.now() < deadline) {
    messages = list(await requestJson(baseURL, directory, `/session/${encodeURIComponent(sessionID)}/message`)).map(
      record,
    )
    if (predicate(messages)) return messages
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return messages
}

function assertReceipt(messages: RecordValue[], workflowID: string, graphRev: number, childSessionID: string): string {
  const assistant = messages.filter((message) => record(message.info).role === "assistant")
  expect(assistant).toHaveLength(1)
  const deliveryParts = assistant.flatMap((message) =>
    list(message.parts)
      .map(record)
      .map((part) => ({ part, meta: deliveryMeta(part) })),
  )
  const answers = deliveryParts.filter((item) => item.meta?.workflow_id === workflowID && item.meta?.kind === "answer")
  const sources = deliveryParts.filter((item) => item.meta?.workflow_id === workflowID && item.meta?.kind === "source")
  expect(answers).toHaveLength(1)
  expect(sources).toHaveLength(1)
  const receipt = answers[0].meta!
  expect(receipt.workflow_id).toBe(workflowID)
  expect(receipt.graph_rev).toBe(graphRev)
  expect(receipt.node_id).toBe("delivery")
  expect(receipt.child_session_id).toBe(childSessionID)
  expect(receipt.replan_attempt).toBe(0)
  expect(typeof receipt.completion_seq).toBe("number")
  const text = answers[0].part.text
  if (typeof text !== "string") throw new Error("answer receipt has no text")
  return text
}

async function tryCandidate(input: {
  serverURL: string
  home: string
  serverEnv: Record<string, string>
  providerID: string
  modelID: string
}): Promise<
  | "unavailable"
  | {
      status: "passed"
      directory: string
      parentID: string
      workflowID: string
      childSessionID: string
      graphRev: number
      serverEnv: Record<string, string>
    }
> {
  const { serverURL, home, serverEnv, providerID, modelID } = input
  const directory = path.join(home, `workspace-${modelID}`)
  await mkdir(directory, { recursive: true })
  const parent = record(
    await requestJson(serverURL, directory, "/session", {
      method: "POST",
      body: { title: `DAG final response live ${modelID}`, model: { id: modelID, providerID } },
    }),
  )
  const parentID = stringField(parent, "id")

  // Starting the workflow through HTTP bypasses parent model planning. The
  // runtime owns the synthetic user anchor required to attach its receipt.
  const start = record(
    await requestJson(serverURL, directory, "/dag", {
      method: "POST",
      body: {
        session_id: parentID,
        title: `Final response capture ${modelID}`,
        config: {
          name: `live-final-response-${modelID}`,
          result_protocol: "final_response",
          delivery_node: "delivery",
          max_concurrency: 1,
          nodes: [
            {
              id: "schema",
              name: "Return the structured proof",
              worker_type: "general",
              depends_on: [],
              required: true,
              prompt_template: {
                inline: `Return exactly one JSON object and no Markdown: {"token":"${schemaToken}"}.`,
              },
              output_schema: {
                type: "object",
                properties: { token: { type: "string" } },
                required: ["token"],
                additionalProperties: false,
              },
            },
            {
              id: "delivery",
              name: "Return the raw final answer",
              worker_type: "general",
              depends_on: ["schema"],
              required: true,
              input_mapping: { proof: "schema.output.token" },
              prompt_template: {
                inline: `The upstream proof token is {{proof}}. Finish with exactly this plain-text line and no other text: ${plainAnswer}`,
              },
            },
          ],
        },
      },
    }),
  )
  const workflowID = stringField(start, "id")
  const workflow = await waitForWorkflow(serverURL, directory, workflowID, 180_000)
  if (workflow.timedOut) return "unavailable"
  if (workflow.detail.status !== "completed") {
    const failed = workflow.nodes.find((node) => node.status === "failed")
    const reason = typeof failed?.error_reason === "string" ? failed.error_reason : ""
    if (providerUnavailable(reason)) return "unavailable"
    throw new Error(`live DAG did not complete for ${modelID} (workflow status ${String(workflow.detail.status)})`)
  }

  expect(workflow.nodes).toHaveLength(2)
  const storedConfig = record(JSON.parse(stringField(workflow.detail, "config")))
  expect(storedConfig.result_protocol).toBe("final_response")
  expect(storedConfig.delivery_node).toBe("delivery")
  const schemaNode = workflow.nodes.find((node) => node.id === "schema")!
  const deliveryNode = workflow.nodes.find((node) => node.id === "delivery")!
  expect(schemaNode.status).toBe("completed")
  expect(deliveryNode.status).toBe("completed")
  expect(schemaNode.output).toEqual({ token: schemaToken })
  const deliveryOutput = deliveryNode.output
  if (typeof deliveryOutput !== "string") throw new Error("delivery node output is not a string")
  expect(deliveryOutput).toBe(plainAnswer)
  expect(typeof schemaNode.child_session_id).toBe("string")
  expect(typeof deliveryNode.child_session_id).toBe("string")
  const schemaSessionID = String(schemaNode.child_session_id)
  const childSessionID = String(deliveryNode.child_session_id)

  const [schemaMessages, deliveryMessages] = await Promise.all(
    [schemaSessionID, childSessionID].map(async (sessionID) =>
      list(await requestJson(serverURL, directory, `/session/${encodeURIComponent(sessionID)}/message`)).map(record),
    ),
  )
  const schemaAssistant = schemaMessages.filter((message) => record(message.info).role === "assistant")
  const schemaFinalText = visibleText(schemaAssistant.at(-1) ?? {})
  expect(JSON.parse(schemaFinalText)).toEqual({ token: schemaToken })
  const childAssistant = deliveryMessages.filter((message) => record(message.info).role === "assistant")
  const childFinalText = visibleText(childAssistant.at(-1) ?? {})
  expect(childFinalText).toBe(plainAnswer)
  const usedSubmitResult = [...schemaMessages, ...deliveryMessages]
    .flatMap((message) => list(message.parts).map(record))
    .some((part) => part.type === "tool" && part.tool === "submit_result")
  expect(usedSubmitResult).toBe(false)

  const summary = list(await requestJson(serverURL, directory, `/dag/session/${encodeURIComponent(parentID)}/summary`))
    .map(record)
    .find((item) => item.id === workflowID)
  if (!summary || typeof summary.graphRev !== "number") throw new Error("workflow summary omitted graphRev")
  const parentMessages = await waitForParentMessages(
    serverURL,
    directory,
    parentID,
    (messages) =>
      messages.some((message) =>
        list(message.parts).some((part) => deliveryMeta(record(part))?.workflow_id === workflowID),
      ),
    20_000,
  )
  const reportedText = assertReceipt(parentMessages, workflowID, summary.graphRev, childSessionID)
  expect(reportedText).toBe(childFinalText)
  expect(reportedText).toBe(deliveryOutput)
  expect(
    parentMessages.flatMap((message) => list(message.parts).map(record)).filter((part) => part.text === childFinalText),
  ).toHaveLength(1)
  expect(
    parentMessages
      .filter((message) => record(message.info).role === "assistant")
      .flatMap((message) => list(message.parts).map(record))
      .some((part) => part.type === "tool" && part.tool === "submit_result"),
  ).toBe(false)

  return {
    status: "passed",
    directory,
    parentID,
    workflowID,
    childSessionID,
    graphRev: summary.graphRev,
    serverEnv,
  }
}

test.skipIf(!liveEnabled)(
  "installed opencode captures and delivers final DAG output once without a parent model turn",
  async () => {
    const candidates = await readModelCandidates(liveConfigPath())
    await Effect.runPromise(
      Effect.scoped(
        withCliFixture(
          ({ opencode, home, env, target }) =>
            Effect.gen(function* () {
              const resolved = yield* Effect.promise(() => resolveCliTarget(cliTarget))
              yield* Effect.promise(() => verifyCliTarget(resolved))
              const version = yield* opencode.spawn(["--version"], { timeoutMs: 30_000 })
              if (version.exitCode !== 0 || version.stdout.trim().length === 0)
                throw new Error("installed /usr/local/bin/opencode did not report a version")

              const unavailable: string[] = []
              for (const candidate of candidates) {
                const configJson = JSON.stringify({
                  $schema: "https://opencode.ai/config.json",
                  provider: { [candidate.providerID]: candidate.provider },
                  compaction: { auto: false },
                  reasoningDistillation: { enabled: false },
                })
                const serverEnv = {
                  ...env,
                  OPENCODE_CONFIG: "",
                  OPENCODE_CONFIG_DIR: "",
                  OPENCODE_CONFIG_CONTENT: configJson,
                  OPENCODE_DB: path.join(home, "isolated-opencode.db"),
                }
                const server = yield* opencode.serve({ port: 0, hostname: "127.0.0.1", env: serverEnv })
                const result = yield* Effect.promise(() =>
                  tryCandidate({
                    serverURL: server.url,
                    home,
                    serverEnv,
                    providerID: candidate.providerID,
                    modelID: candidate.modelID,
                  }),
                )
                server.kill()
                yield* Effect.promise(() => server.exited)
                if (result === "unavailable") {
                  unavailable.push(candidate.modelID)
                  continue
                }

                // Restart and re-read durable output + the delivery receipt.
                const restarted = yield* opencode.serve({ port: 0, hostname: "127.0.0.1", env: result.serverEnv })
                const persisted = yield* Effect.promise(() =>
                  waitForWorkflow(restarted.url, result.directory, result.workflowID, 30_000),
                )
                expect(persisted.timedOut).toBe(false)
                expect(persisted.detail.status).toBe("completed")
                expect(persisted.nodes.find((node) => node.id === "schema")?.output).toEqual({ token: schemaToken })
                expect(persisted.nodes.find((node) => node.id === "delivery")?.output).toBe(plainAnswer)
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2_000)))
                const afterRestart = yield* Effect.promise(() =>
                  waitForParentMessages(
                    restarted.url,
                    result.directory,
                    result.parentID,
                    (messages) => messages.some((message) => record(message.info).role === "assistant"),
                    10_000,
                  ),
                )
                expect(assertReceipt(afterRestart, result.workflowID, result.graphRev, result.childSessionID)).toBe(
                  plainAnswer,
                )
                const parentAssistantMessages = afterRestart.filter(
                  (message) => record(message.info).role === "assistant",
                )
                process.stderr.write(
                  `[dag-final-response-live] model=${candidate.modelID} status=passed workflow_nodes=${persisted.nodes.length} ` +
                    `submit_result_calls=0 parent_assistant_messages=${parentAssistantMessages.length} ` +
                    `answer_receipts=1 source_receipts=1 binary_version=${version.stdout.trim()} ` +
                    `binary_sha256=${target.mode === "artifact" ? target.sha256 : "source"}\n`,
                )
                return
              }
              throw new Error(`no configured live model completed acceptance; unavailable: ${unavailable.join(", ")}`)
            }),
          cliTarget,
        ),
      ),
    )
  },
  15 * 60_000,
)
