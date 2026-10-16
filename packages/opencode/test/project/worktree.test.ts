import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppProcess } from "@opencode-ai/core/process"
import { NodePath } from "@effect/platform-node"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { SettingsHook } from "../../src/hook/settings"
import { InstanceLayer } from "../../src/project/instance-layer"
import { InstanceState } from "../../src/effect/instance-state"
import { MemoryHome } from "../../src/memory/home"
import { MemoryStore } from "../../src/memory/store"
import { Project } from "../../src/project/project"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Worktree.defaultLayer,
    Project.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
    MemoryStore.defaultLayer,
  ),
)
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip

class RemoveHookProbe extends Context.Service<
  RemoveHookProbe,
  {
    readonly entered: Effect.Effect<void>
    readonly overlap: Effect.Effect<void>
    readonly release: Effect.Effect<boolean>
    readonly run: Effect.Effect<void>
  }
>()("@test/WorktreeRemoveHookProbe") {}

const removeHookProbeLayer = Layer.effect(
  RemoveHookProbe,
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const overlap = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const state = yield* Ref.make({ active: 0, calls: 0 })
    return RemoveHookProbe.of({
      entered: Deferred.await(entered),
      overlap: Deferred.await(overlap),
      release: Deferred.succeed(release, undefined),
      run: Effect.acquireUseRelease(
        Ref.modify(state, (current) => {
          const next = { active: current.active + 1, calls: current.calls + 1 }
          return [next, next]
        }),
        (current) =>
          Effect.gen(function* () {
            if (current.active > 1) yield* Deferred.succeed(overlap, undefined)
            if (current.calls !== 1) return
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        () => Ref.update(state, (current) => ({ ...current, active: current.active - 1 })),
      ),
    })
  }),
)

const hookResult = { additionalContexts: [], systemMessages: [] }
const worktreeRemoveHookLayer = Layer.effect(
  SettingsHook.Service,
  Effect.gen(function* () {
    const probe = yield* RemoveHookProbe
    const fs = yield* FSUtil.Service
    return SettingsHook.Service.of({
      trigger: (payload) =>
        Effect.gen(function* () {
          if (payload.event === "WorktreeCreate") {
            yield* fs.makeDirectory(payload.path!, { recursive: true })
            return { ...hookResult, worktreePath: payload.path }
          }
          if (payload.event === "WorktreeRemove") {
            yield* probe.run
            yield* fs.remove(payload.path!, { recursive: true })
          }
          return hookResult
        }).pipe(Effect.orDie),
      list: () =>
        Effect.succeed([
          { event: "WorktreeCreate", scope: "project", type: "command", descriptor: "fixture create" },
          { event: "WorktreeRemove", scope: "project", type: "command", descriptor: "fixture remove" },
        ]),
    })
  }),
).pipe(Layer.provideMerge(removeHookProbeLayer), Layer.provide(FSUtil.defaultLayer))

const concurrentIt = testEffect(
  Layer.mergeAll(
    Worktree.defaultLayer.pipe(Layer.provideMerge(worktreeRemoveHookLayer)),
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
  ),
)

class CreateHookProbe extends Context.Service<
  CreateHookProbe,
  {
    readonly entered: Effect.Effect<void>
    readonly release: Effect.Effect<boolean>
    readonly run: Effect.Effect<void>
  }
>()("@test/WorktreeCreateHookProbe") {}

const createHookProbeLayer = Layer.effect(
  CreateHookProbe,
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    return CreateHookProbe.of({
      entered: Deferred.await(entered),
      release: Deferred.succeed(release, undefined),
      run: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    })
  }),
)

const projectCreateHookLayer = Layer.effect(
  Project.Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const probe = yield* CreateHookProbe
    return Project.Service.of({
      ...project,
      addSandbox: (id, directory) => probe.run.pipe(Effect.andThen(project.addSandbox(id, directory))),
    })
  }),
).pipe(Layer.provideMerge(Project.defaultLayer), Layer.provideMerge(createHookProbeLayer))

const createIt = testEffect(
  Worktree.layer.pipe(
    Layer.provide(Git.defaultLayer),
    Layer.provide(AppProcess.defaultLayer),
    Layer.provideMerge(projectCreateHookLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(NodePath.layer),
    Layer.provide(InstanceLayer.layer),
  ),
)

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }

  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

