// A pre-2026-07-28 MCP stdio server: it rejects the era probe (unknown method)
// and only implements the 2025-11-25 initialize / tools flow. The client's
// `auto` negotiation must fall back to the legacy handshake instead of failing.
//
// Newline-delimited JSON-RPC over stdin/stdout, implemented by hand so the
// fixture cannot accidentally advertise modern support through an SDK helper.
const decoder = new TextDecoder()
let buffer = ""

const send = (message: unknown) => {
  process.stdout.write(JSON.stringify(message) + "\n")
}

const respond = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result })
const reject = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } })

function readText(params: unknown) {
  if (typeof params !== "object" || params === null || !("arguments" in params)) return ""
  const args = params.arguments
  if (typeof args !== "object" || args === null || !("text" in args)) return ""
  return typeof args.text === "string" ? args.text : ""
}

function handle(raw: string) {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return
  if (!("method" in message) || typeof message.method !== "string") return
  const method = message.method
  const id = "id" in message ? message.id : undefined
  const params = "params" in message ? message.params : undefined
  // Notifications (no id) carry no response.
  if (id === undefined) return

  switch (method) {
    case "server/discover":
      reject(id, -32601, "Method not found")
      return
    case "initialize":
      respond(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy-only-fixture", version: "0.0.0" },
      })
      return
    case "tools/list":
      respond(id, {
        tools: [
          {
            name: "echo",
            description: "Echo the input text",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      })
      return
    case "tools/call": {
      respond(id, { content: [{ type: "text", text: `echo-legacy-only:${readText(params)}` }] })
      return
    }
    case "ping":
      respond(id, {})
      return
    default:
      reject(id, -32601, "Method not found")
  }
}

async function main() {
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) handle(line)
      newline = buffer.indexOf("\n")
    }
  }
}

await main()
