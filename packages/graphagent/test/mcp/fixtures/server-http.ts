import { z } from "zod"
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server"

const factory = () => {
  const server = new McpServer({ name: "v2-fixture-http", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.registerTool(
    "echo",
    {
      description: "echo the input back",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text" as const, text: `echo-http:${text}` }] }),
  )
  return server
}

const handler = createMcpHandler(factory)
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    try {
      return await handler.fetch(req)
    } catch (e) {
      console.error("[fixture]", e)
      return new Response(JSON.stringify({ error: "internal fixture error" }), { status: 500 })
    }
  },
})
console.log(`listening ${server.port}`)
