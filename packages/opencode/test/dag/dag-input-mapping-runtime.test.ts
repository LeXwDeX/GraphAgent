// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks use the narrow runtime surface exercised here
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Layer, Option, Queue, Scope } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { isManagedOutputFileRef } from "@/dag/runtime/output-ref"
import { ReadTool } from "@/tool/read"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { awaitWithTimeout, it, pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptRecord {
  readonly title: string
  readonly text: string
  readonly release: Deferred.Deferred<string>
  readonly readOutput?: string
  readonly permission: PermissionV1.Ruleset
}

function node(id: string, dependsOn: string[] = [], inputMapping?: Record<string, string>): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    ...(inputMapping ? { input_mapping: inputMapping } : {}),
  }
}

function reply(sessionID: string, text = "done"): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
  } as never
}

function runtimeLayer(records: Queue.Queue<PromptRecord>, created: string[], parentPermissions: PermissionV1.Ruleset) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, status, dag)
  const titles = new Map<string, string>()
  const permissions = new Map<string, PermissionV1.Ruleset>()
  // Resolve the existing temp root before adding wildcard segments: Windows
  // realpath cannot expand RUNNER~1 through a non-existent dag-* directory.
  const agentPermissions = Permission.fromConfig({ read: "allow", external_directory: { "*": "ask", [path.join(FSUtil.normalizePath(os.tmpdir()), "dag-*", "*")]: "allow" } })
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (id) => Effect.succeed({ id, permission: permissions.get(id) ?? parentPermissions, agent: "build" } as never),
    create: (input) =>
      Effect.sync(() => {
        const id = `ses_mapping_child_${created.length + 1}`
        created.push(id)
        titles.set(id, (input?.title ?? id).replace(" (DAG node)", ""))
        permissions.set(id, input?.permission ?? [])
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.mapping")(function* (input: SessionPrompt.PromptInput) {
    const sessionID = input.sessionID as string
    if (sessionID === "ses_mapping_parent") return reply(sessionID)
    const release = yield* Deferred.make<string>()
    const text = input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    const artifactPath = text.match(/^Read the committed report: (.+)$/m)?.[1]
    const readOutput = artifactPath ? yield* Effect.gen(function* () {
      const info = yield* ReadTool
      const read = yield* info.init()
      const result = yield* read.execute({ filePath: artifactPath }, {
        sessionID: SessionID.make(sessionID), messageID: MessageID.ascending(), agent: "build",
        abort: new AbortController().signal, messages: [], metadata: () => Effect.void,
        ask: (request) => Effect.sync(() => {
          for (const pattern of request.patterns) {
            const action = Permission.evaluate(request.permission, pattern, agentPermissions, permissions.get(sessionID) ?? []).action
            if (action !== "allow") throw new Error(`${action}: ${request.permission}`)
          }
        }),
      })
      return result.output
    }).pipe(Effect.provide(Layer.mergeAll(
      FSUtil.defaultLayer,
      Layer.mock(Instruction.Service, { resolve: () => Effect.succeed([]) }),
      Layer.mock(LSP.Service, { touchFile: () => Effect.void }),
      Layer.mock(Truncate.Service, { output: (content) => Effect.succeed({ content, truncated: false }) }),
      agent,
    )), Effect.scoped) : undefined
    yield* Queue.offer(records, {
      title: titles.get(sessionID) ?? sessionID,
      text: input.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      release,
      readOutput,
      permission: permissions.get(sessionID) ?? [],
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: deliver,
      promptIfIdle: (input) => deliver(input).pipe(Effect.map(Option.some)),
    }),
  )
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: agentPermissions,
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

function runLoopTest<A>(
  test: (services: {
    dag: Dag.Interface
    loop: DagLoop.Interface
    store: DagStore.Interface
    records: Queue.Queue<PromptRecord>
    created: string[]
  }) => Effect.Effect<A, Error, Scope.Scope>,
  parentPermissions: PermissionV1.Ruleset = [],
) {
  return Effect.gen(function* () {
    const records = yield* Queue.unbounded<PromptRecord>()
    const created: string[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionID.make("ses_mapping_parent"),
          project_id: Project.ID.global,
          slug: "mapping-parent",
          directory: process.cwd(),
          title: "Mapping parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, records, created })
    }).pipe(
      Effect.provide(runtimeLayer(records, created, parentPermissions)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: Project.ID.global },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop input_mapping execution boundary", () => {
  for (const permission of ["read", "external_directory"] as const) {
    it.live(`does not capture or complete a source denied by ${permission}`, () => {
      const parentPermissions: PermissionV1.Rule[] = [{ permission, pattern: "*", action: "deny" }]
      return runLoopTest(({ dag, loop, store, records }) => Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-denied-capture-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )
        const source = path.join(directory, "secret.txt")
        yield* Effect.promise(() => fs.writeFile(source, `private capture ${directory}`))
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global, sessionID: "ses_mapping_parent", title: "Denied source",
          config: { name: "denied-source", nodes: [node("producer")] },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        yield* Deferred.succeed(producer.release, source)
        const failed = yield* pollWithTimeout(store.getNode(dagID, "producer").pipe(
          Effect.map((row) => row?.status === "failed" ? row : undefined),
        ), "denied source did not fail producer")
        expect(failed.errorReason).toContain(`source ${permission} denied`)
        expect(failed.capturedOutput).toBeNull()
        expect(failed.output).toBeNull()
      }), parentPermissions)
    })
  }

  it.live("recovers only the failed verification and downstream report using committed upstream files", () =>
    runLoopTest(({ dag, loop, store, records, created }) => Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-recover-wave-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const source = path.join(directory, "analysis.md")
      yield* Effect.promise(() => fs.writeFile(source, `completed analysis ${directory}`))
      const verify = node("verify", ["implement"], { report: "analyze.output" })
      verify.prompt_template = { inline: "Read the committed report: {{report}}" }
      yield* loop.init()
      const dagID = yield* dag.create({
        projectID: Project.ID.global, sessionID: "ses_mapping_parent", title: "Recover verification",
        config: { name: "recover-verification", nodes: [node("analyze"), node("implement", ["analyze"]), verify, node("report", ["verify"])] },
      })
      const analyze = yield* awaitWithTimeout(Queue.take(records), "analysis did not start")
      expect(analyze.title).toBe("analyze")
      yield* Deferred.succeed(analyze.release, source)
      const implement = yield* awaitWithTimeout(Queue.take(records), "implementation did not start")
      expect(implement.title).toBe("implement")
      yield* Deferred.succeed(implement.release, "implementation already done")
      const verification = yield* awaitWithTimeout(Queue.take(records), "verification did not start")
      expect(verification.readOutput).toContain("completed analysis")
      yield* dag.nodeFailed(dagID, "verify", "test temporarily unavailable", "exec_failed")
      const failed = yield* pollWithTimeout(
        store.getWorkflow(dagID).pipe(Effect.map((row) => row?.status === "failed" ? row : undefined)),
        "workflow did not become failed",
      )
      yield* Effect.promise(() => fs.rm(directory, { recursive: true, force: true }))
      const analysis = yield* store.getNode(dagID, "analyze")
      if (!isManagedOutputFileRef(analysis?.capturedOutput)) throw new Error("missing analysis artifact")
      const objectDirectory = path.dirname(analysis.capturedOutput.path)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(objectDirectory, { recursive: true, force: true })))
      const recovered = yield* dag.recover(dagID, { nodeIDs: ["verify"], expectedGraphRev: failed.graphRev })
      expect(recovered.reused).toEqual(expect.arrayContaining(["analyze", "implement"]))
      expect(recovered.replacements.map((entry) => entry.previous).sort()).toEqual(["report", "verify"])
      const retry = yield* awaitWithTimeout(Queue.take(records), "recovered verification was not scheduled")
      expect(retry.title).toBe("verify")
      expect(retry.readOutput).toContain("completed analysis")
      expect(retry.text).toContain("Recovery context:")
      expect(retry.text).toContain('"previous_node_id": "verify"')
      expect(retry.text).toContain('"previous_child_session_id": "ses_mapping_child_3"')
      yield* Deferred.succeed(retry.release, "verification passed")
      const report = yield* awaitWithTimeout(Queue.take(records), "recovered report was not scheduled")
      expect(report.title).toBe("report")
      yield* Deferred.succeed(report.release, "complete")
      yield* pollWithTimeout(
        store.getWorkflow(dagID).pipe(Effect.map((row) => row?.status === "completed" ? row : undefined)),
        "recovered workflow did not complete",
      )
      expect(created).toHaveLength(5)
      expect((yield* store.getNode(dagID, "analyze"))?.childSessionId).toBe(analysis.childSessionId)
      expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
    })),
  )

  for (const [corrupt, deny, sourceReadDeny, targetReadDeny] of [[false, false, false, false], [true, false, false, false], [false, true, false, false], [false, false, true, false], [false, false, false, true]]) {
    const parentPermissions: PermissionV1.Rule[] = []
    it.live(`reads verified artifacts with scoped permissions (corrupt=${corrupt}, deny=${deny}, sourceReadDeny=${sourceReadDeny}, targetReadDeny=${targetReadDeny})`, () =>
      runLoopTest(({ dag, loop, store, records }) =>
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-file-handoff-"))),
            (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
          )
          const source = path.join(directory, "report with spaces.md")
          const body = `unique report body ${directory}`
          yield* Effect.promise(() => fs.writeFile(source, body))
          yield* loop.init()
          const consumer = node("consumer", ["producer", "blocker"], { report: "producer.output" })
          consumer.prompt_template = { inline: "Read the committed report: {{report}}" }
          const dagID = yield* dag.create({
            projectID: Project.ID.global, sessionID: "ses_mapping_parent", title: "File handoff",
            config: { name: "file-handoff", nodes: [node("producer"), node("blocker"), consumer] },
          })
          const first = yield* awaitWithTimeout(Queue.take(records), "first source did not start")
          const second = yield* awaitWithTimeout(Queue.take(records), "second source did not start")
          const producer = [first, second].find((record) => record.title === "producer")!
          yield* Deferred.succeed(producer.release, source)
          const row = yield* pollWithTimeout(
            store.getNode(dagID, "producer").pipe(Effect.map((row) => row?.status === "completed" ? row : undefined)),
            "producer did not commit its file",
          )
          const ref = row.capturedOutput
          expect(isManagedOutputFileRef(ref)).toBe(true)
          if (!isManagedOutputFileRef(ref)) throw new Error("missing managed receipt")
          if (sourceReadDeny) parentPermissions.push({ permission: "read", pattern: path.relative(process.cwd(), FSUtil.normalizePath(source)), action: "deny" })
          if (deny) parentPermissions.push({ permission: "external_directory", pattern: "*", action: "deny" })
          if (targetReadDeny) parentPermissions.push(
            { permission: "read", pattern: path.relative(process.cwd(), FSUtil.normalizePath(source)), action: "ask" },
            { permission: "read", pattern: path.relative(process.cwd(), FSUtil.normalizePath(ref.path)), action: "deny" },
          )
          yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(path.dirname(ref.path), { recursive: true, force: true })))
          yield* Effect.promise(() => fs.rm(directory, { recursive: true, force: true }))
          if (corrupt) {
            yield* Effect.promise(() => fs.chmod(ref.path, 0o600))
            yield* Effect.promise(() => fs.writeFile(ref.path, "X".repeat(ref.size)))
          }
          yield* dag.nodeCompleted(dagID, "blocker", "ready")
          if (corrupt || deny || sourceReadDeny || targetReadDeny) {
            const failed = yield* pollWithTimeout(
              store.getNode(dagID, "consumer").pipe(Effect.map((row) => row?.status === "failed" ? row : undefined)),
              "invalid or denied artifact did not stop consumer",
            )
            expect(failed.errorReason).toContain(corrupt ? "Input artifact verification failed" : sourceReadDeny || targetReadDeny ? "deny: read" : "deny: external_directory")
            expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
          } else {
            const prompt = yield* awaitWithTimeout(Queue.take(records), "consumer did not start")
            expect(prompt.text).toContain(ref.path)
            expect(prompt.text).not.toContain(body)
            expect(prompt.text).not.toContain(source)
            expect(prompt.readOutput).toContain(body)
            expect(Permission.evaluate("edit", path.relative(process.cwd(), FSUtil.normalizePath(ref.path)), prompt.permission).action).toBe("deny")
            expect(Permission.evaluate("external_directory", path.join(path.dirname(path.dirname(ref.path)), "unrelated", "*"), prompt.permission).action).toBe("ask")
            expect(yield* Effect.promise(() => fs.readFile(ref.path, "utf8"))).toBe(body)
          }
        }), parentPermissions,
      ),
    )
  }

  for (const findings of ["unique upstream finding", { summary: "unique upstream finding", files: ["a.ts"] }]) {
    it.live(`delivers interpolated ${typeof findings} output once and retains unused context`, () =>
      runLoopTest(({ dag, loop, records }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const consumer = node("consumer", ["producer"], {
            findings: "producer.output.findings",
            extra: "producer.output.extra",
          })
          consumer.prompt_template = { inline: "Use these findings: {{findings}}" }
          const dagID = yield* dag.create({
            projectID: Project.ID.global,
            sessionID: "ses_mapping_parent",
            title: "Single delivery",
            config: { name: "single-delivery", nodes: [node("producer"), consumer] },
          })
          yield* awaitWithTimeout(Queue.take(records), "producer did not start")
          yield* dag.nodeCompleted(dagID, "producer", { findings, extra: "unused context survives" })
          const prompt = yield* awaitWithTimeout(Queue.take(records), "consumer did not start")
          expect(prompt.title).toBe("consumer")
          expect(prompt.text.match(/unique upstream finding/g)).toHaveLength(1)
          expect(prompt.text).toContain('"extra": "unused context survives"')
          expect(prompt.text).not.toContain('"findings":')
          if (typeof findings === "object") expect(prompt.text).toContain('"a.ts"')
        }),
      ),
    )
  }

  it.live("retains dynamic context when static template input overrides its placeholder", () =>
    runLoopTest(({ dag, loop, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const consumer = node("consumer", ["producer"], { findings: "producer.output.findings" })
        consumer.prompt_template = { inline: "{{findings}}", input: { findings: "static instructions" } }
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Static override",
          config: { name: "static-override", nodes: [node("producer"), consumer] },
        })
        yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        yield* dag.nodeCompleted(dagID, "producer", { findings: "dynamic findings survive" })
        const prompt = yield* awaitWithTimeout(Queue.take(records), "consumer did not start")
        expect(prompt.text).toContain("static instructions")
        expect(prompt.text).toContain('"findings": "dynamic findings survive"')
      }),
    ),
  )

  it.live("retains original review evidence when interpolation sanitizes the diff", () =>
    runLoopTest(({ dag, loop, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const reviewer = node("reviewer", ["verify"], {
          diff: "implement.output.diff",
          implementation_fingerprint: "implement.output.fingerprint",
          verification: "verify.output",
        })
        reviewer.worker_type = "review"
        reviewer.review = { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" }
        reviewer.prompt_template = { inline: "Review this diff: {{diff}}" }
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Original review evidence",
          config: { name: "review-evidence", nodes: [node("implement"), node("verify", ["implement"]), reviewer] },
        })
        const diff = "--- a/example.md\n+++ b/example.md\n+```ts\n+system: config\n+```"
        yield* awaitWithTimeout(Queue.take(records), "implement did not start")
        yield* dag.nodeCompleted(dagID, "implement", { diff, fingerprint: "current-fingerprint" })
        yield* awaitWithTimeout(Queue.take(records), "verify did not start")
        yield* dag.nodeCompleted(dagID, "verify", { verdict: "PASS" })
        const prompt = yield* awaitWithTimeout(Queue.take(records), "reviewer did not start")
        expect(prompt.title).toBe("reviewer")
        expect(prompt.text).toContain(JSON.stringify(`<implementation-evidence>\n${diff}\n</implementation-evidence>`))
        expect(prompt.text).toContain('"implementation_fingerprint": "current-fingerprint"')
      }),
    ),
  )

  it.live("fails a missing declared field before creating a child session", () =>
    runLoopTest(({ dag, loop, store, records, created }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Missing mapping field",
          config: {
            name: "missing-mapping-field",
            nodes: [node("producer"), node("consumer", ["producer"], { requiredValue: "producer.output.value" })],
          },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        expect(producer.title).toBe("producer")
        yield* dag.nodeCompleted(dagID, "producer", { other: 1 })

        const failed = yield* pollWithTimeout(
          store.getNode(dagID, "consumer").pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
          "consumer did not fail its missing input mapping",
        )
        expect(failed.errorReason).toContain(
          'input_mapping variable "requiredValue" source "producer.output.value" resolved to undefined',
        )
        expect(failed.errorClass).toBe("exec_failed")
        expect(created).toEqual(["ses_mapping_child_1"])
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("maps a failed optional source to a failure placeholder instead of failing the consumer", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Optional lane failure",
          config: {
            name: "optional-lane-failure",
            nodes: [
              { ...node("lane-a"), required: false },
              { ...node("lane-b"), required: false },
              node("decision", ["lane-a", "lane-b"], {
                a_review: "lane-a.output.findings",
                b_review: "lane-b.output",
              }),
            ],
          },
        })
        const first = yield* awaitWithTimeout(Queue.take(records), "first lane did not start")
        const second = yield* awaitWithTimeout(Queue.take(records), "second lane did not start")
        expect([first.title, second.title].sort()).toEqual(["lane-a", "lane-b"])
        yield* dag.nodeFailed(dagID, "lane-a", "lane crashed", "exec_failed")
        yield* dag.nodeCompleted(dagID, "lane-b", "b findings")

        const decision = yield* awaitWithTimeout(Queue.take(records), "decision did not start after an optional lane failed")
        expect(decision.title).toBe("decision")
        expect(decision.text).toContain('"a_review": "Dependency \\"lane-a\\" failed: lane crashed"')
        expect(decision.text).toContain('"b_review": "b findings"')
        yield* Deferred.succeed(decision.release, "decision done")
        const workflow = yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row && row.status !== "running" ? row : undefined))),
          "workflow did not settle after the decision",
        )
        expect(workflow.status).toBe("completed")
        for (const lane of [first, second]) yield* Deferred.succeed(lane.release, "late")
      }),
    ),
  )

  it.live("preserves a completed null whole output as a declared value", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Null whole output",
          config: {
            name: "null-whole-output",
            nodes: [node("producer"), node("consumer", ["producer"], { whole: "producer.output" })],
          },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        expect(producer.title).toBe("producer")
        yield* dag.nodeCompleted(dagID, "producer", null)

        const consumer = yield* awaitWithTimeout(Queue.take(records), "null-output consumer did not start")
        expect(consumer.title).toBe("consumer")
        expect(consumer.text).toContain('"whole": null')
        yield* Deferred.succeed(consumer.release, "consumer done")
        yield* pollWithTimeout(
          store.getNode(dagID, "consumer").pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "null-output consumer did not complete",
        )
      }),
    ),
  )

  it.live("resolves direct and transitive sources while preserving a null leaf", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Valid mappings",
          config: {
            name: "valid-mappings",
            nodes: [
              node("producer"),
              node("middle", ["producer"]),
              node("direct", ["producer"], { value: "producer.output.value" }),
              node("transitive", ["middle"], { nullable: "producer.output.nullable" }),
            ],
          },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        expect(producer.title).toBe("producer")
        yield* dag.nodeCompleted(dagID, "producer", { value: 7, nullable: null })

        const first = yield* awaitWithTimeout(Queue.take(records), "first direct dependent did not start")
        const second = yield* awaitWithTimeout(Queue.take(records), "second direct dependent did not start")
        const direct = [first, second].find((record) => record.title === "direct")
        const middle = [first, second].find((record) => record.title === "middle")
        expect(middle).toBeDefined()
        expect(direct?.text).toContain('"value": 7')
        yield* Deferred.succeed(direct!.release, "direct done")
        yield* Deferred.succeed(middle!.release, "middle done")

        const transitive = yield* awaitWithTimeout(Queue.take(records), "transitive dependent did not start")
        expect(transitive.title).toBe("transitive")
        expect(transitive.text).toContain('"nullable": null')
        yield* Deferred.succeed(transitive.release, "transitive done")
        yield* pollWithTimeout(
          Effect.all([store.getNode(dagID, "direct"), store.getNode(dagID, "transitive")]).pipe(
            Effect.map((rows) => (rows.every((row) => row?.status === "completed") ? rows : undefined)),
          ),
          "valid mapped consumers did not complete",
        )
      }),
    ),
  )
})
