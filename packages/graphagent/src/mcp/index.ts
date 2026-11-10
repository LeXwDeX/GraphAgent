import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { type Tool } from "ai"
import { ConfigMCP } from "@graphagent/core/config/mcp"
import { serviceUse } from "@graphagent/core/effect/service-use"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"
import type { ClientOptions, LoggingMessageNotification, Tool as MCPToolDef } from "@modelcontextprotocol/client"
import { McpConfig } from "./config"
import { NamedError } from "@graphagent/core/util/error"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { APP_NAME } from "@graphagent/core/brand"
import { withTimeout } from "@/util/timeout"
import { Process } from "@/util/process"
import { FSUtil } from "@graphagent/core/fs-util"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProjectTrust } from "@/project/trust/service"
import { mcpEntries } from "@/project/trust/entries"
import { ProjectTrust as ProjectTrustEvent } from "@graphagent/schema/project-trust"
import { TuiEvent } from "@/server/tui-event"
import { registerElicitationHandler } from "./elicitation"
import open from "open"
import { Cause, Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@graphagent/schema/mcp-event"

const DEFAULT_TIMEOUT = 30_000
const CLIENT_OPTIONS = {
  capabilities: {
    // https://github.com/anomalyco/opencode/issues/11948
    // sampling: {},
    // mcp-elicitation-notification: elicitation client capability + handler wiring.
    // The handler is registered per-client in `watch` (the connected-client chokepoint).
    elicitation: {},
    // https://github.com/anomalyco/opencode/issues/2308
    roots: {},
    // https://github.com/anomalyco/opencode/issues/28567
    // tasks: {},
  },
} satisfies ClientOptions

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

function createClient(directory: string) {
  const client = new Client(
    { name: APP_NAME, version: InstallationVersion },
    {
      ...CLIENT_OPTIONS,
      // Protocol negotiation is always automatic: probe server/discover and
      // fall back to the 2025 initialize handshake. The per-server `protocol`
      // override was removed with the mcp.json migration.
      versionNegotiation: { mode: "auto" },
    },
  )
  client.setRequestHandler("roots/list", () => Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }))
  return client
}

// Protocol versions are ISO dates and sort lexicographically, so >= the
// 2026-07-28 baseline (server/discover era) means modern.
export function protocolEra(version: string): "modern" | "legacy" {
  return version >= "2026-07-28" ? "modern" : "legacy"
}

// Connected status carries the negotiated protocol era/version when the client
// reports one; test doubles without the getter get the plain shape.
function connectedStatus(client: MCPClient): Status {
  const protocolVersion =
    typeof client.getNegotiatedProtocolVersion === "function" ? client.getNegotiatedProtocolVersion() : undefined
  if (protocolVersion === undefined) return { status: "connected" }
  return { status: "connected", era: protocolEra(protocolVersion), protocolVersion }
}

const StatusConnected = Schema.Struct({
  status: Schema.Literal("connected"),
  era: Schema.optional(Schema.Literals(["modern", "legacy"])),
  protocolVersion: Schema.optional(Schema.String),
}).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
const pendingOAuthTransports = new Map<string, StreamableHTTPClientTransport>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
type McpServer = ConfigMCP.Server

