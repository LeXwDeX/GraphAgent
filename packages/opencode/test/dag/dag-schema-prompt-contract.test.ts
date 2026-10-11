// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- harness
// deliberately mirrors dag-wake-integration.test.ts: mocked service layers and
// row fixtures use `as never` type shims (mock objects implement only the
// interface slice the scenario exercises). The shims are type-only.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Issue #386 — structured-output single-authority contract.
 *
 * A DAG node with output_schema must instruct the child, up front, that the
 * submit_result payload is the single authoritative report: the summary lives
 * inside the payload, prose must not duplicate it, and a successful submission
 * ends the turn. Both delivery channels carry the contract: the DAG-generated
 * schema instruction part (loop.ts) and the submit_result tool description.
 */
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptGate {
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<string>
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function schemaNode(): NodeConfig {
  return {
    id: "report",
    name: "report",
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: "Summarize the delivery" },
    output_schema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
  }
}

function contractLayer(childPrompts: Queue.Queue<PromptGate>) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: () => Effect.succeed({ id: "ses_child_1" } as never),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(childPrompts, { input: value, release })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: () => Effect.void,
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
  }))
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
      name: "build",
      mode: "all",
      permission: [],
      options: {},
      description: "",
      prompt: "",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
      hooks: {},
    }),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.merge(base, loop)
}

function runContractTest(test: (services: {
  readonly dag: Dag.Interface
  readonly loop: DagLoop.Interface
  readonly store: DagStore.Interface
  readonly childPrompts: Queue.Queue<PromptGate>
}) => Effect.Effect<void, Error>) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd(),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      yield* loop.init()
      return yield* test({ dag, loop, store, childPrompts })
    }).pipe(
      Effect.provide(contractLayer(childPrompts)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  })
}

