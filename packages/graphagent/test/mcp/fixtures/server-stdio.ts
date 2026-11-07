// Dual-era fixture: the SAME factory serves 2026-07-28 (server/discover) and
// legacy (initialize) clients — serveStdio owns the era decision per connection.
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

// Process-tree fixture (#503): optionally spawn a long-lived child so tests can
// assert the server's whole tree is reaped on disconnect. The child's pid is
// published to the file named by MCP_FIXTURE_CHILD_PID_FILE.
const childPidFile = process.env.MCP_FIXTURE_CHILD_PID_FILE
if (childPidFile) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  child.unref()
  writeFileSync(childPidFile, String(child.pid))
}

serveStdio(
  () => {
    const server = new McpServer({ name: "v2-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
    server.registerTool(
      "echo",
      {
        description: "echo the input back",
        inputSchema: { text: z.string() },
      },
      async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
    )
    return server
  },
  {
    onerror: (e) => console.error("[fixture]", e.message),
  },
)
