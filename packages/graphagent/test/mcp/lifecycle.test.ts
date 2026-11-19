import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { expect, mock, beforeEach, afterAll } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Logger } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { EventV2 } from "@graphagent/core/event"
import { FSUtil } from "@graphagent/core/fs-util"
import { Hash } from "@graphagent/core/util/hash"
import { Project } from "@graphagent/core/project"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Git } from "../../src/git"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import type { InstanceContext } from "../../src/project/instance-context"
import { ProjectTrust } from "../../src/project/trust"
import { TuiEvent } from "../../src/server/tui-event"
import { McpAuth } from "../../src/mcp/auth"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// --- Mock infrastructure ---

// Per-client state for controlling mock behavior
interface MockClientState {
  capabilities: { tools?: object; prompts?: object; resources?: object }
  capabilitiesShouldThrow: boolean
  instructions?: string
  tools: Array<{ name: string; description?: string; inputSchema: object; outputSchema?: object }>
  listToolsCalls: number
  listPromptsCalls: number
  listResourcesCalls: number
  listResourceTemplatesCalls: number
  getPromptTimeout?: number
  readResourceTimeout?: number
  requestCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  toolPages: Record<
    string,
    {
      tools: Array<{ name: string; description?: string; inputSchema: object; outputSchema?: object }>
      nextCursor?: string
    }
  >
  promptPages: Record<string, { prompts: Array<{ name: string; description?: string }>; nextCursor?: string }>
  resourcePages: Record<
    string,
    { resources: Array<{ name: string; uri: string; description?: string }>; nextCursor?: string }
  >
  resourceTemplatePages: Record<
    string,
    { resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>; nextCursor?: string }
  >
  closed: boolean
  clientOptions?: { capabilities?: { roots?: { listChanged?: boolean } } }
  requestHandlers: Map<unknown, (...args: any[]) => Promise<any>>
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
// Tracks how many Client instances were created (detects leaks)
let clientCreateCount = 0
// Tracks how many times transport.close() is called across all mock transports
let transportCloseCount = 0
// Captures the opts passed to each MockStdioTransport, keyed by lastCreatedClientName
const stdioOptsByName = new Map<string, any>()

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      capabilitiesShouldThrow: false,
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listPromptsCalls: 0,
      listResourcesCalls: 0,
      listResourceTemplatesCalls: 0,
      requestCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      resourceTemplates: [],
      toolPages: {},
      promptPages: {},
      resourcePages: {},
      resourceTemplatePages: {},
      closed: false,
      requestHandlers: new Map(),
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

// Mock transport that succeeds or fails based on connectShouldFail / connectShouldHang
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  constructor(opts: any) {
    if (lastCreatedClientName) stdioOptsByName.set(lastCreatedClientName, opts)
  }
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

void mock.module("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: MockStdioTransport,
}))

