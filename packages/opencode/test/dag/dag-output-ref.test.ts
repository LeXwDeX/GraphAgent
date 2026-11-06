// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- spawn-level
// probes deliberately mirror dag-structured-output.test.ts: mocked service
// layers and row fixtures use `as never` type shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * File-output settlement probes. New schemaless file submissions commit
 * immutable managed objects before success; legacy detection and inline JSON
 * remain compatible. Both live capture and crash recovery verify receipts.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { $ } from "bun"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { registerCaptureSlot, validatePayload } from "@/dag/runtime/capture"
import {
  captureOutputFileRef,
  commitOutputFileRef,
  verifyOutputFileRef,
  ensureReportAreaGitignore,
  reportAreaDirective,
  REPORT_AREA,
} from "@/dag/runtime/output-ref"
import { makeNodeRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

const tmpRoots: string[] = []
const STANDARD_TEMPLATE_EXCLUDE = "# task-owned standard template\n# preserved fixture comment\n"

function tmpRoot(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => {
    tmpRoots.push(dir)
    return dir
  })
}

async function gitTmpRoot(prefix: string, templateKind: "standard" | "empty" = "standard") {
  const dir = await tmpRoot(prefix)
  const templateDir = await tmpRoot(`${prefix}template-`)
  if (templateKind === "standard") {
    await fs.mkdir(path.join(templateDir, "info"), { recursive: true })
    await fs.writeFile(path.join(templateDir, "info", "exclude"), STANDARD_TEMPLATE_EXCLUDE)
  }
  await $`git init -q --template=${templateDir} ${dir}`.quiet()
  return dir
}

const excludePath = (root: string) => path.join(root, ".git", "info", "exclude")

async function isIgnored(root: string, candidate: string) {
  return (await $`git -C ${root} check-ignore -q -- ${candidate}`.quiet().nothrow()).exitCode === 0
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
      }))),
    setCapturedOutput: Effect.fn("s")((_childSessionID: string, payload: unknown) =>
      options.capturedFail ? Effect.die(new Error("receipt persistence failed")) : Effect.sync(() => {
        capturedCalls.push(payload)
        capturedStore.set("node-1", payload)
      })),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeStarted: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeCompleted: Effect.fn("s")((_dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID, output }))),
    nodeFailed: Effect.fn("s")((_dagID: string, nodeID: string, reason: string, trigger?: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID, reason, trigger }))),
    nodeSkipped: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID }))),
  })
  return { events, dagLayer }
}