function promptText(input: SessionPrompt.PromptInput) {
  return input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

describe("DAG schema prompt contract (issue #386)", () => {
  it("new workflows request one final JSON value and capture it automatically", async () => {
    await Effect.runPromise(
      runContractTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Final response schema contract",
            config: { name: "final-response-contract", nodes: [schemaNode()] },
          })
          const gate = yield* Queue.take(childPrompts)
          const prompt = promptText(gate.input)
          expect(prompt).toContain("exactly one JSON value")
          expect(prompt).not.toContain("submit_result")
          yield* Deferred.succeed(gate.release, '{"summary":"Captured from final answer."}')
          const row = yield* pollWithTimeout(
            store.getNode(dagID, "report").pipe(Effect.map((node) => node?.status === "completed" ? node : undefined)),
            "new protocol did not complete from final JSON",
          )
          expect(row.output).toEqual({ summary: "Captured from final answer." })
        }),
      ),
    )
  })

  it("schema instruction tells the child the payload is the single authoritative report", async () => {
    await Effect.runPromise(
      runContractTest(({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Schema prompt contract",
            config: { name: "schema-prompt-contract", result_protocol: "submit_result", nodes: [schemaNode()] },
          })
          const gate = yield* Queue.take(childPrompts)
          const prompt = promptText(gate.input)
          expect(prompt).toContain("submit_result")
          // Summary belongs inside the payload, not in prose.
          expect(prompt).toContain("Put your full summary inside the payload")
          // Prose must not duplicate the payload.
          expect(prompt).toContain("Do not repeat the payload in your message text")
          // A successful submission ends the turn.
          expect(prompt).toContain("end your turn without restating the result")
          // Issue #436: the consequence of skipping submit_result is stated
          // up front so the child cannot treat prose as a substitute.
          expect(prompt).toContain("does NOT count as submitting")
          expect(prompt).toContain("this node FAILS")
          yield* Deferred.succeed(gate.release, "done")
        }),
      ),
    )
  })

  // The issue-#386 acceptance chain does not stop at prompt construction:
  // the child submits through submit_result, the capture lands durably, and
  // the node settles with the payload as its durable output — prose plays no
  // part in settlement. The gate replays exactly the durable write the real
  // tool performs (store.setCapturedOutput); spawn's completion gate
  // (settleCapturedOutput) runs unmocked below it.
  it("settles the node from the submit_result payload as the durable output", async () => {
    await Effect.runPromise(
      runContractTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Schema prompt contract",
            config: { name: "schema-prompt-contract", result_protocol: "submit_result", nodes: [schemaNode()] },
          })
          const gate = yield* Queue.take(childPrompts)
          const payload = { summary: "Delivered through submit_result only." }
          yield* store.setCapturedOutput(gate.input.sessionID as string, payload)
          // The contract-compliant reply: no payload duplication in prose.
          yield* Deferred.succeed(gate.release, "Submitted.")
          const node = yield* pollWithTimeout(
            store.getNode(dagID, "report").pipe(
              Effect.map((row) => row?.status === "completed" ? row : undefined),
            ),
            "schema node did not complete from the submitted payload",
          )
          expect(node.output).toEqual(payload)
        }),
      ),
    )
  })

  it("submit_result tool description carries the same single-authority contract", async () => {
    const description = await Bun.file(
      path.join(import.meta.dir, "../../src/tool/submit_result.txt"),
    ).text()
    expect(description).toContain("Do not duplicate the payload")
    expect(description).toContain("end your turn without restating the result")
  })

  // Issue #436 minimal step: a child that ends its turn without ever calling
  // submit_result gets exactly one nudge turn in the same session before the
  // node is failed. Review-aggregate children were observed (PR #424 era)
  // producing the whole review in prose and never handing it back.
  describe("submit_result retry nudge (issue #436)", () => {
    it("nudges once when the child never submits, then completes from the submitted payload", async () => {
      await Effect.runPromise(
        runContractTest(({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_parent",
              title: "Nudge completes",
              config: { name: "schema-prompt-contract", result_protocol: "submit_result", nodes: [schemaNode()] },
            })
            // First turn: full analysis in prose, no submit_result call.
            const first = yield* Queue.take(childPrompts)
            expect(promptText(first.input)).toContain("[OUTPUT CONTRACT")
            yield* Deferred.succeed(first.release, "Full review: everything checks out.")
            // The nudge arrives as a second prompt to the SAME child session.
            const nudge = yield* Queue.take(childPrompts)
            expect(nudge.input.sessionID).toBe(first.input.sessionID)
            expect(promptText(nudge.input)).toContain("without calling the submit_result tool")
            // The child complies on the second chance.
            const payload = { summary: "Submitted after the nudge." }
            yield* store.setCapturedOutput(nudge.input.sessionID as string, payload)
            yield* Deferred.succeed(nudge.release, "Submitted.")
            const node = yield* pollWithTimeout(
              store.getNode(dagID, "report").pipe(
                Effect.map((row) => row?.status === "completed" ? row : undefined),
              ),
              "node did not complete after the nudge turn",
            )
            expect(node.output).toEqual(payload)
          }),
        ),
      )
    })

    it("fails the node after the nudge still produces no submission", async () => {
      await Effect.runPromise(
        runContractTest(({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_parent",
              title: "Nudge exhausted",
              config: { name: "schema-prompt-contract", result_protocol: "submit_result", nodes: [schemaNode()] },
            })
            const first = yield* Queue.take(childPrompts)
            yield* Deferred.succeed(first.release, "Prose only, no submission.")
            const nudge = yield* Queue.take(childPrompts)
            yield* Deferred.succeed(nudge.release, "Still nothing.")
            // No third prompt comes from spawn: the nudge is one per node
            // EXECUTION. (The DagLoop's own NodeFailed handler may respawn
            // the node as a fresh attempt afterwards — that retry policy is
            // a separate pre-existing layer, not spawn's business.)
            const node = yield* pollWithTimeout(
              store.getNode(dagID, "report").pipe(
                Effect.map((row) => row?.status === "failed" ? row : undefined),
              ),
              "node was not failed after the exhausted nudge",
            )
            expect(node.errorReason).toContain("never successfully called")
          }),
        ),
      )
    })
  })
})
