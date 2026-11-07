import { expect, test } from "bun:test"
import { $ } from "bun"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Dag } from "@/dag/dag"
import { DagStore } from "@opencode-ai/core/dag/store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppLayer } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionAbortReason } from "@/session/abort-reason"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { TestLLMServer } from "../lib/llm-server"
import { awaitWithTimeout } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

test("workflow cancel stops its real cross-workspace child without stopping an owner session", async () => {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const config = {
            model: "test/test-model",
            provider: {
              test: {
                name: "Test",
                id: "test",
                env: [],
                npm: "@ai-sdk/openai-compatible",
                models: {
                  "test-model": {
                    id: "test-model",
                    name: "Test Model",
                    attachment: false,
                    reasoning: false,
                    temperature: false,
                    tool_call: true,
                    release_date: "2025-01-01",
                    limit: { context: 100000, output: 10000 },
                    cost: { input: 0, output: 0 },
                    options: {},
                  },
                },
                options: { apiKey: "test-key", baseURL: llm.url },
              },
            },
          }
          yield* Effect.promise(() =>
            Promise.all(
              [owner.path, workspace.path].map(async (dir) => {
                const file = path.join(dir, ".agents", "settings.json")
                await mkdir(path.dirname(file), { recursive: true })
                await writeFile(file, JSON.stringify(config))
              }),
            ),
          )
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const dag = yield* Dag.Service
          const store = yield* DagStore.Service
          const runs = yield* SessionRunState.Service
          const status = yield* SessionStatus.Service
          const events = yield* EventV2Bridge.Service
          const ownerCtx = yield* instances.load({ directory: owner.path })
          const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)
          const inChild = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: workspace.path }, fx)
          const started = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* instances.disposeAll()
              if (yield* Deferred.isDone(started)) expect(yield* Deferred.isDone(stopped)).toBe(true)
            }),
          )

          yield* inOwner(
            Effect.gen(function* () {
              const parent = yield* sessions.create({
                title: "owner",
                agent: "build",
                model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
              })
              const control = yield* sessions.create({ title: "owner control" })
              yield* runs.ensureRunningHandle(
                control.id,
                Effect.die("owner control interrupted"),
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                ),
              )
              yield* awaitWithTimeout(Deferred.await(started), "owner control did not start", "10 seconds")
              yield* llm.hang
              const id = yield* dag.create({
                projectID: ownerCtx.project.id,
                sessionID: parent.id,
                title: "cross-workspace cancellation",
                config: {
                  name: "cross-workspace cancellation",
                  workspace: workspace.path,
                  nodes: [
                    {
                      id: "worker",
                      name: "worker",
                      worker_type: "general",
                      depends_on: [],
                      required: true,
                      prompt_template: { inline: "Work until cancelled." },
                    },
                  ],
                },
              })
              yield* awaitWithTimeout(llm.wait(1), "child did not reach the synthetic LLM", "20 seconds")
              const node = yield* store.getNode(id, "worker")
              if (node?.status !== "running" || !node.childSessionId)
                throw new Error(`child not running: ${JSON.stringify(node)}`)
              expect(node?.status).toBe("running")
              expect(node?.childSessionId).toBeDefined()
              const child = SessionID.make(node.childSessionId)
              expect((yield* sessions.get(child)).directory).toBe(workspace.path)
              expect((yield* inChild(status.get(child))).type).toBe("busy")
              const childHandle = yield* inChild(
                runs.ensureRunningHandle(child, Effect.die("not a new runner"), Effect.never),
              )
              const idle = yield* Deferred.make<string | undefined>()
              yield* events.subscribe(SessionStatus.Event.Status).pipe(
                Stream.runForEach((event) =>
                  event.data.sessionID === child && event.data.status.type === "idle"
                    ? Deferred.succeed(idle, event.location?.directory).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkScoped({ startImmediately: true }),
              )
              yield* dag.cancel(id)
              const idleDirectory = yield* awaitWithTimeout(
                Deferred.await(idle),
                "cancel did not emit child idle",
                "10 seconds",
              )
              expect(idleDirectory).toBe(workspace.path)
              const childExit = yield* childHandle.pipe(Effect.exit, Effect.timeoutOption("3 seconds"))
              expect(yield* Deferred.isDone(stopped)).toBe(false)
              expect((yield* status.get(control.id)).type).toBe("busy")
              if (Option.isNone(childExit)) {
                const childStatus = yield* inChild(status.get(child))
                throw new Error(
                  `child runner did not exit; B status=${childStatus.type}, idle event directory=${idleDirectory === owner.path ? "owner A" : idleDirectory === workspace.path ? "child B" : idleDirectory}`,
                )
              }
              expect((yield* inChild(status.get(child))).type).toBe("idle")
              expect(Option.isSome(childExit)).toBe(true)
            }),
          )
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
}, 60_000)

