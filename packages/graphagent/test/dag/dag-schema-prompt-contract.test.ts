// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- harness
// deliberately mirrors dag-wake-integration.test.ts: mocked service layers and
// row fixtures use `as never` type shims (mock objects implement only the
// interface slice the scenario exercises). The shims are type-only.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #386 — structured-output single-authority contract.
 *
 * A DAG node with output_schema must instruct the child, up front, that its
 * final assistant answer is the single authoritative report: exactly one JSON
 * value, captured automatically, with no prose duplication. The DAG-generated
 * schema instruction part (loop.ts) carries the contract.
 */
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
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
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

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
    parts: text ? ([{ type: "text", text }] as never) : [],
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
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status, AgentScheduler.defaultLayer)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: (input?: { directory?: string }) =>
      Effect.succeed({ id: "ses_child_1", directory: input?.directory ?? process.cwd() } as never),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(childPrompts, { input: value, release })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = mockSessionPrompt(
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: deliver,
      deliver: (value) => deliver(value).pipe(Effect.map(Option.some)),
    }),
  )
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
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

function runContractTest(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
  }) => Effect.Effect<void, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: "project-1" as never,
          worktree: process.cwd() as never,
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: "ses_parent" as never,
          project_id: "project-1" as never,
          slug: "parent",
          directory: process.cwd(),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
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
          yield* Deferred.succeed(gate.release, '{"summary":"Captured from final answer."}')
          const row = yield* pollWithTimeout(
            store
              .getNode(dagID, "report")
              .pipe(Effect.map((node) => (node?.status === "completed" ? node : undefined))),
            "new protocol did not complete from final JSON",
          )
          expect(row.output).toEqual({ summary: "Captured from final answer." })
        }),
      ),
    )
  })

  it("states allowed verdict values last and makes the output contract override instruction wording", async () => {
    await Effect.runPromise(
      runContractTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Verdict contract",
            config: {
              name: "verdict-contract",
              nodes: [
                {
                  ...schemaNode(),
                  id: "review",
                  name: "review",
                  prompt_template: { inline: "Return PASS or BLOCKING" },
                  output_schema: {
                    type: "object",
                    required: ["verdict"],
                    properties: { verdict: { type: "string", enum: ["ACCEPT", "REJECT"] } },
                  },
                },
              ],
            },
          })
          const gate = yield* Queue.take(childPrompts)
          const prompt = promptText(gate.input)
          expect(prompt).toContain('Allowed values: verdict in ["ACCEPT","REJECT"]')
          expect(prompt).toContain("This output contract overrides any conflicting verdict wording")
          expect(prompt.indexOf("Allowed values")).toBeGreaterThan(prompt.indexOf("[OUTPUT CONTRACT"))
          yield* Deferred.succeed(gate.release, '{"verdict":"ACCEPT"}')
          const row = yield* pollWithTimeout(
            store
              .getNode(dagID, "review")
              .pipe(Effect.map((node) => (node?.status === "completed" ? node : undefined))),
            "verdict node did not complete",
          )
          expect(row.output).toEqual({ verdict: "ACCEPT" })
        }),
      ),
    )
  })
})
