// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Same harness
// idiom as dag-spawn-pause-fence.test.ts: typed mocks implement only the
// methods this spawn path calls.
import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DateTime, Effect, Fiber, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { DagIsolation } from "@/dag/isolation"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { WorkflowTool } from "@/tool/workflow"
import { TerminalViolationError } from "@graphagent/core/dag/core/types"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

/** The per-workflow child-run schedule the loop hands to `spawnNode`. */
const spawnSchedule = <T extends { readonly dagID: string }>(input: T, cap: number) => ({
  limit: { kind: "workflow" as const, workflowID: input.dagID },
  cap,
})

const roots: string[] = []

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dag-isolation-spawn-"))
  roots.push(root)
  git(root, ["init"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(path.join(root, "base.txt"), "base\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "base"])
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Completion {
  nodeID: string
  worktree?: {
    directory: string
    commit?: string
    patchPath?: string
    touchedPaths: readonly string[]
    state: string
    conflictsWith: readonly string[]
  }
  touchedPaths?: readonly string[]
}

interface Harness {
  layer: Layer.Layer<never>
  completed: Completion[]
  failed: { nodeID: string; reason: string; worktree?: DagEvent.NodeWorktree }[]
  removals: string[]
  directories: Map<string, string>
  worktrees: string[]
  fail: boolean
  failSessionCreate: boolean
  failRemoval: boolean
  failCreate: boolean
  onFailure: (reason: string, worktree: DagEvent.NodeWorktree | undefined) => Effect.Effect<void>
  rejectNodeStarted: boolean
  prompt: (sessionID: string, directory: string) => void
}

function reply(sessionID: string): SessionV1.WithParts {
  return {
    info: {
      id: "msg_reply",
      role: "assistant",
      parentID: "msg_parent",
      sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test",
      time: { created: 0 },
      finish: "stop",
    },
    parts: [{ type: "text", text: "done" }],
  } as SessionV1.WithParts
}

function makeHarness(
  target: string,
  mode: "success" | "failure" = "success",
  options: { withWorktree?: boolean } = {},
): Harness {
  const harness: Harness = {
    layer: Layer.empty as unknown as Layer.Layer<never>,
    completed: [],
    failed: [],
    removals: [],
    directories: new Map(),
    worktrees: [],
    fail: mode === "failure",
    failSessionCreate: false,
    failRemoval: false,
    failCreate: false,
    onFailure: () => Effect.void,
    rejectNodeStarted: false,
    prompt: () => {},
  }
  const store: Partial<DagStore.Interface> = {
    getWorkflow: Effect.fn("s")(() => Effect.succeed(makeWorkflowRow({ directory: target }))),
    tryClaimAdoption: Effect.fn("s")(() => Effect.succeed(true)),
    getNode: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.succeed(makeNodeRow({ id: nodeID, status: "queued", replanAttempts: 0 })),
    ),
    getCurrentNodes: Effect.fn("s")(() =>
      Effect.succeed(
        harness.completed.map((completion) =>
          makeNodeRow({
            id: completion.nodeID,
            status: "completed",
            worktreeState: completion.worktree?.state ?? null,
            touchedPaths: completion.touchedPaths ? [...completion.touchedPaths] : null,
          }),
        ),
      ),
    ),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: store as DagStore.Interface,
    nodeQueued: Effect.fn("s")(() => Effect.void),
    nodeStarted: Effect.fn("s")((): Effect.Effect<void, TerminalViolationError> =>
      harness.rejectNodeStarted ? Effect.fail(new TerminalViolationError("node-1", "failed", "started")) : Effect.void,
    ),
    nodeCompleted: Effect.fn("s")(
      (
        _dagID: string,
        nodeID: string,
        _output: unknown,
        _attempt?: unknown,
        _captured?: unknown,
        worktree?: Completion["worktree"],
        touchedPaths?: readonly string[],
      ) =>
        Effect.sync(() => {
          const conflicts = worktree
            ? DagIsolation.conflictsFor(
                worktree.touchedPaths,
                harness.completed
                  .filter((completion) => completion.worktree)
                  .map((completion) => ({
                    id: completion.nodeID,
                    touchedPaths: completion.worktree?.touchedPaths ?? [],
                  })),
              )
            : []
          harness.completed.push({
            nodeID,
            ...(worktree
              ? { worktree: { ...worktree, conflictsWith: conflicts.map((conflict) => conflict.nodeID) } }
              : {}),
            ...(touchedPaths ? { touchedPaths } : {}),
          })
        }),
    ),
    nodeFailed: Effect.fn("s")(
      (
        _dagID: string,
        nodeID: string,
        reason: string,
        _trigger: string,
        _attempt?: unknown,
        _errorClass?: unknown,
        worktree?: DagEvent.NodeWorktree,
      ) =>
        Effect.gen(function* () {
          harness.failed.push({ nodeID, reason, ...(worktree ? { worktree } : {}) })
          yield* harness.onFailure(reason, worktree)
        }),
    ),
    failUnrecoverable: Effect.fn("s")(() => Effect.succeed("failed" as const)),
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
        model: { providerID: "test" as never, modelID: "test-model" as never },
        tools: {},
        hooks: {},
      }),
    list: () => Effect.succeed([]),
    defaultAgent: () => Effect.succeed("build"),
  })
  const sessionLayer = Layer.mock(Session.Service, {
    get: () =>
      Effect.succeed({
        id: "ses_parent" as never,
        permission: [],
        agent: "build",
        directory: target,
      } as never),
    create: (input?: { directory?: string }) =>
      Effect.sync(() => {
        if (harness.failSessionCreate) throw new Error("session create failed")
        const id = `ses_child_${harness.directories.size + 1}`
        const directory = input?.directory ?? target
        harness.directories.set(id, directory)
        return { id, directory } as never
      }),
    list: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
  })
  const promptLayer = mockSessionPrompt({
    prompt: (input: { sessionID: string }) =>
      Effect.sync(() => {
        if (harness.fail) throw new Error("prompt failed")
        harness.prompt(input.sessionID, harness.directories.get(input.sessionID) ?? target)
        return reply(input.sessionID)
      }),
    cancel: () => Effect.void,
  })
  const worktreeLayer = Layer.mock(Worktree.Service, {
    create: (input?: { name?: string }) =>
      Effect.gen(function* () {
        if (harness.failCreate)
          return yield* Effect.fail(new Worktree.CreateFailedError({ message: "worktree create exploded" }))
        const directory = mkdtempSync(path.join(tmpdir(), "dag-isolation-wt-"))
        roots.push(directory)
        rmSync(directory, { recursive: true, force: true })
        git(target, ["worktree", "add", "--detach", directory, "HEAD"])
        harness.worktrees.push(directory)
        const name = input?.name ?? "wt"
        return { name, branch: `opencode/${name}`, directory }
      }),
    remove: (input: { directory: string }) =>
      Effect.gen(function* () {
        // Mirror Worktree.removeLocked: the current instance must never be the
        // worktree being removed.
        const current = yield* InstanceRef
        if (harness.failRemoval)
          return yield* Effect.fail(new Worktree.RemoveFailedError({ message: "cleanup failed" }))
        if (current && path.resolve(current.directory) === path.resolve(input.directory))
          return yield* Effect.fail(
            new Worktree.RemoveFailedError({ message: "Cannot remove the primary or current worktree" }),
          )
        execFileSync("git", ["-C", target, "worktree", "remove", "--force", input.directory])
        harness.removals.push(input.directory)
        return true
      }),
    list: () => Effect.succeed([]),
  })
  const instanceStoreLayer = Layer.succeed(InstanceStore.Service, {
    provide: (input: { directory: string }, effect: Effect.Effect<unknown>) =>
      Effect.provideService(effect, InstanceRef, { directory: input.directory } as never),
  } as never)
  harness.layer = Layer.mergeAll(
    dagLayer,
    agentLayer,
    sessionLayer,
    promptLayer,
    ...(options.withWorktree === false ? [] : [worktreeLayer]),
    instanceStoreLayer,
    AgentScheduler.defaultLayer,
  ) as never
  return harness
}

