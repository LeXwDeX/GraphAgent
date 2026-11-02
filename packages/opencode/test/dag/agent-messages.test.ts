import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagAgentMessages } from "@/dag/agent-messages"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { layer as sqliteLayer } from "@opencode-ai/core/database/sqlite.bun"
import { sql } from "drizzle-orm"
import { Database as NativeSqlite } from "bun:sqlite"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "../lib/effect"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const it = testEffect(Layer.empty)
const endpoint: DagMessages.Endpoint = {
  id: "endpoint-parent",
  kind: "main",
  sessionID: "ses_parent",
}
function transcript(): SessionV1.WithParts {
  const sessionID = SessionID.make("ses_child")
  const messageID = MessageID.make("msg_child")
  const part = { sessionID, messageID }
  return {
    info: {
      id: messageID,
      sessionID,
      parentID: MessageID.make("msg_parent"),
      role: "assistant",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    },
    parts: [
      { ...part, id: PartID.make("prt_reasoning"), type: "reasoning", text: "HIDDEN_REASONING", time: { start: 1 } },
      { ...part, id: PartID.make("prt_text"), type: "text", text: "Visible progress" },
      {
        ...part,
        id: PartID.make("prt_tool"),
        type: "tool",
        tool: "read",
        callID: "call_read",
        state: {
          status: "completed",
          input: { secret: "SECRET_TOOL_ARGUMENT" },
          title: "Read secret",
          output: "SECRET_TOOL_OUTPUT",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}
function hintOf(result: unknown) {
  if (typeof result !== "object" || result === null || !("next_wake_hint" in result)) return ""
  const hint = result.next_wake_hint
  return typeof hint === "string" ? hint : ""
}
function adapter(
  core: Partial<DagMessages.Interface>,
  store: Partial<DagStore.Interface> = {},
  sessions: Partial<Session.Interface> = {},
) {
  return DagAgentMessages.layer.pipe(
    Layer.provide(
      Layer.mock(DagMessages.Service, {
        identify: (caller) => Effect.succeed({
          ok: true,
          value: { id: `endpoint-${caller.sessionID}`, kind: "main", sessionID: caller.sessionID },
        }),
        latestMessageAt: () => Effect.succeed({ ok: true, value: undefined }),
        revisions: (caller) =>
          Effect.succeed({
            ok: true,
            value: {
              endpoint: { id: `endpoint-${caller.sessionID}`, kind: "main", sessionID: caller.sessionID },
              accepted: 0,
              snapshot: 0,
              queued: 0,
              delivered: 0,
              undeliverable: 0,
            },
          }),
        ...core,
      }),
    ),
    Layer.provide(
      Layer.mock(DagStore.Service, {
        getLastNodeChange: () => Effect.succeed(undefined),
        getNodeTime: () => Effect.succeed(undefined),
        getNodes: () => Effect.succeed([]),
        getUnreportedWakeNodes: () => Effect.succeed([]),
        getUnreportedWakeWorkflows: () => Effect.succeed([]),
        ...store,
      }),
    ),
    Layer.provide(Layer.mock(Session.Service, sessions)),
  )
}

describe("DAG agent message adapter", () => {
  it.instance("a long poll that already read reports a retryable rejection after contention", () => {
    const sqlite = sqliteLayer({ filename: ":memory:" })
    const database = Database.layer.pipe(Layer.provide(sqlite))
    const core = DagMessages.layer.pipe(Layer.provide(database))
    const store = DagStore.layer.pipe(Layer.provide(database))
    return Effect.gen(function* () {
      const firstRead = yield* Deferred.make<void>()
      const cStarted = yield* Deferred.make<void>()
      const cGate = yield* Deferred.make<void>()
      let first = true
      let armC = false
      const wrapped = Layer.effect(DagMessages.Service, Effect.gen(function* () {
        const original = yield* DagMessages.Service
        return DagMessages.Service.of({ ...original,
          identify: (caller, workflow) => Effect.gen(function* () {
            const result = yield* original.identify(caller, workflow)
            if (armC) {
              armC = false
              yield* Deferred.succeed(cStarted, undefined)
              yield* Deferred.await(cGate)
            }
            return result
          }),
          receive: (caller, input) => Effect.gen(function* () {
            const result = yield* original.receive(caller, input)
            if (first) { first = false; yield* Deferred.succeed(firstRead, undefined) }
            return result
          }),
        })
      })).pipe(Layer.provide(core))
      const deps = Layer.mergeAll(database, wrapped, store, Layer.mock(Session.Service, {}))
      const services = Layer.merge(deps, DagAgentMessages.layer.pipe(Layer.provide(deps)))
      yield* Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const { db } = yield* Database.Service
        const project = instance.project.id
        const directory = instance.directory
        yield* db.run(sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${project},${directory},'[]',1,1) ON CONFLICT(id) DO NOTHING`)
        yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_poll_race',${project},NULL,'parent',${directory},'parent','test',1,1)`)
        yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_poll_race_child',${project},'ses_poll_race','child',${directory},'child','test',1,1)`)
        yield* db.run(sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated) VALUES ('wf-race',${project},'ses_poll_race',${directory},'race','running','{}',0,1,1)`)
        yield* db.run(sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated) VALUES ('n','wf-race','node','build','running','[]','ses_poll_race_child',0,1,1)`)
        const adapter = yield* DagAgentMessages.Service
        const messages = yield* DagMessages.Service
        const input = { sessionID: "ses_poll_race", workflow_id: "wf-race", after_sequence: 0 }
        const queries: string[] = []
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            // oxlint-disable-next-line typescript-eslint/unbound-method -- proxy forwards the receiver
            const original = NativeSqlite.prototype.query
            NativeSqlite.prototype.query = new Proxy(original, { apply(target, self, args) {
              if (first && typeof args[0] === "string") queries.push(args[0])
              return Reflect.apply(target, self, args)
            } })
            return original
          }),
          () => Effect.gen(function* () {
            const a = yield* adapter.receive({ ...input, wait_ms: 2_000 }).pipe(Effect.forkChild)
            yield* Deferred.await(firstRead)
            yield* Effect.yieldNow
            expect(queries.some((query) => /SELECT \* FROM agent_message\b/i.test(query))).toBe(true)
            expect(yield* adapter.receive(input)).toMatchObject({ ok: true, messages: [] })
            expect(yield* adapter.receive(input)).toMatchObject({ ok: true, messages: [] })
            armC = true
            const c = yield* adapter.receive({ ...input, wait_ms: 1_500 }).pipe(Effect.forkChild)
            yield* Deferred.await(cStarted)
            yield* Deferred.succeed(cGate, undefined)
            yield* Effect.yieldNow
            expect(yield* messages.send({ projectID: project, directory, sessionID: "ses_poll_race_child" }, {
              workflowID: "wf-race", idempotencyKey: "new", content: "synthetic-new-message",
            })).toMatchObject({ ok: true })
            yield* TestClock.adjust("100 millis")
            const result = yield* Fiber.join(a)
            // #952: a read that raced with another poll is not a successful
            // observation. Return the explicit retryable rejection instead of
            // replaying the previous result or cursor.
            expect(result).toMatchObject({
              ok: false,
              reason: "rate_limited",
              retry_after_ms: expect.any(Number),
              read_performed: false,
            })
            expect(result).not.toHaveProperty("messages")
            expect(result).not.toHaveProperty("cursor")
            expect(result).not.toHaveProperty("last_relevant_change_at")
            yield* Fiber.interrupt(c)
            const retry = yield* adapter.receive({ ...input, wait_ms: 1_500 }).pipe(Effect.forkChild)
            yield* TestClock.adjust("900 millis")
            expect(yield* Fiber.join(retry)).toMatchObject({ ok: true, messages: [{ content: "synthetic-new-message" }], cursor: 1 })
          }),
          (original) => Effect.sync(() => { NativeSqlite.prototype.query = original }),
        )
      }).pipe(Effect.orDie, Effect.provide(services), Effect.provide(TestClock.layer()))
    })
  })

  it.instance("does not expose a prior endpoint's rate limit after identity changes", () => {
    let calls = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const input = { sessionID: "ses_parent", workflow_id: "wf-1" }
      for (let index = 0; index < 3; index++) yield* messages.receive(input)
      expect(yield* messages.receive(input)).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(Effect.provide(adapter({
      resolve: () => Effect.succeed({ ok: true, value: endpoint }),
      identify: () => Effect.sync(() => ({ ok: true, value: { ...endpoint, id: ++calls < 5 ? "old" : "new" } })),
      receive: () => Effect.succeed({ ok: true, value: [] }),
    }, { getWorkflow: () => Effect.succeed(makeWorkflowRow()) })))
  })

  it.instance("rejects a zero-wait concurrent receive and releases the slot on abort", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let reads = 0
      const service = adapter({
        resolve: () => Effect.succeed({ ok: true, value: endpoint }),
        receive: () => Effect.gen(function* () {
          reads++
          if (reads === 1) {
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(gate)
          }
          return { ok: true as const, value: [] }
        }),
      }, { getWorkflow: () => Effect.succeed(makeWorkflowRow()) })
      yield* Effect.gen(function* () {
        const messages = yield* DagAgentMessages.Service
        const abort = new AbortController()
        const input = { sessionID: "ses_parent", workflow_id: "wf-1", wait_ms: 0 }
        const first = yield* messages.receive({ ...input, signal: abort.signal }).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        const started = Date.now()
        const busy = yield* messages.receive(input)
        expect(Date.now() - started).toBeLessThan(200)
        expect(busy).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
        expect(reads).toBe(1)
        abort.abort()
        const result = yield* Fiber.await(first)
        expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
        expect(yield* messages.receive(input)).toMatchObject({ ok: true, messages: [] })
        expect(reads).toBe(2)
      }).pipe(Effect.provide(service))
    }),
  )

  it.instance("retries the original cursor against real accepted messages and terminal pages", () => {
    const sqlite = sqliteLayer({ filename: ":memory:" })
    const database = Database.layer.pipe(Layer.provide(sqlite))
    const core = DagMessages.layer.pipe(Layer.provide(database))
    const store = DagStore.layer.pipe(Layer.provide(database))
    const deps = Layer.mergeAll(database, core, store, Layer.mock(Session.Service, { messages: () => Effect.succeed([]) }))
    const services = Layer.merge(deps, DagAgentMessages.layer.pipe(Layer.provide(deps)))
    return Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const project = instance.project.id
      const directory = instance.directory
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${project},${directory},'[]',1,1) ON CONFLICT(id) DO NOTHING`)
      yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_poll_parent',${project},NULL,'parent',${directory},'parent','test',1,1)`)
      yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_poll_child',${project},'ses_poll_parent','child',${directory},'child','test',1,1)`)
      yield* db.run(sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated) VALUES ('wf-poll',${project},'ses_poll_parent',${directory},'poll','running','{}',0,1,1)`)
      yield* db.run(sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated) VALUES ('n','wf-poll','node','build','running','[]','ses_poll_child',0,1,1)`)
      const adapter = yield* DagAgentMessages.Service
      const messages = yield* DagMessages.Service
      const workerInput = { sessionID: "ses_poll_child", wait_ms: 0 }
      for (let i = 0; i < 3; i++) expect(yield* adapter.receive(workerInput)).toMatchObject({ ok: true, messages: [] })
      const workerStatements: string[] = []
      const workerLimited = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          // oxlint-disable-next-line typescript-eslint/unbound-method -- the proxy forwards the actual receiver with Reflect.apply
          const original = NativeSqlite.prototype.query
          NativeSqlite.prototype.query = new Proxy(original, {
            apply(target, self, args) {
              if (typeof args[0] === "string") workerStatements.push(args[0])
              return Reflect.apply(target, self, args)
            },
          })
          return original
        }),
        () => adapter.receive(workerInput),
        (original) => Effect.sync(() => { NativeSqlite.prototype.query = original }),
      )
      expect(workerLimited).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
      expect(workerStatements.some((statement) => /\bworkflow_node\b/i.test(statement))).toBe(true)
      expect(workerStatements.filter((statement) => /\bagent_message\b/i.test(statement))).toEqual([])
      yield* db.run(sql`UPDATE session SET parent_id = 'ses_poll_child' WHERE id = 'ses_poll_child'`)
      expect(yield* adapter.receive(workerInput)).toEqual({ ok: false, reason: "unauthorized" })
      yield* db.run(sql`UPDATE session SET parent_id = 'ses_poll_parent' WHERE id = 'ses_poll_child'`)
      yield* db.run(sql`UPDATE workflow_node SET replan_attempts = 1 WHERE id = 'n' AND workflow_id = 'wf-poll'`)
      expect(yield* adapter.receive(workerInput)).toMatchObject({ ok: true, messages: [], empty_polls: 1 })
      expect(yield* adapter.receive({ sessionID: "ses_missing", workflow_id: "wf-poll" })).toEqual({ ok: false, reason: "unauthorized" })
      const input = { sessionID: "ses_poll_parent", workflow_id: "wf-poll", after_sequence: 0, limit: 1 }
      for (let i = 0; i < 3; i++) expect(yield* adapter.receive(input)).toMatchObject({ ok: true, messages: [] })
      const observe = { sessionID: "ses_poll_parent", workflow_id: "wf-poll" }
      for (let i = 0; i < 3; i++) expect(yield* adapter.observe(observe)).toMatchObject({ ok: true, nodes: [{ name: "node" }] })
      expect(yield* adapter.observe(observe)).toMatchObject({ ok: false, reason: "rate_limited" })
      const child = { projectID: project, directory, sessionID: "ses_poll_child" }
      for (const key of ["one", "two"]) {
        const accepted = yield* messages.send(child, { workflowID: "wf-poll", idempotencyKey: key, content: key })
        expect(accepted.ok).toBe(true)
      }
      const statements: string[] = []
      const wakeBefore = yield* db.get(sql`SELECT wake_reported FROM workflow WHERE id = 'wf-poll'`)
      const limited = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          // oxlint-disable-next-line typescript-eslint/unbound-method -- the proxy forwards the actual receiver with Reflect.apply
          const original = NativeSqlite.prototype.query
          NativeSqlite.prototype.query = new Proxy(original, {
            apply(target, self, args) {
              if (typeof args[0] === "string") statements.push(args[0])
              return Reflect.apply(target, self, args)
            },
          })
          return original
        }),
        () => adapter.receive(input),
        (original) => Effect.sync(() => { NativeSqlite.prototype.query = original }),
      )
      expect(limited).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
      expect(limited).toHaveProperty("hint", expect.stringContaining("original cursor"))
      expect(limited).not.toHaveProperty("next_wake_hint")
      expect(limited).not.toHaveProperty("nodes")
      expect(JSON.stringify(limited)).not.toContain("No new messages")
      expect(statements.some((statement) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement))).toBe(false)
      expect(yield* db.get(sql`SELECT wake_reported FROM workflow WHERE id = 'wf-poll'`)).toEqual(wakeBefore)
      expect(statements.some((statement) => /\bsession\b/i.test(statement))).toBe(true)
      expect(statements.some((statement) => /\bworkflow\b/i.test(statement))).toBe(true)
      expect(statements.filter((statement) => /\bagent_message\b/i.test(statement))).toEqual([])
      expect(limited).not.toHaveProperty("messages")
      expect(limited).not.toHaveProperty("cursor")
      yield* db.run(sql`UPDATE workflow_node SET name = 'changed', seq = seq + 1 WHERE id = 'n' AND workflow_id = 'wf-poll'`)
      yield* Effect.sleep(1_010)
      expect(yield* adapter.observe(observe)).toMatchObject({ ok: true, nodes: [{ name: "changed" }] })
      expect(yield* adapter.observe(observe)).toMatchObject({ ok: true, empty_polls: 2 })
      yield* db.run(sql`UPDATE workflow SET status = 'completed' WHERE id = 'wf-poll'`)
      const first = yield* adapter.receive(input)
      expect(first).toMatchObject({ ok: true, messages: [{ content: "one" }], cursor: 1 })
      const repeated = yield* adapter.receive(input)
      expect(repeated).toMatchObject({ ok: true, messages: [{ content: "one" }], cursor: 1, empty_polls: 2 })
      expect(hintOf(repeated)).toContain("No relevant changes")
      expect(yield* adapter.receive(input)).toMatchObject({ ok: true, messages: [{ content: "one" }], cursor: 1, empty_polls: 3 })
      expect(yield* adapter.receive(input)).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
      const second = yield* adapter.receive({ ...input, after_sequence: 1 })
      expect(second).toMatchObject({ ok: true, messages: [{ content: "two" }], cursor: 2 })
    }).pipe(Effect.orDie, Effect.provide(services))
  })

  it.instance("rejects unread receive polls without hiding later messages", () => {
    let reads = 0
    let available = false
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const input = { sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 }
      for (let i = 0; i < 3; i++) yield* messages.receive(input)
      available = true
      const limited = yield* messages.receive(input)
      expect(limited).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
      expect(limited).not.toHaveProperty("messages")
      expect(limited).not.toHaveProperty("cursor")
      expect(reads).toBe(3)
      const retry = yield* messages.receive({ ...input, wait_ms: 1_500 })
      expect(retry).toMatchObject({ ok: true, messages: [{ message_id: "new" }], cursor: 8 })
    }).pipe(
      Effect.provide(adapter({
        resolve: () => Effect.succeed({ ok: true, value: endpoint }),
        receive: () => Effect.sync(() => {
          reads++
          return { ok: true, value: available ? [{
            id: "new", workflowID: "wf-1", recipientSequence: 8, sender: endpoint, recipient: endpoint,
            content: "synthetic", state: "queued" as const, acceptedRevision: 8,
            transcriptID: "synthetic", partID: "synthetic", timeCreated: 1,
          }] : [] }
        }),
      }, { getWorkflow: () => Effect.succeed(makeWorkflowRow()) })),
    )
  })

  it.instance("limits unchanged visible observations and returns the nodes again after a change", () => {
    let status = "running" as "running" | "completed"
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const input = { sessionID: "ses_parent", workflow_id: "wf-1" }
      for (let i = 0; i < 3; i++) {
        expect(yield* messages.observe(input)).toMatchObject({ ok: true, nodes: [{ node_id: "a" }] })
      }
      expect(yield* messages.observe(input)).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
      status = "completed"
      yield* Effect.sleep(1_010)
      expect(yield* messages.observe(input)).toMatchObject({ ok: true, nodes: [{ node_id: "a", status: "completed" }] })
      expect(yield* messages.observe(input)).toMatchObject({ ok: true, empty_polls: 2 })
    }).pipe(Effect.provide(adapter({
      resolve: () => Effect.succeed({ ok: true, value: endpoint }),
      metadata: () => Effect.succeed({ ok: false, reason: "closed" }),
    }, {
      getWorkflow: () => Effect.succeed(makeWorkflowRow()),
      getNodes: () => Effect.succeed([makeNodeRow({ id: "a", status })]),
    })))
  })

  it.instance("does not read a replacement child's transcript after observation authority changes", () => {
    let nodeReads = 0
    const transcriptReads: string[] = []
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_child", workflow_id: "wf-1", node_id: "a" })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(transcriptReads).toEqual([])
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.sync(() => [
                makeNodeRow({
                  id: "a",
                  childSessionId: nodeReads++ === 0 ? "ses_child" : "ses_replacement",
                  replanAttempts: nodeReads - 1,
                }),
              ]),
          },
          {
            messages: (input) =>
              Effect.sync(() => {
                transcriptReads.push(input.sessionID)
                return [transcript()]
              }),
          },
        ),
      ),
    )
  })

  it.instance("uses current project and directory authority and does not read a denied workflow", () => {
    let identity: DagMessages.Caller | undefined
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const instance = yield* InstanceState.context
      const observed = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf_foreign" })
      expect(identity).toEqual({
        sessionID: "ses_parent",
        projectID: instance.project.id,
        directory: instance.directory,
      })
      expect(observed).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(
      Effect.provide(
        adapter({
          resolve: (caller) =>
            Effect.sync(() => {
              identity = caller
              return { ok: false, reason: "unauthorized" }
            }),
        }),
      ),
    )
  })

  it.instance("observes paginated current and historical attempts without reading hidden reasoning", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const observed = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1", limit: 1 })
      expect(observed).toMatchObject({
        ok: true,
        graph_rev: 1,
        projection_sequence: 1,
        freshness: "durable_reads_nonatomic",
        nodes: [
          {
            node_id: "a",
            status: "running",
            attempt_id: DagMessages.nodeAttemptID("ses_child", 0),
            directory: "/repo/.worktrees/a",
            head: "0123456789ab",
            last_activity_at: "1970-01-01T00:00:00.002Z",
            message_counts: { queued: 1, delivered: 2, undeliverable: 0 },
            progress: { text: "Visible progress", truncated: false },
            tools: [{ tool: "read", status: "completed" }],
          },
        ],
      })
      expect(JSON.stringify(observed)).not.toContain("HIDDEN_REASONING")
      expect(JSON.stringify(observed)).not.toContain("SECRET_TOOL_ARGUMENT")
      expect(JSON.stringify(observed)).not.toContain("SECRET_TOOL_OUTPUT")
      const historical = yield* messages.observe({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        node_id: "a",
        attempt_id: "attempt-old",
      })
      expect(historical).toMatchObject({
        nodes: [
          {
            node_id: "a",
            status: "attempt_replaced",
            historical: true,
            attempt_id: "attempt-old",
            closed_reason: "attempt_replaced",
          },
        ],
      })
      expect(JSON.stringify(historical)).not.toContain("CURRENT_OUTPUT")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: (_caller, workflowID, nodeID, attemptID) =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: "endpoint-child",
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID,
                    nodeID,
                    attemptID: attemptID ?? DagMessages.nodeAttemptID("ses_child", 0),
                  },
                  accepted: 3,
                  snapshot: 2,
                  queued: 1,
                  delivered: 2,
                  undeliverable: 0,
                  closedReason: attemptID === "attempt-old" ? "attempt_replaced" : undefined,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({
                  id: "a",
                  status: "running",
                  childSessionId: "ses_child",
                  output: "CURRENT_OUTPUT",
                  directory: "/repo/.worktrees/a",
                  baseHead: "0123456789abcdef",
                  timeUpdated: 2,
                }),
                makeNodeRow({ id: "b" }),
              ]),
          },
          {
            messages: () => Effect.succeed([transcript()]),
          },
        ),
      ),
    ),
  )

  it.instance("does not let a child inspect a sibling through an owned workflow", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      expect(yield* messages.observe({ sessionID: "ses_child", workflow_id: "wf-1", node_id: "sibling" })).toEqual({
        ok: false,
        reason: "unauthorized",
      })
    }).pipe(
      Effect.provide(
        adapter(
          { resolve: () => Effect.succeed({ ok: true, value: endpoint }) },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([makeNodeRow({ id: "a", childSessionId: "ses_child" })]),
          },
        ),
      ),
    ),
  )

  it.instance("returns an immediate empty receive with a bounded empty hint", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        cursor: 7,
        empty_polls: 1,
        last_relevant_change_at: "1970-01-01T00:00:00.001Z",
      })
      expect(result).not.toHaveProperty("stop_polling")
      expect(result).not.toHaveProperty("last_workflow_change_at")
      expect(result).toMatchObject({ next_wake_hint: expect.stringContaining("No new messages") })
      expect(reads).toBe(1)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: (_caller, input) =>
              Effect.sync(() => {
                reads += 1
                expect(input?.workflowID).toBe("wf-1")
                expect(input?.afterSequence).toBe(7)
                return { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("derives last relevant change from workflow, node and mailbox sources", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        empty_polls: 1,
        last_relevant_change_at: "1970-01-01T00:00:03.000Z",
      })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
            latestMessageAt: () => Effect.succeed({ ok: true, value: 2_000 }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ timeUpdated: 1_000 })),
            getLastNodeChange: () => Effect.succeed(3_000),
          },
        ),
      ),
    ),
  )

  it.instance("uses the mailbox timestamp for an unscoped empty receive", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent" })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        empty_polls: 1,
        last_relevant_change_at: "1970-01-01T00:00:05.000Z",
      })
    }).pipe(
      Effect.provide(
        adapter({
          receive: () => Effect.succeed({ ok: true, value: [] }),
          latestMessageAt: () => Effect.succeed({ ok: true, value: 5_000 }),
        }),
      ),
    ),
  )

  it.instance("does not aggregate sibling timing for a filtered observation", () => {
    let globalReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1", node_id: "a" })
      expect(result).toMatchObject({
        ok: true,
        nodes: [{ node_id: "a" }],
        last_relevant_change_at: "1970-01-01T00:00:01.000Z",
      })
      expect(globalReads).toBe(0)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: (_caller, _workflowID, nodeID) =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: `endpoint-${nodeID}`,
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID: "wf-1",
                    nodeID,
                    attemptID: "attempt",
                  },
                  accepted: 1,
                  snapshot: 1,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                  lastMessageAt: nodeID === "a" ? 1_000 : 9_000,
                },
              }),
            latestMessageAt: () =>
              Effect.sync(() => {
                globalReads += 1
                return { ok: true, value: 9_000 } as const
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ timeUpdated: 9_000 })),
            getLastNodeChange: () =>
              Effect.sync(() => {
                globalReads += 1
                return 9_000
              }),
            getNodeTime: () => Effect.succeed(1_000),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ id: "a", childSessionId: "ses_child", replanAttempts: 0 }),
                makeNodeRow({ id: "b", childSessionId: "ses_child_b", replanAttempts: 0 }),
              ]),
          },
          { messages: () => Effect.succeed([]) },
        ),
      ),
    )
  })

  it.instance("does not use the current node time for a stale attempt observation", () => {
    let globalReads = 0
    let nodeTimeReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        node_id: "a",
        attempt_id: "old",
      })
      expect(result).toMatchObject({
        ok: true,
        last_relevant_change_at: "1970-01-01T00:00:05.000Z",
      })
      expect(globalReads).toBe(0)
      expect(nodeTimeReads).toBe(0)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: (_caller, _workflowID, nodeID, attemptID) =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: `endpoint-${nodeID}-${attemptID}`,
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID: "wf-1",
                    nodeID,
                    attemptID,
                  },
                  accepted: 1,
                  snapshot: 1,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                  lastMessageAt: attemptID === "old" ? 5_000 : 9_000,
                },
              }),
            latestMessageAt: () =>
              Effect.sync(() => {
                globalReads += 1
                return { ok: true, value: 9_000 } as const
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ timeUpdated: 9_000 })),
            getLastNodeChange: () =>
              Effect.sync(() => {
                globalReads += 1
                return 9_000
              }),
            getNodeTime: () =>
              Effect.sync(() => {
                nodeTimeReads += 1
                return 9_000
              }),
            getNodes: () => Effect.succeed([makeNodeRow({ id: "a", childSessionId: "ses_child", replanAttempts: 0 })]),
          },
          { messages: () => Effect.succeed([]) },
        ),
      ),
    )
  })

  it.instance("omits filtered time when neither the current attempt nor mailbox timestamp exists", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        node_id: "a",
        attempt_id: "old",
      })
      expect(result).toMatchObject({ ok: true })
      expect(result).not.toHaveProperty("last_relevant_change_at")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: (_caller, _workflowID, nodeID, attemptID) =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: `endpoint-${nodeID}-${attemptID}`,
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID: "wf-1",
                    nodeID,
                    attemptID,
                  },
                  accepted: 1,
                  snapshot: 1,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([makeNodeRow({ id: "a", childSessionId: "ses_child", replanAttempts: 0 })]),
            getNodeTime: () => Effect.succeed(9_000),
          },
          { messages: () => Effect.succeed([]) },
        ),
      ),
    ),
  )

  it.instance("never uses a replanned node timestamp for an exact attempt observation", () => {
    let nodeTimeReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        node_id: "a",
        attempt_id: "ses_a:0",
      })
      expect(result).toMatchObject({
        ok: true,
        last_relevant_change_at: "1970-01-01T00:00:01.000Z",
      })
      expect(nodeTimeReads).toBe(0)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: (_caller, _workflowID, nodeID, attemptID) =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: `endpoint-${nodeID}-${attemptID}`,
                    kind: "node",
                    sessionID: "ses_a",
                    workflowID: "wf-1",
                    nodeID,
                    attemptID,
                  },
                  accepted: 1,
                  snapshot: 1,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                  lastMessageAt: 1_000,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ timeUpdated: 9_000 })),
            getNodes: () => Effect.succeed([makeNodeRow({ id: "a", childSessionId: "ses_a", replanAttempts: 0 })]),
            getNodeTime: () =>
              Effect.sync(() => {
                nodeTimeReads += 1
                return 9_000
              }),
          },
          { messages: () => Effect.succeed([]) },
        ),
      ),
    )
  })

  it.instance("propagates unauthorized from timestamp aggregation", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            latestMessageAt: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([]),
          },
        ),
      ),
    ),
  )

  it.instance("rechecks permission after timestamp aggregation", () => {
    let allowed = true
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.succeed(
                allowed ? { ok: true, value: endpoint } : ({ ok: false, reason: "unauthorized" } as const),
              ),
            receive: () => Effect.succeed({ ok: true, value: [] }),
            latestMessageAt: () =>
              Effect.sync(() => {
                allowed = false
                return { ok: true, value: 2_000 } as const
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("does not aggregate mailbox state for an unread rate-limited response", () => {
    let latestCalls = 0
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      }
      const result = yield* messages.receive({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        after_sequence: 7,
        wait_ms: 0,
      })
      expect(result).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false })
      expect(latestCalls).toBe(3)
      expect(reads).toBe(3)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
            latestMessageAt: () =>
              Effect.sync(() => {
                latestCalls += 1
                return latestCalls <= 3
                  ? ({ ok: true, value: undefined } as const)
                  : ({ ok: false, reason: "unauthorized" } as const)
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("rechecks permission after observation timestamp aggregation", () => {
    let allowed = true
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.succeed(
                allowed ? { ok: true, value: endpoint } : ({ ok: false, reason: "unauthorized" } as const),
              ),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
            latestMessageAt: () =>
              Effect.sync(() => {
                allowed = false
                return { ok: true, value: 2_000 } as const
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([]),
          },
        ),
      ),
    )
  })

  it.instance("stops polling after three consecutive empty receives without hiding a durable read", () => {
    let reads = 0
    let workflowReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const results = []
      for (let index = 0; index < 3; index++) {
        results.push(yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 }))
      }
      expect(results[0]).toMatchObject({ empty_polls: 1 })
      expect(results[1]).toMatchObject({ empty_polls: 2 })
      expect(results[2]).toMatchObject({
        empty_polls: 3,
        retry_after_ms: expect.any(Number),
        read_performed: true,
        next_wake_hint: expect.stringContaining("Retry after"),
      })
      expect(results[2]).not.toHaveProperty("rate_limited")
      expect(reads).toBe(3)
      expect(workflowReads).toBe(6)
      const started = Date.now()
      const capped = yield* messages.receive({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        after_sequence: 7,
        wait_ms: 30_000,
      })
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(10_000)
      expect(capped).toMatchObject({ empty_polls: 4, read_performed: true })
      expect(capped).not.toHaveProperty("rate_limited")
      expect(reads).toBe(4)
      expect(workflowReads).toBe(8)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
          },
          {
            getWorkflow: () =>
              Effect.sync(() => {
                workflowReads += 1
                return makeWorkflowRow()
              }),
          },
        ),
      ),
    )
  })

  it.instance("refreshes workflow state after a wait before reporting an empty receive", () => {
    let workflowReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", wait_ms: 200 })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        next_wake_hint: expect.stringContaining("terminal but a durable wake is pending"),
      })
      expect(result).not.toHaveProperty("rate_limited")
      expect(workflowReads).toBe(2)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () =>
              Effect.sync(() => {
                workflowReads += 1
                return makeWorkflowRow({ status: "completed" })
              }),
            getUnreportedWakeWorkflows: () => Effect.succeed([makeWorkflowRow({ status: "completed" })]),
          },
        ),
      ),
    )
  })

  it.instance("resets the empty poll streak after a message", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      expect(yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })).toMatchObject({
        empty_polls: 1,
      })
      expect(yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })).toMatchObject({
        messages: [{ message_id: "message-one" }],
      })
      expect(yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })).toMatchObject({
        empty_polls: 1,
      })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return reads === 2
                  ? {
                      ok: true,
                      value: [
                        {
                          id: "message-one",
                          workflowID: "wf-1",
                          recipientSequence: 2,
                          sender: endpoint,
                          recipient: endpoint,
                          content: "hello",
                          state: "queued" as const,
                          acceptedRevision: 1,
                          transcriptID: "transcript-one",
                          partID: "part-one",
                          timeCreated: 1,
                        },
                      ],
                    }
                  : { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("counts concurrent empty receives independently and still reads every time", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const started = Date.now()
      const results = yield* Effect.all(
        Array.from({ length: 5 }, () => messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })),
        { concurrency: "unbounded" },
      )
      const elapsed = Date.now() - started
      expect(reads).toBe(3)
      expect(elapsed).toBeLessThan(2_000)
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ empty_polls: 1 }),
          expect.objectContaining({ empty_polls: 2 }),
          expect.objectContaining({ empty_polls: 3, read_performed: true }),
        ]),
      )
      const limited = results.filter(
        (result): result is Record<string, unknown> =>
          typeof result === "object" && result !== null && "reason" in result && result.reason === "rate_limited",
      )
      expect(limited).toHaveLength(2)
      expect(limited.filter((result) => result.read_performed === false)).toHaveLength(2)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("returns explicit rate-limited results instead of delaying a zero or small wait", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      }
      for (const wait_ms of [0, 10]) {
        const started = Date.now()
        const result = yield* messages.receive({
          sessionID: "ses_parent",
          workflow_id: "wf-1",
          after_sequence: 7,
          wait_ms,
        })
        expect(Date.now() - started).toBeLessThan(200)
        expect(result).toMatchObject({
          ok: false,
          reason: "rate_limited",
          retry_after_ms: expect.any(Number),
          read_performed: false,
        })
        expect(result).not.toHaveProperty("messages")
        expect(result).not.toHaveProperty("cursor")
      }
      expect(reads).toBe(3)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("returns a rate-limited rejection immediately for wait_ms 0 under contention", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const layer = adapter(
        {
          resolve: () => Effect.succeed({ ok: true, value: endpoint }),
          receive: () =>
            Effect.gen(function* () {
              calls += 1
              if (calls === 1) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(gate)
              }
              return { ok: true, value: [] }
            }),
        },
        { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
      )
      yield* Effect.gen(function* () {
        const messages = yield* DagAgentMessages.Service
        const first = yield* messages
          .receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 4, wait_ms: 0 })
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const started = Date.now()
        const limited = yield* messages.receive({
          sessionID: "ses_parent",
          workflow_id: "wf-1",
          after_sequence: 4,
          wait_ms: 0,
        })
        expect(Date.now() - started).toBeLessThan(200)
        expect(limited).toMatchObject({
          ok: false,
          reason: "rate_limited",
          retry_after_ms: expect.any(Number),
          read_performed: false,
        })
        expect(limited).not.toHaveProperty("messages")
        expect(limited).not.toHaveProperty("cursor")
        yield* Deferred.succeed(gate, undefined)
        expect(yield* Fiber.join(first)).toMatchObject({ ok: true, messages: [] })
      }).pipe(Effect.provide(layer))
    }),
  )

  it.instance("rechecks ownership immediately before a rate-limited receive returns", () => {
    let resolveCalls = 0
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      }
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(reads).toBe(3)
      expect(resolveCalls).toBe(11)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.sync(() => {
                resolveCalls += 1
                return resolveCalls === 11
                  ? ({ ok: false, reason: "unauthorized" } as const)
                  : ({ ok: true, value: endpoint } as const)
              }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("rechecks ownership after the receive cooldown", () => {
    let resolveCalls = 0
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      }
      const started = Date.now()
      const result = yield* messages.receive({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        after_sequence: 7,
        wait_ms: 1_500,
      })
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(reads).toBe(3)
      expect(resolveCalls).toBe(11)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.sync(() => {
                resolveCalls += 1
                return resolveCalls === 11
                  ? ({ ok: false, reason: "unauthorized" } as const)
                  : ({ ok: true, value: endpoint } as const)
              }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("rechecks ownership before returning received messages", () => {
    let resolveCalls = 0
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })
      }
      const result = yield* messages.receive({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        after_sequence: 7,
        wait_ms: 1_500,
      })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(reads).toBe(4)
      expect(resolveCalls).toBe(12)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.sync(() => {
                resolveCalls += 1
                return resolveCalls === 12
                  ? ({ ok: false, reason: "unauthorized" } as const)
                  : ({ ok: true, value: endpoint } as const)
              }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return reads <= 3
                  ? { ok: true, value: [] }
                  : {
                      ok: true,
                      value: [
                        {
                          id: "protected",
                          workflowID: "wf-1",
                          recipientSequence: 8,
                          sender: endpoint,
                          recipient: endpoint,
                          content: "protected",
                          state: "queued" as const,
                          acceptedRevision: 1,
                          transcriptID: "transcript-protected",
                          partID: "part-protected",
                          timeCreated: 1,
                        },
                      ],
                    }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("still reads a message that arrives during the bounded poll delay", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      }
      const started = Date.now()
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", wait_ms: 1_500 })
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(result).toMatchObject({ ok: true, messages: [{ message_id: "late" }] })
      expect(reads).toBe(4)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return reads <= 3
                  ? { ok: true, value: [] }
                  : {
                      ok: true,
                      value: [
                        {
                          id: "late",
                          workflowID: "wf-1",
                          recipientSequence: 2,
                          sender: endpoint,
                          recipient: endpoint,
                          content: "late",
                          state: "queued" as const,
                          acceptedRevision: 1,
                          transcriptID: "transcript-late",
                          partID: "part-late",
                          timeCreated: 1,
                        },
                      ],
                    }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("cancels the bounded poll delay without performing a read", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      }
      const abort = new AbortController()
      const started = Date.now()
      const fiber = yield* messages
        .receive({ sessionID: "ses_parent", workflow_id: "wf-1", wait_ms: 1_500, signal: abort.signal })
        .pipe(Effect.forkChild)
      yield* Effect.sleep(100)
      abort.abort()
      const outcome = yield* Fiber.await(fiber)
      expect(Exit.isFailure(outcome)).toBe(true)
      if (Exit.isFailure(outcome)) expect(Cause.hasInterrupts(outcome.cause)).toBe(true)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(reads).toBe(3)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () =>
              Effect.sync(() => {
                reads += 1
                return { ok: true, value: [] }
              }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    )
  })

  it.instance("returns retry guidance for repeated unscoped empty receives without stopping", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const first = yield* messages.receive({ sessionID: "ses_parent" })
      yield* messages.receive({ sessionID: "ses_parent" })
      const third = yield* messages.receive({ sessionID: "ses_parent" })
      expect(first).toMatchObject({
        ok: true,
        messages: [],
        empty_polls: 1,
        next_wake_hint: expect.stringContaining("No new messages"),
      })
      expect(third).toMatchObject({
        ok: true,
        messages: [],
        empty_polls: 3,
        retry_after_ms: expect.any(Number),
        read_performed: true,
        next_wake_hint: expect.stringContaining("Retry after"),
      })
      expect(third).not.toHaveProperty("stop_polling")
      expect(third).not.toHaveProperty("last_workflow_change_at")
    }).pipe(
      Effect.provide(
        adapter({
          receive: () => Effect.succeed({ ok: true, value: [] }),
        }),
      ),
    ),
  )

  it.instance("reports a pending durable wake after a terminal workflow without promising delivery", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("terminal but a durable wake is pending")
      expect(hint).toContain("delivery is not guaranteed")
      expect(result).not.toHaveProperty("stop_polling")
      expect(result).not.toHaveProperty("rate_limited")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ status: "completed" })),
            getUnreportedWakeWorkflows: () => Effect.succeed([makeWorkflowRow({ status: "completed" })]),
          },
        ),
      ),
    ),
  )

  it.instance("states that no durable wake remains after a terminal workflow wake is reported", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("terminal and no durable wake is pending")
      expect(hint).toContain("no further wake is assured")
      expect(result).not.toHaveProperty("stop_polling")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () =>
              Effect.succeed(makeWorkflowRow({ status: "completed", wakeReported: true })),
          },
        ),
      ),
    ),
  )

  it.instance("describes an eligible reporting-checkpoint wake without promising model delivery", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("durable reporting-checkpoint, escalation, or timeout-extension wake is pending")
      expect(hint).toContain("delivery is not guaranteed")
      expect(hint).toContain("owning instance is running")
      expect(hint).toContain("directory ownership matches")
      expect(hint).toContain("session becomes idle")
      expect(hint).toContain("model processing is not guaranteed")
      expect(hint).toContain("Assistant errors can suppress mailbox delivery")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getUnreportedWakeNodes: () =>
              Effect.succeed([makeNodeRow({ wakeEligible: true, status: "completed" })]),
          },
        ),
      ),
    ),
  )

  it.instance("states that no eligible reporting wake is pending", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("no durable reporting-checkpoint, escalation, or timeout-extension wake is pending")
      expect(hint).toContain("no future wake is assured")
      expect(hint).toContain("model processing is not guaranteed")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([makeNodeRow({ wakeEligible: false, status: "completed" })]),
          },
        ),
      ),
    ),
  )

  it.instance("counts a timeout extension as a durable wake after escalation is cleared", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("durable reporting-checkpoint, escalation, or timeout-extension wake is pending")
      expect(hint).not.toContain("no durable")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getUnreportedWakeNodes: () =>
              Effect.succeed([
                makeNodeRow({
                  wakeEligible: false,
                  wakeReported: false,
                  escalationPending: false,
                  timeoutExtensions: 1,
                  status: "running",
                }),
              ]),
          },
        ),
      ),
    ),
  )

  it.instance("does not infer staleness for an unscoped running worker receive", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_child" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("Parent replies are processed only while this attempt is running")
      expect(hint).not.toContain("no longer current")
    }).pipe(
      Effect.provide(
        adapter(
          {
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: "endpoint-child",
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID: "wf-1",
                    nodeID: "node-1",
                    attemptID: "ses_child:0",
                  },
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ childSessionId: "ses_child", replanAttempts: 0, status: "running" }),
              ]),
          },
        ),
      ),
    ),
  )

  it.instance("limits parent replies to the current worker attempt", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_child", workflow_id: "wf-1" })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        next_wake_hint: expect.stringContaining("Parent replies are processed only while this attempt is running"),
      })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: "endpoint-child",
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID: "wf-1",
                    nodeID: "node-1",
                    attemptID: "ses_child:0",
                  },
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ childSessionId: "ses_child", replanAttempts: 0, status: "running" }),
              ]),
          },
        ),
      ),
    ),
  )

  it.instance("states that a detached worker session no longer receives parent replies", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_old", workflow_id: "wf-1" })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        next_wake_hint: expect.stringContaining("no longer current"),
      })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.succeed({ ok: true, value: { id: "endpoint-old", kind: "main", sessionID: "ses_old" } }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: { id: "endpoint-old", kind: "main", sessionID: "ses_old" },
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ childSessionId: "ses_replacement", replanAttempts: 1, status: "running" }),
              ]),
          },
        ),
      ),
    ),
  )

  it.instance("states that a replaced worker attempt no longer receives parent replies", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_child", workflow_id: "wf-1" })
      expect(result).toMatchObject({
        ok: true,
        messages: [],
        next_wake_hint: expect.stringContaining("no longer current"),
      })
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: "endpoint-child",
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID: "wf-1",
                    nodeID: "node-1",
                    attemptID: "ses_child:0",
                  },
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ childSessionId: "ses_child", replanAttempts: 1, status: "running" }),
              ]),
          },
        ),
      ),
    ),
  )

  it.instance("gives a terminal child its own attempt hint instead of the parent durable wake hint", () => {
    const childEndpoint: DagMessages.Endpoint = {
      id: "endpoint-child",
      kind: "node",
      sessionID: "ses_child",
      workflowID: "wf-1",
      nodeID: "node-1",
      attemptID: "ses_child:0",
    }
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.receive({ sessionID: "ses_child", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, messages: [] })
      const hint = hintOf(result)
      expect(hint).toContain("no longer current")
      expect(hint).not.toContain("durable wake is pending")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: childEndpoint }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: childEndpoint,
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
            receive: () => Effect.succeed({ ok: true, value: [] }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ status: "completed" })),
            getUnreportedWakeWorkflows: () => Effect.succeed([makeWorkflowRow({ status: "completed" })]),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ childSessionId: "ses_child", replanAttempts: 0, status: "completed" }),
              ]),
          },
        ),
      ),
    )
  })

  it.instance("gives a running worker a conditional observe hint", () => {
    const childEndpoint: DagMessages.Endpoint = {
      id: "endpoint-child",
      kind: "node",
      sessionID: "ses_child",
      workflowID: "wf-1",
      nodeID: "node-1",
      attemptID: "ses_child:0",
    }
    const cursor = JSON.stringify({ workflowID: "wf-1", nodeID: "node-1", offset: 1 })
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({
        sessionID: "ses_child",
        workflow_id: "wf-1",
        node_id: "node-1",
        cursor,
      })
      expect(result).toMatchObject({ ok: true, nodes: [] })
      expect(hintOf(result)).toContain("Parent replies are processed only while this attempt is running")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: childEndpoint }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: childEndpoint,
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({
                  id: "node-1",
                  childSessionId: "ses_child",
                  replanAttempts: 0,
                  status: "running",
                }),
              ]),
          },
        ),
      ),
    )
  })

  it.instance("gives a non-reporting parent a conditional observe hint", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, nodes: [] })
      const hint = hintOf(result)
      expect(hint).toContain("no durable reporting-checkpoint, escalation, or timeout-extension wake is pending")
      expect(hint).not.toContain("durable wake is pending")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          { getWorkflow: () => Effect.succeed(makeWorkflowRow()) },
        ),
      ),
    ),
  )

  it.instance("keeps a terminal child observe on its own attempt hint", () => {
    const childEndpoint: DagMessages.Endpoint = {
      id: "endpoint-child",
      kind: "node",
      sessionID: "ses_child",
      workflowID: "wf-1",
      nodeID: "node-1",
      attemptID: "ses_child:0",
    }
    const cursor = JSON.stringify({ workflowID: "wf-1", nodeID: "node-1", offset: 1 })
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({
        sessionID: "ses_child",
        workflow_id: "wf-1",
        node_id: "node-1",
        cursor,
      })
      expect(result).toMatchObject({ ok: true, nodes: [] })
      const hint = hintOf(result)
      expect(hint).toContain("no longer current")
      expect(hint).not.toContain("durable wake is pending")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: childEndpoint }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: childEndpoint,
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ status: "completed" })),
            getUnreportedWakeWorkflows: () => Effect.succeed([makeWorkflowRow({ status: "completed" })]),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({
                  id: "node-1",
                  childSessionId: "ses_child",
                  replanAttempts: 0,
                  status: "completed",
                }),
              ]),
          },
        ),
      ),
    )
  })

  it.instance("gives a stale worker a conditional observe hint", () => {
    const childEndpoint: DagMessages.Endpoint = {
      id: "endpoint-child",
      kind: "node",
      sessionID: "ses_child",
      workflowID: "wf-1",
      nodeID: "node-1",
      attemptID: "ses_child:0",
    }
    const cursor = JSON.stringify({ workflowID: "wf-1", nodeID: "node-1", offset: 1 })
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({
        sessionID: "ses_child",
        workflow_id: "wf-1",
        node_id: "node-1",
        cursor,
      })
      expect(result).toMatchObject({ ok: true, nodes: [] })
      expect(hintOf(result)).toContain("no longer current")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: childEndpoint }),
            revisions: () =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: childEndpoint,
                  accepted: 0,
                  snapshot: 0,
                  queued: 0,
                  delivered: 0,
                  undeliverable: 0,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({
                  id: "node-1",
                  childSessionId: "ses_child",
                  replanAttempts: 0,
                  status: "completed",
                }),
              ]),
          },
        ),
      ),
    )
  })

  it.instance("gives an eligible parent a conditional observe hint", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, nodes: [] })
      expect(hintOf(result)).toContain(
        "durable reporting-checkpoint, escalation, or timeout-extension wake is pending",
      )
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getUnreportedWakeNodes: () =>
              Effect.succeed([makeNodeRow({ wakeEligible: true, status: "completed" })]),
          },
        ),
      ),
    ),
  )

  it.instance("gives a terminal parent a conditional observe hint", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toMatchObject({ ok: true, nodes: [], status: "completed" })
      expect(hintOf(result)).toContain("terminal but a durable wake is pending")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow({ status: "completed" })),
            getUnreportedWakeWorkflows: () => Effect.succeed([makeWorkflowRow({ status: "completed" })]),
          },
        ),
      ),
    ),
  )

  it.instance("rate-limits repeated empty observations for a non-reporting empty graph", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const first = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(first).toMatchObject({
        ok: true,
        nodes: [],
        empty_polls: 1,
        last_relevant_change_at: "1970-01-01T00:00:00.001Z",
      })
      expect(first).not.toHaveProperty("last_workflow_change_at")
      expect(first).toMatchObject({ next_wake_hint: expect.stringContaining("No new messages") })
      const second = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      const third = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(second).toMatchObject({ empty_polls: 2 })
      expect(third).toMatchObject({
        empty_polls: 3,
        retry_after_ms: expect.any(Number),
        next_wake_hint: expect.stringContaining("Retry after"),
      })
      expect(third).not.toHaveProperty("stop_polling")
      const started = Date.now()
      const fourth = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(200)
      expect(fourth).toMatchObject({ ok: false, reason: "rate_limited", read_performed: false, retry_after_ms: expect.any(Number) })
      expect(fourth).not.toHaveProperty("nodes")
      expect(fourth).not.toHaveProperty("stop_polling")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([]),
          },
        ),
      ),
    ),
  )

  it.instance("refreshes observation status after the rate-limited scan", () => {
    let workflowReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      }
      const started = Date.now()
      yield* Effect.sleep(1_010)
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(result).toMatchObject({ ok: true, status: "completed" })
      expect(hintOf(result)).toContain("terminal and no durable wake is pending")
      expect(result).not.toHaveProperty("last_workflow_change_at")
      expect(workflowReads).toBe(8)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () =>
              Effect.sync(() => {
                workflowReads += 1
                return makeWorkflowRow({
                  status: workflowReads > 6 ? "completed" : "running",
                  timeUpdated: 1_000,
                })
              }),
            getNodes: () => Effect.succeed([]),
          },
        ),
      ),
    )
  })

  it.instance("rechecks ownership after the observe cooldown", () => {
    let resolveCalls = 0
    let nodeReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      }
      const started = Date.now()
      yield* Effect.sleep(1_010)
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(nodeReads).toBe(3)
      expect(resolveCalls).toBe(11)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.sync(() => {
                resolveCalls += 1
                return resolveCalls === 11
                  ? ({ ok: false, reason: "unauthorized" } as const)
                  : ({ ok: true, value: endpoint } as const)
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.sync(() => {
                nodeReads += 1
                return []
              }),
          },
        ),
      ),
    )
  })

  it.instance("rechecks ownership before returning observed workflow state", () => {
    let resolveCalls = 0
    let nodeReads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      for (let index = 0; index < 3; index++) {
        yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      }
      yield* Effect.sleep(1_010)
      const result = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1" })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(nodeReads).toBe(4)
      expect(resolveCalls).toBe(12)
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () =>
              Effect.sync(() => {
                resolveCalls += 1
                return resolveCalls === 12
                  ? ({ ok: false, reason: "unauthorized" } as const)
                  : ({ ok: true, value: endpoint } as const)
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.sync(() => {
                nodeReads += 1
                return []
              }),
          },
        ),
      ),
    )
  })

  it.instance("cancels only the receive waiter without calling delivery or workflow mutation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const abort = new AbortController()
      const layer = adapter({
        receive: () => Deferred.succeed(started, undefined).pipe(Effect.as({ ok: true, value: [] } as const)),
      })
      yield* Effect.gen(function* () {
        const messages = yield* DagAgentMessages.Service
        const waiter = yield* messages
          .receive({ sessionID: "ses_parent", wait_ms: 30_000, signal: abort.signal })
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        abort.abort()
        const outcome = yield* Fiber.await(waiter)
        expect(Exit.isFailure(outcome)).toBe(true)
        if (Exit.isFailure(outcome)) expect(Cause.hasInterrupts(outcome.cause)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )
})
