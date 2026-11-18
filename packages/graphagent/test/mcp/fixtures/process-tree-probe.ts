// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Runs in a fresh bun process so the real @modelcontextprotocol transports are
// used even when the surrounding test run has mock.module overrides active
// (Bun's module registry is process-global across the suite). Drives
// MCP.Service against the server-stdio fixture: connect a local server that
// spawns a child, disconnect, and report whether the whole process tree was
// reaped (issue #503).
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Effect } from "effect"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { alive, readLaunches } from "./launch-log"

// A direct subprocess does not run test/preload.ts. Set its own paths before
// importing application modules, including xdg-basedir's import-time cache.
const isolation = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-tree-"))
process.env.XDG_DATA_HOME = path.join(isolation, "share")
process.env.XDG_CACHE_HOME = path.join(isolation, "cache")
process.env.XDG_CONFIG_HOME = path.join(isolation, "config")
process.env.XDG_STATE_HOME = path.join(isolation, "state")
process.env.GRAPHAGENT_CONFIG_DIR = path.join(isolation, "config", "graphagent")
process.env.GRAPHAGENT_TEST_HOME = path.join(isolation, "home")
process.env.GRAPHAGENT_TEST_MANAGED_CONFIG_DIR = path.join(isolation, "managed")
process.env.GRAPHAGENT_DB = ":memory:"
delete process.env.GRAPHAGENT_CONFIG
delete process.env.GRAPHAGENT_CONFIG_CONTENT
await fs.mkdir(process.env.GRAPHAGENT_TEST_HOME, { recursive: true })
const { MCP } = await import("../../../src/mcp/index")
const { withTmpdirInstance } = await import("../../fixture/fixture")
const { Process } = await import("../../../src/util/process")
const { AppRuntime } = await import("../../../src/effect/app-runtime")
const ownedPids: number[] = []
// The fixture appends one line per launch (see launch-log.ts). The test passes
// the path so it can check for leftovers after this process exits.
const launchLog = process.argv[2] ?? path.join(isolation, "fixture-launches.log")

function waitDead(pid: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (!alive(pid)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

// One connect launches the server more than once (the SDK negotiates the era on
// a disposable sibling first), so match the launch by this session's server pid
// instead of trusting whichever launch wrote last.
async function waitForChild(file: string, serverPid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const launch = (await readLaunches(file)).find((entry) => entry.server === serverPid)
    if (launch) return launch.child
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

let result: { ok: boolean; rootDead?: boolean; childDead?: boolean }
try {
  result = await Effect.runPromise(
    withTmpdirInstance({ mcp: {} })(
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("tree-server", {
          type: "local",
          command: [process.execPath, path.join(import.meta.dir, "server-stdio.ts")],
          environment: { MCP_FIXTURE_CHILD_PID_FILE: launchLog },
        })

        const status = (yield* mcp.status())["tree-server"]
        if (status?.status !== "connected") return { ok: false, stage: "connect", status }

        const client = (yield* mcp.clients())["tree-server"]
        const rootPid = client?.transport instanceof StdioClientTransport ? client.transport.pid : null
        if (typeof rootPid !== "number") return { ok: false, stage: "root-pid" }
        ownedPids.push(rootPid)

        const childPid = yield* Effect.promise(() => waitForChild(launchLog, rootPid, 5_000))
        if (childPid === undefined) return { ok: false, stage: "child-pid-file", rootPid }
        ownedPids.push(childPid)

        yield* mcp.disconnect("tree-server")

        return {
          ok: true,
          rootDead: yield* Effect.promise(() => waitDead(rootPid, 10_000)),
          childDead: yield* Effect.promise(() => waitDead(childPid, 10_000)),
          rootPid,
          childPid,
        }
      }),
    ).pipe(Effect.scoped, Effect.provide(MCP.defaultLayer)),
  )
} finally {
  // Cleanup follows the observations and never changes a failed result into a
  // pass. Only fixture-owned PIDs are eligible, even when pgrep is unavailable:
  // this session's server and child, plus every child the fixture logged. The
  // era-negotiation sibling started a child of its own that only the log knows.
  const logged = (await readLaunches(launchLog)).map((launch) => launch.child)
  await Process.stopTree([...new Set([...ownedPids, ...logged])])
  await AppRuntime.dispose()
  await fs.rm(isolation, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`)
process.exit(result.ok && result.rootDead && result.childDead ? 0 : 1)
