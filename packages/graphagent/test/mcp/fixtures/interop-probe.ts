// Runs the real v2 client against the fixture servers in a fresh process.
// Sibling test files mock.module("@modelcontextprotocol/client") in the shared
// bun test process, so real-transport coverage must not import the SDK there.
import path from "node:path"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const mode = process.argv[2] ?? "stdio-auto"
const TIMEOUT_MS = 10_000
let httpServer: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined

process.on("SIGTERM", () => {
  httpServer?.kill()
  process.exit(1)
})

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function firstText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text
}

async function runStdio(legacy: boolean) {
  const client = new Client({ name: "interop-probe", version: "0.0.0" }, { versionNegotiation: { mode: legacy ? "legacy" : "auto" } })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dir, "server-stdio.ts")],
  })
  await withTimeout(client.connect(transport), "stdio connect timed out")
  try {
    const result = await client.callTool({ name: "echo", arguments: { text: legacy ? "legacy" : "hello" } })
    return { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion(), echo: firstText(result as { content: Array<{ type: string; text?: string }> }) }
  } finally {
    await client.close()
  }
}

async function readListeningPort(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value)
    const port = Number(buffer.match(/listening (\d+)/)?.[1])
    if (port) {
      reader.releaseLock()
      return port
    }
    if (done) throw new Error(`http fixture exited before reporting a port: ${buffer}`)
  }
}

async function runHttp() {
  httpServer = Bun.spawn([process.execPath, path.join(import.meta.dir, "server-http.ts")], {
    cwd: path.join(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "inherit",
  })
  const port = await withTimeout(readListeningPort(httpServer.stdout), "http fixture did not report a port in time")
  const client = new Client({ name: "interop-probe", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } })
  await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))), "http connect timed out")
  try {
    const result = await client.callTool({ name: "echo", arguments: { text: "http" } })
    return { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion(), echo: firstText(result as { content: Array<{ type: string; text?: string }> }) }
  } finally {
    await client.close()
    httpServer.kill()
    await httpServer.exited
  }
}

const outcome = mode === "http-auto" ? await runHttp() : await runStdio(mode === "stdio-legacy")
console.log(JSON.stringify({ mode, ...outcome }))
process.exit(0)
