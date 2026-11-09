// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../../fixture/fixture"

test("real worker reload/shutdown diagnostics only reach its background file", async () => {
  await using tmp = await tmpdir()
  const proc = Bun.spawn(
    [process.execPath, "run", fileURLToPath(new URL("./fixtures/lifecycle-worker.ts", import.meta.url))],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        GRAPHAGENT_LOG_LEVEL: "DEBUG",
        GRAPHAGENT_PRINT_LOGS: "1",
        GRAPHAGENT_TEST_HOME: tmp.path,
        XDG_DATA_HOME: tmp.path,
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(stdout).not.toContain("lifecycle.")
  expect(stderr).not.toContain("lifecycle.")
  const log = await Bun.file(path.join(tmp.path, "graphagent", "log", "graphagent.log")).text()
  expect(log).toContain("lifecycle.worker.reload")
  expect(log).toContain("source=worker.rpc.reload")
  expect(log).toContain("lifecycle.worker.shutdown")
  expect(log).toContain("source=worker.rpc.shutdown")
  expect(log).toMatch(/pid=\d+ threadId=\d+/)
  expect(log).not.toContain("kind=unhandledRejection")
  expect(log).not.toContain("kind=uncaughtException")
})
