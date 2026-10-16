import { Rpc } from "../../../src/util/rpc"
const worker = new Worker(new URL("../../../src/cli/tui/worker.ts", import.meta.url).href)
const client = Rpc.client<typeof import("../../../src/cli/tui/worker").rpc>(worker)
try {
  const response = await client.call("fetch", {
    url: process.env.LIFECYCLE_V2 === "1" ? "http://opencode.internal/api/session" : "http://opencode.internal/session",
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": process.env.LIFECYCLE_DIRECTORY! },
    body:
      process.env.LIFECYCLE_V2 === "1"
        ? JSON.stringify({ location: { directory: process.env.LIFECYCLE_DIRECTORY! } })
        : "{}",
  })
  if (response.status !== 200) throw new Error(`session fixture status ${response.status}`)
  if (process.env.LIFECYCLE_MOVE === "1") {
    const directory = process.env.LIFECYCLE_DIRECTORY!
    const destination = directory + "/moved"
    await (await import("node:fs/promises")).mkdir(destination)
    const session = JSON.parse(response.body)
    const moved = await client.call("fetch", {
      url: "http://opencode.internal/experimental/control-plane/move-session",
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      body: JSON.stringify({ sessionID: session.id, destination: { directory: destination } }),
    })
    if (moved.status !== 204) throw new Error(`move fixture status ${moved.status}`)
  }
  await client.call("shutdown", undefined)
} finally {
  worker.terminate()
}
