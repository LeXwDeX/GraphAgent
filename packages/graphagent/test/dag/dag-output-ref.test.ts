// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- spawn-level
// probes deliberately mirror dag-structured-output.test.ts: mocked service
// layers and row fixtures use `as never` type shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * File-output settlement probes. New schemaless file submissions commit
 * immutable managed objects before success; legacy detection and inline JSON
 * remain compatible. Both live capture and crash recovery verify receipts.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import {
  captureOutputFileRef,
  commitOutputFileRef,
  verifyOutputFileRef,
  reportAreaDirective,
  workflowArtifactsRoot,
  workflowDagSpecsArea,
  workflowDraftsArea,
  workflowReportsArea,
} from "@/dag/runtime/output-ref"
import { makeNodeRow } from "./fixtures"
import type { DagStore } from "@graphagent/core/dag/store"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

/** The per-workflow child-run schedule the loop hands to `spawnNode`. */
const spawnSchedule = <T extends { readonly dagID: string }>(input: T, cap: number) => ({
  limit: { kind: "workflow" as const, workflowID: input.dagID },
  cap,
})

const tmpRoots: string[] = []

function tmpRoot(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => {
    tmpRoots.push(dir)
    return dir
  })
}

afterAll(async () => {
  for (const dir of tmpRoots) await fs.rm(dir, { recursive: true, force: true })
})

type TrackedEvent = { type: string; nodeID: string; output?: unknown; reason?: string; trigger?: string }

let capturedStore: Map<string, unknown> = new Map()
let capturedCalls: unknown[] = []

function makeEventTracker(options: { capturedFail?: boolean; directory?: string } = {}) {
  const events: TrackedEvent[] = []
  capturedStore = new Map()
  capturedCalls = []
  const storeStub: Partial<DagStore.Interface> = {
    tryClaimAdoption: () => Effect.succeed(true),
    ...(options.directory
      ? {
          getWorkflow: () =>
            Effect.succeed({
              id: "wf-1",
              projectId: "p",
              directory: options.directory,
              status: "running",
            } as DagStore.WorkflowRow),
        }
      : {}),
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => ({
        ...makeNodeRow({ id: nodeID, status: "running", childSessionId: "ses_child" }),
        capturedOutput: capturedStore.get(nodeID),
      })),
    ),
    setCapturedOutput: Effect.fn("s")((_childSessionID: string, payload: unknown) =>
      options.capturedFail
        ? Effect.die(new Error("receipt persistence failed"))
        : Effect.sync(() => {
            capturedCalls.push(payload)
            capturedStore.set("node-1", payload)
          }),
    ),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeStarted: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeCompleted: Effect.fn("s")((_dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID, output })),
    ),
    nodeFailed: Effect.fn("s")((_dagID: string, nodeID: string, reason: string, trigger?: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID, reason, trigger })),
    ),
    nodeSkipped: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID })),
    ),
  })
  return { events, dagLayer }
}

const agentLayer = Layer.mock(Agent.Service, {
  get: () =>
    Effect.succeed({
      name: "build",
      mode: "all",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      options: {},
      description: "",
      prompt: "",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
      hooks: {},
    }),
  list: () => Effect.succeed([]),
  defaultAgent: () => Effect.succeed("build"),
})

const sessionLayer = Layer.mock(Session.Service, {
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: (input?: { directory?: string }) =>
    Effect.succeed({ id: "ses_child" as never, directory: input?.directory ?? process.cwd() } as never),
  list: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
})

function reply(text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: "ses_child" as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? ([{ type: "text", text }] as never) : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts, onPrompt?: (parts: unknown) => void): Layer.Layer<never> {
  return mockSessionPrompt({
    prompt: (input) =>
      Effect.sync(() => {
        onPrompt?.(input.parts)
        return result
      }),
  })
}

function makeSpawnInput(
  outputSchema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
    outputSchema,
    ...overrides,
  }
}

