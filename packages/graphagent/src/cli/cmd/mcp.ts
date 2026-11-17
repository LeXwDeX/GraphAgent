import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { Cause } from "effect"
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/client"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpConfig } from "../../mcp/config"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { InstanceRef } from "@/effect/instance-ref"
import { assertProjectRootWritable, hasProjectLayer } from "@/project/project-root"
import { ConfigMCP } from "@graphagent/core/config/mcp"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { Global } from "@graphagent/core/global"
import { APP_NAME } from "@graphagent/core/brand"
import { Effect } from "effect"
import { t } from "@graphagent/tui/i18n"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return t("cli.mcp.authStatus.authenticated")
    case "expired":
      return t("cli.mcp.authStatus.expired")
    case "not_authenticated":
      return t("cli.mcp.authStatus.notAuthenticated")
  }
}

/** `mcp debug` prints developer diagnostics, which stay English in every interface language. */
const DEBUG_AUTH_STATUS: Record<MCP.AuthStatus, string> = {
  authenticated: "authenticated",
  expired: "expired",
  not_authenticated: "not authenticated",
}

type McpConfigured = ConfigMCP.Server
type McpRemote = Extract<McpConfigured, { type: "remote" }>

function isMcpRemote(server: McpConfigured): server is McpRemote {
  return server.type === "remote"
}

function configuredServers(servers: McpConfig.Servers) {
  return Object.entries(servers)
}

function oauthServers(servers: McpConfig.Servers) {
  return configuredServers(servers).filter(
    (entry): entry is [string, McpRemote] => entry[1].type === "remote" && entry[1].oauth !== false,
  )
}

/** The project root and the merged `mcpServers` map for the current instance. */
function mcpState() {
  return Effect.gen(function* () {
    const ctx = yield* InstanceRef
    const root = ctx?.root ?? Global.Path.home
    return { root, servers: McpConfig.load(root) }
  })
}

