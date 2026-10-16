import { expect } from "bun:test"
import { Effect, Layer, Deferred } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Worktree } from "@/worktree"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Project } from "@/project/project"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
const hooks = SettingsHook.layer.pipe(Layer.provide(SessionHooks.defaultLayer))
const it = testEffect(
  Layer.mergeAll(
    Worktree.defaultLayer.pipe(Layer.provideMerge(hooks)),
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
    Project.defaultLayer,
  ),
)
it.instance(
  "a real creation hook supplies the directory instead of default git creation",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const target = path.join(directory, "custom-isolation")
      const hook = path.join(directory, "create-hook.ts")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          hook,
          `await Bun.write(${JSON.stringify(path.join(target, "marker"))}, "hook-created");process.stdout.write(${JSON.stringify(target)})`,
        )
        await fs.writeFile(
          path.join(directory, ".opencode/hooks.json"),
          JSON.stringify({
            WorktreeCreate: [{ hooks: [{ type: "command", command: process.execPath, args: [hook] }] }],
          }),
        )
      })
      const ready = yield* Deferred.make<void>()
      const listener = (event: import("@/bus/global").GlobalEvent) => {
        if (event.directory === target && event.payload.type === Worktree.Event.Ready.type)
          Deferred.doneUnsafe(ready, Effect.void)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          GlobalBus.off("event", listener)
        }),
      )
      const created = yield* (yield* Worktree.Service).create({ name: "hook-owned" })
      yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
      expect(created.directory).toBe(target)
      expect(yield* Effect.promise(() => fs.readFile(path.join(target, "marker"), "utf8"))).toBe("hook-created")
    }),
  { git: true },
)
it.instance(
  "a failing configured creation hook never falls back to git",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode/hooks.json"),
          JSON.stringify({ WorktreeCreate: [{ hooks: [{ type: "command", command: "exit 2" }] }] }),
        )
      })
      const result = yield* (yield* Worktree.Service).create({ name: "must-not-fallback" }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      const current = yield* InstanceState.context
      const project = yield* (yield* Project.Service).get(current.project.id)
      expect(project?.sandboxes ?? []).toEqual([])
    }),
  { git: true },
)

for (const mode of ["exit-zero", "fail-present", "fail-removed"] as const) {
  it.instance(
    `hook-owned cleanup ${mode} respects actual outcome without git fallback`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const target = path.join(directory, "custom-owned")
        const createScript = path.join(directory, "create.ts")
        const removeScript = path.join(directory, "remove.ts")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
          await fs.writeFile(
            createScript,
            `await Bun.write(${JSON.stringify(path.join(target, "marker"))},"owned");process.stdout.write(${JSON.stringify(target)})`,
          )
          await fs.writeFile(
            removeScript,
            mode === "fail-removed"
              ? `const i=JSON.parse(await Bun.stdin.text());await import("node:fs/promises").then(fs=>fs.rm(i.worktree_path,{recursive:true,force:true}));process.exit(7)`
              : `process.exit(${mode === "exit-zero" ? 0 : 7})`,
          )
          await fs.writeFile(
            path.join(directory, ".opencode/hooks.json"),
            JSON.stringify({
              WorktreeCreate: [{ hooks: [{ type: "command", command: process.execPath, args: [createScript] }] }],
              WorktreeRemove: [{ hooks: [{ type: "command", command: process.execPath, args: [removeScript] }] }],
            }),
          )
        })
        const ready = yield* Deferred.make<void>()
        const listener = (event: import("@/bus/global").GlobalEvent) => {
          if (event.directory === target && event.payload.type === Worktree.Event.Ready.type)
            Deferred.doneUnsafe(ready, Effect.void)
        }
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            GlobalBus.off("event", listener)
          }),
        )
        const worktree = yield* Worktree.Service
        yield* worktree.create({ name: "hook-owned" })
        yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
        const result = yield* worktree.remove({ directory: target }).pipe(Effect.exit)
        expect(result._tag).toBe(mode === "fail-present" ? "Failure" : "Success")
        expect(yield* Effect.promise(() => Bun.file(path.join(target, "marker")).exists())).toBe(
          mode !== "fail-removed",
        )
        const ctx = yield* InstanceState.context
        const current = yield* (yield* Project.Service).get(ctx.project.id)
        expect(current?.sandboxes.includes(target)).toBe(mode === "fail-present")
      }),
    { git: true },
  )
}

