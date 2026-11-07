import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

// ProviderAdapters owns provider auth hooks; the legacy plugin `auth` fixture
// is no longer consumed by ProviderAuth (#1006). A4 removes the plugin service
// and this case, so skip the stale end-to-end fixture on this baseline. The MCP
// case below still covers the auth_success notification contract.
test.skip("actual provider OAuth callback emits one credential-free instance auth_success only after auth.set")

cliIt.live("actual loopback MCP authenticate emits auth_success without fabricating a chat", ({ home, opencode }) =>
  Effect.gen(function* () {
    const { Server, WebStandardStreamableHTTPServerTransport } = yield* Effect.promise(
      () => import("@modelcontextprotocol/server"),
    )
    const audit = path.join(home, "mcp-auth-notification.jsonl")
    const hook = path.join(home, "mcp-auth-hook.ts")
    const probe = Bun.serve({ fetch: () => new Response() })
    const callbackPort = probe.port
    yield* Effect.promise(async () => {
      await probe.stop(true)
    })
    const mcp = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: true,
            })
            const server = new Server({ name: "local-auth-fixture", version: "0" }, { capabilities: { tools: {} } })
            server.setRequestHandler("tools/list", async () => ({ tools: [] }))
            await server.connect(transport)
            return transport.handleRequest(request)
          },
        }),
      ),
      (server) =>
        Effect.promise(async () => {
          await server.stop(true)
        }),
    )
    yield* Effect.promise(async () => {
      await fs.writeFile(
        hook,
        `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},JSON.stringify(i))`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          mcp: { fixture: { type: "remote", url: `http://127.0.0.1:${mcp.port}/mcp`, oauth: { callbackPort } } },
        }),
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          Notification: [
            { matcher: "auth_success", hooks: [{ type: "command", command: process.execPath, args: [hook] }] },
          ],
        }),
      )
    })
    const server = yield* opencode.host()
    const response = yield* Effect.promise(() =>
      fetch(server.url + "/mcp/fixture/auth/authenticate", {
        method: "POST",
        headers: { "x-opencode-directory": home },
      }),
    )
    const body = yield* Effect.promise(() => response.json())
    expect(response.status).toBe(200)
    expect(body.status).toBe("connected")
    const notification = JSON.parse(yield* Effect.promise(() => fs.readFile(audit, "utf8")))
    expect(notification).toMatchObject({ hook_event_name: "Notification", notification_type: "auth_success" })
    expect(notification).not.toHaveProperty("session_id")
    expect(notification).not.toHaveProperty("transcript_path")
  }),
)