async function runSpawn(
  dagLayer: Layer.Layer<never>,
  promptLayer: Layer.Layer<never>,
  outputSchema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
) {
  const input = makeSpawnInput(outputSchema, overrides)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer, AgentScheduler.defaultLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(spawnSchedule(input, 1), input)
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

// Train A cast idiom: the extra `directory` field is cast away pre-feature so
// the probe compiles against the baseline NodeSpawnInput while offering the
// post-feature seam (info/exclude guarantee keyed on the execution directory).
const directoryOverride = (directory: string) => ({ directory }) as unknown as Partial<NodeSpawnInput>

describe("submit-time absolute-path capture (Train B, B-p1)", () => {
  it("B-p1(a) captures {content_ref, size, sha256} when the reply IS an existing non-empty absolute path", async () => {
    const dir = await tmpRoot("dag-ref-")
    const content = `${"report line\n".repeat(40)}SENTINEL`
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, content)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).not.toBe(reportPath)
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]).toEqual(
      expect.objectContaining({
        kind: "file_ref",
        storage: "managed-v1",
        source_path: FSUtil.normalizePath(reportPath),
        content_ref: completed!.output,
        path: completed!.output,
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        summary: `${content.slice(0, 200)}\u2026`,
      }),
    )
    await fs.writeFile(reportPath, "overwritten source")
    expect(await fs.readFile(String(completed!.output), "utf8")).toBe(content)
    await fs.rm(dir, { recursive: true, force: true })
    expect(await fs.readFile(String(completed!.output), "utf8")).toBe(content)
  })

  it("does not complete when the managed receipt cannot be persisted", async () => {
    const dir = await tmpRoot("dag-ref-persist-")
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, "receipt persistence regression")
    const { events, dagLayer } = makeEventTracker({ capturedFail: true })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", trigger: "exec_failed" }))
  })

  it("checks input artifacts again after waiting for a concurrency permit", async () => {
    const dir = await tmpRoot("dag-ref-queued-")
    const source = path.join(dir, "report.md")
    await fs.writeFile(source, `queued artifact ${dir}`)
    const ref = await Effect.runPromise(
      commitOutputFileRef(source, {
        workflow_id: "wf-1",
        node_id: "producer",
        child_session_id: "ses_producer",
        replan_attempt: 0,
      }),
    )
    if (!ref) throw new Error("missing input artifact")
    tmpRoots.push(path.dirname(ref.path))
    const { events, dagLayer } = makeEventTracker({ directory: dir })
    const input = makeSpawnInput(undefined, { directory: dir, inputArtifacts: [ref] })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* AgentScheduler.Service
          // Hold the only workflow slot so the spawn queues until the artifact
          // is removed, matching the old semaphore-held window.
          const held = yield* scheduler.childSlot({ kind: "workflow", workflowID: input.dagID }, 1)
          const spawned = yield* spawnNode(spawnSchedule(input, 1), input)
          yield* Effect.promise(() => fs.chmod(ref.path, 0o600))
          yield* Effect.promise(() => fs.unlink(ref.path))
          yield* held.release
          yield* Fiber.await(spawned.fiber)
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            dagLayer,
            agentLayer,
            sessionLayer,
            makePromptLayer(reply("must not execute")),
            AgentScheduler.defaultLayer,
          ),
        ),
      ) as Effect.Effect<void, Error>,
    )
    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "nodeFailed",
        reason: expect.stringContaining("Managed DAG artifact unavailable"),
      }),
    )
  })

  it("B-p1(a2) keeps the full text as summary when the file is at most 200 chars", async () => {
    const dir = await tmpRoot("dag-ref-")
    const content = "short report"
    const reportPath = path.join(dir, "short.md")
    await Bun.write(reportPath, content)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(
      expect.stringContaining("workflow-artifacts"),
    )
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]).toEqual(
      expect.objectContaining({ summary: "short report", size: Buffer.byteLength(content) }),
    )
  })

  it("B-p1(b) leaves output inline when the absolute path does not exist", async () => {
    const ghostPath = path.join(os.tmpdir(), `dag-ref-ghost-${Date.now()}.md`)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(ghostPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(ghostPath)
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(c) leaves output inline when the file exists but is empty", async () => {
    const dir = await tmpRoot("dag-ref-")
    const emptyPath = path.join(dir, "empty.md")
    await Bun.write(emptyPath, "")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(emptyPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(emptyPath)
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(d) leaves output inline when the reply mentions a path inside prose", async () => {
    const dir = await tmpRoot("dag-ref-")
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, "prose-embedded report")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(`Report written to ${reportPath}`)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(`Report written to ${reportPath}`)
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(e) leaves output inline for a plain-text reply (baseline behavior)", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed")))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe("Task completed")
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(f) leaves output inline when the reply is a directory path", async () => {
    const dir = await tmpRoot("dag-ref-")
    const subDir = path.join(dir, "subdir")
    await fs.mkdir(subDir)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(subDir)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(subDir)
    expect(capturedCalls).toHaveLength(0)
  })
})