async function assertFollowupCancelNoOp(loadThenDispose: boolean) {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const status = yield* SessionStatus.Service
          const runs = yield* SessionRunState.Service
          const events = yield* EventV2Bridge.Service
          yield* instances.load({ directory: owner.path })
          const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)
          if (loadThenDispose) {
            yield* instances.provide({ directory: workspace.path }, Effect.void)
            yield* instances.disposeDirectory(workspace.path)
          }

          yield* inOwner(
            Effect.gen(function* () {
              const child = yield* sessions.create({ title: "durable followup", directory: workspace.path })
              yield* sessions.setMetadata({
                sessionID: child.id,
                metadata: { hookPendingInput: { text: "pending" } },
              })
              const control = yield* sessions.create({ title: "owner control" })
              const started = yield* Deferred.make<void>()
              const stopped = yield* Deferred.make<void>()
              yield* runs.ensureRunningHandle(
                control.id,
                Effect.die("owner control interrupted"),
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                ),
              )
              yield* Deferred.await(started)
              const idle = yield* Deferred.make<void>()
              yield* events.subscribe(SessionStatus.Event.Status).pipe(
                Stream.runForEach((event) =>
                  event.data.sessionID === child.id && event.data.status.type === "idle"
                    ? Deferred.succeed(idle, undefined)
                    : Effect.void,
                ),
                Effect.forkScoped({ startImmediately: true }),
              )

              yield* prompt.cancel(child.id)

              const observed = yield* Deferred.await(idle).pipe(Effect.timeoutOption("100 millis"))
              expect(Option.isNone(observed)).toBe(true)
              expect(yield* Deferred.isDone(stopped)).toBe(false)
              expect((yield* status.get(control.id)).type).toBe("busy")
              expect((yield* sessions.get(child.id)).metadata?.hookPendingInput).toBeUndefined()
              expect(
                Option.isNone(
                  yield* instances.provideIfLoaded!(
                    { directory: workspace.path },
                    Effect.succeed("target workspace was loaded"),
                  ),
                ),
              ).toBe(true)
            }),
          )
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
}

test("cancel stops a moved session's runner in its original workspace", async () => {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const runs = yield* SessionRunState.Service
          const events = yield* EventV2Bridge.Service
          yield* instances.load({ directory: owner.path })
          yield* instances.load({ directory: workspace.path })
          const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)
          const started = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => instances.disposeAll())

          yield* inOwner(
            Effect.gen(function* () {
              const session = yield* sessions.create({ title: "moved runner" })
              const handle = yield* runs.ensureRunningHandle(
                session.id,
                Effect.die("moved runner interrupted"),
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                ),
              )
              yield* awaitWithTimeout(Deferred.await(started), "moved runner did not start", "10 seconds")
              yield* events
                .publish(SessionEvent.Moved, {
                  sessionID: session.id,
                  location: Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
                  timestamp: yield* DateTime.now,
                })
                .pipe(Effect.orDie)
              expect((yield* sessions.get(session.id)).directory).toBe(workspace.path)

              yield* prompt.cancel(session.id)

              const exited = yield* handle.pipe(Effect.exit, Effect.timeoutOption("1 second"))
              expect(Option.isSome(exited)).toBe(true)
              expect(yield* Deferred.isDone(stopped)).toBe(true)
            }),
          )
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
})