function makeStartCommandProbe(directory: string, name: string) {
  const pidFile = path.join(directory, `${name}.pid`)
  return {
    command: `printf '%s:ready\n' "$$" > ${JSON.stringify(pidFile)}; trap 'exit 0' TERM INT; while :; do sleep 1; done`,
    started: pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(pidFile)
        if (!(await file.exists())) return undefined
        const match = (await file.text()).match(/^([1-9]\d*):ready\n?$/)
        return match ? Number(match[1]) : undefined
      }),
      `timed out waiting for ${name}`,
    ),
    stopped: (pid: number) =>
      pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
            throw error
          }
        }),
        `${name} was left running`,
        "2 seconds",
      ),
  }
}

const removeCreatedWorktree = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    if (yield* fs.exists(directory).pipe(Effect.orDie)) {
      const svc = yield* Worktree.Service
      const ok = yield* svc.remove({ directory })
      if (!ok) yield* Effect.fail(new Error(`failed to remove worktree ${directory}`))
    }
  })

const withCreatedWorktree = <A, E, R>(
  input: Parameters<Worktree.Interface["create"]>[0],
  use: (created: { info: Worktree.Info; ready: { name: string; branch?: string } }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      const ready = yield* waitReady().pipe(Effect.forkScoped)
      const info = yield* svc.create(input)
      const props = yield* Fiber.join(ready)
      return { info, ready: props }
    }),
    use,
    ({ info }) => removeCreatedWorktree(info.directory),
  )

const git = Effect.fn("WorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const gitResult = Effect.fn("WorktreeTest.gitResult")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  return yield* service.run(args, { cwd })
})

