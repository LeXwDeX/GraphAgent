import path from "node:path"
import { expect, test } from "bun:test"

// Issue #503: dynamic disconnect must reap the local server's whole process
// tree — the root stdio process AND any children it spawned — not just close
// the client. The probe runs in a subprocess because sibling mcp test files
// mock @modelcontextprotocol/client via mock.module, whose registry is
// process-global across the suite; a fresh process guarantees the real
// transports (same pattern as session-recovery.test.ts).
test("mcp disconnect kills the local server process and its spawned child", async () => {
  if (process.platform === "win32") return // descendants discovery is POSIX-only

  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "process-tree-probe.ts")], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])

  expect(code, `${stderr}\n${stdout}`).toBe(0)
  const jsonLine = stdout.trimEnd().split("\n").pop()
  expect(JSON.parse(jsonLine ?? "")).toMatchObject({ ok: true, rootDead: true, childDead: true })
})
