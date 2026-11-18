// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Dual-era fixture: the SAME factory serves 2026-07-28 (server/discover) and
// legacy (initialize) clients — serveStdio owns the era decision per connection.
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

// Process-tree fixture (#503): optionally spawn a long-lived child so tests can
// assert the server's whole tree is reaped on disconnect. Every launch appends
// "<server pid> <child pid>" to the file named by MCP_FIXTURE_CHILD_PID_FILE
// (see launch-log.ts): the SDK launches this server once more on a disposable
// sibling for era negotiation, so a single-slot file loses that launch's child.
// The child outlives its parent on purpose, so it also expires on its own; a
// launch nobody reaps (a killed test runner) must not leave an immortal orphan.
// The lifetime far exceeds every wait in the tests, so expiry never stands in
// for the reaping they assert.
const CHILD_LIFETIME_MS = 120_000
const childPidFile = process.env.MCP_FIXTURE_CHILD_PID_FILE
if (childPidFile) {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${CHILD_LIFETIME_MS})`], { stdio: "ignore" })
  child.unref()
  appendFileSync(childPidFile, `${process.pid} ${child.pid}\n`)
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