describe("output_schema dual track (Train B, B-p2 pin)", () => {
  it("B-p2 keeps a captured payload containing an absolute path as inline JSON (no file_ref rewrite)", async () => {
    const dir = await tmpRoot("dag-ref-")
    const reportPath = path.join(dir, "schema-report.md")
    await Bun.write(reportPath, "schema node report")
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object" as const, required: ["report"] }
    const payload = { report: reportPath }
    const promptLayer = makePromptLayer(reply(JSON.stringify(payload)))
    await runSpawn(dagLayer, promptLayer, schema)
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual(payload)
  })
})

describe("report area under project-scoped XDG artifacts (B5)", () => {
  it("B5(a) places drafts, reports, patches and dag specs under the project's workflow-artifacts area", () => {
    const root = path.join(Global.Path.data, "workflow-artifacts", "proj-b5")
    expect(workflowArtifactsRoot("proj-b5")).toBe(root)
    expect(workflowDraftsArea("proj-b5")).toBe(path.join(root, "workflow-drafts"))
    expect(workflowReportsArea("proj-b5")).toBe(path.join(root, "workflow-reports"))
    expect(workflowDagSpecsArea("proj-b5")).toBe(path.join(root, ".dag-specs"))
    for (const area of [
      workflowDraftsArea("proj-b5"),
      workflowReportsArea("proj-b5"),
      workflowDagSpecsArea("proj-b5"),
    ]) {
      expect(path.isAbsolute(area)).toBe(true)
      expect(FSUtil.contains(root, area)).toBe(true)
    }
  })

  it("B5(b) omits the directive when the project scope is unknown", async () => {
    expect(await Effect.runPromise(reportAreaDirective(undefined))).toBeUndefined()
  })

  it("B5(c) names the project XDG report area as JSON data without touching the tree", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, "existing-code.ts"), "export const x = 1\n")
    const directive = await Effect.runPromise(reportAreaDirective("p"))
    expect(directive).toBeDefined()
    const json = directive!.split("\n").find((line) => line.startsWith('{"report_directory"'))
    expect(json).toBeDefined()
    const payload = JSON.parse(json!) as { report_directory: string }
    expect(payload.report_directory).toBe(`${workflowReportsArea("p")}${path.sep}`)
    expect(payload.report_directory.startsWith(Global.Path.data)).toBe(true)
    expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
    expect(await Bun.file(path.join(projectDir, ".agents")).exists()).toBe(false)
  })

  it("B5(d) serializes a hostile project identifier as JSON data", async () => {
    const projectID = 'proj" back\\slash\ttab\u001b[31m'
    const directive = await Effect.runPromise(reportAreaDirective(projectID))
    expect(directive).toBeDefined()
    expect(directive).not.toContain("\t")
    expect(directive).not.toContain("\u001b")
    const json = directive!.split("\n").find((line) => line.startsWith('{"report_directory"'))
    expect(json).toBeDefined()
    const payload = JSON.parse(json!) as { report_directory: string }
    expect(payload.report_directory).toBe(`${workflowReportsArea(projectID)}${path.sep}`)
    expect(path.isAbsolute(payload.report_directory)).toBe(true)
  })

  it("B5(e) accepts legacy in-repo report paths without writing ignore entries", async () => {
    const projectDir = await tmpRoot("dag-ref-legacy-")
    const reportPath = path.join(projectDir, ".agents", "workflow-reports", "old.md")
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await Bun.write(reportPath, "# legacy report\n")
    const { events, dagLayer } = makeEventTracker({ directory: projectDir })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(
      expect.stringContaining("workflow-artifacts"),
    )
    expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
  })
})