test("both moved runner owners read the same cancellation reason", async () => {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const runs = yield* SessionRunState.Service
          yield* instances.load({ directory: owner.path })
          yield* instances.load({ directory: workspace.path })
          yield* Effect.addFinalizer(() => instances.disposeAll())
          const session = yield* instances.provide({ directory: owner.path }, sessions.create({ title: "two owners" }))
          const seen: Array<SessionAbortReason.Info | undefined> = []
          const makeRun = (directory: string) =>
            Effect.gen(function* () {
              const started = yield* Deferred.make<void>()
              const handle = yield* instances.provide(
                { directory },
                runs.ensureRunningHandle(
                  session.id,
                  Effect.die("interrupted"),
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        seen.push(SessionAbortReason.peek(session.id))
                      }),
                    ),
                  ),
                ),
              )
              yield* awaitWithTimeout(Deferred.await(started), "owner did not start", "10 seconds")
              return handle
            })
          const first = yield* makeRun(owner.path)
          const second = yield* makeRun(workspace.path)
          const reason = SessionAbortReason.make("replan", "dag-replan")
          yield* instances.provide({ directory: owner.path }, prompt.cancel(session.id, { reason }))
          yield* awaitWithTimeout(first.pipe(Effect.exit), "first owner did not stop", "5 seconds")
          yield* awaitWithTimeout(second.pipe(Effect.exit), "second owner did not stop", "5 seconds")
          expect(seen).toEqual([reason, reason])
          expect(SessionAbortReason.peek(session.id)).toBeUndefined()
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
}, 60_000)

test("interrupting the abort caller does not abandon its owner snapshot", async () => {
  await using workspace = await tmpdir({ git: true })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const instances = yield* InstanceStore.Service
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const runs = yield* SessionRunState.Service
        const entered = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(instances.disposeAll())),
        )
        const session = yield* instances.provide(
          { directory: workspace.path },
          sessions.create({ title: "caller interrupt" }),
        )
        const owner = yield* instances.provide(
          { directory: workspace.path },
          runs.ensureRunningHandle(
            session.id,
            Effect.die("interrupted"),
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
          ),
        )
        yield* awaitWithTimeout(Deferred.await(started), "owner did not start", "5 seconds")
        const cancel = yield* instances
          .provide({ directory: workspace.path }, prompt.cancel(session.id))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitWithTimeout(Deferred.await(entered), "abort did not reach owner", "5 seconds")
        const interrupted = yield* Fiber.interrupt(cancel).pipe(Effect.forkChild({ startImmediately: true }))
        expect(Option.isNone(yield* Fiber.await(cancel).pipe(Effect.timeoutOption("100 millis")))).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Fiber.await(interrupted), "abort caller did not terminate", "5 seconds")
        yield* awaitWithTimeout(Deferred.await(stopped), "abort abandoned its owner", "5 seconds")
        yield* awaitWithTimeout(owner.pipe(Effect.exit), "owner did not settle", "5 seconds")
      }),
    ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
  )
}, 60_000)

test("cross-directory cancel does not publish idle in a loaded moved target without a runner", async () => {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const runs = yield* SessionRunState.Service
          const status = yield* SessionStatus.Service
          const events = yield* EventV2Bridge.Service
          yield* instances.load({ directory: owner.path })
          yield* instances.load({ directory: workspace.path })
          const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)
          const started = yield* Deferred.make<void>()
          const interrupting = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => instances.disposeAll())

          yield* inOwner(
            Effect.gen(function* () {
              const session = yield* sessions.create({ title: "moved idle barrier" })
              const handle = yield* runs.ensureRunningHandle(
                session.id,
                Effect.die("moved runner interrupted"),
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupting, undefined).pipe(Effect.andThen(Deferred.await(release))),
                  ),
                ),
              )
              yield* awaitWithTimeout(Deferred.await(started), "moved runner did not start", "10 seconds")
              yield* events
                .publish(SessionEvent.Moved, {
                  sessionID: session.id,
                  location: Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
                  timestamp: yield* DateTime.now,
                })
                .pipe(Effect.orDie)
              expect((yield* sessions.get(session.id)).directory).toBe(workspace.path)

              const idle = yield* Deferred.make<string | undefined>()
              yield* events.subscribe(SessionStatus.Event.Status).pipe(
                Stream.runForEach((event) =>
                  event.data.sessionID === session.id && event.data.status.type === "idle"
                    ? Deferred.succeed(idle, event.location?.directory).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkScoped({ startImmediately: true }),
              )

              const cancelled = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
              // The routed target cancel (workspace B) has completed once the
              // original runner is being interrupted (workspace A). A target
              // without a runner must not publish an idle event: DagLoop and
              // GoalLoop would read it as a real turn boundary.
              yield* awaitWithTimeout(
                Deferred.await(interrupting),
                "original moved runner was not cancelled",
                "10 seconds",
              )
              // Capture the target-side idle before releasing the old runner, so
              // a false idle is observable even when the assertion fails.
              const idleDone = yield* Deferred.isDone(idle)
              yield* Deferred.succeed(release, undefined)
              expect(idleDone).toBe(false)

              const joined = yield* Fiber.join(cancelled).pipe(Effect.timeoutOption("10 seconds"))
              if (Option.isNone(joined)) {
                const ownerStatus = yield* inOwner(status.get(session.id))
                const childStatus = yield* instances.provide({ directory: workspace.path }, status.get(session.id))
                const idleAfterJoin = yield* Deferred.isDone(idle)
                throw new Error(
                  `cancel did not finish; A status=${ownerStatus.type}, B status=${childStatus.type}, idle=${idleAfterJoin}, interrupt done=${yield* Deferred.isDone(interrupting)}`,
                )
              }
              const directory = yield* awaitWithTimeout(
                Deferred.await(idle),
                "cancelled runner did not publish idle",
                "5 seconds",
              )
              expect(directory).toBe(owner.path)
              const exited = yield* handle.pipe(Effect.exit, Effect.timeoutOption("3 seconds"))
              expect(Option.isSome(exited)).toBe(true)
            }),
          )
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
})