function remoteURL(value: string) {
  if (URL.canParse(value)) return new URL(value)
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  instructions?: string
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, McpServer>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  instructions: Record<string, string>
  /**
   * Servers the user explicitly disconnected. A later trust decision that
   * grants access must not override that choice and reconnect them.
   */
  manualDisabled: Set<string>
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (name: string, mcp: McpServer) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    // `defaultLayer` always provides the trust service; the option keeps bare
    // `MCP.layer` constructible for tests, which then run ungated.
    const trust = Option.getOrUndefined(yield* Effect.serviceOption(ProjectTrust.Service))

    type Transport = StdioClientTransport | StreamableHTTPClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (
      transport: Transport,
      timeout: number,
    ) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = createClient(directory)
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )
    })

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (key: string, mcp: ConfigMCP.Remote) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            client_id: oauthConfig?.client_id,
            client_secret: oauthConfig?.client_secret,
            scope: oauthConfig?.scope,
            callback_port: oauthConfig?.callback_port,
            redirect_uri: oauthConfig?.redirect_uri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )
      }

      // The dual StreamableHTTP→SSE fallback was removed with the v2 migration:
      // Streamable HTTP failure is terminal (SSE-only servers predate 2025-03-26).
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
      })

      const connectTimeout = mcp.timeout?.startup ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      const result = yield* connectTransport(transport, connectTimeout).pipe(
        Effect.catch((error) => {
          const lastError = error instanceof Error ? error : new Error(String(error))
          const isAuthError =
            error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

          if (isAuthError) {
            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              lastStatus = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide client_id in config.",
              }
              return events
                .publish(TuiEvent.ToastShow, {
                  title: "MCP Authentication Required",
                  message: `Server "${key}" requires a pre-registered client ID. Add client_id to your mcp.json entry.`,
                  variant: "warning",
                  duration: 8000,
                })
                .pipe(Effect.ignore, Effect.as(undefined))
            } else {
              pendingOAuthTransports.set(key, transport)
              lastStatus = { status: "needs_auth" as const }
              return events
                .publish(TuiEvent.ToastShow, {
                  title: "MCP Authentication Required",
                  message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                  variant: "warning",
                  duration: 8000,
                })
                .pipe(Effect.ignore, Effect.as(undefined))
            }
          }

          lastStatus = { status: "failed" as const, error: lastError.message }
          return Effect.void
        }),
      )
      if (result) return { client: result, status: connectedStatus(result) }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (key: string, mcp: ConfigMCP.Local) {
      const [cmd, ...args] = mcp.command
      const baseDir = yield* InstanceState.directory
      const cwd = mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === APP_NAME ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })

      const connectTimeout = mcp.timeout?.startup ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: connectedStatus(client),
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(
      function* (key: string, mcp: McpServer) {
        if (mcp.disabled === true) {
          return DISABLED_RESULT
        }

        const { client: mcpClient, status } =
          mcp.type === "remote" ? yield* connectRemote(key, mcp) : yield* connectLocal(key, mcp)

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            yield* Effect.logWarning("server unavailable", { key, type: mcp.type, status: status.status })
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          const listed = mcpClient.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(mcpClient, mcp.timeout?.request)
            : []
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          return {
            mcpClient,
            status,
            defs: listed,
            instructions: mcpClient.getInstructions()?.trim(),
          } satisfies CreateResult
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* shutdownClient(mcpClient)
              return yield* Effect.failCause(cause)
            }),
          ),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )
    /**
     * Project-trust verdict for one server name whose effective configuration
     * comes from the project `mcp.json`. Undefined when the name is not
     * project-sourced (a global entry or a runtime-added server): no project
     * provenance, so nothing to gate.
     */
    const projectVerdict = Effect.fnUntraced(function* (name: string) {
      if (!trust) return undefined
      const ctx = yield* InstanceState.context
      const project = McpConfig.projectLayer(ctx.root)
      if (!project) return undefined
      const entry = mcpEntries(project.relative, project.value).find((candidate) => candidate.label === name)
      if (!entry) return undefined
      const result = yield* trust.gate([{ scope: "project", file: project.relative, entry }])
      return result.allowed[0] === true
    })

    /**
     * Trust verdicts for a batch of server names, keyed by name. Names absent
     * from the project layer are omitted and stay ungated. One gate call keeps
     * the refused ids in the directory's skipped report.
     */
    const projectVerdicts = Effect.fnUntraced(function* (root: string, names: readonly string[]) {
      const verdicts = new Map<string, boolean>()
      if (!trust || names.length === 0) return verdicts
      const project = McpConfig.projectLayer(root)
      if (!project) return verdicts
      const byName = new Map(mcpEntries(project.relative, project.value).map((entry) => [entry.label, entry]))
      const sourced = names.flatMap((name) => {
        const entry = byName.get(name)
        return entry === undefined ? [] : [{ name, entry }]
      })
      if (sourced.length === 0) return verdicts
      const result = yield* trust.gate(
        sourced.map(({ entry }) => ({ scope: "project" as const, file: project.relative, entry })),
      )
      sourced.forEach(({ name }, index) => verdicts.set(name, result.allowed[index] === true))
      return verdicts
    })

    /** Refuse a project entry the trust gate rejected, naming the remedy. */
    const assertProjectAllowed = Effect.fnUntraced(function* (name: string) {
      if ((yield* projectVerdict(name)) !== false) return
      throw new Error(`MCP server "${name}" is a project entry that is not trusted. Run /trust to review it.`)
    })

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          const code = yield* handle.exitCode
          // pgrep exits 1 when there are no children; larger codes mean the
          // process listing itself failed, so surface the incomplete snapshot.
          if (code > 1) {
            yield* Effect.logWarning("MCP descendant discovery failed", { pid: current, exitCode: code })
            continue
          }
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch((error) =>
        Effect.logWarning("MCP descendant discovery failed", { error }).pipe(Effect.as([] as number[])),
      ),
    )

    // Close a client and make sure its whole process tree is reaped. The
    // descendant snapshot must be taken while the root pid is alive (pgrep
    // walks parent links); close() shuts the root down gracefully, and
    // stopTree force-kills whatever survived (ignored SIGTERM, orphaned
    // grandchildren) and waits for exit.
    const shutdownClient = Effect.fnUntraced(function* (client: MCPClient) {
      const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
      const tree = typeof pid === "number" ? [pid, ...(yield* descendants(pid))] : []
      yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      if (tree.length === 0) return
      yield* Effect.tryPromise(() => Process.stopTree(tree)).pipe(Effect.ignore)
    })

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      // mcp-elicitation-notification: handle `elicitation/create` reverse requests.
      // Routes through the Question service (best-effort session via SessionContext),
      // firing Elicitation/ElicitationResult hooks and the Notification emitter.
      registerElicitationHandler(client, bridge, name)
      client.onclose = () => {
        if (s.clients[name] !== client) return
        delete s.clients[name]
        delete s.defs[name]
        delete s.instructions[name]
        s.status[name] = { status: "failed", error: "Connection closed" }
        bridge.fork(
          Effect.logWarning("MCP connection closed", { server: name }).pipe(
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler("notifications/message", (notification) =>
        bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler("notifications/tools/list_changed", async () => {
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(McpCatalog.defs(client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* (ctx) {
        const bridge = yield* EffectBridge.make()
        // mcp.json is the only source of server definitions; a removed V1 shape
        // throws a ConfigInvalidError that names the offending file and key.
        const config = McpConfig.load(ctx.root)
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
          instructions: {},
          manualDisabled: new Set(),
        }
        // Project-layer servers must be trusted before their process starts.
        // A refused server keeps a `disabled` status (the same surface a user
        // sees for `disabled: true`) and is reported by the CLI's skipped count.
        const verdicts = yield* projectVerdicts(ctx.root, Object.keys(config))

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (verdicts.get(key) === false) {
                s.status[key] = { status: "disabled" }
                return
              }
              const result = yield* create(key, mcp)
              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                if (result.instructions) s.instructions[key] = result.instructions
                watch(s, key, result.mcpClient, bridge, mcp.timeout?.request)
              }
            }),
          { concurrency: "unbounded" },
        )

        // A trust decision changes the gate output without touching mcp.json,
        // so the state must react on its own: newly trusted servers start,
        // revoked ones are closed. A manual disconnect wins over a later grant.
        const reconcile = Effect.fnUntraced(function* () {
          const next = yield* projectVerdicts(ctx.root, Object.keys(config))
          for (const [name, allowed] of next) {
            if (!allowed) {
              const client = s.clients[name]
              if (client) yield* closeClient(s, name)
              s.status[name] = { status: "disabled" }
              continue
            }
            if (s.manualDisabled.has(name)) continue
            if (s.clients[name]) continue
            if (s.status[name]?.status === "connected" || s.status[name]?.status === "needs_auth") continue
            const mcp = config[name]
            const result = yield* create(name, mcp)
            if (!result.mcpClient) {
              s.status[name] = result.status
              continue
            }
            yield* storeClient(s, name, result.mcpClient, result.defs!, result.instructions, mcp.timeout?.request)
          }
        })
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== ProjectTrustEvent.Event.Updated.type) return Effect.void
          if (event.location?.directory !== ctx.directory) return Effect.void
          return bridge.run(reconcile())
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const clients = Object.values(s.clients)
            s.clients = {}
            s.defs = {}
            s.instructions = {}
            yield* Effect.forEach(clients, (client) => shutdownClient(client), { concurrency: "unbounded" })
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      delete s.instructions[name]
      if (!client) return Effect.void
      return shutdownClient(client)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      instructions: string | undefined,
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      const previous = s.clients[name]
      s.status[name] = connectedStatus(client)
      s.clients[name] = client
      s.defs[name] = listed
      if (instructions) s.instructions[name] = instructions
      else delete s.instructions[name]
      watch(s, name, client, bridge, timeout)
      if (previous) yield* shutdownClient(previous)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)
      const ctx = yield* InstanceState.context
      const config = McpConfig.load(ctx.root)
      const result: Record<string, Status> = {}

      for (const key of Object.keys(config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      for (const key of Object.keys(s.config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.entries(s.instructions)
        .filter(([name]) => s.status[name]?.status === "connected")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          instructions: item,
          tools: (s.defs[name] ?? []).map((tool) => McpCatalog.toolName(name, tool.name)),
        }))
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: McpServer) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, result.instructions, mcp.timeout?.request)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: McpServer) {
      const s = yield* InstanceState.get(state)
      // A runtime add is user-supplied content, but a name that the project
      // layer also declares keeps the project entry's verdict: overriding an
      // untrusted server by name must not start it.
      yield* assertProjectAllowed(name)
      s.config[name] = mcp
      s.manualDisabled.delete(name)
      yield* createAndStore(name, mcp)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* assertProjectAllowed(name)
      const s = yield* InstanceState.get(state)
      s.manualDisabled.delete(name)
      yield* createAndStore(name, { ...mcp, disabled: false })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      s.manualDisabled.add(name)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    function requestTimeout(s: State, name: string, configured: McpServer | undefined) {
      return s.config[name]?.timeout?.request ?? configured?.timeout?.request ?? DEFAULT_TIMEOUT
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)
      const ctx = yield* InstanceState.context
      const config = McpConfig.load(ctx.root)

      for (const [clientName, client] of Object.entries(s.clients)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Effect.logWarning("missing cached tools for connected server", { clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig)
        for (const mcpTool of listed) {
          const key = McpCatalog.toolName(clientName, mcpTool.name)
          result[key] = McpCatalog.bindTool(McpCatalog.convertTool(mcpTool, client, timeout), {
            server: clientName,
            tool: mcpTool.name,
            // Configuration provenance is not tracked per MCP server yet; never infer it from a name.
            source: "unknown",
            // Only the boolean `true` marks a tool; any other value is ignored.
            requiresUserInteraction: mcpTool._meta?.["anthropic/requiresUserInteraction"] === true,
          })
        }
      }
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
      key?: (item: T) => string,
      targetClientName?: string,
    ) {
      return Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const config = McpConfig.load(ctx.root)
        return yield* Effect.forEach(
          Object.entries(s.clients).filter(
            ([name]) => s.status[name]?.status === "connected" && (!targetClientName || name === targetClientName),
          ),
          ([clientName, client]) =>
            McpCatalog.fetch(
              clientName,
              client,
              (c) => listFn(c, requestTimeout(s, clientName, config[clientName])),
              label,
              key,
            ).pipe(Effect.map((items) => Object.entries(items ?? {}))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resources,
        "resources",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resourceTemplates,
        "resource templates",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      const ctx = yield* InstanceState.context
      const config = McpConfig.load(ctx.root)
      return yield* Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, config[clientName])),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(`failed to ${label}`, {
            clientName,
            ...meta,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const ctx = yield* InstanceState.context
      return McpConfig.load(ctx.root)[mcpName]
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      yield* assertProjectAllowed(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirect_uri > callback_port shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirect_uri ??
        (oauthConfig?.callback_port ? `http://127.0.0.1:${oauthConfig.callback_port}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          client_id: oauthConfig?.client_id,
          client_secret: oauthConfig?.client_secret,
          scope: oauthConfig?.scope,
          redirect_uri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
      })
      const directory = yield* InstanceState.directory

      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)),
        )

        const listed = client
          ? client.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(client, mcpConfig.timeout?.request)
            : []
          : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } satisfies Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        const status = yield* storeClient(
          s,
          mcpName,
          client,
          listed,
          client.getInstructions()?.trim(),
          mcpConfig.timeout?.request,
        )
        const { Notification } = yield* Effect.promise(() => import("@/notification"))
        const notification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
        if (status.status === "connected" && notification)
          yield* notification.notify({ notificationType: "auth_success", message: "MCP authentication completed" })
        return status
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)
      onAuthorization?.(result.authorizationUrl)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      yield* assertProjectAllowed(mcpName)
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } satisfies Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      const status = yield* createAndStore(mcpName, mcpConfig)
      const { Notification } = yield* Effect.promise(() => import("@/notification"))
      const notification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
      if (status.status === "connected" && notification)
        yield* notification.notify({ notificationType: "auth_success", message: "MCP authentication completed" })
      return status
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated"
      const expired = yield* auth.isTokenExpired(mcpName)
      return expired ? "expired" : "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      prompts,
      resources,
      resourceTemplates,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(ProjectTrust.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)

export const node = LayerNode.make(layer, [
  CrossSpawnSpawner.node,
  McpAuth.node,
  EventV2Bridge.node,
  ProjectTrust.node,
])

export * as MCP from "."
