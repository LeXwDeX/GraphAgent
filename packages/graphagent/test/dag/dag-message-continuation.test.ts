// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { Context, Effect, Fiber, Layer, Schema, Semaphore, Option } from "effect"
import { Dag, StaleMessageInputError } from "@/dag/dag"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID, PartID } from "@/session/schema"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { hasCaptureSlot } from "@/dag/runtime/capture"
import { spawnNode } from "@/dag/runtime/spawn"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

function reply(text: string, finish: "stop" | "length" = "stop"): SessionV1.WithParts {
  const id = MessageID.ascending(),
    sessionID = SessionID.make("ses_child")
  return {
    info: {
      id,
      sessionID,
      parentID: MessageID.ascending(),
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish,
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
  }
}

function userReply(text: string): SessionV1.WithParts {
  const id = MessageID.ascending(),
    sessionID = SessionID.make("ses_child")
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent: "build",
      model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
      time: { created: Date.now() },
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
  }
}

function errorReply(text: string): SessionV1.WithParts {
  const message = reply(text)
  if (message.info.role === "assistant")
    message.info.error = { name: "UnknownError", data: { message: "continuation failed" } }
  return message
}
const REPAIR_SCHEMA = {
  type: "object",
  required: ["result"],
  properties: { result: { type: "string", enum: ["old", "updated"] } },
}