test("same-directory cancel with a stale InstanceRef after disposal does not publish idle", async () => {
  await using owner = await tmpdir({ git: true })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const instances = yield* InstanceStore.Service
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const events = yield* EventV2Bridge.Service
        const ctx = yield* instances.load({ directory: owner.path })
        const session = yield* instances.provide(
          { directory: owner.path },
          sessions.create({ title: "stale same-directory cancel" }),
        )
        const idle = yield* Deferred.make<string | undefined>()
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.runForEach((event) =>
            event.data.sessionID === session.id && event.data.status.type === "idle"
              ? Deferred.succeed(idle, event.location?.directory).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* instances.disposeDirectory(owner.path)

        // Mirrors the HTTP middleware: it holds the InstanceRef loaded before
        // disposal and does not attach a generation to the request effect.
        yield* prompt.cancel(session.id).pipe(Effect.provideService(InstanceRef, ctx), Effect.exit)
        const observed = yield* Deferred.await(idle).pipe(Effect.timeoutOption("100 millis"))
        expect(Option.isNone(observed)).toBe(true)
        expect(
          Option.isNone(
            yield* instances.provideIfLoaded!(
              { directory: owner.path },
              Effect.succeed("stale cancel reloaded the instance"),
            ),
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
  )
})

test("cancel clears a durable followup when the target workspace is not loaded", () => assertFollowupCancelNoOp(false))

test("cancel clears a durable followup when the target workspace was disposed", () => assertFollowupCancelNoOp(true))

test.skipIf(process.platform === "win32")(
  "cancel resolves a symlinked target directory to the loaded workspace",
  async () => {
    await using owner = await tmpdir({ git: true })
    await using workspace = await tmpdir()
    await rm(workspace.path, { recursive: true, force: true })
    await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
    const link = path.join(path.dirname(workspace.path), `opencode-target-${Math.random().toString(36).slice(2)}`)
    await symlink(workspace.path, link)
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const instances = yield* InstanceStore.Service
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const runs = yield* SessionRunState.Service
            const events = yield* EventV2Bridge.Service
            yield* instances.load({ directory: workspace.path })
            const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)

            yield* inOwner(
              Effect.gen(function* () {
                const child = yield* sessions.create({ title: "symlink target", directory: link })
                expect((yield* sessions.get(child.id)).directory).toBe(link)
                yield* sessions.setMetadata({
                  sessionID: child.id,
                  metadata: { hookPendingInput: { text: "pending" } },
                })
                yield* instances.provide({ directory: workspace.path }, Effect.void)
                const childHandle = yield* instances.provide(
                  { directory: workspace.path },
                  runs.ensureRunningHandle(child.id, Effect.die("interrupted"), Effect.never),
                )
                const idle = yield* Deferred.make<string | undefined>()
                yield* events.subscribe(SessionStatus.Event.Status).pipe(
                  Stream.runForEach((event) =>
                    event.data.sessionID === child.id && event.data.status.type === "idle"
                      ? Deferred.succeed(idle, event.location?.directory)
                      : Effect.void,
                  ),
                  Effect.forkScoped({ startImmediately: true }),
                )

                yield* prompt.cancel(child.id)

                expect((yield* sessions.get(child.id)).metadata?.hookPendingInput).toBeUndefined()
                const directory = yield* awaitWithTimeout(
                  Deferred.await(idle),
                  "symlinked target did not publish idle in the loaded workspace",
                  "5 seconds",
                )
                expect(directory).toBe(workspace.path)
                const exit = yield* childHandle.pipe(Effect.exit, Effect.timeoutOption("3 seconds"))
                expect(Option.isSome(exit)).toBe(true)
              }),
            )
          }),
        ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
      )
    } finally {
      await rm(link, { force: true })
      await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
    }
  },
)

