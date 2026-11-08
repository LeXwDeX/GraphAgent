import { SettingsHook } from "@/hook"
import { $ } from "bun"
import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber, Deferred, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Project } from "@graphagent/core/project"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { DagStore } from "@graphagent/core/dag/store"
import { boundedCancel, spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { Permission } from "@/permission"
import { TerminalViolationError } from "@graphagent/core/dag/core/types"
import { InstanceStore } from "@/project/instance-store"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import { tmpdir } from "../fixture/fixture"

type TrackedEvent = {
  type: string
  dagID: string
  nodeID: string
  output?: unknown
  reason?: string
  trigger?: string
  directory?: string
  baseHead?: string
}

function makeEventTracker(store: Partial<DagStore.Interface> = {}) {
  const events: TrackedEvent[] = []
  const dagLayer = Layer.mock(Dag.Service, {
    store: { tryClaimAdoption: () => Effect.succeed(true), ...store } as unknown as DagStore.Interface,
    nodeQueued: Effect.fn("stub.nodeQueued")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeQueued", dagID, nodeID })),
    ),
    nodeStarted: Effect.fn("stub.nodeStarted")(
      (
        dagID: string,
        nodeID: string,
        _childSessionID: string,
        _deadlineMs?: number,
        _wakeEligible?: boolean,
        _attempt?: unknown,
        directory?: string,
        baseHead?: string,
      ) => Effect.sync(() => events.push({ type: "nodeStarted", dagID, nodeID, directory, baseHead })),
    ),
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID, output })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string, trigger: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason, trigger })),
    ),
    failUnrecoverable: Effect.fn("stub.failUnrecoverable")((dagID: string, reason: string) =>
      Effect.sync(() => {
        events.push({ type: "failUnrecoverable", dagID, nodeID: "", reason })
        return "failed" as const
      }),
    ),
  })
  return { events, dagLayer }
}

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

const sessionStub = {
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: (input?: { directory?: string }) =>
    Effect.succeed({ id: "ses_child" as never, directory: input?.directory ?? process.cwd() } as never),
  list: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
}
const sessionLayer = Layer.mock(Session.Service, sessionStub)

const sessionInfo = (id: string, directory = process.cwd(), model?: Session.Info["model"]): Session.Info => ({
  id: SessionID.make(id),
  slug: id,
  projectID: Project.ID.make("p"),
  directory,
  title: id,
  version: "test",
  time: { created: 0, updated: 0 },
  model,
})

const instanceStoreWith = (provide: InstanceStore.Interface["provide"]): InstanceStore.Interface => ({
  load: () => Effect.die("unused in spawn completion test"),
  reload: () => Effect.die("unused in spawn completion test"),
  dispose: () => Effect.die("unused in spawn completion test"),
  disposeDirectory: () => Effect.die("unused in spawn completion test"),
  disposeAll: () => Effect.die("unused in spawn completion test"),
  provide,
})

function reply(text: string, includeText = text !== ""): SessionV1.WithParts {
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
    parts: includeText ? ([{ type: "text", text }] as never) : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts): Layer.Layer<SessionPrompt.Service> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(result),
  })
}

function makeFailingPromptLayer(error: string): Layer.Layer<SessionPrompt.Service> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.die(new Error(error)),
  })
}

function makeSpawnInput(): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }] as never,
  }
}

async function runSpawn(dagLayer: Layer.Layer<never>, extraLayer: Layer.Layer<never>) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, extraLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput())
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

function findEvent(events: TrackedEvent[], type: string) {
  return events.find((e) => e.type === type)
}