describe("Worktree", () => {
  afterEach(() => disposeAllInstances())

  describe("makeWorktreeInfo", () => {
    it.instance(
      "returns info with name, branch, and directory",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo()

          expect(info.name).toBeDefined()
          expect(typeof info.name).toBe("string")
          expect(info.branch).toBe(`opencode/${info.name}`)
          expect(info.directory).toContain(info.name)
        }),
      { git: true },
    )

    it.instance(
      "uses provided name as base",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "my-feature" })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBe("opencode/my-feature")
        }),
      { git: true },
    )

    it.instance(
      "slugifies the provided name",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" })

          expect(info.name).toBe("my-feature-branch")
        }),
      { git: true },
    )

    it.instance(
      "omits branch for detached info",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          yield* git(test.directory, ["branch", "opencode/my-feature"])

          const info = yield* svc.makeWorktreeInfo({ name: "my-feature", detached: true })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBeUndefined()
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.makeWorktreeInfo())

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )

    wintest(
      "creates detached git worktree when info has no branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "detached-test", detached: true })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = normalize(list)
          const normalizedDir = normalize(info.directory)
          expect(normalizedList).toContain(normalizedDir)

          const branch = yield* gitResult(info.directory, ["symbolic-ref", "-q", "--short", "HEAD"])
          expect(branch.exitCode).not.toBe(0)

          const props = yield* Fiber.join(ready)
          expect(props.name).toBe(info.name)
          expect(props.branch).toBeUndefined()

          yield* svc.remove({ directory: info.directory })
        }),
      { git: true },
    )
  })

  describe("create + remove lifecycle", () => {
    it.instance(
      "create returns worktree info and remove cleans up",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("opencode/")
            expect(info.directory).toBeDefined()
          }),
        ),
      { git: true },
    )

    it.instance(
      "refuses to remove a worktree while project memory would be destroyed",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const svc = yield* Worktree.Service
            const ctx = yield* InstanceState.context
            const project = yield* Project.Service
            yield* project.setInitialized(ctx.project.id)
            const memory = path.join(info.directory, ".opencode", "memory", "topics", "project.yaml")
            yield* fs.makeDirectory(path.dirname(memory), { recursive: true })
            yield* fs.writeFileString(memory, "id: project\n")

            const exit = yield* svc.remove({ directory: info.directory }).pipe(Effect.exit)
            const preserved = yield* fs.exists(memory).pipe(Effect.orDie)

            // Let the fixture's release remove the worktree after the assertion
            // signal has been captured.
            yield* fs.remove(path.join(info.directory, ".opencode"), { recursive: true }).pipe(Effect.ignore)

            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("topic.invalid")
            expect(preserved).toBe(true)
          }),
        ),
      { git: true },
    )

    it.instance(
      "migrates valid legacy memory before removing a worktree",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const fs = yield* FSUtil.Service
            const project = yield* Project.Service
            const store = yield* MemoryStore.Service
            const svc = yield* Worktree.Service
            yield* project.setInitialized(ctx.project.id)
            const home = MemoryHome.make(Global.Path.data)
            const projectHome = home.directory(ctx.project.id)
            const legacy = path.join(info.directory, ".opencode", "memory", "topics", "project-architecture.yaml")
            yield* Effect.addFinalizer(() => fs.remove(projectHome, { recursive: true }).pipe(Effect.ignore))
            yield* fs.makeDirectory(path.dirname(legacy), { recursive: true })
            yield* fs.writeFileString(legacy, Bun.YAML.stringify(memoryTopic()))

            expect(yield* svc.remove({ directory: info.directory })).toBe(true)
            expect(yield* fs.exists(info.directory).pipe(Effect.orDie)).toBe(false)
            expect((yield* store.readTopics(ctx.project.id))[0]?.id).toBe("project-architecture")
            expect((yield* project.get(ctx.project.id))?.sandboxes).not.toContain(info.directory)
          }),
        ),
      { git: true },
    )

    it.instance(
      "create returns after setup and fires Event.Ready after bootstrap",
      () =>
        withCreatedWorktree(undefined, ({ info, ready }) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service

            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("opencode/")

            expect(ready.name).toBe(info.name)
            expect(ready.branch).toBe(info.branch)

            const list = yield* svc.list()
            expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))
          }),
        ),
      { git: true },
    )

    wintest(
      "remove interrupts an in-flight start command",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const probe = makeStartCommandProbe(test.directory, "worktree-remove-start-command")

          yield* withCreatedWorktree({ name: "remove-during-start", startCommand: probe.command }, ({ info }) =>
            Effect.gen(function* () {
              const svc = yield* Worktree.Service
              const pid = yield* probe.started

              expect(yield* svc.remove({ directory: info.directory })).toBe(true)
              yield* probe.stopped(pid)
            }),
          )
        }),
      { git: true },
      { timeout: 20_000 },
    )

    it.instance(
      "lists the active linked worktree but not the project checkout",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const list = yield* svc.list().pipe(provideInstance(info.directory))

            expect(list.map((item) => item.name)).toContain(info.name)
            expect(list.map((item) => item.name)).not.toContain(path.basename(test.directory).toLowerCase())
          }),
        ),
      { git: true },
    )

    it.instance(
      "create with custom name",
      () =>
        withCreatedWorktree({ name: "test-workspace" }, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("opencode/test-workspace")
          }),
        ),
      { git: true },
    )

    wintest(
      "reset coordinates with asynchronous bootstrap",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const probe = makeStartCommandProbe(test.directory, "worktree-reset-start-command")
          yield* Effect.acquireUseRelease(
            svc.create({ name: "reset-during-bootstrap", startCommand: probe.command }),
            (info) =>
              Effect.gen(function* () {
                const pid = yield* probe.started
                expect(yield* svc.reset({ directory: info.directory })).toBe(true)
                yield* probe.stopped(pid)
              }),
            (info) => svc.remove({ directory: info.directory }).pipe(Effect.ignore),
          )
        }),
      { git: true },
    )

    createIt.instance(
      "serializes create setup with removal for the same worktree",
      () =>
        Effect.gen(function* () {
          const probe = yield* CreateHookProbe
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "serialized-create" })
          yield* Effect.addFinalizer(() =>
            probe.release.pipe(Effect.andThen(svc.remove({ directory: info.directory }).pipe(Effect.ignore))),
          )

          const creating = yield* svc.createFromInfo(info).pipe(Effect.forkScoped)
          yield* probe.entered.pipe(Effect.timeout("2 seconds"))
          const removing = yield* svc.remove({ directory: info.directory }).pipe(Effect.forkScoped)
          const earlyRemoval = yield* Fiber.join(removing).pipe(Effect.timeoutOption("250 millis"))

          yield* probe.release
          yield* Fiber.join(creating)
          expect(earlyRemoval._tag).toBe("None")
          expect(yield* Fiber.join(removing)).toBe(true)
        }),
      { git: true },
      { timeout: 20_000 },
    )

    concurrentIt.instance(
      "serializes destructive operations for the same worktree",
      () =>
        Effect.gen(function* () {
          const probe = yield* RemoveHookProbe
          const svc = yield* Worktree.Service
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          const info = yield* svc.create({ name: "serialized-remove" })
          yield* Fiber.join(ready)

          const first = yield* svc.remove({ directory: info.directory }).pipe(Effect.forkScoped)
          yield* probe.entered.pipe(Effect.timeout("2 seconds"))
          const second = yield* svc.remove({ directory: info.directory }).pipe(Effect.forkScoped)

          expect((yield* probe.overlap.pipe(Effect.timeoutOption("250 millis")))._tag).toBe("None")
          yield* probe.release
          expect(yield* Fiber.join(first)).toBe(true)
          const repeated = yield* Fiber.await(second)
          expect(Exit.isFailure(repeated)).toBe(true)
        }),
      { git: true },
      { timeout: 20_000 },
    )
  })

  describe("reset", () => {
    it.instance(
      "migrates project memory before removing other untracked files",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const ctx = yield* InstanceState.context
            const svc = yield* Worktree.Service
            const store = yield* MemoryStore.Service
            const project = yield* Project.Service
            yield* project.setInitialized(ctx.project.id)
            const home = MemoryHome.make(Global.Path.data)
            const projectHome = home.directory(ctx.project.id)
            const topic = path.join(info.directory, ".opencode", "memory", "topics", "project-architecture.yaml")
            const disposable = path.join(info.directory, ".opencode", "disposable.tmp")
            yield* Effect.addFinalizer(() => fs.remove(projectHome, { recursive: true }).pipe(Effect.ignore))
            yield* fs.makeDirectory(path.dirname(topic), { recursive: true })
            yield* fs.writeFileString(topic, Bun.YAML.stringify(memoryTopic()))
            yield* fs.writeFileString(disposable, "remove me\n")

            yield* svc.reset({ directory: info.directory })

            const topicPreserved = (yield* store.readTopics(ctx.project.id)).length === 1
            const legacyPreserved = yield* fs.exists(topic).pipe(Effect.orDie)
            const disposablePreserved = yield* fs.exists(disposable).pipe(Effect.orDie)

            expect(topicPreserved).toBe(true)
            expect(legacyPreserved).toBe(false)
            expect(disposablePreserved).toBe(false)
          }),
        ),
      { git: true },
    )

    it.instance(
      "migrates modified tracked legacy memory before hard reset",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const fs = yield* FSUtil.Service
            const svc = yield* Worktree.Service
            const store = yield* MemoryStore.Service
            const project = yield* Project.Service
            yield* project.setInitialized(ctx.project.id)
            const home = MemoryHome.make(Global.Path.data)
            const projectHome = home.directory(ctx.project.id)
            const legacy = path.join(info.directory, ".opencode", "memory", "topics", "project-architecture.yaml")
            yield* Effect.addFinalizer(() => fs.remove(projectHome, { recursive: true }).pipe(Effect.ignore))
            yield* fs.makeDirectory(path.dirname(legacy), { recursive: true })
            yield* fs.writeFileString(legacy, Bun.YAML.stringify(memoryTopic("committed")))
            yield* git(info.directory, ["add", ".opencode/memory/topics/project-architecture.yaml"])
            yield* git(info.directory, ["commit", "-m", "test: add legacy memory"])
            yield* fs.writeFileString(legacy, Bun.YAML.stringify(memoryTopic("modified before reset")))

            yield* svc.reset({ directory: info.directory })

            expect((yield* store.readTopics(ctx.project.id))[0]?.summary).toBe("modified before reset")
          }),
        ),
      { git: true },
    )

    it.instance(
      "rejects reset of the primary or current worktree",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const primary = yield* svc.reset({ directory: test.directory }).pipe(Effect.exit)
            const current = yield* svc
              .reset({ directory: info.directory })
              .pipe(provideInstance(info.directory), Effect.exit)

            expect(Exit.isFailure(primary)).toBe(true)
            expect(Exit.isFailure(current)).toBe(true)
            if (Exit.isFailure(primary)) expect(Cause.pretty(primary.cause)).toContain("primary or current")
            if (Exit.isFailure(current)) expect(Cause.pretty(current.cause)).toContain("primary or current")
          }),
        ),
      { git: true },
    )

    it.instance(
      "rejects reset of an unregistered git worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const target = path.join(path.dirname(test.directory), `unregistered-reset-${Date.now()}`)
          const branch = `unregistered-reset-${Date.now()}`
          yield* git(test.directory, ["worktree", "add", "-b", branch, target])
          yield* Effect.addFinalizer(() =>
            gitResult(test.directory, ["worktree", "remove", "--force", target]).pipe(
              Effect.andThen(gitResult(test.directory, ["branch", "-D", branch])),
              Effect.ignore,
            ),
          )

          const exit = yield* svc.reset({ directory: target }).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("not registered")
        }),
      { git: true },
    )
  })

  describe("createFromInfo", () => {
    wintest(
      "creates git worktree and boots asynchronously",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = list.replace(/\\/g, "/")
          const normalizedDir = info.directory.replace(/\\/g, "/")
          expect(normalizedList).toContain(normalizedDir)

          yield* Fiber.join(ready)
          yield* removeCreatedWorktree(info.directory)
        }),
      { git: true },
    )
  })

  describe("list", () => {
    it.instance(
      "uses parent folder name when worktree basename matches the primary worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const ctx = yield* InstanceState.context
          const project = yield* Project.Service
          const svc = yield* Worktree.Service
          const parent = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-parent`)
          const target = path.join(parent, path.basename(test.directory))
          const branch = `same-basename-list-${Date.now()}`

          yield* fs.ensureDir(parent)
          yield* git(test.directory, ["worktree", "add", "-b", branch, target])
          yield* project.addSandbox(ctx.project.id, target)

          const list = yield* svc.list()
          const directory = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(target)))

          expect(list.map((item) => ({ ...item, directory: normalize(item.directory) }))).toContainEqual({
            name: path.basename(parent),
            branch,
            directory: normalize(directory),
          })

          yield* svc.remove({ directory: target })
        }),
      { git: true },
    )

    it.instance(
      "hides a missing worktree in list and cleans it up on explicit remove",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const fs = yield* FSUtil.Service
            const project = yield* Project.Service
            const svc = yield* Worktree.Service
            yield* fs.remove(info.directory, { recursive: true })

            // list() is non-destructive: the entry is hidden from the listing
            // but the git admin data and registration stay untouched.
            expect((yield* svc.list()).map((item) => item.directory)).not.toContain(info.directory)
            expect(yield* git(ctx.worktree, ["worktree", "list", "--porcelain"])).toContain(info.directory)
            expect((yield* project.get(ctx.project.id))?.sandboxes.length).toBeGreaterThan(0)

            // Explicit remove does the cleanup: prune admin data, drop the
            // registration.
            expect(yield* svc.remove({ directory: info.directory })).toBe(true)
            expect(yield* git(ctx.worktree, ["worktree", "list", "--porcelain"])).not.toContain(info.directory)
            const after = yield* project.get(ctx.project.id)
            expect(after?.sandboxes.some((sandbox) => sandbox === info.directory)).toBe(false)
          }),
        ),
      { git: true },
    )
  })

  describe("remove edge cases", () => {
    it.instance(
      "rejects a directory that is not a registered worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const exit = yield* svc.remove({ directory: path.join(test.directory, "does-not-exist") }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("not registered")
        }),
      { git: true },
    )

    it.instance(
      "rejects removal of the primary or current worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const exit = yield* svc.remove({ directory: test.directory }).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("primary or current")
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.remove({ directory: path.join(test.directory, "fake") }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )
  })
})

function memoryTopic(summary = "已确认的核心架构边界") {
  return {
    schema_version: 1,
    id: "project-architecture",
    name: "架构边界",
    summary,
    metadata: {
      categories: ["decision"],
      status: "active",
      importance: "core",
      keywords: ["架构"],
      related_topics: [],
      created_at: "2026-08-11T00:00:00Z",
      updated_at: "2026-08-11T00:00:00Z",
      last_matched_at: null,
      match_count: 0,
      revision: 1,
      item_count: 1,
    },
    items: [
      {
        id: "decision-01",
        kind: "decision",
        content: "已确认决定：核心模块之间使用稳定边界",
        rationale: "该边界由用户确认并长期适用",
        confirmed_at: "2026-08-11T00:00:00Z",
      },
    ],
  }
}
