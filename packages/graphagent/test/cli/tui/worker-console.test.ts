import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

test("worker imports and SDK warnings are logged without writing to the TUI terminal", async () => {
  await using tmp = await tmpdir()
  const worker = new URL("./fixtures/worker-diagnostics.ts", import.meta.url).href
  const script = `const worker = new Worker(${JSON.stringify(worker)}); worker.onmessage = () => worker.terminate(); worker.onerror = (event) => { throw event.error };`
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      XDG_DATA_HOME: tmp.path,
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
  const log = await Bun.file(path.join(tmp.path, "graphagent", "log", "graphagent.log")).text()
  for (const marker of [
    "worker-import-warning-marker",
    "worker-info-marker",
    "worker-debug-marker",
    "worker-error-marker",
    "AI SDK Warning: System messages",
  ])
    expect(log).toContain(marker)
})
