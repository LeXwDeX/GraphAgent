// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { Identifier } from "@graphagent/core/id/id"
import { createClient } from "@graphagent/sdk"
import { Cause, Effect, Exit } from "effect"
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { artifactCliTarget, sourceCliTarget, withCliFixture } from "../../lib/cli-process"
import { it } from "../../lib/effect"
import { reply } from "../../lib/llm-server"
import { createTuiProcess } from "../../lib/tui-process"

const artifactExecutable = process.env.GRAPHAGENT_TEST_ARTIFACT_EXECUTABLE
const sourceEnabled = process.env.GRAPHAGENT_TEST_TUI_SOURCE === "1"
const enabled = !!artifactExecutable || sourceEnabled
const target = artifactExecutable ? artifactCliTarget(artifactExecutable) : sourceCliTarget
const run = enabled ? it.live : it.live.skip

const INITIAL = "TUI_GATE_INITIAL"
const INITIAL_DONE = "TUI_GATE_INITIAL_DONE"
const Q1 = "Q1_EDIT_ME"
const Q1_EDITED = `${Q1}_DONE`
const Q2 = "Q2_STALE_ME"
const Q2_EXTERNAL = "Q2_EXTERNAL_STATE"
const Q3 = "Q3_DELETE_ME"
const FINAL_DONE = "TUI_QUEUE_FINAL_DONE"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`expected object, got ${String(value)}`)
  return Object.fromEntries(Object.entries(value))
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array")
  return value
}

function sdkData(result: { data?: unknown; error?: unknown; response?: Response }) {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`SDK request failed (${result.response?.status ?? "unknown"}): ${JSON.stringify(result.error)}`)
  }
  return result.data
}

function message(value: unknown) {
  const data = record(value)
  return {
    info: record(data.info),
    parts: array(data.parts).map(record),
  }
}

function textPart(value: ReturnType<typeof message>) {
  const part = value.parts.find((item) => item.type === "text" && item.synthetic !== true)
  if (!part || typeof part.id !== "string" || typeof part.text !== "string") {
    throw new Error("expected one ordinary text part")
  }
  return { id: part.id, text: part.text }
}

function bodyIncludes(marker: string) {
  return (hit: { body: unknown }) => JSON.stringify(hit.body).includes(marker)
}

function observedPromise() {
  let seen = false
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = () => {
      seen = true
      resolve()
    }
  })
  return { promise, release, seen: () => seen }
}

async function bounded<T>(value: Promise<T>, description: string, timeoutMs = 20_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve a loopback port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function evidenceDirectory() {
  const configured = process.env.GRAPHAGENT_TEST_TUI_EVIDENCE_DIR
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`TUI evidence directory must be absolute: ${configured}`)
    await chmod(configured, 0o700).catch(() => {})
    return configured
  }
  const created = await mkdtemp(path.join(os.tmpdir(), "graphagent-tui-evidence-"))
  await chmod(created, 0o700)
  process.stderr.write(`[tui-evidence] ${created}\n`)
  return created
}

