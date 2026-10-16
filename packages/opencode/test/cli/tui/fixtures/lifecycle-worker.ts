import { Rpc } from "../../../../src/util/rpc"
import fs from "node:fs/promises"
import path from "node:path"

const worker = new Worker(new URL("../../../../src/cli/tui/worker.ts", import.meta.url).href)
const events: unknown[] = []
const client = Rpc.client<typeof import("../../../../src/cli/tui/worker").rpc>(worker)
client.on("global.event", (event) => events.push(event))
client.on("worker.fatal", () => {
  throw new Error("unexpected worker fatal")
})
try {
  await client.call("reload", undefined)
  await client.call("shutdown", undefined)
  const file = path.join(process.env.XDG_DATA_HOME!, "opencode", "log", "opencode.log")
  const deadline = Date.now() + 10000
  while (true) {
    const log = await fs.readFile(file, "utf8").catch(() => "")
    if (log.includes("lifecycle.worker.shutdown")) break
    if (Date.now() > deadline) throw new Error("worker diagnostic flush never observed")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (JSON.stringify(events).includes("lifecycle.")) throw new Error("diagnostic leaked into RPC events")
} finally {
  worker.terminate()
}