type Case = {
  modelDefect?: boolean
  artifactPath?: string
  staleReceipt?: boolean
  structured?: boolean
  queued?: number
  undeliverable?: number
  stopReason?: string
  replaced?: boolean
  paused?: boolean
  cancelled?: boolean
  modelError?: boolean
  deadline?: boolean
  replaceWhilePaused?: boolean
  /** First turn ends at the output cap; the continuation result takes this shape. */
  lengthFence?: "paused" | "extended" | "replaced" | "cancelled"
  /** First turn ends at the output cap, then the same-session continuation returns this result. */
  lengthContinuation?: "user" | "error"
  /** First final response is a near-miss; `claimResultNudge` decides the repair admission. */
  repair?: "admitted" | "already" | "stale"
  /** `snapshotForTurn` reports success without a snapshot for the first final response. */
  firstSnapshotUnavailable?: boolean
}
async function exercise(options: Case = {}) {
  let node = makeNodeRow({
    status: "pending",
    capturedOutput: { result: "old" },
    capturedOutputPresent: true,
    capturedSnapshotID: "old-snapshot",
  })
  let workflow = makeWorkflowRow({ directory: process.cwd() })
  let accepted = 1
  let newInputQueued = false
  let permitReleased = false
  let captureRegistered = false
  const semaphore = Semaphore.makeUnsafe(1)
  let receipts = 0
  let created = 0,
    loops = 0,
    prompts = 0,
    completions = 0,
    toolWrites = 0
  const events: { type: string; output?: unknown; reason?: string }[] = []
  const promptStates: Array<{ status: string; overdue: boolean }> = []
  const initial = reply(
      options.repair
        ? JSON.stringify({ result: "invalid" })
        : (options.artifactPath ?? (options.structured ? JSON.stringify({ result: "old" }) : "old")),
    ),
    updated = reply(
      options.artifactPath ?? (options.structured || options.repair ? JSON.stringify({ result: "updated" }) : "updated"),
    )
  if (options.modelError && initial.info.role === "assistant")
    initial.info.error = { name: "UnknownError", data: { message: "blocked" } }
  const storeLayer = Layer.mock(DagStore.Service, {
    tryClaimAdoption: () => Effect.succeed(true),
    getNode: () => Effect.succeed(node),
    getWorkflow: () => Effect.succeed(workflow),
    setCapturedOutput: (_id, output, snapshot) =>
      Effect.sync(() => {
        node = { ...node, capturedOutput: output, capturedOutputPresent: true, capturedSnapshotID: snapshot }
      }),
  })
  const dagLayer = Layer.effect(
    Dag.Service,
    Effect.gen(function* () {
      const store = yield* DagStore.Service
      return yield* Layer.build(
        Layer.mock(Dag.Service, {
          store,
          nodeQueued: () =>
            Effect.sync(() => {
              node = { ...node, status: "queued" }
            }),
          nodeStarted: () =>
            Effect.sync(() => {
              node = { ...node, status: "running", childSessionId: "ses_child" }
            }),
          nodeCompleted: (_dag, _node, output) =>
            Effect.gen(function* () {
              completions++
              if (
                completions === 1 &&
                !options.staleReceipt &&
                !options.lengthFence &&
                !options.repair &&
                !options.firstSnapshotUnavailable
              ) {
                if (options.replaced) node = { ...node, replanAttempts: 1, childSessionId: "ses_replaced" }
                if (options.paused || options.replaceWhilePaused) workflow = { ...workflow, status: "paused" }
                if (options.deadline) node = { ...node, deadlineMs: Date.now() - 1 }
                if (options.cancelled) workflow = { ...workflow, status: "cancelled" }
                yield* new StaleMessageInputError({ dagID: "dag_live", nodeID: "node-1", reason: "stale_input" })
              }
              node = { ...node, status: "completed" }
              events.push({ type: "completed", output })
            }),
          nodeFailed: (_dag, _node, reason, _trigger, attempt) =>
            Effect.gen(function* () {
              if (attempt?.expectedAcceptedRevision !== undefined && attempt.expectedAcceptedRevision !== accepted)
                yield* new StaleMessageInputError({ dagID: "dag_live", nodeID: "node-1", reason: "stale_input" })
              node = { ...node, status: "failed" }
              events.push({ type: "failed", reason })
            }),
        }),
      ).pipe(Effect.map((context) => Context.get(context, Dag.Service)))
    }),
  ).pipe(Layer.provide(storeLayer))
  const guard: DagMessages.Interface["guard"] = (_caller, _input, commit) =>
    Effect.gen(function* () {
      receipts++
      if (options.staleReceipt && receipts === 1) return { ok: false as const, reason: "stale_input" as const }
      return { ok: true as const, value: yield* commit }
    })
  const messagesLayer = Layer.mock(DagMessages.Service, {
    guard,
    claimResultNudge: () =>
      Effect.succeed(
        options.repair === "stale"
          ? { ok: false as const, reason: "stale_input" as const }
          : { ok: true as const, value: options.repair !== "already" },
      ),
    snapshotForTurn: (_caller, id) =>
      Effect.succeed(
        options.firstSnapshotUnavailable && id === initial.info.id
          ? { ok: true as const, value: undefined }
          : {
              ok: true,
              value: {
                id: id === initial.info.id ? "old-snapshot" : "updated-snapshot",
                mailboxID: "box",
                logicalTurnID: id,
                revision: id === initial.info.id ? 0 : 1,
                messages: [],
                associated: true,
                ...(options.stopReason ? { stopReason: options.stopReason } : {}),
              },
            },
      ),
    revisions: () =>
      Effect.sync(() => ({
        ok: true as const,
        value: {
          endpoint: { id: "box", kind: "node", sessionID: "ses_child" },
          accepted,
          snapshot: 0,
          queued: newInputQueued ? 1 : (options.queued ?? 1),
          delivered: 0,
          undeliverable: options.undeliverable ?? 0,
        },
      })),
  })
  const agentLayer = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        tools: {},
        hooks: {},
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      }),
  })
  const decoded = Schema.decodeUnknownSync(Session.Info)({
    id: "ses_parent",
    projectID: "proj_test",
    slug: "test",
    directory: process.cwd(),
    title: "test",
    version: "test",
    agent: "build",
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ],
    time: { created: 1, updated: 1 },
  })
  const info: Session.Info = {
    id: decoded.id,
    projectID: decoded.projectID,
    slug: decoded.slug,
    directory: decoded.directory,
    title: decoded.title,
    version: decoded.version,
    agent: "build",
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ],
    time: { created: decoded.time.created, updated: decoded.time.updated },
  }
  const sessionsLayer = Layer.mock(Session.Service, {
    get: () => Effect.succeed(info),
    create: () =>
      Effect.sync(() => {
        created++
        return { ...info, id: SessionID.make("ses_child") }
      }),
  })
  const next = Effect.sync(() => {
    newInputQueued = false
    node = { ...node, capturedOutput: { result: "updated" }, capturedSnapshotID: "updated-snapshot" }
    return updated
  })
  const promptLayer = Layer.mock(SessionPrompt.Service, {
    prompt: () =>
      Effect.gen(function* () {
        prompts++
        const fence = options.lengthFence
        promptStates.push({
          status: workflow.status,
          overdue: node.deadlineMs !== null && Date.now() >= node.deadlineMs,
        })
        if (options.modelDefect) return yield* Effect.die(new Error("live preparation defect"))
        if (prompts > 3) return yield* Effect.die(new Error("unbounded nudge regression"))
        if (prompts === 1) {
          toolWrites++
          if (options.lengthContinuation) return reply("", "length")
          if (!fence) return initial
          if (fence === "paused") workflow = { ...workflow, status: "paused" }
          if (fence === "cancelled") workflow = { ...workflow, status: "cancelled" }
          if (fence === "replaced") node = { ...node, replanAttempts: 1, childSessionId: "ses_replaced" }
          if (fence === "extended") node = { ...node, deadlineMs: Date.now() - 1 }
          return reply("", "length")
        }
        if (options.lengthContinuation === "user") return userReply("late input")
        if (options.lengthContinuation === "error") return errorReply("partial")
        return yield* next
      }),
    loop: () =>
      Effect.gen(function* () {
        loops++
        return yield* next
      }),
    cancel: () => Effect.void,
  })
  const layer = Layer.mergeAll(dagLayer, agentLayer, sessionsLayer, promptLayer, messagesLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawned = yield* spawnNode(semaphore, {
          dagID: "dag_live",
          nodeID: "node-1",
          node: makeNodeRow(),
          parentSessionID: "ses_parent",
          promptParts: [{ type: "text", text: "work" }],
          ...(options.repair
            ? { outputSchema: REPAIR_SCHEMA }
            : options.structured
              ? { outputSchema: { type: "object" } }
              : {}),
        })
        if (
          options.paused ||
          options.deadline ||
          options.replaceWhilePaused ||
          options.lengthFence === "paused" ||
          options.lengthFence === "extended"
        )
          yield* Effect.forkChild(
            Effect.sleep(300).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  workflow = { ...workflow, status: "running" }
                  if (options.deadline || options.lengthFence === "extended")
                    node = { ...node, deadlineMs: Date.now() + 60_000 }
                  if (options.replaceWhilePaused) node = { ...node, replanAttempts: 1, childSessionId: "ses_replaced" }
                }),
              ),
            ),
          )
        yield* Fiber.join(spawned.fiber)
        captureRegistered = hasCaptureSlot("ses_child")
        const available = yield* semaphore.take(1).pipe(Effect.timeoutOption(100))
        permitReleased = Option.isSome(available)
        if (permitReleased) yield* semaphore.release(1)
      }),
    ).pipe(Effect.provide(layer)),
  )
  return {
    events,
    created,
    loops,
    prompts,
    promptStates,
    toolWrites,
    node,
    receipts,
    permitReleased,
    captureRegistered,
  }
}