function spawnInput(
  target: string,
  nodeID: string,
  mode: "success" | "failure",
  harness: Harness,
  isolated = true,
): NodeSpawnInput {
  harness.prompt = (sessionID, directory) => {
    if (mode === "failure") return
    writeFileSync(path.join(directory, "shared.txt"), `from ${nodeID}\n`)
  }
  return {
    dagID: "dag_1",
    nodeID,
    node: makeNodeRow({ id: nodeID, workerType: "build", replanAttempts: 0 }),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
    directory: target,
    executionDirectory: target,
    ...(isolated ? { isolation: "worktree" as const } : {}),
  }
}

describe("spawn worktree isolation", () => {
  it("commits and patches two parallel writers, reports the conflict and removes both worktrees", async () => {
    const target = repo()
    const harness = makeHarness(target)
    const a = spawnInput(target, "a", "success", harness)
    const b = spawnInput(target, "b", "success", harness)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* spawnNode(spawnSchedule(a, 2), a)
          const second = yield* spawnNode(spawnSchedule(b, 2), b)
          yield* Fiber.await(first.fiber)
          yield* Fiber.await(second.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toHaveLength(2)
    const commits = harness.completed.map((completion) => completion.worktree?.commit)
    expect(new Set(commits).size).toBe(2)
    for (const completion of harness.completed) {
      expect(completion.worktree?.touchedPaths).toEqual(["shared.txt"])
      expect(completion.worktree?.state).toBe("removed")
      expect(completion.worktree?.patchPath).toBeDefined()
      expect(readFileSync(completion.worktree?.patchPath ?? "", "utf8")).toContain("shared.txt")
    }
    const conflicted = harness.completed.filter((completion) => (completion.worktree?.conflictsWith.length ?? 0) > 0)
    expect(conflicted).toHaveLength(1)
    expect(conflicted[0]?.worktree?.conflictsWith).toHaveLength(1)
    expect(harness.removals).toHaveLength(2)
    for (const worktree of harness.worktrees) expect(existsSync(worktree)).toBe(false)
    expect(git(target, ["status", "--porcelain"])).toBe("")
    expect(existsSync(path.join(target, "shared.txt"))).toBe(false)
  })

  it("records touched paths for non-isolated writers", async () => {
    const target = repo()
    const harness = makeHarness(target)
    const first = spawnInput(target, "a", "success", harness, false)
    const second = spawnInput(target, "b", "success", harness, false)
    // Each concurrent writer owns a distinct path: attribution is per writer,
    // and two writers racing on the same file would depend on scheduling for
    // whether the second sees the first's write as pre-existing.
    const files = new Map([
      ["ses_child_1", "shared-a.txt"],
      ["ses_child_2", "shared-b.txt"],
    ])
    harness.prompt = (sessionID, directory) => {
      writeFileSync(path.join(directory, files.get(sessionID) ?? "shared.txt"), `from ${sessionID}\n`)
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstFiber = yield* spawnNode(spawnSchedule(first, 2), first)
          const secondFiber = yield* spawnNode(spawnSchedule(second, 2), second)
          yield* Fiber.await(firstFiber.fiber)
          yield* Fiber.await(secondFiber.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toHaveLength(2)
    for (const completion of harness.completed) {
      expect(completion.touchedPaths).toHaveLength(1)
      expect(completion.touchedPaths?.[0]).toMatch(/^shared-[ab]\.txt$/)
      expect(completion.worktree).toBeUndefined()
    }
    expect(new Set(harness.completed.flatMap((completion) => completion.touchedPaths ?? []))).toEqual(
      new Set(["shared-a.txt", "shared-b.txt"]),
    )
    expect(harness.removals).toEqual([])
    const status = git(target, ["status", "--porcelain"])
    expect(status).toContain("?? shared-a.txt")
    expect(status).toContain("?? shared-b.txt")
  })

  it("does not attribute pre-existing edits to a non-isolated writer", async () => {
    const target = repo()
    writeFileSync(path.join(target, "preexisting.txt"), "before\n")
    const harness = makeHarness(target)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "success", harness, false), 1),
            spawnInput(target, "a", "success", harness, false),
          )
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toHaveLength(1)
    expect(harness.completed[0]?.touchedPaths).toEqual(["shared.txt"])
  })

  it("keeps a failed node's worktree for inspection", async () => {
    const target = repo()
    const harness = makeHarness(target, "failure")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "failure", harness), 1),
            spawnInput(target, "a", "failure", harness),
          )
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toHaveLength(1)
    expect(harness.failed[0]?.worktree?.state).toBe("kept")
    expect(harness.removals).toEqual([])
    expect(existsSync(harness.failed[0]?.worktree?.directory ?? "")).toBe(true)
  })

  it("shows both attempts when replacement session creation and cleanup fail", async () => {
    const target = repo()
    const first = mkdtempSync(path.join(tmpdir(), "dag-isolation-first-"))
    roots.push(first)
    rmSync(first, { recursive: true, force: true })
    git(target, ["worktree", "add", "--detach", first, "HEAD"])
    const harness = makeHarness(target)
    harness.failSessionCreate = true
    harness.failRemoval = true
    const database = Database.layerFromPath(":memory:")
    const eventsLayer = EventV2.layer.pipe(Layer.provide(database))
    const storeLayer = DagStore.layer.pipe(Layer.provide(database))
    const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, eventsLayer)))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const events = yield* EventV2.Service
          const store = yield* DagStore.Service
          yield* db
            .insert(ProjectTable)
            .values({
              id: Project.ID.make("project-1"),
              worktree: AbsolutePath.make(target),
              sandboxes: [],
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionTable)
            .values({
              id: SessionSchema.ID.make("ses_parent"),
              project_id: Project.ID.make("project-1"),
              slug: "parent",
              directory: AbsolutePath.make(target),
              title: "Parent",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(WorkflowTable)
            .values({
              id: "dag_1",
              project_id: Project.ID.make("project-1"),
              session_id: SessionSchema.ID.make("ses_parent"),
              directory: target,
              target_fingerprint: { kind: "none" },
              title: "Isolation",
              status: "running",
              config: "{}",
              seq: 0,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(WorkflowNodeTable)
            .values({
              id: "a",
              workflow_id: "dag_1",
              name: "Node",
              worker_type: "build",
              status: "pending",
              required: true,
              depends_on: [],
              seq: 0,
            })
            .run()
            .pipe(Effect.orDie)
          const dagID = DagEvent.DagID.make("dag_1")
          const nodeID = DagEvent.NodeID.make("a")
          yield* events.publish(DagEvent.NodeStarted, {
            dagID,
            nodeID,
            childSessionID: SessionSchema.ID.make("ses_first"),
            timestamp: yield* DateTime.now,
            worktree: { directory: first, touchedPaths: [], state: "active", conflictsWith: [] },
          })
          yield* events.publish(DagEvent.NodeRestarted, {
            dagID,
            nodeID,
            childSessionID: SessionSchema.ID.make("ses_first"),
            timestamp: yield* DateTime.now,
          })
          harness.onFailure = (reason, worktree) =>
            Effect.gen(function* () {
              yield* events.publish(DagEvent.NodeFailed, {
                dagID,
                nodeID,
                reason,
                trigger: "exec_failed",
                worktree,
                timestamp: yield* DateTime.now,
              })
            })
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "success", harness), 1),
            spawnInput(target, "a", "success", harness),
          )
          yield* Fiber.await(result.fiber)
          const status = yield* Effect.gen(function* () {
            const info = yield* WorkflowTool
            const workflow = yield* info.init()
            return yield* workflow.execute(
              { params: { action: "inspect", operation: "status", workflow_id: Dag.ID.make("dag_1") } },
              {
                sessionID: SessionID.make("ses_parent"),
                messageID: MessageID.ascending(),
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(Dag.Service, { store }),
                Layer.mock(DagControl.Service, {}),
                Layer.mock(Provider.Service, {}),
                Layer.mock(Truncate.Service, { output: (content) => Effect.succeed({ content, truncated: false }) }),
              ),
            ),
          )
          const view = JSON.parse(status.output)
          expect(view.worktrees).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ directory: first, state: "active", retired: true }),
              expect.objectContaining({ directory: harness.worktrees[0], state: "kept" }),
            ]),
          )
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(harness.layer, database, eventsLayer, storeLayer, projector)),
      ) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toHaveLength(1)
    expect(harness.failed[0]?.reason).toContain("session create failed")
    expect(harness.failed[0]?.worktree).toEqual({
      directory: harness.worktrees[0],
      branch: "opencode/dag-dag_1-a",
      baseHead: git(target, ["rev-parse", "HEAD"]),
      touchedPaths: [],
      state: "kept",
      conflictsWith: [],
    })
    expect(existsSync(harness.worktrees[0])).toBe(true)
  })

  it("keeps a worktree when a successful commit hook leaves residual changes", async () => {
    const target = repo()
    const hook = path.join(target, ".git", "hooks", "pre-commit")
    git(target, ["config", "core.hooksPath", path.dirname(hook)])
    writeFileSync(hook, "#!/bin/sh\nprintf 'residual\\n' > hook.txt\nprintf 'hook change\\n' >> base.txt\n")
    chmodSync(hook, 0o755)
    const harness = makeHarness(target)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "success", harness), 1),
            spawnInput(target, "a", "success", harness),
          )
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toHaveLength(1)
    expect(harness.failed[0]?.reason).toContain("hook.txt")
    expect(harness.failed[0]?.reason).toContain("base.txt")
    expect(harness.failed[0]?.worktree?.state).toBe("kept")
    expect(harness.removals).toEqual([])
    const directory = harness.failed[0]?.worktree?.directory ?? ""
    expect(readFileSync(path.join(directory, "hook.txt"), "utf8")).toBe("residual\n")
    expect(readFileSync(path.join(directory, "base.txt"), "utf8")).toContain("hook change")
    expect(git(directory, ["show", "HEAD:shared.txt"])).toBe("from a")
  })

  it("keeps a worktree when Git hides an untracked post-commit residual", async () => {
    const target = repo()
    const hook = path.join(target, ".git", "hooks", "post-commit")
    git(target, ["config", "core.hooksPath", path.dirname(hook)])
    git(target, ["config", "extensions.worktreeConfig", "true"])
    writeFileSync(hook, "#!/bin/sh\nprintf 'residual\\n' > hook.txt\n")
    chmodSync(hook, 0o755)
    const harness = makeHarness(target)
    const input = spawnInput(target, "a", "success", harness)
    harness.prompt = (_sessionID, directory) => {
      git(directory, ["config", "--worktree", "status.showUntrackedFiles", "no"])
      writeFileSync(path.join(directory, "base.txt"), "committed\n")
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(spawnSchedule(input, 1), input)
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toHaveLength(1)
    expect(harness.failed[0]?.reason).toContain("hook.txt")
    expect(harness.failed[0]?.worktree?.state).toBe("kept")
    expect(harness.removals).toEqual([])
    const directory = harness.failed[0]?.worktree?.directory ?? ""
    expect(readFileSync(path.join(directory, "hook.txt"), "utf8")).toBe("residual\n")
    expect(git(directory, ["show", "HEAD:base.txt"])).toBe("committed")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
    expect(git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("?? hook.txt")
  })

  it("removes a worktree whose nodeStarted was rejected before any row referenced it", async () => {
    const target = repo()
    const harness = makeHarness(target)
    harness.rejectNodeStarted = true
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "success", harness), 1),
            spawnInput(target, "a", "success", harness),
          )
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    // The node was terminalized by another control op: no settlement event is
    // published, and the unrecorded worktree must not leak.
    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([])
    expect(harness.removals).toHaveLength(1)
    for (const worktree of harness.worktrees) expect(existsSync(worktree)).toBe(false)
  })

  it("fails the node when worktree isolation has no Worktree service", async () => {
    const target = repo()
    const harness = makeHarness(target, "success", { withWorktree: false })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "success", harness), 1),
            spawnInput(target, "a", "success", harness),
          )
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([
      expect.objectContaining({ reason: "worktree isolation requires the Worktree service" }),
    ])
    expect(harness.worktrees).toEqual([])
  })

  it("fails the node when worktree isolation has no execution directory", async () => {
    const target = repo()
    const harness = makeHarness(target)
    const base = spawnInput(target, "a", "success", harness)
    const input: NodeSpawnInput = {
      dagID: base.dagID,
      nodeID: base.nodeID,
      node: base.node,
      parentSessionID: base.parentSessionID,
      promptParts: base.promptParts,
      isolation: "worktree",
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(spawnSchedule(input, 1), input)
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([
      expect.objectContaining({ reason: "worktree isolation requires an execution directory" }),
    ])
    expect(harness.worktrees).toEqual([])
  })

  it("fails the node when worktree creation fails", async () => {
    const target = repo()
    const harness = makeHarness(target)
    harness.failCreate = true
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(
            spawnSchedule(spawnInput(target, "a", "success", harness), 1),
            spawnInput(target, "a", "success", harness),
          )
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([
      expect.objectContaining({ reason: "worktree create failed: worktree create exploded" }),
    ])
    expect(harness.worktrees).toEqual([])
  })
})