// v2 packs Client, StreamableHTTPClientTransport, and UnauthorizedError into
// the single package root, so one mock.module covers the whole surface src
// imports. Every export src binds at runtime must be present — a missing
// UnauthorizedError would make `instanceof` throw instead of classify.
// Mock Client that delegates to per-name MockClientState
void mock.module("@modelcontextprotocol/client", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
  UnauthorizedError: MockUnauthorizedError,
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_info: any, options?: MockClientState["clientOptions"]) {
      clientCreateCount++
      this._state = getOrCreateClientState(lastCreatedClientName)
      this._state.clientOptions = options
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // After successful connect, bind to the last-created client name
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setRequestHandler(schema: unknown, handler: (...args: any[]) => Promise<any>) {
      this._state.requestHandlers.set(schema, handler)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    getServerCapabilities() {
      if (this._state?.capabilitiesShouldThrow) throw new Error("capability discovery failed")
      return this._state?.capabilities
    }

    getInstructions() {
      return this._state?.instructions
    }

    async listTools(params?: { cursor?: string }) {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      const page = this._state?.toolPages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { tools: this._state?.tools ?? [] }
    }

    async request(
      request: { method: string; params?: { cursor?: string } },
      schema: { parse: (value: unknown) => unknown },
    ) {
      if (this._state) this._state.requestCalls++
      if (request.method === "tools/list") {
        return schema.parse(
          this._state?.toolPages[request.params === undefined ? "initial" : (request.params.cursor ?? "")] ?? {
            tools: this._state?.tools ?? [],
          },
        )
      }
      throw new Error(`unsupported request: ${request.method}`)
    }

    async listPrompts(params?: { cursor?: string }) {
      if (this._state) this._state.listPromptsCalls++
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      const page = this._state?.promptPages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources(params?: { cursor?: string }) {
      if (this._state) this._state.listResourcesCalls++
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      const page = this._state?.resourcePages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { resources: this._state?.resources ?? [] }
    }

    async listResourceTemplates(params?: { cursor?: string }) {
      if (this._state) this._state.listResourceTemplatesCalls++
      const page = this._state?.resourceTemplatePages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { resourceTemplates: this._state?.resourceTemplates ?? [] }
    }

    async getPrompt(_params: unknown, options?: { timeout?: number }) {
      if (this._state) this._state.getPromptTimeout = options?.timeout
      return { messages: [] }
    }

    async readResource(params: { uri: string }, options?: { timeout?: number }) {
      if (this._state) this._state.readResourceTimeout = options?.timeout
      return { contents: [{ uri: params.uri, text: "test" }] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

afterAll(() => {
  // These MCP SDK mocks are file-scoped fixtures, but Bun's mock.module registry
  // is process-global during the full suite. Restore it so tests that exercise
  // a real SDK Client don't inherit this reduced mock implementation.
  mock.restore()
})

// Import after mocks
const { MCP } = await import("../../src/mcp/index")
const { McpConfig } = await import("../../src/mcp/config")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { McpCatalog } = await import("../../src/mcp/catalog")

const it = testEffect(MCP.defaultLayer)

// The toasts the service publishes, in order. A test that reads them starts from an empty list.
type Toast = { title?: string; message: string; variant: string; duration?: number }
const toasts: Toast[] = []

const isToast = (data: unknown): data is Toast =>
  typeof data === "object" && data !== null && "message" in data && "variant" in data

// The real bridge, except that it keeps what is published as a toast.
const capturingBridge = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const original = yield* EventV2Bridge.Service
    const publish: EventV2.Interface["publish"] = (definition, data, options) => {
      if (definition.type === TuiEvent.ToastShow.type && isToast(data)) toasts.push(data)
      return original.publish(definition, data, options)
    }
    return EventV2Bridge.Service.of({ ...original, publish })
  }),
).pipe(Layer.provide(EventV2Bridge.defaultLayer))

// `MCP.defaultLayer` with that bridge.
const toastIt = testEffect(
  MCP.layer.pipe(
    Layer.provide(McpAuth.defaultLayer),
    Layer.provide(capturingBridge),
    Layer.provide(ProjectTrust.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  ),
)

/**
 * The real MCP service with an isolated ProjectTrust store so project-layer
 * servers can be exercised before and after a decision. `it.instance` always
 * boots a trusted instance, so these tests provide their own InstanceRef.
 */
const mcpWithTrust = (stateDirectory: string) =>
  MCP.layer.pipe(
    Layer.provideMerge(ProjectTrust.makeLayer({ stateDirectory })),
    Layer.provide(McpAuth.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Git.defaultLayer),
  )

const trustIt = testEffect(Layer.empty)

trustIt.live("a project MCP server starts no client before trust, starts after it and closes on revoke", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "mcp-trust-root-")))
    const stateDirectory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "mcp-trust-state-")))
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(stateDirectory, { recursive: true, force: true })
      }),
    )
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(root, ".agents"), { recursive: true })
      await fs.writeFile(
        path.join(root, ".agents", "mcp.json"),
        JSON.stringify({ mcpServers: { "project-trusted": { type: "local", command: ["echo", "test"] } } }),
      )
    })

    const services = yield* Layer.build(mcpWithTrust(stateDirectory))
    const mcp = Context.get(services, MCP.Service)
    const trust = Context.get(services, ProjectTrust.Service)
    const ctx: InstanceContext = {
      directory: root,
      worktree: root,
      root,
      project: { id: Project.ID.global, worktree: root, time: { created: 0, updated: 0 }, sandboxes: [] },
    }
    const inInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(InstanceRef, ctx))

    lastCreatedClientName = "project-trusted"
    const serverState = getOrCreateClientState("project-trusted")

    expect((yield* inInstance(mcp.status()))["project-trusted"]).toEqual({ status: "disabled" })
    expect(clientCreateCount).toBe(0)
    const entries = yield* inInstance(trust.list())
    expect(entries.map((entry) => entry.category)).toEqual(["mcp"])

    yield* inInstance(trust.decide([{ id: entries[0].id, state: "trusted" }]))
    yield* inInstance(
      pollWithTimeout(
        mcp
          .status()
          .pipe(Effect.map((status) => (status["project-trusted"]?.status === "connected" ? true : undefined))),
        "the trusted MCP server did not start",
      ),
    )
    expect(clientCreateCount).toBe(1)
    expect(serverState.closed).toBe(false)

    yield* inInstance(trust.decide([{ id: entries[0].id, state: "revoked" }]))
    yield* inInstance(
      pollWithTimeout(
        mcp
          .status()
          .pipe(Effect.map((status) => (status["project-trusted"]?.status === "disabled" ? true : undefined))),
        "revocation did not stop the MCP server",
      ),
    )
    expect(serverState.closed).toBe(true)
    expect(clientCreateCount).toBe(1)
  }),
)

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

it.instance(
  "advertises and lists the instance directory as its root",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        lastCreatedClientName = "roots"
        yield* mcp.add("roots", { type: "local", command: ["echo", "test"] })

        const state = getOrCreateClientState("roots")
        expect(state.clientOptions?.capabilities?.roots).toEqual({})
        expect(state.clientOptions?.capabilities?.roots?.listChanged).toBeUndefined()

        const handler = state.requestHandlers.get("roots/list")
        expect(handler).toBeDefined()
        const result = yield* Effect.promise(() => handler?.() ?? Promise.reject(new Error("roots handler missing")))
        expect(result).toEqual({ roots: [{ uri: pathToFileURL(directory).href }] })
      }),
    ),
  { mcp: {} },
)

it.instance(
  "local mcp cwd resolves relative paths against instance directory",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        lastCreatedClientName = "rel-cwd"
        yield* mcp.add("rel-cwd", { type: "local", command: ["echo", "test"], cwd: "plugins/sub" })
        expect(stdioOptsByName.get("rel-cwd")?.cwd).toBe(path.resolve(directory, "plugins/sub"))
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: tools() are cached after connect
// ========================================================================

it.instance(
  "tools() reuses cached tool definitions after connect",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "my-server"
        const serverState = getOrCreateClientState("my-server")
        serverState.tools = [
          { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
        ]

        // First: add the server successfully
        const addResult = yield* mcp.add("my-server", {
          type: "local",
          command: ["echo", "test"],
        })
        expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

        expect(serverState.listToolsCalls).toBe(1)

        const toolsA = yield* mcp.tools()
        const toolsB = yield* mcp.tools()
        expect(Object.keys(toolsA).length).toBeGreaterThan(0)
        expect(Object.keys(toolsB).length).toBeGreaterThan(0)
        expect(serverState.listToolsCalls).toBe(1)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "instructions() returns connected server instructions with tool names",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "guide-server"
        const serverState = getOrCreateClientState("guide-server")
        serverState.instructions = "Use lookup before mutate."

        yield* mcp.add("guide-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(yield* mcp.instructions()).toContainEqual({
          name: "guide-server",
          instructions: "Use lookup before mutate.",
          tools: ["guide-server_test_tool"],
        })
      }),
    ),
  { mcp: {} },
)