it.instance("a configured hook can isolate a local non-git project", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const target = path.join(directory, "plain-isolation")
    const script = path.join(directory, "create.ts")
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
      await fs.writeFile(
        script,
        `await Bun.write(${JSON.stringify(path.join(target, "marker"))},"plain");process.stdout.write("plain-isolation")`,
      )
      await fs.writeFile(
        path.join(directory, ".opencode/hooks.json"),
        JSON.stringify({
          WorktreeCreate: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    const ready = yield* Deferred.make<void>()
    const listener = (event: import("@/bus/global").GlobalEvent) => {
      if (event.directory === target && event.payload.type === Worktree.Event.Ready.type)
        Deferred.doneUnsafe(ready, Effect.void)
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        GlobalBus.off("event", listener)
      }),
    )
    const result = yield* (yield* Worktree.Service).create({ name: "plain" })
    yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
    expect(result.directory).toBe(target)
  }),
)

for (const mode of ["dot-segment", "symlink", "session-ancestor"] as const) {
  it.instance(
    `creation hook rejects unsafe ${mode} directory ownership`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const target = path.join(directory, "real-target")
        const alias = path.join(directory, "alias-target")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
          await fs.mkdir(target)
          if (mode === "symlink") await fs.symlink(target, alias, "dir")
          const output =
            mode === "symlink" ? alias : mode === "session-ancestor" ? path.dirname(directory) : target + path.sep + "."
          const script = path.join(directory, "unsafe-hook.ts")
          await fs.writeFile(script, `process.stdout.write(${JSON.stringify(output)})`)
          await fs.writeFile(
            path.join(directory, ".opencode/hooks.json"),
            JSON.stringify({
              WorktreeCreate: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
            }),
          )
        })
        const result = yield* (yield* Worktree.Service).create({ name: "unsafe" }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        const ctx = yield* InstanceState.context
        expect((yield* (yield* Project.Service).get(ctx.project.id))?.sandboxes ?? []).toEqual([])
      }),
    { git: true },
  )
}

it.instance(
  "default Git cleanup of a hook-created worktree preserves the hook-created branch",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const target = path.join(directory, "git-hook-target")
      const branch = "hook-owned-preserved"
      const script = path.join(directory, "git-create-hook.ts")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          script,
          `const child=Bun.spawnSync(['git','worktree','add','-b',${JSON.stringify(branch)},${JSON.stringify(target)},'HEAD'],{cwd:${JSON.stringify(directory)},stdout:'pipe',stderr:'pipe'});if(child.exitCode!==0){process.stderr.write(child.stderr);process.exit(child.exitCode)}process.stdout.write(${JSON.stringify(target)});`,
        )
        await fs.writeFile(
          path.join(directory, ".opencode/hooks.json"),
          JSON.stringify({
            WorktreeCreate: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      const ready = yield* Deferred.make<void>()
      const listener = (event: import("@/bus/global").GlobalEvent) => {
        if (event.directory === target && event.payload.type === Worktree.Event.Ready.type)
          Deferred.doneUnsafe(ready, Effect.void)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          GlobalBus.off("event", listener)
        }),
      )
      const worktree = yield* Worktree.Service
      const created = yield* worktree.create({ name: "hook-git" })
      yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
      expect(created.directory).toBe(target)
      expect(yield* worktree.remove({ directory: target })).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(target, ".git")).exists())).toBe(false)
      const result = yield* Effect.sync(() =>
        Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/${branch}`], {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      expect(result.exitCode).toBe(0)
    }),
  { git: true },
)
