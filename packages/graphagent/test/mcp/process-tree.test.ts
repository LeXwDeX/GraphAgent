// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "node:path"
import { expect, test } from "bun:test"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"
import { alive, readLaunches } from "./fixtures/launch-log"

// Issue #503: dynamic disconnect must reap the local server's whole process
// tree — the root stdio process AND any children it spawned — not just close
// the client. The probe runs in a subprocess because sibling mcp test files
// mock @modelcontextprotocol/client via mock.module, whose registry is
// process-global across the suite; a fresh process guarantees the real
// transports (same pattern as session-recovery.test.ts).
test("mcp disconnect kills the local server process and its spawned child", async () => {
  if (process.platform === "win32") return // descendants discovery is POSIX-only

  // The fixture logs every child it starts here. One connect launches the server
  // more than once (the SDK negotiates the era on a disposable sibling first) and
  // the product only reaps the session's own tree, so this log is how the test
  // shows that nothing the fixture started outlives the run (#1411).
  await using tmp = await tmpdir()
  const launchLog = path.join(tmp.path, "fixture-launches.log")
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures", "process-tree-probe.ts"), launchLog],
    {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      // A hung probe must fail this test and be killed, not linger in the background.
      timeout: 25_000,
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
    ])

    expect(code, `${stderr}\n${stdout}`).toBe(0)
    const jsonLine = stdout.trimEnd().split("\n").pop()
    expect(JSON.parse(jsonLine ?? "")).toMatchObject({ ok: true, rootDead: true, childDead: true })

    const launches = await readLaunches(launchLog)
    expect(launches.length).toBeGreaterThan(0)
    expect(launches.filter((launch) => alive(launch.child))).toEqual([])
  } finally {
    // The probe reaps its own launches; this covers one that died or hung before it could.
    child.kill()
    await Process.stopTree((await readLaunches(launchLog)).map((launch) => launch.child).filter(alive))
  }
})