it.instance(
  "instructions() omits empty and disconnected server instructions",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "temporary-server"
        getOrCreateClientState("temporary-server").instructions = "Temporary guidance."

        yield* mcp.add("temporary-server", {
          type: "local",
          command: ["echo", "test"],
        })
        yield* mcp.disconnect("temporary-server")

        lastCreatedClientName = "blank-server"
        getOrCreateClientState("blank-server").instructions = "   "

        yield* mcp.add("blank-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const instructions = yield* mcp.instructions()
        expect(instructions.some((item) => item.name === "temporary-server")).toBe(false)
        expect(instructions.some((item) => item.name === "blank-server")).toBe(false)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: model-facing tool keys are unique and at most 64 characters (Issue #1459)
// ========================================================================

const emptyInput = { type: "object", properties: {} }
const toolKeySuffix = (server: string, tool: string) => Hash.sha256(server + "\0" + tool).slice(0, 8)

// Connect a server that lists `names` as its tools (and, if given, serves `instructions`).
const connectWith = (mcp: MCPNS.Interface, server: string, names: string[], instructions?: string) => {
  lastCreatedClientName = server
  const state = getOrCreateClientState(server)
  state.tools = names.map((name) => ({ name, description: `${server}/${name}`, inputSchema: emptyInput }))
  state.instructions = instructions
  return mcp.add(server, { type: "local", command: ["echo", "test"] })
}

// The (server, tool) each key of `tools()` stands for.
const bound = (tools: Record<string, object>) =>
  Object.fromEntries(
    Object.entries(tools).map(([key, item]) => {
      const binding = McpCatalog.toolBinding(item)
      return [key, binding ? `${binding.server}/${binding.tool}` : undefined]
    }),
  )

it.instance(
  "tools() keeps both tools when two servers sanitize to the same key (B1)",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        yield* connectWith(mcp, "a.b", ["c"])
        yield* connectWith(mcp, "a", ["b.c"])

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(2)
        expect(bound(tools)).toEqual({
          [`a_b_c_${toolKeySuffix("a.b", "c")}`]: "a.b/c",
          [`a_b_c_${toolKeySuffix("a", "b.c")}`]: "a/b.c",
        })
      }),
    ),
  { mcp: {} },
)

it.instance(
  "tools() gives the same keys whichever server connects first",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        yield* connectWith(mcp, "a", ["b.c"])
        yield* connectWith(mcp, "a.b", ["c"])

        expect(bound(yield* mcp.tools())).toEqual({
          [`a_b_c_${toolKeySuffix("a.b", "c")}`]: "a.b/c",
          [`a_b_c_${toolKeySuffix("a", "b.c")}`]: "a/b.c",
        })
      }),
    ),
  { mcp: {} },
)

it.instance(
  "tools() cuts a key longer than 64 characters and keeps the real tool name in the binding",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const tool = "very_long_tool_name_".repeat(5)
        yield* connectWith(mcp, "srv", [tool, "short"])

        const keys = Object.keys(yield* mcp.tools()).sort()
        expect(keys).toHaveLength(2)
        expect(keys.every((key) => key.length <= 64)).toBe(true)
        expect(keys).toContain("srv_short")
        const long = keys.find((key) => key !== "srv_short")!
        expect(long).toBe(("srv_" + tool).slice(0, 55) + "_" + toolKeySuffix("srv", tool))
        expect(bound(yield* mcp.tools())[long]).toBe(`srv/${tool}`)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "tools() does not hand out the reserved mcp_describe and mcp_call keys",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        yield* connectWith(mcp, "mcp", ["describe", "call", "callable"])

        const keys = Object.keys(yield* mcp.tools()).sort()
        expect(keys).toEqual(
          [
            "mcp_callable",
            `mcp_call_${toolKeySuffix("mcp", "call")}`,
            `mcp_describe_${toolKeySuffix("mcp", "describe")}`,
          ].sort(),
        )
      }),
    ),
  { mcp: {} },
)

// The warnings `tools()` logs while it runs.
const warnedBy = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const warnings: string[] = []
  const collector = Logger.make((entry) => {
    if (entry.logLevel === "Warn") warnings.push(JSON.stringify(entry.message))
  })
  return effect.pipe(
    Effect.provide(Logger.layer([collector])),
    Effect.map((result) => ({ result, warnings })),
  )
}

it.instance(
  "tools() warns about every key it rewrote",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        yield* connectWith(mcp, "a.b", ["c"])
        yield* connectWith(mcp, "a", ["b.c"])
        yield* connectWith(mcp, "plain", ["y"])

        const { result, warnings } = yield* warnedBy(mcp.tools())
        expect(Object.keys(result)).toHaveLength(3)
        expect(warnings).toHaveLength(2)
        expect(warnings.every((message) => message.includes("rewritten"))).toBe(true)
        expect(warnings.some((message) => message.includes("a.b") && message.includes(toolKeySuffix("a.b", "c")))).toBe(
          true,
        )
        expect(warnings.some((message) => message.includes("b.c") && message.includes(toolKeySuffix("a", "b.c")))).toBe(
          true,
        )
      }),
    ),
  { mcp: {} },
)