function listState() {
  return Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const { servers } = yield* mcpState()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(servers).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { servers, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const { servers } = yield* mcpState()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(servers).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { servers, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: t("cli.mcp.describe"),
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: t("cli.mcp.list.describe"),
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro(t("cli.mcp.list.intro"))

    const { servers: serverMap, statuses, stored } = yield* listState()
    const servers = configuredServers(serverMap)

    if (servers.length === 0) {
      prompts.log.warn(t("cli.mcp.list.empty"))
      prompts.outro(t("cli.mcp.list.addHint"))
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = t("cli.mcp.status.notInitialized")
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = `${t("cli.mcp.status.connected")}${status.era ? ` · ${status.era}` : ""}${status.protocolVersion ? ` (${status.protocolVersion})` : ""}`
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = t("cli.mcp.status.disabled")
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = t("cli.mcp.status.needsAuth")
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = t("cli.mcp.status.needsClientRegistration")
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = t("cli.mcp.status.failed")
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(t("cli.mcp.list.count", { count: servers.length }))
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: t("cli.mcp.auth.describe"),
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: t("cli.mcp.option.name"),
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro(t("cli.mcp.auth.intro"))

    const { servers: mcpServers, auth } = yield* authState()
    const servers = oauthServers(mcpServers)

    if (servers.length === 0) {
      prompts.log.warn(t("cli.mcp.auth.noServers"))
      prompts.log.info(t("cli.mcp.auth.remoteHint"))
      prompts.log.info(`
  "mcpServers": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro(t("cli.mcp.done"))
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: t("cli.mcp.auth.select"),
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(t("cli.mcp.auth.notFound", { name: serverName }))
      prompts.outro(t("cli.mcp.done"))
      return
    }

    if (serverConfig.type !== "remote" || serverConfig.oauth === false) {
      prompts.log.error(t("cli.mcp.auth.notOauthCapable", { name: serverName }))
      prompts.outro(t("cli.mcp.done"))
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          active: t("cli.common.yes"),
          inactive: t("cli.common.no"),
          message: t("cli.mcp.auth.reauthConfirm", { name: serverName }),
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro(t("cli.mcp.auth.cancelled"))
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(t("cli.mcp.auth.expiredReauth", { name: serverName }))
    }

    const spinner = prompts.spinner()
    spinner.start(t("cli.mcp.auth.starting"))

    yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop(t("cli.mcp.auth.authorizeInBrowser"))
        prompts.log.info(url)
        spinner.start(t("cli.mcp.auth.waiting"))
      }),
    ).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop(t("cli.mcp.auth.success"))
          } else if (status.status === "needs_client_registration") {
            spinner.error(t("cli.mcp.auth.failed"))
            prompts.log.error(status.error)
            prompts.log.info(t("cli.mcp.auth.registerClientHint"))
            prompts.log.info(`
  "mcpServers": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "client_id": "your-client-id",
        "client_secret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.error(t("cli.mcp.auth.failed"))
            prompts.log.error(status.error)
          } else {
            spinner.error(t("cli.mcp.auth.unexpectedStatus", { status: status.status }))
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.error(t("cli.mcp.auth.failed"))
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
    )

    prompts.outro(t("cli.mcp.done"))
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: t("cli.mcp.authList.describe"),
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro(t("cli.mcp.authList.intro"))

    const { servers: mcpServers, auth } = yield* authState()
    const servers = oauthServers(mcpServers)

    if (servers.length === 0) {
      prompts.log.warn(t("cli.mcp.auth.noServers"))
      prompts.outro(t("cli.mcp.done"))
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(t("cli.mcp.authList.count", { count: servers.length }))
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: t("cli.mcp.logout.describe"),
  builder: (yargs) =>
    yargs.positional("name", {
      describe: t("cli.mcp.option.name"),
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro(t("cli.mcp.logout.intro"))

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    if (serverNames.length === 0) {
      prompts.log.warn(t("cli.mcp.logout.none"))
      prompts.outro(t("cli.mcp.done"))
      return
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: t("cli.mcp.logout.select"),
          options: serverNames.map((name) => {
            const entry = credentials[name]
            const hasTokens = !!entry.tokens
            const hasClient = !!entry.clientInfo
            let hint = ""
            if (hasTokens && hasClient) hint = t("cli.mcp.logout.hint.tokensAndClient")
            else if (hasTokens) hint = t("cli.mcp.logout.hint.tokens")
            else if (hasClient) hint = t("cli.mcp.logout.hint.client")
            return {
              label: name,
              value: name,
              hint,
            }
          }),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!credentials[serverName]) {
      prompts.log.error(t("cli.mcp.logout.notFound", { name: serverName }))
      prompts.outro(t("cli.mcp.done"))
      return
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(t("cli.mcp.logout.removed", { name: serverName }))
    prompts.outro(t("cli.mcp.done"))
  }),
})

/** The `mcp.json` file a write targets: project layer by default, user level on `--global`. */
function configFile(root: string, global: boolean) {
  return global ? McpConfig.globalFile() : McpConfig.projectFile(root)
}

/**
 * Write one server entry to the selected `mcp.json` layer. Project-layer writes
 * are refused when the project root resolves to `$HOME`, because `~/.agents` is
 * the user-level shared directory, not a project layer.
 */
function addMcp(root: string, name: string, server: McpConfigured, global: boolean) {
  const file = configFile(root, global)
  if (!global) assertProjectRootWritable(root, Global.Path.home)
  McpConfig.upsert(file, name, server)
  return file
}

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: t("cli.mcp.add.describe"),
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: t("cli.mcp.option.name"),
        type: "string",
      })
      .option("url", {
        describe: t("cli.mcp.option.url"),
        type: "string",
      })
      .option("env", {
        describe: t("cli.mcp.option.env"),
        type: "string",
        array: true,
      })
      .option("header", {
        describe: t("cli.mcp.option.header"),
        type: "string",
        array: true,
      })
      .option("global", {
        describe: t("cli.mcp.option.global"),
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      const command = args["--"] ?? []
      if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
        throw new Error(t("cli.mcp.add.nameRequired"))
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error(t("cli.mcp.add.urlOrCommand"))
        }
        if (args.url && !URL.canParse(args.url)) {
          throw new Error(t("cli.mcp.add.invalidUrlValue", { url: args.url }))
        }
        if (args.url && args.env?.length) {
          throw new Error(t("cli.mcp.add.envLocalOnly"))
        }
        if (command.length && args.header?.length) {
          throw new Error(t("cli.mcp.add.headerRemoteOnly"))
        }

        const entries = (values: string[], invalid: "cli.mcp.add.invalidEnv" | "cli.mcp.add.invalidHeader") =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(t(invalid, { entry }))
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "cli.mcp.add.invalidEnv")
        const headers = entries(args.header ?? [], "cli.mcp.add.invalidHeader")
        const mcpConfig: McpConfigured = args.url
          ? {
              type: "remote",
              url: args.url,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        const configPath = addMcp(ctx.root, args.name, mcpConfig, Boolean(args.global))
        prompts.log.success(t("cli.mcp.add.added", { name: args.name, path: configPath }))
        return
      }

      UI.empty()
      prompts.intro(t("cli.mcp.add.intro"))

      // Resolve config paths eagerly for hints
      const projectConfigPath = McpConfig.projectFile(ctx.root)
      const globalConfigPath = McpConfig.globalFile()

      // Determine scope; a project layer exists everywhere except $HOME.
      let global = true
      if (hasProjectLayer(ctx.root, Global.Path.home)) {
        const scopeResult = await prompts.select({
          message: t("cli.mcp.add.locationPrompt"),
          options: [
            {
              label: t("cli.mcp.add.location.project"),
              value: false,
              hint: projectConfigPath,
            },
            {
              label: t("cli.mcp.add.location.global"),
              value: true,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        global = scopeResult
      }
      const configPath = configFile(ctx.root, global)

      const name = await prompts.text({
        message: t("cli.mcp.add.namePrompt"),
        validate: (x) => (x && x.length > 0 ? undefined : t("cli.mcp.add.required")),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: t("cli.mcp.add.typePrompt"),
        options: [
          {
            label: t("cli.mcp.add.type.local"),
            value: "local",
            hint: t("cli.mcp.add.type.localHint"),
          },
          {
            label: t("cli.mcp.add.type.remote"),
            value: "remote",
            hint: t("cli.mcp.add.type.remoteHint"),
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: t("cli.mcp.add.commandPrompt"),
          placeholder: t("cli.mcp.add.example", { example: "graphagent x @modelcontextprotocol/server-filesystem" }),
          validate: (x) => (x && x.length > 0 ? undefined : t("cli.mcp.add.required")),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: McpConfigured = {
          type: "local",
          command: command.split(" "),
        }

        addMcp(ctx.root, name, mcpConfig, global)
        prompts.log.success(t("cli.mcp.add.added", { name, path: configPath }))
        prompts.outro(t("cli.mcp.add.success"))
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: t("cli.mcp.add.urlPrompt"),
          placeholder: t("cli.mcp.add.example", { example: "https://example.com/mcp" }),
          validate: (x) => {
            if (!x) return t("cli.mcp.add.required")
            if (x.length === 0) return t("cli.mcp.add.required")
            const isValid = URL.canParse(x)
            return isValid ? undefined : t("cli.mcp.add.urlInvalid")
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          active: t("cli.common.yes"),
          inactive: t("cli.common.no"),
          message: t("cli.mcp.add.oauthPrompt"),
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: McpConfigured

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            active: t("cli.common.yes"),
            inactive: t("cli.common.no"),
            message: t("cli.mcp.add.hasClientIdPrompt"),
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: t("cli.mcp.add.clientIdPrompt"),
              validate: (x) => (x && x.length > 0 ? undefined : t("cli.mcp.add.required")),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              active: t("cli.common.yes"),
              inactive: t("cli.common.no"),
              message: t("cli.mcp.add.hasSecretPrompt"),
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: t("cli.mcp.add.secretPrompt"),
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                client_id: clientId,
                ...(clientSecret && { client_secret: clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        addMcp(ctx.root, name, mcpConfig, global)
        prompts.log.success(t("cli.mcp.add.added", { name, path: configPath }))
      }

      prompts.outro(t("cli.mcp.add.success"))
    })
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: t("cli.mcp.debug.describe"),
  builder: (yargs) =>
    yargs.positional("name", {
      describe: t("cli.mcp.option.name"),
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const ctx = yield* InstanceRef
    const root = ctx?.root ?? Global.Path.home
    const mcpServers = McpConfig.load(root)
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("MCP OAuth Debug")

      const serverName = args.name

      const serverConfig = mcpServers[serverName]
      if (!serverConfig) {
        prompts.log.error(`MCP server not found: ${serverName}`)
        prompts.outro("Done")
        return
      }

      if (!isMcpRemote(serverConfig)) {
        prompts.log.error(`MCP server ${serverName} is not a remote server`)
        prompts.outro("Done")
        return
      }

      if (serverConfig.oauth === false) {
        prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)
        prompts.outro("Done")
        return
      }

      prompts.log.info(`Server: ${serverName}`)
      prompts.log.info(`URL: ${serverConfig.url}`)

      // Check stored auth status — services already in hand, run inline.
      const { authStatus, entry } = await Effect.runPromise(
        Effect.all({
          authStatus: mcp.getAuthStatus(serverName),
          entry: auth.get(serverName),
        }),
      )
      prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${DEBUG_AUTH_STATUS[authStatus]}`)

      if (entry?.tokens) {
        prompts.log.info(`  Access token: ${entry.tokens.accessToken.substring(0, 20)}...`)
        if (entry.tokens.expiresAt) {
          const expiresDate = new Date(entry.tokens.expiresAt * 1000)
          const isExpired = entry.tokens.expiresAt < Date.now() / 1000
          prompts.log.info(`  Expires: ${expiresDate.toISOString()} ${isExpired ? "(EXPIRED)" : ""}`)
        }
        if (entry.tokens.refreshToken) {
          prompts.log.info(`  Refresh token: present`)
        }
      }
      if (entry?.clientInfo) {
        prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
        if (entry.clientInfo.clientSecretExpiresAt) {
          const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)
          prompts.log.info(`  Client secret expires: ${expiresDate.toISOString()}`)
        }
      }

      const spinner = prompts.spinner()
      spinner.start("Testing connection...")

      // Test basic HTTP connectivity first
      try {
        const response = await fetch(serverConfig.url, {
          method: "POST",
          headers: {
            ...serverConfig.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: `${APP_NAME}-debug`, version: InstallationVersion },
            },
            id: 1,
          }),
        })

        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

        // Check for WWW-Authenticate header
        const wwwAuth = response.headers.get("www-authenticate")
        if (wwwAuth) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }

        if (response.status === 401) {
          prompts.log.warn("Server returned 401 Unauthorized")

          // Try to discover OAuth metadata
          const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
          const authProvider = new McpOAuthProvider(
            serverName,
            serverConfig.url,
            {
              client_id: oauthConfig?.client_id,
              client_secret: oauthConfig?.client_secret,
              scope: oauthConfig?.scope,
              redirect_uri: oauthConfig?.redirect_uri,
            },
            {
              onRedirect: async () => {},
            },
            auth,
          )

          prompts.log.info("Testing OAuth flow (without completing authorization)...")

          // Try creating transport with auth provider to trigger discovery
          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
            authProvider,
            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
          })

          try {
            const client = new Client(
              { name: `${APP_NAME}-debug`, version: InstallationVersion },
              {
                // Mirror createClient: protocol negotiation is always automatic.
                versionNegotiation: { mode: "auto" },
              },
            )
            await client.connect(transport)
            prompts.log.success("Connection successful (already authenticated)")
            await client.close()
          } catch (error) {
            if (error instanceof UnauthorizedError) {
              prompts.log.info(`OAuth flow triggered: ${error.message}`)

              // Check if dynamic registration would be attempted
              const clientInfo = await authProvider.clientInformation()
              if (clientInfo) {
                prompts.log.info(`Client ID available: ${clientInfo.client_id}`)
              } else {
                prompts.log.info("No client ID - dynamic registration will be attempted")
              }
            } else {
              prompts.log.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } else if (response.status >= 200 && response.status < 300) {
          prompts.log.success("Server responded successfully (no auth required or already authenticated)")
          const body = await response.text()
          try {
            const json = JSON.parse(body)
            if (json.result?.serverInfo) {
              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
            }
          } catch {
            // Not JSON, ignore
          }
        } else {
          prompts.log.warn(`Unexpected status: ${response.status}`)
          const body = await response.text().catch(() => "")
          if (body) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      } catch (error) {
        spinner.error("Connection failed")
        prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }

      prompts.outro("Debug complete")
    })
  }),
})