describe("spawnNode completion bridge", () => {
  it("injects the execution directory and starting HEAD into the child system context", async () => {
    await using tmp = await tmpdir({ git: true })
    const head = (await $`git -C ${tmp.path} rev-parse HEAD`.text()).trim()
    let promptSystem: SessionPrompt.PromptInput["system"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptSystem = input.system
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), { ...makeSpawnInput(), directory: tmp.path })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeEventTracker({
              getWorkflow: () => Effect.succeed(makeWorkflowRow({ directory: tmp.path })),
            }).dagLayer,
            agentLayer,
            sessionLayer,
            prompt,
          ),
        ),
      ) as Effect.Effect<never>,
    )

    expect(promptSystem).toContain(`Execution directory: ${tmp.path}`)
    expect(promptSystem).toContain(`HEAD at start: ${head}`)
  })

  it("creates the child in the bound workspace with its permissions and instance", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(os.tmpdir(), `opencode-spawn-workspace-${Math.random().toString(36).slice(2)}`)
    await $`git worktree add --detach ${linked} HEAD`.cwd(tmp.path).quiet()
    const workspace = await fs.realpath(linked)
    const head = (await $`git -C ${workspace} rev-parse HEAD`.text()).trim()
    let created: Parameters<Session.Interface["create"]>[0]
    let providedDirectory: string | undefined
    try {
      const { events, dagLayer } = makeEventTracker({
        getWorkflow: () => Effect.succeed(makeWorkflowRow({ directory: tmp.path, executionDirectory: workspace })),
      })
      const sessions = Layer.mock(Session.Service, {
        get: () => Effect.succeed(sessionInfo("ses_parent")),
        create: (input?: Parameters<Session.Interface["create"]>[0]) =>
          Effect.sync(() => {
            created = input
            return sessionInfo("ses_child", input?.directory ?? process.cwd())
          }),
        list: () => Effect.succeed([]),
        messages: () => Effect.succeed([]),
      })
      const provideInstance: InstanceStore.Interface["provide"] = (input, effect) =>
        Effect.tap(effect, () =>
          Effect.sync(() => {
            providedDirectory = input.directory
          }),
        )
      const instanceStore = instanceStoreWith(provideInstance)
      const prompt = makePromptLayer(reply("done"))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
              ...makeSpawnInput(),
              directory: tmp.path,
              executionDirectory: workspace,
            })
            yield* Fiber.await(result.fiber)
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessions, prompt)),
          Effect.provideService(InstanceStore.Service, instanceStore),
          Effect.orDie,
        ),
      )

      expect(created?.directory).toBe(workspace)
      expect(providedDirectory).toBe(workspace)
      const started = findEvent(events, "nodeStarted")
      expect(started?.directory).toBe(workspace)
      expect(started?.baseHead).toBe(head)
      // The child runs inside B's InstanceRef, so the workspace is already
      // internal there. A workspace-wide external_directory allow would only
      // weaken an inherited deny (and a wildcard path could widen it).
      expect(
        (created?.permission ?? []).filter(
          (rule) =>
            rule.permission === "external_directory" &&
            rule.action === "allow" &&
            rule.pattern.startsWith(workspace.replaceAll("\\", "/") + "/"),
        ),
      ).toEqual([])
    } finally {
      await $`git worktree remove --force ${workspace}`.cwd(tmp.path).quiet().catch(() => undefined)
    }
  })

  it("preserves an inherited workspace external-directory deny", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(os.tmpdir(), `opencode-spawn-deny-${Math.random().toString(36).slice(2)}`)
    await $`git worktree add --detach ${linked} HEAD`.cwd(tmp.path).quiet()
    const workspace = await fs.realpath(linked)
    const deny = {
      permission: "external_directory",
      pattern: path.join(workspace, "**").replaceAll("\\", "/"),
      action: "deny",
    } as const
    let created: Parameters<Session.Interface["create"]>[0]
    try {
      const { dagLayer } = makeEventTracker({
        getWorkflow: () => Effect.succeed(makeWorkflowRow({ directory: tmp.path, executionDirectory: workspace })),
      })
      const sessions = Layer.mock(Session.Service, {
        get: () => Effect.succeed({ ...sessionInfo("ses_parent"), permission: [deny] }),
        create: (input) =>
          Effect.sync(() => {
            created = input
            return sessionInfo("ses_child", input?.directory ?? process.cwd())
          }),
        list: () => Effect.succeed([]),
        messages: () => Effect.succeed([]),
      })
      const prompt = makePromptLayer(reply("done"))
      const instanceStore = instanceStoreWith(<A, E, R>(_input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
              ...makeSpawnInput(),
              directory: tmp.path,
              executionDirectory: workspace,
            })
            yield* Fiber.await(result.fiber)
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessions, prompt)),
          Effect.provideService(InstanceStore.Service, instanceStore),
          Effect.orDie,
        ),
      )

      const rules = created?.permission ?? []
      expect(rules).toContainEqual(deny)
      expect(Permission.evaluate("external_directory", path.join(workspace, "file"), rules).action).toBe("deny")
      expect(rules.filter((rule) => rule.permission === "external_directory" && rule.action === "allow")).toEqual([])
    } finally {
      await $`git worktree remove --force ${workspace}`.cwd(tmp.path).quiet().catch(() => undefined)
    }
  })

  it("grants only the verified artifact directory and keeps an inherited deny", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(os.tmpdir(), `opencode-spawn-artifact-${Math.random().toString(36).slice(2)}`)
    await $`git worktree add --detach ${linked} HEAD`.cwd(tmp.path).quiet()
    const workspace = await fs.realpath(linked)
    const source = path.join(workspace, "report.txt")
    await fs.writeFile(source, "source")
    const ref = await Effect.runPromise(
      commitOutputFileRef(source, {
        workflow_id: "wf-1",
        node_id: "node-1",
        child_session_id: "ses_child",
        replan_attempt: 0,
      }),
    )
    if (!ref) throw new Error("failed to commit artifact")
    const target = ref.path
    const deny = {
      permission: "external_directory",
      pattern: path.join(workspace, "secret", "**").replaceAll("\\", "/"),
      action: "deny",
    } as const
    let created: Parameters<Session.Interface["create"]>[0]
    try {
      const { dagLayer } = makeEventTracker({
        getWorkflow: () => Effect.succeed(makeWorkflowRow({ directory: tmp.path, executionDirectory: workspace })),
      })
      const sessions = Layer.mock(Session.Service, {
        get: () => Effect.succeed({ ...sessionInfo("ses_parent"), permission: [deny] }),
        create: (input) =>
          Effect.sync(() => {
            created = input
            return sessionInfo("ses_child", input?.directory ?? process.cwd())
          }),
        list: () => Effect.succeed([]),
        messages: () => Effect.succeed([]),
      })
      const prompt = makePromptLayer(reply("done"))
      const instanceStore = instanceStoreWith(<A, E, R>(_input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
              ...makeSpawnInput(),
              directory: tmp.path,
              executionDirectory: workspace,
              inputArtifacts: [ref],
            })
            yield* Fiber.await(result.fiber)
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessions, prompt)),
          Effect.provideService(InstanceStore.Service, instanceStore),
          Effect.orDie,
        ),
      )

      const rules = created?.permission ?? []
      expect(rules).toContainEqual(deny)
      expect(rules).toContainEqual({
        permission: "external_directory",
        pattern: path.join(path.dirname(target), "*").replaceAll("\\", "/"),
        action: "allow",
      })
      expect(
        rules.filter(
          (rule) =>
            rule.permission === "external_directory" &&
            rule.action === "allow" &&
            rule.pattern.startsWith(workspace.replaceAll("\\", "/") + "/"),
        ),
      ).toEqual([])
      expect(Permission.evaluate("external_directory", path.join(workspace, "secret", "file"), rules).action).toBe(
        "deny",
      )
      expect(Permission.evaluate("external_directory", target, rules).action).toBe("allow")
    } finally {
      await $`git worktree remove --force ${workspace}`.cwd(tmp.path).quiet().catch(() => undefined)
      await fs.rm(path.dirname(target), { recursive: true, force: true })
    }
  })

  it("rejects a node workspace replaced by a plain directory before creating a child", async () => {
    await using tmp = await tmpdir({ git: true })
    const plain = path.join(tmp.path, "plain")
    await fs.mkdir(plain)
    let created = 0
    const { events, dagLayer } = makeEventTracker({
      getWorkflow: () => Effect.succeed(makeWorkflowRow({ directory: tmp.path })),
    })
    const sessions = Layer.mock(Session.Service, {
      get: () => Effect.succeed(sessionInfo("ses_parent")),
      create: () =>
        Effect.sync(() => {
          created++
          return sessionInfo("ses_child", tmp.path)
        }),
      list: () => Effect.succeed([]),
      messages: () => Effect.succeed([]),
    })
    const prompt = makePromptLayer(reply("done"))
    const instanceStore = instanceStoreWith(<A, E, R>(_input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect)
    const fullLayer: Layer.Layer<Dag.Service | Agent.Service | Session.Service | SessionPrompt.Service> =
      Layer.mergeAll(dagLayer, agentLayer, sessions, prompt)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            directory: tmp.path,
            executionDirectory: plain,
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(
        Effect.provide(fullLayer),
        Effect.provideService(InstanceStore.Service, instanceStore),
        Effect.orDie,
      ),
    )

    expect(created).toBe(0)
    expect(events.find((event) => event.type === "failUnrecoverable")?.reason).toContain("workspace_invalid")
  })

  it("inherits the parent session model when the node and agent omit one", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const agentWithoutModel = Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "general",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          tools: {},
          hooks: {},
        }),
    })
    const parentWithModel = Layer.mock(Session.Service, {
      get: () =>
        Effect.succeed({
          ...sessionInfo("ses_parent", process.cwd(), {
            providerID: ProviderV2.ID.make("local-proxy-compatible"),
            id: ModelV2.ID.make("glm-5.2"),
          }),
        }),
      create: (input?: { directory?: string }) =>
        Effect.succeed(sessionInfo("ses_child", input?.directory ?? process.cwd())),
    })
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentWithoutModel, parentWithModel, prompt)), Effect.orDie),
    )

    expect(promptModel as unknown).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "glm-5.2",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("prefers the configured DAG tier over the worker agent model", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            fallbackModel: {
              providerID: "configured",
              modelID: "dag-tier-model",
            },
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, prompt)), Effect.orDie),
    )

    expect(promptModel as unknown).toEqual({
      providerID: "configured",
      modelID: "dag-tier-model",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("canonicalizes a provider-qualified model from a persisted node", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            node: makeNodeRow({
              modelId: "local-proxy-compatible/glm-5.2",
              modelProviderId: "local-proxy-compatible",
            }),
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, prompt)), Effect.orDie),
    )

    expect(promptModel as unknown).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "glm-5.2",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("publishes NodeCompleted with output text on success", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed successfully")))

    const completed = findEvent(events, "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed successfully")

    const started = findEvent(events, "nodeStarted")
    expect(started).toBeDefined()
  })

  it("publishes verdict_fail when the provider returns no text output", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("")))

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
    expect(findEvent(events, "nodeFailed")).toEqual(
      expect.objectContaining({
        reason: "provider returned empty output",
        trigger: "verdict_fail",
      }),
    )
  })

  it("classifies empty and whitespace-only text parts like missing text", async () => {
    for (const text of ["", " \n\t "]) {
      const { events, dagLayer } = makeEventTracker()
      await runSpawn(dagLayer, makePromptLayer(reply(text, true)))
      expect(findEvent(events, "nodeCompleted")).toBeUndefined()
      expect(findEvent(events, "nodeFailed")).toEqual(
        expect.objectContaining({
          reason: "provider returned empty output",
          trigger: "verdict_fail",
        }),
      )
    }
  })

  it("preserves non-empty text byte-for-byte", async () => {
    const { events, dagLayer } = makeEventTracker()
    const text = "\n  exact output\t"
    await runSpawn(dagLayer, makePromptLayer(reply(text, true)))

    expect(findEvent(events, "nodeCompleted")?.output).toBe(text)
  })

  it("publishes NodeFailed when prompt fails", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makeFailingPromptLayer("LLM exploded"))

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("Error: LLM exploded")
    expect(failed!.reason).not.toContain("Cause([Die(")

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
  })

  // Issue #777: the live path must keep the durable assistant error identity
  // in the failure reason; the trigger stays "exec_failed" and the role check
  // precedes the error check so non-assistant results keep the plain reason.
  function replyWith(error: SessionV1.Assistant["error"]): SessionV1.WithParts {
    const info: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: SessionID.make("ses_child"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      error,
    }
    return { info, parts: [] }
  }

  it("keeps a persisted abort identity in the live NodeFailed reason", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(
      dagLayer,
      makePromptLayer(
        replyWith({ name: "MessageAbortedError", data: { message: "Aborted" } } satisfies SessionV1.Assistant["error"]),
      ),
    )

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.trigger).toBe("exec_failed")
    expect(failed!.reason).toContain("child model turn stopped before a successful result")
    expect(failed!.reason).toContain("(MessageAbortedError)")
    expect(failed!.reason).toContain("interrupted")
    expect(failed!.reason).toContain("source unknown")
    expect(failed!.reason).toContain("checking side effects")
    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
  })

  it("keeps a genuine failure identity in the live NodeFailed reason", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(
      dagLayer,
      makePromptLayer(
        replyWith({
          name: "UnknownError",
          data: { message: "provider exploded" },
        } satisfies SessionV1.Assistant["error"]),
      ),
    )

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.trigger).toBe("exec_failed")
    expect(failed!.reason).toBe("child model turn stopped before a successful result (UnknownError)")
    expect(failed!.reason).not.toContain("interrupted")
  })

  it("keeps the plain live reason for a non-assistant prompt result", async () => {
    const { events, dagLayer } = makeEventTracker()
    const base = reply("")
    const nonAssistant: SessionV1.WithParts = {
      info: {
        id: base.info.id,
        sessionID: base.info.sessionID,
        role: "user",
        time: { created: base.info.time.created },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      },
      parts: [],
    }
    await runSpawn(dagLayer, makePromptLayer(nonAssistant))

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toBe("child model turn stopped before a successful result")
    expect(failed!.trigger).toBe("exec_failed")
  })

  it("publishes exactly one terminal event per node", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("done")))

    const terminal = events.filter((e) => e.type === "nodeCompleted" || e.type === "nodeFailed")
    expect(terminal.length).toBe(1)
  })

  it("notification preparation defects cannot publish a second terminal event", async () => {
    const { events, dagLayer } = makeEventTracker()
    const hooks: string[] = []
    await runSpawn(
      dagLayer,
      Layer.merge(
        makePromptLayer(reply("done")),
        Layer.mock(SettingsHook.Service, {
          registerScoped: () => Effect.void,
          unregisterScoped: () => Effect.void,
          trigger: (payload) =>
            Effect.sync(() => {
              hooks.push(payload.event)
              return { additionalContexts: [], systemMessages: [] }
            }),
        }),
      ),
    )
    // This fixture intentionally has no store.getNode: notification preparation
    // fails after nodeCompleted, but that optional notification is not execution.
    expect(hooks).toEqual(["SubagentStart"])
    expect(events.filter((e) => e.type === "nodeCompleted" || e.type === "nodeFailed").map((e) => e.type)).toEqual([
      "nodeCompleted",
    ])
  })

  for (const status of ["completed", "failed", "stale-attempt", "stale-child", "cancelled"] as const)
    it(`notifies Stop only for the settled live attempt: ${status}`, async () => {
      const { events, dagLayer } = makeEventTracker({
        getNode: () =>
          Effect.succeed(
            makeNodeRow({
              status: status === "failed" || status === "cancelled" ? "failed" : "completed",
              superseded: status === "cancelled",
              childSessionId: status === "stale-child" ? "ses_other" : "ses_child",
              replanAttempts: status === "stale-attempt" ? 1 : 0,
            }),
          ),
      })
      const hooks: string[] = []
      const appended: string[] = []
      const unregistered: string[] = []
      const userID = MessageID.ascending()
      await runSpawn(
        dagLayer,
        Layer.mergeAll(
          makePromptLayer(reply(status === "failed" ? "" : "done")),
          Layer.mock(Session.Service, {
            ...sessionStub,
            messages: ({ sessionID }) =>
              Effect.succeed<SessionV1.WithParts[]>([
                {
                  info: {
                    id: userID,
                    sessionID,
                    role: "user",
                    time: { created: 1 },
                    agent: "build",
                    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
                  },
                  parts: [],
                },
              ]),
            updatePart: (part) =>
              Effect.sync(() => {
                expect(part.messageID).toBe(userID)
                expect(part.sessionID).toBe(SessionID.make("ses_child"))
                if (part.type === "text") appended.push(part.text)
                return part
              }),
          }),
          Layer.mock(SettingsHook.Service, {
            registerScoped: () => Effect.void,
            unregisterScoped: (sessionID) =>
              Effect.sync(() => {
                unregistered.push(sessionID)
              }),
            trigger: (payload, context) =>
              Effect.sync(() => {
                hooks.push(payload.event)
                expect(context.sessionID).toBe("ses_parent")
                if (payload.event !== "SubagentStop") return { additionalContexts: [], systemMessages: [] }
                // Completion/failure must already be durable before Stop can observe it.
                expect(events.filter((event) => ["nodeCompleted", "nodeFailed"].includes(event.type))).toHaveLength(1)
                expect(payload.agentID).toBe("ses_child")
                expect(payload.agentTranscriptPath).toBeString()
                expect(payload.stopHookActive).toBe(false)
                expect(payload.backgroundTasks).toEqual([])
                return {
                  additionalContexts: ["settled context"],
                  systemMessages: ["notice"],
                  blocked: { reason: "block cannot reopen settlement", command: "fixture" },
                  stopReason: "stop notice",
                }
              }),
          }),
        ),
      )
      const current = status === "completed" || status === "failed"
      expect(hooks).toEqual(current ? ["SubagentStart", "SubagentStop"] : ["SubagentStart"])
      expect(appended).toEqual(current ? ["settled context"] : [])
      expect(unregistered).toEqual(["ses_child"])
      expect(
        events.filter((event) => ["nodeCompleted", "nodeFailed"].includes(event.type)).map((event) => event.type),
      ).toEqual([status === "failed" ? "nodeFailed" : "nodeCompleted"])
    })

  it("releases its permit for the next node", async () => {
    const { events, dagLayer } = makeEventTracker()
    const semaphore = Semaphore.makeUnsafe(1)
    const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, makePromptLayer(reply("done")))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(first.fiber)
          const second = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(second.fiber)
        }),
      ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
    )

    expect(events.filter((event) => event.type === "nodeCompleted")).toHaveLength(2)
  })
})

