process.env.AGENT = "1"
process.env.OPENCODE = "1"

const { Server } = await import("../../src/server/server")

const hostname = "127.0.0.1"
const server = Bun.serve({
  hostname,
  port: 0,
  idleTimeout: 0,
  fetch: Server.Default().app.fetch,
})

console.log(`opencode test host listening on http://${hostname}:${server.port}`)