describe("live durable message continuation", () => {
  test("live preparation defects settle failure and release capture and concurrency ownership", async () => {
    const r = await exercise({ structured: true, modelDefect: true })
    expect(r).toMatchObject({ prompts: 1, loops: 0, permitReleased: true, captureRegistered: false })
    expect(r.events[0]).toMatchObject({ type: "failed" })
    expect(r.events[0]?.reason).toContain("live preparation defect")
  })
  test("stale file receipt is rejected before capture, then same child persists current receipt", async () => {
    await using tmp = await tmpdir()
    const artifactPath = path.join(tmp.path, "report.txt")
    await writeFile(artifactPath, "current report")
    const r = await exercise({ artifactPath, staleReceipt: true })
    expect(r).toMatchObject({ loops: 1, receipts: 2, created: 1, toolWrites: 1 })
    expect(r.events[0]?.type).toBe("completed")
    expect(r.node.capturedOutput).toMatchObject({ kind: "file_ref", source_path: artifactPath })
  })
  test("expired live deadline waits for durable extension before another model call", async () => {
    const r = await exercise({ deadline: true })
    expect(r.loops).toBe(1)
    expect(r.events[0]?.output).toBe("updated")
  })
  test("attempt replacement during pause prevents an old continuation", async () => {
    const r = await exercise({ replaceWhilePaused: true })
    expect(r.loops).toBe(0)
    expect(r.events).toEqual([])
  })
  test("late plain input continues the same child without repeating completed tools", async () => {
    const r = await exercise()
    expect(r).toMatchObject({ created: 1, loops: 1, prompts: 1, toolWrites: 1 })
    expect(r.events).toEqual([{ type: "completed", output: "updated" }])
  })
  test("structured capture is refreshed after a stale receipt continuation", async () => {
    const r = await exercise({ structured: true, staleReceipt: true })
    expect(r.events).toEqual([{ type: "completed", output: { result: "updated" } }])
    expect(r).toMatchObject({ created: 1, loops: 1, prompts: 1, toolWrites: 1, receipts: 2 })
  })
  test("budget exhaustion cannot reset through a message continuation", async () => {
    const r = await exercise({ stopReason: "budget_exhausted" })
    expect(r.loops).toBe(0)
    expect(r.events[0]).toMatchObject({ type: "failed" })
    expect(r.events[0]?.reason).toContain("budget_exhausted")
  })
  test("attempt replacement abandons the old callback", async () => {
    const r = await exercise({ replaced: true })
    expect(r.events).toEqual([])
    expect(r.loops).toBe(0)
    expect(r.node.childSessionId).toBe("ses_replaced")
  })
  test("paused workflow holds continuation until resume", async () => {
    const r = await exercise({ paused: true })
    expect(r.loops).toBe(1)
    expect(r.events[0]?.output).toBe("updated")
  })
  test("cancellation prevents provider continuation", async () => {
    const r = await exercise({ cancelled: true })
    expect(r.loops).toBe(0)
    expect(r.events).toEqual([])
  })
  test("discarded input cannot admit an extra model turn", async () => {
    const r = await exercise({ queued: 0, undeliverable: 1 })
    expect(r.loops).toBe(0)
    expect(r.events[0]?.reason).toContain("unavailable")
  })
  test("a length continuation waits for resume after a durable pause", async () => {
    const r = await exercise({ lengthFence: "paused" })
    expect(r.prompts).toBe(2)
    expect(r.promptStates).toEqual([
      { status: "running", overdue: false },
      { status: "running", overdue: false },
    ])
    expect(r.loops).toBe(0)
    expect(r.events).toEqual([{ type: "completed", output: "updated" }])
  })
  test("a length continuation waits for a durable deadline extension", async () => {
    const r = await exercise({ lengthFence: "extended" })
    expect(r.prompts).toBe(2)
    expect(r.promptStates[1]).toEqual({ status: "running", overdue: false })
    expect(r.events).toEqual([{ type: "completed", output: "updated" }])
  })
  test("attempt replacement fences the length continuation", async () => {
    const r = await exercise({ lengthFence: "replaced" })
    expect(r.prompts).toBe(1)
    expect(r.events).toEqual([])
    expect(r.node.childSessionId).toBe("ses_replaced")
  })
  test("cancellation fences the length continuation", async () => {
    const r = await exercise({ lengthFence: "cancelled" })
    expect(r.prompts).toBe(1)
    expect(r.events).toEqual([])
  })
  test("a failed model result never publishes success", async () => {
    const r = await exercise({ modelError: true })
    expect(r.loops).toBe(0)
    expect(r.events[0]).toMatchObject({ type: "failed" })
  })
  test("a length continuation stops when the follow-up turn is not an assistant result", async () => {
    const r = await exercise({ lengthContinuation: "user" })
    expect(r.prompts).toBe(2)
    expect(r.events).toEqual([{ type: "failed", reason: "child model turn stopped before a successful result" }])
  })
  test("a length continuation stops when the follow-up turn reports a model error", async () => {
    const r = await exercise({ lengthContinuation: "error" })
    expect(r.prompts).toBe(2)
    expect(r.events[0]?.type).toBe("failed")
    expect(r.events[0]?.reason).toContain("(UnknownError)")
  })
  test("repairs a near-miss final response once when the resubmission is admitted", async () => {
    const r = await exercise({ repair: "admitted" })
    expect(r.events).toEqual([{ type: "completed", output: { result: "updated" } }])
    expect(r).toMatchObject({ created: 1, loops: 0, prompts: 2, toolWrites: 1, receipts: 1 })
  })
  test("does not spend a repair turn when the resubmission is already claimed", async () => {
    const r = await exercise({ repair: "already" })
    expect(r.prompts).toBe(1)
    expect(r.events[0]?.type).toBe("failed")
    expect(r.events[0]?.reason).toContain("resubmission already requested")
  })
  test("a stale resubmission receipt re-enters the same session once", async () => {
    const r = await exercise({ repair: "stale" })
    expect(r.events).toEqual([{ type: "completed", output: { result: "updated" } }])
    expect(r).toMatchObject({ created: 1, loops: 1, prompts: 1, receipts: 1 })
  })
  test("an unassociated final response re-enters the same session instead of settling", async () => {
    const r = await exercise({ structured: true, firstSnapshotUnavailable: true })
    expect(r.events).toEqual([{ type: "completed", output: { result: "updated" } }])
    expect(r).toMatchObject({ created: 1, loops: 1, prompts: 1, receipts: 1 })
  })
})