it.instance(
  "tools() binds a rewritten key to the key the tool had before, and a plain key to nothing",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const long = "very_long_tool_name_".repeat(5)
        yield* connectWith(mcp, "a.b", ["c"])
        yield* connectWith(mcp, "a", ["b.c"])
        yield* connectWith(mcp, "plain", ["y"])
        yield* connectWith(mcp, "long", [long])
        yield* connectWith(mcp, "mcp", ["describe"])

        const tools = yield* mcp.tools()
        const binding = (key: string) => McpCatalog.toolBinding(tools[key])
        // Two tools that sanitize to `a_b_c`, an overlong key and a reserved name each remember the key they had.
        expect(binding(`a_b_c_${toolKeySuffix("a.b", "c")}`)?.baseKey).toBe("a_b_c")
        expect(binding(`a_b_c_${toolKeySuffix("a", "b.c")}`)?.baseKey).toBe("a_b_c")
        expect(binding(("long_" + long).slice(0, 55) + "_" + toolKeySuffix("long", long))?.baseKey).toBe("long_" + long)
        expect(binding(`mcp_describe_${toolKeySuffix("mcp", "describe")}`)?.baseKey).toBe("mcp_describe")
        // A key that stayed as it was carries nothing: its binding is what it was before.
        expect(binding("plain_y")).toEqual({
          server: "plain",
          tool: "y",
          source: "unknown",
          requiresUserInteraction: false,
        })
      }),
    ),
  { mcp: {} },
)

it.instance(
  "tools() keeps the first of a tool a server lists twice and says it skipped the other",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        yield* connectWith(mcp, "dup", ["x", "x"])

        const { result, warnings } = yield* warnedBy(mcp.tools())
        // One tool, so it is not a collision: its key stays the plain one.
        expect(Object.keys(result)).toEqual(["dup_x"])
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("skipped")
        expect(warnings[0]).toContain("dup")
      }),
    ),
  { mcp: {} },
)

it.instance(
  "instructions() lists the keys tools() uses, rewritten keys included, each once",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        yield* connectWith(mcp, "a.b", ["c"], "Guidance for a.b.")
        yield* connectWith(mcp, "a", ["b.c"])
        yield* connectWith(mcp, "dup", ["x", "x"], "Guidance for dup.")

        const instructions = yield* mcp.instructions()
        expect(instructions).toEqual([
          { name: "a.b", instructions: "Guidance for a.b.", tools: [`a_b_c_${toolKeySuffix("a.b", "c")}`] },
          { name: "dup", instructions: "Guidance for dup.", tools: ["dup_x"] },
        ])
        const keys = Object.keys(yield* mcp.tools())
        for (const item of instructions) for (const key of item.tools) expect(keys).toContain(key)
      }),
    ),
  { mcp: {} },
)

// Issue #1459: a server marked `deferred` binds its tools as deferred; the runtime entry wins over the file's.
it.instance(
  "tools() binds deferred from the server's config, and only on a tool of a deferred server",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "lazy"
        getOrCreateClientState("lazy").tools = [{ name: "a", description: "lazy/a", inputSchema: emptyInput }]
        yield* mcp.add("lazy", { type: "local", command: ["echo", "test"], deferred: true })
        yield* connectWith(mcp, "eager", ["b"])
        // A file entry marks the server deferred; a runtime add that says nothing keeps that.
        lastCreatedClientName = "filed"
        getOrCreateClientState("filed").tools = [{ name: "c", description: "filed/c", inputSchema: emptyInput }]
        yield* mcp.add("filed", { type: "local", command: ["echo", "test"] })
        // A runtime entry that says `deferred: false` wins over the file's `true`.
        lastCreatedClientName = "forced"
        getOrCreateClientState("forced").tools = [{ name: "d", description: "forced/d", inputSchema: emptyInput }]
        yield* mcp.add("forced", { type: "local", command: ["echo", "test"], deferred: false })

        const tools = yield* mcp.tools()
        const binding = (key: string) => McpCatalog.toolBinding(tools[key])
        expect(binding("lazy_a")?.deferred).toBe(true)
        expect(binding("filed_c")?.deferred).toBe(true)
        // Nothing else carries the field: an eager tool's binding is what it was before.
        expect(binding("eager_b")).toEqual({
          server: "eager",
          tool: "b",
          source: "unknown",
          requiresUserInteraction: false,
        })
        expect(binding("forced_d")?.deferred).toBeUndefined()
      }),
    ),
  {
    mcp: {
      filed: { type: "local", command: ["echo", "test"], deferred: true },
      forced: { type: "local", command: ["echo", "test"], deferred: true },
    },
  },
)

// ========================================================================
// Test: large definitions of the servers that are not deferred are told about once (Issue #1459)
// ========================================================================

const WARN_BYTES = 16 * 1024
const EMPTY_SCHEMA_BYTES = Buffer.byteLength(JSON.stringify(emptyInput))
const LARGE_TITLE = "MCP tool definitions are large"
const largeMessage = (kb: number) => `set "deferred": true in mcp.json (about ${kb} KB per request)`

// Connect a server with one tool for each size in `sizes`: its definition (description and schema) is that many bytes.
const connectSized = (mcp: MCPNS.Interface, server: string, sizes: number[], deferred = false) => {
  lastCreatedClientName = server
  getOrCreateClientState(server).tools = sizes.map((bytes, index) => ({
    name: `t${index}`,
    description: "x".repeat(bytes - EMPTY_SCHEMA_BYTES),
    inputSchema: emptyInput,
  }))
  return mcp.add(server, { type: "local", command: ["echo", "test"], ...(deferred ? { deferred } : {}) })
}