test("cancel stops an idle moved session's background job in its origin workspace", async () => {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const status = yield* SessionStatus.Service
          const jobs = yield* BackgroundJob.Service
          const events = yield* EventV2Bridge.Service
          yield* instances.load({ directory: owner.path })
          yield* instances.load({ directory: workspace.path })
          const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)
          const inChild = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: workspace.path }, fx)
          yield* Effect.addFinalizer(() => instances.disposeAll())

          yield* inOwner(
            Effect.gen(function* () {
              const moved = yield* sessions.create({ title: "moved background owner" })
              const control = yield* sessions.create({ title: "owner control" })
              const started = yield* Deferred.make<void>()
              const movedJob = yield* jobs.start({
                type: "test",
                metadata: { sessionId: moved.id },
                run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              })
              yield* awaitWithTimeout(Deferred.await(started), "moved background job did not start", "10 seconds")
              const controlJob = yield* jobs.start({
                type: "test",
                metadata: { sessionId: control.id },
                run: Effect.never,
              })
              expect((yield* status.get(moved.id)).type).toBe("idle")

              yield* events
                .publish(SessionEvent.Moved, {
                  sessionID: moved.id,
                  location: Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
                  timestamp: yield* DateTime.now,
                })
                .pipe(Effect.orDie)
              expect((yield* sessions.get(moved.id)).directory).toBe(workspace.path)

              const other = yield* inChild(sessions.create({ title: "target control" }))
              const targetJob = yield* inChild(
                jobs.start({ type: "test", metadata: { sessionId: other.id }, run: Effect.never }),
              )

              // The moved session is idle, but its background job still runs in
              // the origin instance. Cancel must reach that instance even
              // though the durable row now points at the loaded target.
              yield* prompt.cancel(moved.id)

              // Check the unrelated jobs first so a failure below still
              // records that cancellation did not overreach.
              expect((yield* inOwner(jobs.get(controlJob.id)))?.status).toBe("running")
              expect((yield* inChild(jobs.get(targetJob.id)))?.status).toBe("running")
              expect(
                (yield* inOwner(jobs.get(movedJob.id)))?.status,
                "cancel left the moved session's background job running",
              ).toBe("cancelled")
            }),
          )
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
}, 60_000)

test("reload fences a long-running workspace provide without touching the owner", async () => {
  await using owner = await tmpdir({ git: true })
  await using workspace = await tmpdir()
  await rm(workspace.path, { recursive: true, force: true })
  await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const runs = yield* SessionRunState.Service
          const status = yield* SessionStatus.Service
          yield* instances.load({ directory: owner.path })
          const inOwner = <A, E, R>(fx: Effect.Effect<A, E, R>) => instances.provide({ directory: owner.path }, fx)

          const control = yield* inOwner(sessions.create({ title: "owner control" }))
          const started = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          yield* inOwner(
            runs.ensureRunningHandle(
              control.id,
              Effect.die("owner control interrupted"),
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
            ),
          )
          yield* Deferred.await(started)

          const entered = yield* Deferred.make<void>()
          const childStarted = yield* Deferred.make<void>()
          const childStopped = yield* Deferred.make<void>()
          const providing = yield* instances
            .provide(
              { directory: workspace.path },
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Effect.forkScoped(
                  Deferred.succeed(childStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(childStopped, undefined)),
                  ),
                )
                yield* Effect.never
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* Deferred.await(childStarted)

          const next = yield* instances.reload({ directory: workspace.path }).pipe(Effect.timeoutOption("4 seconds"))
          expect(Option.isSome(next)).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(providing))).toBe(true)
          expect(yield* Deferred.isDone(childStopped)).toBe(true)
          expect((yield* inOwner(status.get(control.id))).type).toBe("busy")
          expect(yield* instances.provide({ directory: workspace.path }, Effect.succeed("new"))).toBe("new")
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet()
  }
})
