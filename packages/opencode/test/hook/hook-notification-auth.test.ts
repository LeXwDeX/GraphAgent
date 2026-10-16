import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "actual provider OAuth callback emits one credential-free instance auth_success only after auth.set",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "auth-notification.jsonl")
      const plugin = path.join(home, "synthetic-auth.mjs")
      const command = path.join(home, "auth-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          plugin,
          `export default async()=>({auth:{provider:"fixture-auth",methods:[{type:"oauth",label:"Synthetic local auth",authorize:async()=>({url:"https://invalid.fixture/not-opened",method:"code",instructions:"Synthetic only",callback:async(code)=>code==="fixture-code"?{type:"success",key:"fixture-isolated-value"}:{type:"failed"}})}]}})`,
        )
        await fs.writeFile(
          command,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify(i)+"\\n")`,
        )
        await fs.writeFile(path.join(home, ".config/opencode/opencode.json"), JSON.stringify({ plugin: [plugin] }))
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            Notification: [
              { matcher: "auth_success", hooks: [{ type: "command", command: process.execPath, args: [command] }] },
            ],
          }),
        )
      })
      const server = yield* opencode.serve({ env: { OPENCODE_PURE: "0", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" } })
      const post = (route: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const authorize = yield* post("/provider/fixture-auth/oauth/authorize", { method: 0 })
      if (authorize.status !== 200)
        throw new Error(
          JSON.stringify({
            status: authorize.status,
            body: yield* Effect.promise(() => authorize.text()),
            stderr: server.stderrTail(),
          }),
        )
      expect(authorize.status).toBe(200)
      expect((yield* post("/provider/fixture-auth/oauth/callback", { method: 0, code: "wrong" })).status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(audit).exists())).toBe(false)
      expect((yield* post("/provider/fixture-auth/oauth/callback", { method: 0, code: "fixture-code" })).status).toBe(
        200,
      )
      const raw = yield* Effect.promise(() => fs.readFile(audit, "utf8"))
      const rows = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        hook_event_name: "Notification",
        notification_type: "auth_success",
        cwd: yield* Effect.promise(() => fs.realpath(home)),
      })
      expect(rows[0]).not.toHaveProperty("session_id")
      expect(rows[0]).not.toHaveProperty("transcript_path")
      expect(raw).not.toContain("fixture-code")
      expect(raw).not.toContain("fixture-isolated-value")
    }),
)

cliIt.live("actual loopback MCP authenticate emits auth_success without fabricating a chat", ({ home, opencode }) =>
  Effect.gen(function* () {
    const { Server, WebStandardStreamableHTTPServerTransport } = yield* Effect.promise(
      () => import("@modelcontextprotocol/server"),
    )
    const audit = path.join(home, "mcp-auth-notification.jsonl")
    const hook = path.join(home, "mcp-auth-hook.ts")
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
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
    const server = yield* opencode.serve()
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