const agentLayer = Layer.mock(Agent.Service, {
  get: () => Effect.succeed({
    name: "build", mode: "all", permission: [{ permission: "*", pattern: "*", action: "allow" }], options: {}, description: "", prompt: "",
    model: { providerID: "test" as never, modelID: "test-model" as never },
    tools: {}, hooks: {},
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
      id: MessageID.ascending(), role: "assistant", parentID: MessageID.ascending(),
      sessionID: "ses_child" as never, mode: "build", agent: "build", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never, providerID: "test" as never,
      time: { created: Date.now() }, finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts, onPrompt?: (parts: unknown) => void): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
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
    dagID: "wf-1", nodeID: "node-1", node: makeNodeRow(),
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
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput(outputSchema, overrides))
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

// Train A cast idiom: the extra `directory` field is cast away pre-feature so
// the probe compiles against the baseline NodeSpawnInput while offering the
// post-feature seam (info/exclude guarantee keyed on the execution directory).
const directoryOverride = (directory: string) =>
  ({ directory }) as unknown as Partial<NodeSpawnInput>

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
    expect(capturedCalls[0]).toEqual(expect.objectContaining({
      kind: "file_ref",
      storage: "managed-v1",
      source_path: FSUtil.normalizePath(reportPath),
      content_ref: completed!.output,
      path: completed!.output,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      summary: `${content.slice(0, 200)}\u2026`,
    }))
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
    const ref = await Effect.runPromise(commitOutputFileRef(source, {
      workflow_id: "wf-1", node_id: "producer", child_session_id: "ses_producer", replan_attempt: 0,
    }))
    if (!ref) throw new Error("missing input artifact")
    tmpRoots.push(path.dirname(ref.path))
    const { events, dagLayer } = makeEventTracker({ directory: dir })
    const semaphore = Semaphore.makeUnsafe(1)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* semaphore.take(1)
      const spawned = yield* spawnNode(semaphore, makeSpawnInput(undefined, { directory: dir, inputArtifacts: [ref] }))
      yield* Effect.promise(() => fs.chmod(ref.path, 0o600))
      yield* Effect.promise(() => fs.unlink(ref.path))
      yield* semaphore.release(1)
      yield* Fiber.await(spawned.fiber)
    })).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, makePromptLayer(reply("must not execute")))) ) as Effect.Effect<void, Error>)
    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", reason: expect.stringContaining("Managed DAG artifact unavailable") }))
  })

  it("B-p1(a2) keeps the full text as summary when the file is at most 200 chars", async () => {
    const dir = await tmpRoot("dag-ref-")
    const content = "short report"
    const reportPath = path.join(dir, "short.md")
    await Bun.write(reportPath, content)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(expect.stringContaining("workflow-artifacts"))
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]).toEqual(expect.objectContaining({ summary: "short report", size: Buffer.byteLength(content) }))
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
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () => Effect.gen(function* () {
        registerCaptureSlot("ses_child", schema)
        const result = validatePayload("ses_child", payload)
        if (result.ok) capturedStore.set("node-1", payload)
        return reply("ignored text")
      }),
    })
    await runSpawn(dagLayer, promptLayer, schema)
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual(payload)
  })
})