run(
  "edits, rejects a stale edit, and deletes queued prompts through the real TUI",
  () =>
    withCliFixture(
      ({ env, home, llm, target: resolvedTarget }) =>
        Effect.gen(function* () {
          let checkpoint = "fixture-ready"
          let releaseFirst: () => void = () => {}
          const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          const initialSeen = observedPromise()
          const finalSeen = observedPromise()

          yield* llm.pushMatch((hit) => {
            if (!bodyIncludes(INITIAL)(hit)) return false
            initialSeen.release()
            return true
          }, reply().wait(firstGate).text(INITIAL_DONE).stop().item())

          const port = yield* Effect.promise(freePort)
          const evidenceDir = yield* Effect.promise(evidenceDirectory)
          const project = yield* Effect.promise(() => realpath(home))
          const tui = yield* Effect.promise(() =>
            createTuiProcess({
              target: resolvedTarget,
              args: [
                project,
                "--model",
                "test/test-model",
                "--prompt",
                INITIAL,
                "--hostname",
                "127.0.0.1",
                "--port",
                String(port),
              ],
              cwd: home,
              env,
              evidenceDir,
            }),
          )
          yield* Effect.addFinalizer((exit) =>
            Effect.promise(() =>
              tui.close({
                checkpoint,
                ...(Exit.isFailure(exit)
                  ? {
                      failure: Cause.prettyErrors(exit.cause).map((error) => ({
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                      })),
                    }
                  : {}),
              }),
            ).pipe(Effect.ignore),
          )

          yield* Effect.promise(() => bounded(initialSeen.promise, "the initial provider request"))
          checkpoint = "initial-provider-request-seen"
          const health = yield* Effect.promise(() =>
            bounded(fetch(`http://127.0.0.1:${port}/global/health`), "the external TUI server health response", 5_000),
          )
          expect(health.ok).toBe(true)
          checkpoint = "external-server-healthy"
          const sdk = createClient({ baseUrl: `http://127.0.0.1:${port}`, directory: project })
          const sessions = array(
            sdkData(
              yield* Effect.promise(() => bounded(sdk.session.list({ limit: 10 }), "the SDK session list", 5_000)),
            ),
          )
          checkpoint = "session-listed"
          if (sessions.length === 0) throw new Error(`TUI session list was empty for directory ${project}`)
          const sessionID = String(record(sessions[0]).id)
          expect(sessionID).toStartWith("ses")

          const promptRequests: Promise<void>[] = []
          const seed = (text: string, filename?: string) => {
            const messageID = Identifier.ascending("message")
            const textID = Identifier.ascending("part")
            const fileID = filename ? Identifier.ascending("part") : undefined
            promptRequests.push(
              bounded(
                sdk.session.prompt({
                  sessionID,
                  messageID,
                  agent: "build",
                  model: { providerID: "test", modelID: "test-model" },
                  parts: [
                    { id: textID, type: "text", text },
                    ...(fileID && filename
                      ? [
                          {
                            id: fileID,
                            type: "file" as const,
                            mime: "text/plain",
                            filename,
                            url: `data:text/plain,${text}`,
                          },
                        ]
                      : []),
                  ],
                }),
                `prompt request ${text}`,
                60_000,
              ).then((result) => {
                if (result.error !== undefined || !result.response?.ok) {
                  throw new Error(`failed prompt request ${text}: ${result.response?.status ?? "unknown"}`)
                }
              }),
            )
            return {
              info: { id: messageID },
              parts: [
                { id: textID, type: "text", text },
                ...(fileID && filename ? [{ id: fileID, type: "file", filename }] : []),
              ],
            }
          }

          const q1 = seed(Q1, "q1-original.txt")
          const q2 = seed(Q2, "q2-original.txt")
          const q3 = seed(Q3)
          checkpoint = "queued-messages-seeded"

          yield* Effect.promise(() => tui.waitForText(Q1))
          yield* Effect.promise(() => tui.waitForText(Q2))
          yield* Effect.promise(() => tui.waitForText(Q3))
          const q1Before = message(
            sdkData(yield* Effect.promise(() => sdk.session.message({ sessionID, messageID: q1.info.id }))),
          )
          const q2Before = message(
            sdkData(yield* Effect.promise(() => sdk.session.message({ sessionID, messageID: q2.info.id }))),
          )

          tui.clickText(Q1)
          yield* Effect.promise(() => tui.waitForText("Message Actions"))
          tui.write("\r", "select-edit-q1")
          yield* Effect.promise(() => tui.waitForText("Edit queued message"))
          tui.write("_DONE", "append-q1")
          tui.write("\r", "submit-edit-q1")
          yield* Effect.promise(() => tui.waitForText(Q1_EDITED))
          yield* Effect.promise(() => tui.waitForTextAbsent("Edit queued message"))

          const q1After = message(
            sdkData(yield* Effect.promise(() => sdk.session.message({ sessionID, messageID: q1.info.id }))),
          )
          expect(textPart(q1After).text).toBe(Q1_EDITED)
          expect(q1After.parts.map((part) => part.id)).toEqual(q1Before.parts.map((part) => part.id))
          expect(q1After.parts.find((part) => part.type === "file")?.filename).toBe("q1-original.txt")
          checkpoint = "q1-edit-verified"

          tui.clickText(Q2)
          yield* Effect.promise(() => tui.waitForText("Message Actions"))
          tui.write("\r", "select-edit-q2")
          yield* Effect.promise(() => tui.waitForText("Edit queued message"))

          const q2TextID = textPart(q2Before).id
          sdkData(
            yield* Effect.promise(() =>
              sdk.part.update({
                sessionID,
                messageID: q2.info.id,
                partID: q2TextID,
                part: {
                  id: q2TextID,
                  sessionID,
                  messageID: q2.info.id,
                  type: "text",
                  text: Q2_EXTERNAL,
                },
              }),
            ),
          )
          const externalPartID = Identifier.ascending("part")
          sdkData(
            yield* Effect.promise(() =>
              sdk.part.update({
                sessionID,
                messageID: q2.info.id,
                partID: externalPartID,
                part: {
                  id: externalPartID,
                  sessionID,
                  messageID: q2.info.id,
                  type: "file",
                  mime: "text/plain",
                  filename: "q2-external.txt",
                  url: "data:text/plain,Q2-EXTERNAL-FILE",
                },
              }),
            ),
          )
          tui.write("_LOCAL", "append-stale-q2")
          tui.write("\r", "submit-stale-q2")
          yield* Effect.promise(() => tui.waitForText("Queued message was not changed"))

          const q2After = message(
            sdkData(yield* Effect.promise(() => sdk.session.message({ sessionID, messageID: q2.info.id }))),
          )
          expect(textPart(q2After).text).toBe(Q2_EXTERNAL)
          expect(q2After.parts.map((part) => part.id)).toContain(externalPartID)
          expect(q2After.parts.find((part) => part.id === externalPartID)?.filename).toBe("q2-external.txt")
          checkpoint = "q2-conflict-verified"

          tui.clickText(Q3)
          yield* Effect.promise(() => tui.waitForText("Message Actions"))
          tui.write("\x1b[B", "select-delete-q3")
          tui.write("\r", "open-delete-confirm-q3")
          yield* Effect.promise(() => tui.waitForText("Delete queued message"))
          tui.write("\r", "confirm-delete-q3")
          checkpoint = "q3-delete-submitted"
          yield* Effect.promise(() => tui.waitForTextAbsent("Delete queued message"))
          const q3After = yield* Effect.promise(() => sdk.session.message({ sessionID, messageID: q3.info.id }))
          expect(q3After.response?.status).toBe(404)
          checkpoint = "q3-delete-api-404"
          yield* Effect.promise(() => tui.waitForTextAbsent(Q3))
          expect(tui.screen()).not.toContain(Q3)
          checkpoint = "q3-delete-verified"

          expect(initialSeen.seen()).toBe(true)
          expect(finalSeen.seen()).toBe(false)
          expect(tui.screen()).not.toContain(INITIAL_DONE)
          const beforeRelease = yield* llm.inputs
          expect(
            beforeRelease.filter((input) => {
              const body = JSON.stringify(input)
              return body.includes(INITIAL) && !body.includes("Generate a title for this conversation")
            }),
          ).toHaveLength(1)
          expect(beforeRelease.some((input) => JSON.stringify(input).includes(Q1_EDITED))).toBe(false)
          checkpoint = "first-request-still-held"

          yield* llm.pushMatch((hit) => {
            const body = JSON.stringify(hit.body)
            if (!body.includes(Q1_EDITED) || !body.includes(Q2_EXTERNAL) || body.includes(Q3)) return false
            finalSeen.release()
            return true
          }, reply().text(FINAL_DONE).stop().item())
          releaseFirst()
          yield* Effect.promise(() => bounded(finalSeen.promise, "the next provider request"))
          yield* Effect.promise(() => tui.waitForText(FINAL_DONE, 30_000))
          yield* Effect.promise(() => Promise.all(promptRequests))

          const requests = yield* llm.inputs
          const finalRequest = requests.find((input) => {
            const body = JSON.stringify(input)
            return body.includes(Q1_EDITED) && body.includes(Q2_EXTERNAL)
          })
          expect(finalRequest).toBeDefined()
          expect(JSON.stringify(finalRequest)).not.toContain(Q3)
          yield* Effect.promise(() =>
            writeFile(path.join(evidenceDir, "provider-requests.json"), JSON.stringify(requests, null, 2) + "\n"),
          )
          yield* Effect.promise(() =>
            tui.close({
              mode: resolvedTarget.mode,
              sessionID,
              assertions: {
                q1EditedWithOriginalAttachment: true,
                q2ConflictPreservedExternalAttachment: true,
                q3Deleted: true,
                firstRequestHeldDuringOperations: true,
                nextRequestContainsFinalQueueState: true,
              },
            }),
          )
        }),
      target,
    ),
  120_000,
)