toastIt.instance(
  "tools() tells once that the definitions of the servers that are not deferred are large",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        yield* connectSized(mcp, "big", [10_000, WARN_BYTES - 10_000 + 1])
        // The warning is `tools()`'s: connecting a server says nothing.
        expect(toasts).toEqual([])

        yield* mcp.tools()
        expect(toasts).toEqual([{ title: LARGE_TITLE, message: largeMessage(17), variant: "warning", duration: 8000 }])
        // Later requests do not say it again.
        yield* mcp.tools()
        yield* mcp.tools()
        expect(toasts).toHaveLength(1)
      }),
    ),
  { mcp: {} },
)

toastIt.instance(
  "tools() does not tell at exactly 16384 bytes, and does once a tool takes the total over",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        yield* connectSized(mcp, "edge", [WARN_BYTES])
        yield* mcp.tools()
        expect(toasts).toEqual([])

        // A tool with no description and an empty schema is 2 bytes.
        lastCreatedClientName = "extra"
        getOrCreateClientState("extra").tools = [{ name: "tiny", inputSchema: {} }]
        yield* mcp.add("extra", { type: "local", command: ["echo", "test"] })
        yield* mcp.tools()
        expect(toasts.map((toast) => toast.message)).toEqual([largeMessage(17)])
      }),
    ),
  { mcp: {} },
)

toastIt.instance(
  "tools() leaves a deferred server out of the total",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        yield* connectSized(mcp, "lazy", [WARN_BYTES, WARN_BYTES], true)
        yield* connectSized(mcp, "small", [1000])
        yield* mcp.tools()
        expect(toasts).toEqual([])

        // What is said later counts the servers that are not deferred: 18000 bytes, not 50 KB.
        yield* connectSized(mcp, "eager", [17_000])
        yield* mcp.tools()
        expect(toasts.map((toast) => toast.message)).toEqual([largeMessage(18)])
      }),
    ),
  { mcp: {} },
)

toastIt.instance(
  "tools() adds up the servers, and tells when a later one takes the total over",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        yield* connectSized(mcp, "one", [9000])
        yield* mcp.tools()
        expect(toasts).toEqual([])

        yield* connectSized(mcp, "two", [9000])
        yield* mcp.tools()
        expect(toasts.map((toast) => toast.message)).toEqual([largeMessage(18)])
      }),
    ),
  { mcp: {} },
)

toastIt.instance(
  "tools() counts a definition in bytes, not in characters",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        // Two descriptions of 5000 characters and 10000 bytes each: 10066 characters in all, 20066 bytes.
        lastCreatedClientName = "wide"
        getOrCreateClientState("wide").tools = ["a", "b"].map((name) => ({
          name,
          description: "\u00e9".repeat(5000),
          inputSchema: emptyInput,
        }))
        yield* mcp.add("wide", { type: "local", command: ["echo", "test"] })
        yield* mcp.tools()
        expect(toasts.map((toast) => toast.message)).toEqual([largeMessage(20)])
      }),
    ),
  { mcp: {} },
)

toastIt.instance(
  "tools() tells about a list_changed refresh that makes the definitions large, and the refresh says nothing",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        lastCreatedClientName = "growing"
        const serverState = getOrCreateClientState("growing")
        serverState.tools = [{ name: "small", description: "small", inputSchema: emptyInput }]
        yield* mcp.add("growing", { type: "local", command: ["echo", "test"] })
        yield* mcp.tools()
        expect(toasts).toEqual([])

        serverState.tools = [{ name: "large", description: "x".repeat(WARN_BYTES), inputSchema: emptyInput }]
        const handler = serverState.notificationHandlers.get("notifications/tools/list_changed")
        yield* Effect.promise(() => handler?.())
        expect(toasts).toEqual([])

        yield* mcp.tools()
        expect(toasts).toHaveLength(1)
      }),
    ),
  { mcp: {} },
)

toastIt.instance(
  "tools() tells about a server that connected at startup",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        toasts.length = 0
        // The server is in mcp.json, so the first call to the service connects it; its mock state is set first.
        lastCreatedClientName = "filed-big"
        getOrCreateClientState("filed-big").tools = [
          { name: "t0", description: "x".repeat(WARN_BYTES), inputSchema: emptyInput },
        ]
        expect(Object.keys(yield* mcp.tools())).toEqual(["filed-big_t0"])
        expect(toasts.map((toast) => toast.message)).toEqual([largeMessage(17)])
      }),
    ),
  { mcp: { "filed-big": { type: "local", command: ["echo", "test"] } } },
)