describe("report-area exclude entry (Train B, B-p4)", () => {
  it("B-p4(a) writes the report-area entry to info/exclude instead of the project .gitignore", async () => {
    const projectDir = await gitTmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, "existing-code.ts"), "export const x = 1\n")
    const reportArea = path.join(projectDir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "run-1.md")
    await Bun.write(reportPath, "# report\n")
    const { events, dagLayer } = makeEventTracker({ directory: projectDir })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(expect.stringContaining("workflow-artifacts"))
    expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
    const exclude = await Bun.file(excludePath(projectDir)).text()
    expect(exclude.split("\n").map((line) => line.trim())).toContain(".opencode/workflow-reports/")
    expect(await isIgnored(projectDir, reportPath)).toBe(true)
    expect(await $`git -C ${projectDir} status --porcelain`.quiet().text()).not.toContain("workflow-reports")
  })

  it("B-p4(b) is append-only and idempotent: pre-existing entries survive, the report entry lands exactly once", async () => {
    const projectDir = await gitTmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, ".gitignore"), "node_modules\n*.log\n")
    const reportArea = path.join(projectDir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "run-2.md")
    await Bun.write(reportPath, "# report 2\n")
    const { events, dagLayer } = makeEventTracker({ directory: projectDir })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")).toBeDefined()
    const { events: secondEvents, dagLayer: secondDagLayer } = makeEventTracker({ directory: projectDir })
    await runSpawn(secondDagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(secondEvents.find((event) => event.type === "nodeCompleted")).toBeDefined()
    const exclude = await Bun.file(excludePath(projectDir)).text()
    const lines = exclude.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
    expect(lines.filter((line) => line === ".opencode/workflow-reports/")).toHaveLength(1)
    expect(await Bun.file(path.join(projectDir, ".gitignore")).text()).toBe("node_modules\n*.log\n")
  })

  it("B-p4(c) does not touch the tree for refs outside the report area", async () => {
    const projectDir = await gitTmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, ".gitignore"), "node_modules\n")
    const exclude = excludePath(projectDir)
    const beforeExcludeExists = await Bun.file(exclude).exists()
    const beforeExclude = beforeExcludeExists ? await fs.readFile(exclude) : undefined
    expect(beforeExclude?.toString()).toBe(STANDARD_TEMPLATE_EXCLUDE)
    const outsideDir = await tmpRoot("dag-ref-outside-")
    const reportPath = path.join(outsideDir, "elsewhere.md")
    await Bun.write(reportPath, "# elsewhere\n")
    const { events, dagLayer } = makeEventTracker({ directory: projectDir })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(expect.stringContaining("workflow-artifacts"))
    expect(await Bun.file(path.join(projectDir, ".gitignore")).text()).toBe("node_modules\n")
    expect(await Bun.file(exclude).exists()).toBe(beforeExcludeExists)
    if (beforeExclude !== undefined) expect(await fs.readFile(exclude)).toEqual(beforeExclude)
  })

  it("B-p4(d) ignores a subdirectory session's report through the repository-root area", async () => {
    const projectDir = await gitTmpRoot("dag-ref-repo-")
    const subdir = path.join(projectDir, "packages", "pkg-a")
    await fs.mkdir(subdir, { recursive: true })
    const reportArea = path.join(projectDir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "run.md")
    await Bun.write(reportPath, "# canonical root report\n")
    const { events, dagLayer } = makeEventTracker({ directory: subdir })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(subdir))
    expect(events.find((event) => event.type === "nodeCompleted")).toBeDefined()
    expect(await Bun.file(path.join(subdir, ".gitignore")).exists()).toBe(false)
    const exclude = await Bun.file(excludePath(projectDir)).text()
    expect(exclude).toContain(".opencode/workflow-reports/")
    expect(exclude).not.toContain("packages/pkg-a/")
    expect(await isIgnored(projectDir, reportPath)).toBe(true)
    expect(await $`git -C ${projectDir} status --porcelain`.quiet().text()).not.toContain("workflow-reports")
  })

  it("B-p4(d2) keeps legacy subdirectory report refs ignored with a repository-relative entry", async () => {
    const projectDir = await gitTmpRoot("dag-ref-legacy-")
    const subdir = path.join(projectDir, "packages", "pkg-a")
    const reportArea = path.join(subdir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "old.md")
    await Bun.write(reportPath, "# legacy report\n")
    await Effect.runPromise(ensureReportAreaGitignore(subdir, reportPath))
    expect(await Bun.file(excludePath(projectDir)).text()).toContain("packages/pkg-a/.opencode/workflow-reports/")
    expect(await isIgnored(projectDir, reportPath)).toBe(true)
    expect(await Bun.file(path.join(subdir, ".gitignore")).exists()).toBe(false)
  })

  it("B-p4(d3) escapes glob characters in a repository-relative legacy prefix", async () => {
    const projectDir = await gitTmpRoot("dag-ref-adversarial-")
    const name =
      process.platform === "win32" ? "#hash !bang [bracket]" : "#hash !bang *star ?question [bracket] \\slash "
    const subdir = path.join(projectDir, "packages", name)
    const reportArea = path.join(subdir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "report.md")
    await Bun.write(reportPath, "# adversarial report\n")
    const decoyName = process.platform === "win32" ? "#hash !bang b" : "#hash !bang xstar xquestion b slash "
    const decoyArea = path.join(projectDir, "packages", decoyName, ".opencode", "workflow-reports")
    await fs.mkdir(decoyArea, { recursive: true })
    const decoy = path.join(decoyArea, "decoy.md")
    await Bun.write(decoy, "# unrelated\n")
    await fs.mkdir(path.dirname(excludePath(projectDir)), { recursive: true })
    await Bun.write(excludePath(projectDir), `packages/${name}/.opencode/workflow-reports/\n`)
    expect(await isIgnored(projectDir, decoy)).toBe(true)
    await Bun.write(excludePath(projectDir), "")
    await Effect.runPromise(ensureReportAreaGitignore(subdir, reportPath))
    const exclude = await Bun.file(excludePath(projectDir)).text()
    expect(exclude).toContain("\\[bracket]")
    if (process.platform !== "win32") {
      expect(exclude).toContain("\\*star")
      expect(exclude).toContain("\\?question")
      expect(exclude).toContain("\\\\slash")
    }
    expect(await isIgnored(projectDir, reportPath)).toBe(true)
    expect(await isIgnored(projectDir, decoy)).toBe(false)
  })

  it("B-p4(d6) escapes leading # and ! in a repository-relative prefix", async () => {
    for (const name of ["#hash", "!bang"]) {
      const projectDir = await gitTmpRoot("dag-ref-leading-")
      const subdir = path.join(projectDir, name)
      await fs.mkdir(path.join(subdir, ".opencode", "workflow-reports"), { recursive: true })
      const report = path.join(subdir, ".opencode", "workflow-reports", "report.md")
      await Bun.write(report, "# leading marker\n")
      await Effect.runPromise(ensureReportAreaGitignore(subdir, report))
      expect(await Bun.file(excludePath(projectDir)).text()).toContain(`\\${name}/.opencode/workflow-reports/`)
      expect(await isIgnored(projectDir, report)).toBe(true)
    }
  })

  it("B-p4(f) directs a subdirectory node to the repository-root report area", async () => {
    const projectDir = await gitTmpRoot("dag-ref-directive-")
    const root = await fs.realpath(projectDir)
    const subdir = path.join(projectDir, "packages", "app")
    await fs.mkdir(subdir, { recursive: true })
    const reportArea = path.join(projectDir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "report.md")
    await Bun.write(reportPath, "# root report\n")
    const texts: string[] = []
    const { events, dagLayer } = makeEventTracker({ directory: subdir })
    await runSpawn(
      dagLayer,
      makePromptLayer(reply(reportPath), (input) => {
        for (const part of input as { type?: string; text?: string }[]) {
          if (part.type === "text" && part.text) texts.push(part.text)
        }
      }),
      undefined,
      directoryOverride(subdir),
    )
    expect(events.find((event) => event.type === "nodeCompleted")).toBeDefined()
    const prompt = texts.join("\n")
    const directive = texts.find((text) => text.includes("[REPORT AREA]"))
    expect(directive).toBeDefined()
    const json = directive!.split("\n").find((line) => line.startsWith('{"report_directory"'))
    expect(json).toBeDefined()
    const payload = JSON.parse(json!) as { report_directory: string }
    expect(payload.report_directory).toBe(`${path.join(root, ".opencode", "workflow-reports")}${path.sep}`)
    expect(prompt).not.toContain(path.join(subdir, ".opencode", "workflow-reports"))
    expect(await Bun.file(path.join(subdir, ".gitignore")).exists()).toBe(false)
    expect(await Bun.file(excludePath(projectDir)).text()).toContain(".opencode/workflow-reports/")
    expect(await isIgnored(projectDir, reportPath)).toBe(true)
  })

  it("B-p4(g) serializes hostile repository names as JSON data", async () => {
    const parent = await tmpRoot("dag-ref-hostile-")
    // Windows rejects `"`, `\`, and control characters in file names, so its
    // hostile name uses shell-special characters that are legal on NTFS.
    const name = process.platform === "win32" ? "quote' back space & semi; paren()" : 'quote" back\\slash\ttab\u001b[31m'
    const projectDir = path.join(parent, name)
    await fs.mkdir(projectDir)
    await $`git init -q ${projectDir}`.quiet()
    const subdir = path.join(projectDir, "sub")
    await fs.mkdir(subdir)
    const directive = await Effect.runPromise(reportAreaDirective(subdir))
    expect(directive).toBeDefined()
    if (process.platform !== "win32") {
      expect(directive).not.toContain("\u001b")
      expect(directive).not.toContain("\t")
    }
    const json = directive!.split("\n").find((line) => line.startsWith('{"report_directory"'))
    expect(json).toBeDefined()
    const payload = JSON.parse(json!) as { report_directory: string }
    const root = path.join(await fs.realpath(parent), name)
    const expected = `${path.join(root, ".opencode", "workflow-reports")}${path.sep}`
    // On win32 the path separators must survive JSON escaping; elsewhere the
    // name also carries a quote, a backslash, a tab, and an ESC byte.
    expect(payload.report_directory).toBe(expected)
  })

  it("B-p4(h) skips the directive when a repository path breaks git's line protocol", async () => {
    if (process.platform === "win32") return
    const parent = await tmpRoot("dag-ref-newline-")
    const projectDir = path.join(parent, "line\nbreak")
    await fs.mkdir(projectDir)
    await $`git init -q ${projectDir}`.quiet()
    expect(await Effect.runPromise(reportAreaDirective(projectDir))).toBeUndefined()
  })

  it("B-p4(i) propagates interruption instead of swallowing it", async () => {
    const dir = await tmpRoot("dag-ref-interrupt-")
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const fiber = yield* reportAreaDirective(dir, () => new Promise<never>(() => {})).pipe(
            Effect.forkIn(scope),
          )
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("B-p4(d4) rejects dot segments that only look like the report area", async () => {
    const projectDir = await gitTmpRoot("dag-ref-dotdot-")
    const secret = path.join(projectDir, ".opencode", "secret.md")
    await fs.mkdir(path.dirname(secret), { recursive: true })
    await Bun.write(secret, "# not a report\n")
    const disguised = `${path.join(projectDir, REPORT_AREA)}${path.sep}..${path.sep}secret.md`
    const exclude = excludePath(projectDir)
    const beforeExcludeExists = await Bun.file(exclude).exists()
    const beforeExclude = beforeExcludeExists ? await fs.readFile(exclude) : undefined
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, disguised))
    expect(await Bun.file(exclude).exists()).toBe(beforeExcludeExists)
    if (beforeExclude !== undefined) expect(await fs.readFile(exclude)).toEqual(beforeExclude)
  })

  it("B-p4(d5) canonicalizes dot segments that remain inside the report area", async () => {
    const projectDir = await gitTmpRoot("dag-ref-dot-")
    const reportPath = `${path.join(projectDir, REPORT_AREA)}${path.sep}..${path.sep}workflow-reports${path.sep}report.md`
    await fs.mkdir(path.join(projectDir, REPORT_AREA), { recursive: true })
    await Bun.write(reportPath, "# report\n")
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, reportPath))
    expect(await Bun.file(excludePath(projectDir)).text()).toContain(".opencode/workflow-reports/")
    expect(await isIgnored(projectDir, path.resolve(reportPath))).toBe(true)
  })

  it("B-p4(e) ignores linked-worktree reports through the shared common-dir exclude", async () => {
    const projectDir = await gitTmpRoot("dag-ref-main-")
    await $`git -C ${projectDir} -c user.name=Test -c user.email=test@opencode.test commit --allow-empty -m root`.quiet()
    const worktree = await tmpRoot("dag-ref-wt-")
    await fs.rm(worktree, { recursive: true, force: true })
    await $`git -C ${projectDir} worktree add --detach ${worktree}`.quiet()
    const reportArea = path.join(worktree, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "run.md")
    await Bun.write(reportPath, "# worktree report\n")
    const { events, dagLayer } = makeEventTracker({ directory: worktree })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(worktree))
    expect(events.find((event) => event.type === "nodeCompleted")).toBeDefined()
    expect(await Bun.file(path.join(worktree, ".gitignore")).exists()).toBe(false)
    expect(await Bun.file(excludePath(projectDir)).text()).toContain(".opencode/workflow-reports/")
    expect(await isIgnored(worktree, reportPath)).toBe(true)
    expect(await $`git -C ${worktree} status --porcelain`.quiet().text()).not.toContain("workflow-reports")
  })
})

