import { Rpc } from "../../../src/util/rpc"
const worker = new Worker(new URL("../../../src/cli/tui/worker.ts", import.meta.url).href)
const client = Rpc.client<typeof import("../../../src/cli/tui/worker").rpc>(worker)
try {
  const response = await client.call("fetch", {
    url: "http://opencode.example.com/session",
    method: "POST",
    headers: { "content-type": "application/json", "x-graphagent-directory": process.env.LIFECYCLE_DIRECTORY! },
    body: "{}",
  })
  if (response.status !== 200) throw new Error(`session fixture status ${response.status}`)
  if (process.env.LIFECYCLE_MOVE === "1") {
    const directory = process.env.LIFECYCLE_DIRECTORY!
    const destination = directory + "/moved"
    await (await import("node:fs/promises")).mkdir(destination)
    const session = JSON.parse(response.body)
    const moved = await client.call("fetch", {
      url: "http://opencode.example.com/experimental/control-plane/move-session",
      method: "POST",
      headers: { "content-type": "application/json", "x-graphagent-directory": directory },
      body: JSON.stringify({ sessionID: session.id, destination: { directory: destination } }),
    })
    if (moved.status !== 204) throw new Error(`move fixture status ${moved.status}`)
  }
  await client.call("shutdown")
} finally {
  worker.terminate()
}