it.instance(
  "follows cursors when listing tools, prompts, and resources",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "paged-server"
        const serverState = getOrCreateClientState("paged-server")
        serverState.toolPages = {
          initial: {
            tools: [{ name: "tool-one", inputSchema: { type: "object", properties: {} } }],
            nextCursor: "tools-2",
          },
          "tools-2": { tools: [{ name: "tool-two", inputSchema: { type: "object", properties: {} } }] },
        }
        serverState.promptPages = {
          initial: { prompts: [{ name: "prompt-one" }], nextCursor: "prompts-2" },
          "prompts-2": { prompts: [{ name: "prompt-two" }] },
        }
        serverState.resourcePages = {
          initial: { resources: [{ name: "resource-one", uri: "test://one" }], nextCursor: "resources-2" },
          "resources-2": { resources: [{ name: "resource-two", uri: "test://two" }] },
        }
        serverState.resourceTemplatePages = {
          initial: {
            resourceTemplates: [{ name: "template-one", uriTemplate: "test://one/{id}" }],
            nextCursor: "resource-templates-2",
          },
          "resource-templates-2": { resourceTemplates: [{ name: "template-two", uriTemplate: "test://two/{id}" }] },
        }

        yield* mcp.add("paged-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(Object.keys(yield* mcp.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
        expect(Object.keys(yield* mcp.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
        expect(Object.keys(yield* mcp.resources())).toEqual(["paged-server:test://one", "paged-server:test://two"])
        expect(Object.keys(yield* mcp.resourceTemplates())).toEqual([
          "paged-server:test://one/{id}",
          "paged-server:test://two/{id}",
        ])
        expect(serverState.listToolsCalls).toBe(2)
        expect(serverState.listPromptsCalls).toBe(2)
        expect(serverState.listResourcesCalls).toBe(2)
        expect(serverState.listResourceTemplatesCalls).toBe(2)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "stops listing when a server repeats a cursor",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "looping-server"
        const serverState = getOrCreateClientState("looping-server")
        serverState.toolPages = {
          initial: { tools: [], nextCursor: "repeat" },
          repeat: { tools: [], nextCursor: "repeat" },
        }

        yield* mcp.add("looping-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(serverState.listToolsCalls).toBe(2)
        expect(yield* mcp.tools()).toEqual({})
      }),
    ),
  { mcp: {} },
)

it.instance(
  "follows empty cursors",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "empty-cursor-server"
        const serverState = getOrCreateClientState("empty-cursor-server")
        serverState.promptPages = {
          initial: { prompts: [{ name: "prompt-one" }], nextCursor: "" },
          "": { prompts: [{ name: "prompt-two" }] },
        }

        yield* mcp.add("empty-cursor-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(Object.keys(yield* mcp.prompts())).toEqual([
          "empty-cursor-server:prompt-one",
          "empty-cursor-server:prompt-two",
        ])
        expect(serverState.listPromptsCalls).toBe(2)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: tool change notifications refresh the cache
// ========================================================================

it.instance(
  "tool change notifications refresh cached tool definitions",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "status-server"
        const serverState = getOrCreateClientState("status-server")

        yield* mcp.add("status-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const before = yield* mcp.tools()
        expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
        expect(serverState.listToolsCalls).toBe(1)

        serverState.tools = [
          { name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } },
        ]

        const handler = serverState.notificationHandlers.get("notifications/tools/list_changed")
        expect(handler).toBeDefined()
        yield* Effect.promise(() => handler?.())

        const after = yield* mcp.tools()
        expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
        expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
        expect(serverState.listToolsCalls).toBe(2)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: an unreadable mcp.json does not fail the request (Issue #1458)
// ========================================================================

it.instance(
  "tools() keeps the last valid servers when mcp.json becomes unreadable",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        lastCreatedClientName = "cache-server"
        getOrCreateClientState("cache-server")
        yield* mcp.add("cache-server", { type: "local", command: ["echo", "test"] })

        const before = yield* mcp.tools()
        expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)

        yield* Effect.promise(() => fs.writeFile(McpConfig.projectFile(directory), "{ not json"))
        const warnings: unknown[] = []
        const collector = Logger.make((entry) => {
          if (entry.logLevel === "Warn") warnings.push(entry.message)
        })
        const after = yield* mcp.tools().pipe(Effect.provide(Logger.layer([collector])))
        const again = yield* mcp.tools().pipe(Effect.provide(Logger.layer([collector])))

        expect(Object.keys(after)).toEqual(Object.keys(before))
        expect(Object.keys(again)).toEqual(Object.keys(before))
        // The same broken file is reported once, not on every step, and the warning names the file and the reason.
        const reported = warnings.filter(
          (message) => Array.isArray(message) && String(message[0]).includes("mcp.json cannot be read"),
        )
        expect(reported).toHaveLength(1)
        expect(JSON.stringify(reported[0])).toContain("not valid JSONC")
        expect(JSON.stringify(reported[0])).toContain(JSON.stringify(McpConfig.projectFile(directory)).slice(1, -1))
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: connect() / disconnect() lifecycle
// ========================================================================

it.instance(
  "disconnect sets status to disabled and removes client",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "disc-server"
        getOrCreateClientState("disc-server")

        yield* mcp.add("disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const statusBefore = yield* mcp.status()
        expect(statusBefore["disc-server"]?.status).toBe("connected")

        yield* mcp.disconnect("disc-server")

        const statusAfter = yield* mcp.status()
        expect(statusAfter["disc-server"]?.status).toBe("disabled")

        const tools = yield* mcp.tools()
        const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
        expect(serverTools.length).toBe(0)
      }),
    ),
  {
    mcp: {
        "disc-server": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

it.instance(
  "connect() after disconnect() re-establishes the server",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "reconn-server"
        const serverState = getOrCreateClientState("reconn-server")
        serverState.tools = [
          { name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("reconn-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("disabled")

        yield* mcp.connect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("connected")

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
      }),
    ),
  {
    mcp: {
        "reconn-server": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

it.instance(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "replace-server"
        const firstState = getOrCreateClientState("replace-server")

        yield* mcp.add("replace-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(firstState.closed).toBe(false)

        // Create new state for second client
        clientStates.delete("replace-server")
        const secondState = getOrCreateClientState("replace-server")

        // Re-add should close the first client
        yield* mcp.add("replace-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(firstState.closed).toBe(true)
        expect(secondState.closed).toBe(false)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

it.instance(
  "init connects available servers even when one fails",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        // Set up good server
        const goodState = getOrCreateClientState("good-server")
        goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

        // Set up bad server - will fail on listTools during create()
        const badState = getOrCreateClientState("bad-server")
        badState.listToolsShouldFail = true

        // Add good server first
        lastCreatedClientName = "good-server"
        yield* mcp.add("good-server", {
          type: "local",
          command: ["echo", "good"],
        })

        // Add bad server - should fail but not affect good server
        lastCreatedClientName = "bad-server"
        yield* mcp.add("bad-server", {
          type: "local",
          command: ["echo", "bad"],
        })

        const status = yield* mcp.status()
        expect(status["good-server"]?.status).toBe("connected")
        expect(status["bad-server"]?.status).toBe("failed")

        // Good server's tools should still be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
      }),
    ),
  {
    mcp: {
        "good-server": {
          type: "local",
          command: ["echo", "good"],
        },
        "bad-server": {
          type: "local",
          command: ["echo", "bad"],
        },
      },
  },
)

it.instance(
  "returns failed and closes the client when SDK initialization throws",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "defective-server"
        const serverState = getOrCreateClientState("defective-server")
        serverState.capabilitiesShouldThrow = true

        const result = yield* mcp.add("defective-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(statusName(result.status, "defective-server")).toBe("failed")
        expect((yield* mcp.status())["defective-server"]).toEqual({
          status: "failed",
          error: "capability discovery failed",
        })
        expect(serverState.closed).toBe(true)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "falls back when MCP output schema refs fail SDK tool discovery",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "stitch-like-server"
        const serverState = getOrCreateClientState("stitch-like-server")
        serverState.listToolsShouldFail = true
        serverState.listToolsError = "can't resolve reference #/$defs/ScreenInstance from id #"
        serverState.tools = [
          {
            name: "render_screen",
            description: "renders a screen",
            inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
            outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
          },
        ]

        const addResult = yield* mcp.add("stitch-like-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(statusName(addResult.status, "stitch-like-server")).toBe("connected")

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((key) => key.includes("render_screen"))).toBe(true)
        expect(serverState.listToolsCalls).toBe(1)
        expect(serverState.requestCalls).toBe(1)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "does not fall back for non-schema MCP tool discovery errors",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "broken-server"
        const serverState = getOrCreateClientState("broken-server")
        serverState.listToolsShouldFail = true
        serverState.listToolsError = "transport closed"

        const addResult = yield* mcp.add("broken-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(statusName(addResult.status, "broken-server")).toBe("failed")
        expect(serverState.listToolsCalls).toBe(1)
        expect(serverState.requestCalls).toBe(0)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

it.instance(
  "disabled server is marked as disabled without attempting connection",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const countBefore = clientCreateCount

        yield* mcp.add("disabled-server", {
          type: "local",
          command: ["echo", "test"],
          disabled: true,
        })

        // No client should have been created
        expect(clientCreateCount).toBe(countBefore)

        const status = yield* mcp.status()
        expect(status["disabled-server"]?.status).toBe("disabled")
      }),
    ),
  {
    mcp: {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        disabled: true,
      },
    },
  },
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

it.instance(
  "prompts() returns prompts from connected servers",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-server"
        const serverState = getOrCreateClientState("prompt-server")
        serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

        yield* mcp.add("prompt-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(1)
        const key = Object.keys(prompts)[0]
        expect(key).toContain("prompt-server")
        expect(key).toContain("my-prompt")
      }),
    ),
  {
    mcp: {
        "prompt-server": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

it.instance(
  "resources() returns resources from connected servers",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "resource-server"
        const serverState = getOrCreateClientState("resource-server")
        serverState.resources = [
          { name: "my-resource", uri: "file:///test.txt", description: "A test resource" },
          { name: "my-resource", uri: "ui://component-state", description: "A second resource with same name" },
        ]

        yield* mcp.add("resource-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const resources = yield* mcp.resources()
        expect(Object.keys(resources)).toEqual([
          "resource-server:file:///test.txt",
          "resource-server:ui://component-state",
        ])
      }),
    ),
  {
    mcp: {
        "resource-server": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

it.instance(
  "uses per-server timeouts for prompt and resource requests",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "timeout-server"
        const serverState = getOrCreateClientState("timeout-server")

        yield* mcp.add("timeout-server", {
          type: "local",
          command: ["echo", "test"],
          timeout: { request: 2500 },
        })
        yield* mcp.getPrompt("timeout-server", "test")
        yield* mcp.readResource("timeout-server", "test://resource")

        expect(serverState.getPromptTimeout).toBe(2500)
        expect(serverState.readResourceTimeout).toBe(2500)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "resource-only servers connect without listing tools",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "resource-only-server"
        const serverState = getOrCreateClientState("resource-only-server")
        serverState.capabilities = { resources: {} }
        serverState.resources = [{ name: "docs", uri: "docs://readme" }]

        const result = yield* mcp.add("resource-only-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(statusName(result.status, "resource-only-server")).toBe("connected")
        expect(serverState.listToolsCalls).toBe(0)
        expect(Object.keys(yield* mcp.tools())).toHaveLength(0)
        expect(Object.keys(yield* mcp.resources())).toEqual(["resource-only-server:docs://readme"])
        expect(serverState.listResourcesCalls).toBe(1)
        expect(serverState.listPromptsCalls).toBe(0)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "prompt-only servers connect without listing tools",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-only-server"
        const serverState = getOrCreateClientState("prompt-only-server")
        serverState.capabilities = { prompts: {} }
        serverState.prompts = [{ name: "review" }]

        const result = yield* mcp.add("prompt-only-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(statusName(result.status, "prompt-only-server")).toBe("connected")
        expect(serverState.listToolsCalls).toBe(0)
        expect(Object.keys(yield* mcp.tools())).toHaveLength(0)
        expect(Object.keys(yield* mcp.prompts())).toEqual(["prompt-only-server:review"])
        expect(serverState.listPromptsCalls).toBe(1)
        expect(serverState.listResourcesCalls).toBe(0)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "tools-only servers skip optional prompt and resource discovery",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "tools-only-server"
        const serverState = getOrCreateClientState("tools-only-server")
        serverState.capabilities = { tools: {} }

        const result = yield* mcp.add("tools-only-server", {
          type: "local",
          command: ["echo", "test"],
        })

        expect(statusName(result.status, "tools-only-server")).toBe("connected")
        expect(serverState.listToolsCalls).toBe(1)
        expect(Object.keys(yield* mcp.tools())).toEqual(["tools-only-server_test_tool"])
        expect(yield* mcp.prompts()).toEqual({})
        expect(yield* mcp.resources()).toEqual({})
        expect(serverState.listPromptsCalls).toBe(0)
        expect(serverState.listResourcesCalls).toBe(0)
      }),
    ),
  { mcp: {} },
)

it.instance(
  "prompts() skips disconnected servers",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-disc-server"
        const serverState = getOrCreateClientState("prompt-disc-server")
        serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

        yield* mcp.add("prompt-disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("prompt-disc-server")

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(0)
      }),
    ),
  {
    mcp: {
        "prompt-disc-server": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

// ========================================================================
// Test: connect() on nonexistent server
// ========================================================================

it.instance(
  "connect() on nonexistent server fails with NotFoundError",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const exit = yield* mcp.connect("nonexistent").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "nonexistent" })
        }
        const status = yield* mcp.status()
        expect(status["nonexistent"]).toBeUndefined()
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

it.instance(
  "disconnect() on nonexistent server fails with NotFoundError",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const exit = yield* mcp.disconnect("nonexistent").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "nonexistent" })
        }
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

it.instance(
  "tools() returns empty when no MCP servers are configured",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(0)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

it.instance(
  "server that fails to connect is marked as failed",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "fail-connect"
        getOrCreateClientState("fail-connect")
        connectShouldFail = true
        connectError = "Connection refused"

        yield* mcp.add("fail-connect", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = yield* mcp.status()
        expect(status["fail-connect"]?.status).toBe("failed")
        if (status["fail-connect"]?.status === "failed") {
          expect(status["fail-connect"].error).toContain("Connection refused")
        }

        // No tools should be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(0)
      }),
    ),
  {
    mcp: {
        "fail-connect": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

it.live("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpOAuthCallback.waitForCallback("abc123hexstate", "my-mcp-server")),
    (callback) =>
      Effect.gen(function* () {
        McpOAuthCallback.cancelPending("my-mcp-server")

        const exit = yield* Effect.tryPromise({
          try: () => callback,
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for OAuth cancellation")),
          }),
          Effect.exit,
        )

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    () => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
  ),
)

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

it.instance(
  "tools() prefixes tool names with sanitized server name",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "my.special-server"
        const serverState = getOrCreateClientState("my.special-server")
        serverState.tools = [
          { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
          { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("my.special-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const tools = yield* mcp.tools()
        const keys = Object.keys(tools)

        // Server name dots should be replaced with underscores
        expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
        // Tool name dots should be replaced with underscores
        expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
        expect(keys.length).toBe(2)
      }),
    ),
  {
    mcp: {
        "my.special-server": {
          type: "local",
          command: ["echo", "test"],
        },
      },
  },
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

it.instance(
  "local stdio transport is closed when connect times out (no process leak)",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "hanging-server"
        getOrCreateClientState("hanging-server")
        connectShouldHang = true

        const addResult = yield* mcp.add("hanging-server", {
          type: "local",
          command: ["node", "fake.js"],
          timeout: { startup: 100 },
        })

        const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
        expect(serverStatus.status).toBe("failed")
        expect(serverStatus.error).toContain("timed out")
        // Transport must be closed to avoid orphaned child process
        expect(transportCloseCount).toBeGreaterThanOrEqual(1)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

it.instance(
  "remote transport is closed when connect times out",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "hanging-remote"
        getOrCreateClientState("hanging-remote")
        connectShouldHang = true

        const addResult = yield* mcp.add("hanging-remote", {
          type: "remote",
          url: "http://localhost:9999/mcp",
          timeout: { startup: 100 },
          oauth: false,
        })

        const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
        expect(serverStatus.status).toBe("failed")
        // Transport must be closed to avoid leaked HTTP connections
        expect(transportCloseCount).toBeGreaterThanOrEqual(1)
      }),
    ),
  { mcp: {} },
)

// ========================================================================
// Test: transport leak — failed remote transport not closed (#19168)
// ========================================================================

it.instance(
  "failed remote transport is closed on connect failure",
  () =>
    MCP.Service.use((mcp: MCPNS.Interface) =>
      Effect.gen(function* () {
        lastCreatedClientName = "fail-remote"
        getOrCreateClientState("fail-remote")
        connectShouldFail = true
        connectError = "Connection refused"

        const addResult = yield* mcp.add("fail-remote", {
          type: "remote",
          url: "http://localhost:9999/mcp",
          timeout: { startup: 5000 },
          oauth: false,
        })

        const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
        expect(serverStatus.status).toBe("failed")
        // The StreamableHTTP transport should be closed (no SSE fallback in v2)
        expect(transportCloseCount).toBeGreaterThanOrEqual(1)
      }),
    ),
  { mcp: {} },
)