describe("spawnNode terminalization during spawn window", () => {
  it("does NOT publish spurious NodeFailed when node was cancelled mid-spawn", async () => {
    const events: TrackedEvent[] = []
    let cancelCalled = false
    const dagLayer = Layer.mock(Dag.Service, {
      store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.fail(new TerminalViolationError("node-1", "failed", "running")),
      nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
        Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID })),
      ),
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
      ),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () => Effect.die(new Error("prompt should NOT be called after terminalization")),
      cancel: () =>
        Effect.sync(() => {
          cancelCalled = true
        }),
    })

    const semaphore = Semaphore.makeUnsafe(1)
    const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
    )

    expect(events.filter((e) => e.type === "nodeFailed")).toEqual([])
    expect(events.filter((e) => e.type === "nodeCompleted")).toEqual([])
    expect(cancelCalled).toBe(true)
  })

  it("cancels the child session when nodeStarted fails after session creation", async () => {
    const events: TrackedEvent[] = []
    let cancelCalled = false
    let promptCalled = false
    const dagLayer = Layer.mock(Dag.Service, {
      store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.fail(new Error("nodeStarted write failed")),
      nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
        Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID })),
      ),
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
      ),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () =>
        Effect.sync(() => {
          promptCalled = true
          return reply("unexpected")
        }),
      cancel: () =>
        Effect.sync(() => {
          cancelCalled = true
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer))) as Effect.Effect<never>,
    )

    expect(promptCalled).toBe(false)
    expect(findEvent(events, "nodeFailed")?.reason).toContain("nodeStarted write failed")
    expect(cancelCalled).toBe(true)
  })
})

describe("boundedCancel", () => {
  it("does not interrupt an uninterruptible cancellation at its bound", async () => {
    const release = Deferred.makeUnsafe<void>()
    const entered = Deferred.makeUnsafe<void>()
    const fiber = Effect.runFork(
      boundedCancel(
        Effect.uninterruptible(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        "uninterruptible-test",
        20,
      ),
    )
    const result = await Effect.runPromise(
      Deferred.await(entered).pipe(
        Effect.andThen(Fiber.await(fiber).pipe(Effect.timeoutOption("100 millis"))),
      ),
    )

    expect(Option.isNone(result)).toBe(true)
    expect(Deferred.isDoneUnsafe(release)).toBe(false)
    Deferred.doneUnsafe(release, Effect.void)
    await Effect.runPromise(Fiber.await(fiber))
  })
})
