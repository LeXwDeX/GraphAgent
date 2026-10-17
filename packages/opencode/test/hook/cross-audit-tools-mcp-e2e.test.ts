import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

/**
 * Real stdio MCP server driven through the real CLI process. The model-facing key is
 * `fixture_pick`; official Claude-style hooks address it as `mcp__fixture__pick`.
 */
cliIt.live(
  "real stdio MCP tool fires canonical and native matchers on every tool event with a real mcp_server",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const serverScript = path.join(home, "mcp-server.ts")
      const hookScript = path.join(home, "audit-hook.ts")
      const audit = path.join(home, "audit.jsonl")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          serverScript,
          `import {Server} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};const server=new Server({name:"fixture",version:"0"},{capabilities:{tools:{}}});server.setRequestHandler("tools/list",async()=>({tools:[{name:"pick",description:"ok tool",inputSchema:{type:"object",properties:{}}},{name:"boom",description:"failing tool",inputSchema:{type:"object",properties:{}}}]}));server.setRequestHandler("tools/call",async(request)=>request.params.name==="boom"?{isError:true,content:[{type:"text",text:"MCP_BOOM"}]}:{content:[{type:"text",text:"MCP_PICKED"}]});process.stdin.on("end",()=>process.exit(0));await server.connect(new StdioServerTransport());`,
        )
        await fs.writeFile(
          hookScript,
          `const i=JSON.parse(await Bun.stdin.text());(await import("node:fs")).appendFileSync(${JSON.stringify(audit)},JSON.stringify({tag:process.argv[2],event:i.hook_event_name,tool_name:i.tool_name,mcp_server:i.mcp_server,suggestions:i.permission_suggestions})+"\\n");if(i.hook_event_name==="PermissionRequest")process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"}}}));`,
        )
        const handler = (tag: string, extra: object = {}) => ({
          type: "command",
          command: process.execPath,
          args: [hookScript, tag],
          ...extra,
        })
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PreToolUse: [
              { matcher: "mcp__fixture__pick", hooks: [handler("canonical-pre")] },
              { matcher: "fixture_pick", hooks: [handler("native-pre")] },
              { matcher: "mcp__other__.*", hooks: [handler("other-server-pre")] },
              { hooks: [handler("if-pre", { if: "mcp__fixture__pick" })] },
            ],
            PostToolUse: [{ matcher: "mcp__fixture__.*", hooks: [handler("canonical-post")] }],
            PostToolUseFailure: [{ matcher: "mcp__fixture__boom", hooks: [handler("canonical-failure")] }],
            PermissionRequest: [{ matcher: "mcp__fixture__.*", hooks: [handler("canonical-permission")] }],
          }),
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({
            mcp: { fixture: { type: "local", command: [process.execPath, serverScript], enabled: true } },
            permission: { "*": "ask" },
          }),
        )
      })
      yield* llm.tool("fixture_pick", {})
      yield* llm.tool("fixture_boom", {})
      yield* llm.text("MCP_AUDIT_DONE")
      const server = yield* opencode.serve()
      const request = (route: string, method = "GET", body?: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const created = yield* request("/session", "POST", {})
      const session = yield* Effect.promise(() => created.json())
      const prompt = yield* request(`/session/${session.id}/message`, "POST", {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "MCP_AUDIT_REQUEST" }],
      }).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.text())),
        Effect.forkScoped,
      )
      yield* Fiber.join(prompt)
      yield* llm.wait(3)
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const tags = rows.map((row) => row.tag)
      expect(tags).toContain("canonical-pre")
      expect(tags).toContain("native-pre")
      expect(tags).toContain("if-pre")
      expect(tags).toContain("canonical-post")
      expect(tags).toContain("canonical-failure")
      expect(tags).toContain("canonical-permission")
      expect(tags).not.toContain("other-server-pre")
      expect(rows.find((row) => row.tag === "canonical-failure")?.tool_name).toBe("fixture_boom")
      // Suggestions mirror the dialog's own "always allow" patterns, addressed by the official tool name.
      expect(
        rows.find((row) => row.event === "PermissionRequest" && row.tool_name === "fixture_pick")?.suggestions,
      ).toEqual([
        {
          type: "addRules",
          rules: [{ toolName: "mcp__fixture__pick", ruleContent: "*" }],
          behavior: "allow",
          destination: "session",
        },
      ])
      for (const row of rows) expect(row.mcp_server?.name).toBe("fixture")
      // The real server definition has no tracked provenance; it must never be claimed trusted from its name.
      for (const row of rows) expect(row.mcp_server?.source).toBe("unknown")
    }),
)