describe("output-ref module rules (Train B, post-feature units)", () => {
  it("shares immutable objects across captures and detects corruption without repairing over it", async () => {
    const dir = await tmpRoot("dag-managed-object-")
    const source = path.join(dir, "report.md")
    const content = `managed integrity ${dir}`
    await fs.writeFile(source, content)
    const provenance = {
      workflow_id: "wf-object",
      node_id: "report",
      child_session_id: "ses-object",
      replan_attempt: 0,
    }
    const first = await Effect.runPromise(commitOutputFileRef(source, provenance))
    const second = await Effect.runPromise(commitOutputFileRef(source, provenance))
    expect(first).toBeDefined()
    expect(second?.path).toBe(first!.path)
    tmpRoots.push(path.dirname(first!.path))
    await fs.chmod(first!.path, 0o600)
    await fs.writeFile(first!.path, "X".repeat(first!.size))
    const verificationError = await Effect.runPromise(verifyOutputFileRef(first).pipe(Effect.flip))
    expect(verificationError.message).toContain("digest mismatch")
    const commitError = await Effect.runPromise(commitOutputFileRef(source, provenance).pipe(Effect.flip))
    expect(commitError.message).toContain("DAG artifact commit failed")
    expect(await fs.readFile(first!.path, "utf8")).toBe("X".repeat(first!.size))
  })

  it("rejects a missing managed object and leaves legacy refs compatible", async () => {
    const dir = await tmpRoot("dag-managed-missing-")
    const source = path.join(dir, "report.md")
    await fs.writeFile(source, `missing artifact ${dir}`)
    const ref = await Effect.runPromise(
      commitOutputFileRef(source, {
        workflow_id: "wf-missing",
        node_id: "report",
        child_session_id: "ses-missing",
        replan_attempt: 0,
      }),
    )
    expect(ref).toBeDefined()
    tmpRoots.push(path.dirname(ref!.path))
    await fs.chmod(ref!.path, 0o600)
    await fs.unlink(ref!.path)
    const verificationError = await Effect.runPromise(verifyOutputFileRef(ref).pipe(Effect.flip))
    expect(verificationError.message).toContain("Managed DAG artifact unavailable")
    const legacy = await Effect.runPromise(captureOutputFileRef(source))
    await fs.unlink(source)
    await Effect.runPromise(verifyOutputFileRef(legacy))
  })

  it("rejects relative paths and paths containing whitespace even when the file exists", async () => {
    const dir = await tmpRoot("dag-ref-")
    const spacedPath = path.join(dir, "two words.md")
    await Bun.write(spacedPath, "spaced")
    expect(await Effect.runPromise(captureOutputFileRef(` ${spacedPath} `))).toBeUndefined()
    const relative = path.relative(process.cwd(), spacedPath)
    expect(await Effect.runPromise(captureOutputFileRef(relative))).toBeUndefined()
  })

  it("captures cross-worktree refs and normalizes trailing whitespace only", async () => {
    const dir = await tmpRoot("dag-ref-")
    const reportPath = path.join(dir, "cross.md")
    const content = "cross-worktree report"
    await Bun.write(reportPath, content)
    const ref = await Effect.runPromise(captureOutputFileRef(`\n${reportPath}\n`))
    expect(ref).toEqual(
      expect.objectContaining({
        kind: "file_ref",
        content_ref: reportPath,
        path: reportPath,
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        summary: content,
      }),
    )
  })
})