describe("output-ref module rules (Train B, post-feature units)", () => {
  it("shares immutable objects across captures and detects corruption without repairing over it", async () => {
    const dir = await tmpRoot("dag-managed-object-")
    const source = path.join(dir, "report.md")
    const content = `managed integrity ${dir}`
    await fs.writeFile(source, content)
    const provenance = { workflow_id: "wf-object", node_id: "report", child_session_id: "ses-object", replan_attempt: 0 }
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
    const ref = await Effect.runPromise(commitOutputFileRef(source, {
      workflow_id: "wf-missing", node_id: "report", child_session_id: "ses-missing", replan_attempt: 0,
    }))
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
    expect(ref).toEqual(expect.objectContaining({
      kind: "file_ref",
      content_ref: reportPath,
      path: reportPath,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      summary: content,
    }))
  })

  it("creates a missing info/exclude with only the report-area entry", async () => {
    for (const templateKind of ["standard", "empty"] as const) {
      const projectDir = await gitTmpRoot(`dag-ref-proj-${templateKind}-`, templateKind)
      if (templateKind === "standard") {
        // Remove only this fixture's copied template file so the missing-file case is explicit.
        await fs.rm(excludePath(projectDir))
      }
      const refPath = path.join(projectDir, REPORT_AREA, "x.md")
      await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
      expect(await fs.readFile(excludePath(projectDir), "utf8")).toBe(".opencode/workflow-reports/\n")
      expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
    }
  })

  it("separates the entry onto its own line when the existing exclude lacks a trailing newline", async () => {
    const projectDir = await gitTmpRoot("dag-ref-proj-")
    await fs.mkdir(path.join(projectDir, ".git", "info"), { recursive: true })
    await Bun.write(excludePath(projectDir), "node_modules")
    const refPath = path.join(projectDir, REPORT_AREA, "x.md")
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
    expect(await fs.readFile(excludePath(projectDir), "utf8")).toBe("node_modules\n.opencode/workflow-reports/\n")
  })

  it("leaves the exclude file byte-identical when an entry or a slashless variant already exists", async () => {
    for (const covering of [".opencode/workflow-reports/", ".opencode/workflow-reports"]) {
      const projectDir = await gitTmpRoot("dag-ref-proj-")
      await fs.mkdir(path.join(projectDir, ".git", "info"), { recursive: true })
      const before = `${covering}\nkeep-me\n`
      await Bun.write(excludePath(projectDir), before)
      const refPath = path.join(projectDir, REPORT_AREA, "x.md")
      await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
      expect(await fs.readFile(excludePath(projectDir), "utf8")).toBe(before)
    }
  })

  it("does not create any ignore file for refs outside the report area", async () => {
    for (const templateKind of ["standard", "empty"] as const) {
      const projectDir = await gitTmpRoot(`dag-ref-proj-${templateKind}-`, templateKind)
      const exclude = excludePath(projectDir)
      const beforeExcludeExists = await Bun.file(exclude).exists()
      const beforeExclude = beforeExcludeExists ? await fs.readFile(exclude) : undefined
      const outsideDir = await tmpRoot("dag-ref-outside-")
      const refPath = path.join(outsideDir, "y.md")
      await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
      expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
      expect(await Bun.file(exclude).exists()).toBe(beforeExcludeExists)
      if (beforeExclude !== undefined) expect(await fs.readFile(exclude)).toEqual(beforeExclude)
      if (templateKind === "standard") expect(beforeExclude?.toString()).toBe(STANDARD_TEMPLATE_EXCLUDE)
    }
  })

  it("skips ignore writes outside a git repository", async () => {
    const projectDir = await tmpRoot("dag-ref-nongit-")
    const refPath = path.join(projectDir, REPORT_AREA, "x.md")
    await fs.mkdir(path.dirname(refPath), { recursive: true })
    await Bun.write(refPath, "# report\n")
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
    expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
  })

  it("serializes concurrent captures into one exclude entry", async () => {
    const projectDir = await gitTmpRoot("dag-ref-concurrent-")
    const refs = ["a.md", "b.md"].map((name) => path.join(projectDir, REPORT_AREA, name))
    for (const ref of refs) {
      await fs.mkdir(path.dirname(ref), { recursive: true })
      await Bun.write(ref, `# ${path.basename(ref)}\n`)
    }
    await Effect.runPromise(
      Effect.all(refs.map((ref) => ensureReportAreaGitignore(projectDir, ref)), { concurrency: "unbounded" }),
    )
    const exclude = await Bun.file(excludePath(projectDir)).text()
    expect(exclude.split("\n").filter((line) => line === ".opencode/workflow-reports/")).toHaveLength(1)
  })
})
