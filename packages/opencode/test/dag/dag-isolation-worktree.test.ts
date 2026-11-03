// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Same harness
// idiom as dag-spawn-pause-fence.test.ts: typed mocks implement only the
// methods this spawn path calls.
import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { DagIsolation } from "@/dag/isolation"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

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
  worktree?: { directory: string; commit?: string; patchPath?: string; touchedPaths: readonly string[]; state: string; conflictsWith: readonly string[] }
  touchedPaths?: readonly string[]
}

interface Harness {
  layer: Layer.Layer<never>
  completed: Completion[]
  failed: { nodeID: string; worktree?: { state: string; directory: string } }[]
  removals: string[]
  directories: Map<string, string>
  worktrees: string[]
  fail: boolean
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

function makeHarness(target: string, mode: "success" | "failure" = "success"): Harness {
  const harness: Harness = {
    layer: Layer.empty as unknown as Layer.Layer<never>,
    completed: [],
    failed: [],
    removals: [],
    directories: new Map(),
    worktrees: [],
    fail: mode === "failure",
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
      harness.rejectNodeStarted
        ? Effect.fail(new TerminalViolationError("node-1", "failed", "started"))
        : Effect.void,
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
                  .map((completion) => ({ id: completion.nodeID, touchedPaths: completion.worktree?.touchedPaths ?? [] })),
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
      (_dagID: string, nodeID: string, _reason: string, _trigger: string, _attempt?: unknown, _errorClass?: unknown, worktree?: Completion["worktree"]) =>
        Effect.sync(() => {
          harness.failed.push({ nodeID, ...(worktree ? { worktree } : {}) })
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
        const id = `ses_child_${harness.directories.size + 1}`
        const directory = input?.directory ?? target
        harness.directories.set(id, directory)
        return { id, directory } as never
      }),
    list: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
  })
  const promptLayer = Layer.mock(SessionPrompt.Service, {
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
      Effect.sync(() => {
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
        if (current && path.resolve(current.directory) === path.resolve(input.directory))
          return yield* Effect.fail(new Worktree.RemoveFailedError({ message: "Cannot remove the primary or current worktree" }))
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
    worktreeLayer,
    instanceStoreLayer,
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
          const first = yield* spawnNode(Semaphore.makeUnsafe(2), a)
          const second = yield* spawnNode(Semaphore.makeUnsafe(2), b)
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
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* spawnNode(Semaphore.makeUnsafe(2), spawnInput(target, "a", "success", harness, false))
          const second = yield* spawnNode(Semaphore.makeUnsafe(2), spawnInput(target, "b", "success", harness, false))
          yield* Fiber.await(first.fiber)
          yield* Fiber.await(second.fiber)
        }),
      ).pipe(Effect.provide(harness.layer)) as Effect.Effect<never>,
    )

    expect(harness.completed).toHaveLength(2)
    for (const completion of harness.completed) {
      expect(completion.touchedPaths).toContain("shared.txt")
      expect(completion.worktree).toBeUndefined()
    }
    expect(harness.removals).toEqual([])
    expect(git(target, ["status", "--porcelain"])).toContain("?? shared.txt")
  })

  it("does not attribute pre-existing edits to a non-isolated writer", async () => {
    const target = repo()
    writeFileSync(path.join(target, "preexisting.txt"), "before\n")
    const harness = makeHarness(target)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), spawnInput(target, "a", "success", harness, false))
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
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), spawnInput(target, "a", "failure", harness))
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

  it("removes a worktree whose nodeStarted was rejected before any row referenced it", async () => {
    const target = repo()
    const harness = makeHarness(target)
    harness.rejectNodeStarted = true
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), spawnInput(target, "a", "success", harness))
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
})
