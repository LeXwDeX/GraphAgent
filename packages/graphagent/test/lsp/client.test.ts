import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import * as LSPServer from "@/lsp/server"

function spawnFakeServer() {
  const { spawn } = require("child_process")
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

/** The same fake server, typed, so a test can pass it to LSPClient.create without casts. */
function fakeServerHandle(): LSPServer.Handle {
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return { process: spawn(process.execPath, [serverPath], { stdio: "pipe" }) }
}

/** A diagnostics wait times out after 5 s or 10 s: the timers it must not leave behind once it returned. */
const LONG_TIMER_MS = 1_000

/** The instance around the client runs background work with timers of its own; only timers set by the client count. */
const CLIENT_SOURCE = /src[\\/]lsp[\\/]client\.ts/

/**
 * Wraps globalThis.setTimeout and clearTimeout to watch the timers of LONG_TIMER_MS or more that the client sets. A
 * watched timer is pending from its creation until it fires or is cleared. restore() puts the originals back and clears
 * what is still pending, so a wait that fails its check cannot hold this process or a later test.
 */
function watchLongTimers() {
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  const watched = new Map<ReturnType<typeof setTimeout>, { delay: number; pending: boolean }>()
  // Object.assign keeps the members of the native function, so each wrapper still has the type of the original.
  globalThis.setTimeout = Object.assign((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const entry = { delay: delay ?? 0, pending: true }
    const timer = nativeSetTimeout(
      (...fired: unknown[]) => {
        entry.pending = false
        handler(...fired)
      },
      delay,
      ...args,
    )
    if (entry.delay >= LONG_TIMER_MS && CLIENT_SOURCE.test(new Error().stack ?? "")) watched.set(timer, entry)
    return timer
  }, nativeSetTimeout)
  globalThis.clearTimeout = Object.assign((timer: Parameters<typeof nativeClearTimeout>[0]) => {
    const entry = typeof timer === "object" ? watched.get(timer) : undefined
    if (entry) entry.pending = false
    nativeClearTimeout(timer)
  }, nativeClearTimeout)
  return {
    /** How many watched timers were set. */
    armed: () => watched.size,
    /** Delays, in ms, of the watched timers that are still pending. */
    pending: () => [...watched.values()].filter((entry) => entry.pending).map((entry) => entry.delay),
    restore() {
      globalThis.setTimeout = nativeSetTimeout
      globalThis.clearTimeout = nativeClearTimeout
      for (const [timer, entry] of watched) if (entry.pending) nativeClearTimeout(timer)
    },
  }
}

/** Runs `wait`; returns its answer and the delays of the long timers the client left pending once it returned. */
async function leftoverTimers(wait: () => Promise<boolean>) {
  const timers = watchLongTimers()
  try {
    const answer = await wait()
    // A wait that armed nothing would pass without showing anything, say if stacks stopped naming the client.
    expect(timers.armed()).toBeGreaterThan(0)
    return { answer, pending: timers.pending() }
  } finally {
    timers.restore()
  }
}

/** A client on the fake server with `file` open at `version`, shut down afterwards, for the tests that watch a wait. */
async function withOpenFile(fn: (client: LSPClient.Info, file: string, version: number) => Promise<void>) {
  const handle = fakeServerHandle()
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "client.ts")
  await Bun.write(file, "const x = 1\n")
  await withTestInstance({
    directory: tmp.path,
    fn: async (ctx) => {
      const client = await LSPClient.create({
        serverID: "fake",
        server: handle,
        root: tmp.path,
        directory: tmp.path,
        instance: ctx,
      })
      try {
        await fn(client, file, await client.notify.open({ path: file }))
      } finally {
        await client.shutdown()
      }
    },
  })
}

const diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  message: "diagnostic",
  severity: 1,
}

describe("LSPClient interop", () => {
  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("initialize does not overclaim unsupported diagnostics capabilities", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const params = await client.connection.sendRequest<any>("test/get-initialize-params", {})
    expect(params.capabilities.workspace.diagnostics.refreshSupport).toBe(false)
    expect(params.capabilities.textDocument.publishDiagnostics.versionSupport).toBe(false)

    await client.shutdown()
  })

  test("workspace/configuration returns one result per requested item", async () => {
    const handle = spawnFakeServer() as any
    const initialization = {
      alpha: {
        beta: 1,
      },
      gamma: true,
    }

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: {
            ...(handle as unknown as LSPServer.Handle),
            initialization,
          },
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const response = await client.connection.sendRequest<any[]>("test/request-configuration", {
      items: [{ section: "alpha" }, { section: "alpha.beta" }, { section: "missing" }, {}],
    })

    expect(response).toEqual([{ beta: 1 }, 1, null, initialization])

    await client.shutdown()
  })

  test("sends ranged didChange for incremental sync servers", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "first\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.notify.open({ path: file })
        await Bun.write(file, "second\nthird\n")
        await client.notify.open({ path: file })

        const change = await client.connection.sendRequest<{
          textDocument: { version: number }
          contentChanges: {
            range?: { start: { line: number; character: number }; end: { line: number; character: number } }
            text: string
          }[]
        }>("test/get-last-change", {})
        expect(change.textDocument.version).toBe(1)
        expect(change.contentChanges).toEqual([
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            text: "second\nthird\n",
          },
        ])

        await client.shutdown()
      },
    })
  })

  test("document mode falls back to push diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        const wait = client.waitForDiagnostics({ path: file, version, mode: "document" })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })
        expect(await wait).toBe(true)

        const diagnostics = client.diagnostics.get(file) ?? []
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.message).toBe("push diagnostic")

        const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
        expect(count).toBe(0)

        await client.shutdown()
      },
    })
  })

  test("document mode accepts matching push diagnostics published before waiting", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })

        for (let i = 0; i < 20 && (client.diagnostics.get(file)?.length ?? 0) === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }

        expect(client.diagnostics.get(file)?.[0]?.message).toBe("push diagnostic")

        const started = Date.now()
        expect(await client.waitForDiagnostics({ path: file, version, mode: "document" })).toBe(true)
        expect(Date.now() - started).toBeLessThan(1_000)

        await client.shutdown()
      },
    })
  })

  test("document mode waits for pull diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "DocumentCompilerSemantic" }],
          documentDiagnosticsByIdentifier: {
            DocumentCompilerSemantic: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "pull diagnostic",
                severity: 1,
              },
            ],
          },
        })

        const version = await client.notify.open({ path: file })
        expect(await client.waitForDiagnostics({ path: file, version, mode: "document" })).toBe(true)

        const diagnostics = client.diagnostics.get(file) ?? []
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.message).toBe("pull diagnostic")

        const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
        expect(count).toBeGreaterThan(0)

        await client.shutdown()
      },
    })
  })

  test("document mode does not wait for the slowest pull identifier after current-file diagnostics arrive", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registrations: [{ identifier: "fast" }, { identifier: "slow" }],
          documentDiagnosticsByIdentifier: {
            fast: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "fast diagnostic",
                severity: 1,
              },
            ],
            slow: [],
          },
          documentDelayMsByIdentifier: {
            slow: 2_500,
          },
        })

        const version = await client.notify.open({ path: file })
        await client.connection.sendRequest("test/register-configured-pull-diagnostics", {})
        await new Promise((resolve) => setTimeout(resolve, 100))
        const started = Date.now()
        expect(await client.waitForDiagnostics({ path: file, version, mode: "document" })).toBe(true)

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(client.diagnostics.get(file)?.[0]?.message).toBe("fast diagnostic")
        expect(await client.connection.sendRequest("test/get-diagnostic-request-count", {})).toBeGreaterThan(1)

        await client.shutdown()
      },
    })
  })

  test("full mode includes workspace pull diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    const related = path.join(tmp.path, "other.cs")
    await Bun.write(file, "class C {}\n")
    await Bun.write(related, "class D {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [
            { identifier: "DocumentCompilerSemantic" },
            { identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true },
          ],
          documentDiagnosticsByIdentifier: {
            DocumentCompilerSemantic: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "current file",
                severity: 1,
              },
            ],
          },
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [
              {
                uri: pathToFileURL(related).href,
                items: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 5 },
                    },
                    message: "workspace file",
                    severity: 1,
                  },
                ],
              },
            ],
          },
        })

        const version = await client.notify.open({ path: file })
        expect(await client.waitForDiagnostics({ path: file, version, mode: "full" })).toBe(true)

        expect(client.diagnostics.get(file)?.[0]?.message).toBe("current file")
        expect(client.diagnostics.get(related)?.[0]?.message).toBe("workspace file")

        await client.shutdown()
      },
    })
  })

  test("full mode treats an empty workspace pull response as handled", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true }],
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [],
          },
        })

        const version = await client.notify.open({ path: file })
        const started = Date.now()
        expect(await client.waitForDiagnostics({ path: file, version, mode: "full" })).toBe(true)

        expect(Date.now() - started).toBeLessThan(1_000)

        await client.shutdown()
      },
    })
  })

  test("full mode falls back to push diagnostics", async () => {
    const handle = fakeServerHandle()
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        const wait = client.waitForDiagnostics({ path: file, version, mode: "full" })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })
        expect(await wait).toBe(true)
        expect(client.diagnostics.get(file)?.[0]?.message).toBe("push diagnostic")

        await client.shutdown()
      },
    })
  })

  // The wait window runs from `after`. A touch that began just under the window ago reaches the timeout after a short
  // wait, so the cases where nothing is ever published do not sit through the real 5 and 10 seconds. The service-level
  // test in index.test.ts covers the full-length wait.
  const waits: ["document" | "full", number][] = [
    ["document", 5_000],
    ["full", 10_000],
  ]
  test.each(waits)("%s mode reports false when the server publishes nothing in the window", async (mode, windowMs) => {
    const handle = fakeServerHandle()
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        const started = Date.now()
        const result = await client.waitForDiagnostics({ path: file, version, mode, after: started - (windowMs - 500) })

        expect(result).toBe(false)
        expect(Date.now() - started).toBeLessThan(windowMs - 500)
        expect(client.diagnostics.get(file) ?? []).toHaveLength(0)

        await client.shutdown()
      },
    })
  })

  // A diagnostics wait arms a push wait for the whole call and a registration wait for each round, each with a timer
  // and a listener. The listener goes with the same cancel as the timer, so the timers are what these tests read back.
  // One case per way out of the wait; none may leave its 5 s or 10 s timer pending.
  describe("diagnostics wait cleanup", () => {
    const modes = ["document", "full"] as const

    test.each(modes)("%s mode leaves no timer pending when a pull answers in the first round", (mode) =>
      withOpenFile(async (client, file, version) => {
        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registrations: [{}],
          documentDiagnostics: [diagnostic],
        })
        // The server sends the registration before it answers this request and the client handles messages in order,
        // so the registration is in place when the wait starts.
        await client.connection.sendRequest("test/register-configured-pull-diagnostics", {})

        const { answer, pending } = await leftoverTimers(() => client.waitForDiagnostics({ path: file, version, mode }))

        expect(answer).toBe(true)
        expect(pending).toEqual([])
      }),
    )

    test.each(modes)("%s mode leaves no timer pending when a registration arrives and the next pull answers", (mode) =>
      withOpenFile(async (client, file, version) => {
        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registrations: [{}],
          documentDiagnostics: [diagnostic],
        })

        const { answer, pending } = await leftoverTimers(async () => {
          // Nothing is registered yet, so there is nothing to pull and the wait parks until the registration arrives.
          const wait = client.waitForDiagnostics({ path: file, version, mode })
          await client.connection.sendRequest("test/register-configured-pull-diagnostics", {})
          return wait
        })

        expect(answer).toBe(true)
        expect(pending).toEqual([])
      }),
    )

    test.each(modes)("%s mode leaves no timer pending when a push wins the race", (mode) =>
      withOpenFile(async (client, file, version) => {
        const { answer, pending } = await leftoverTimers(async () => {
          const wait = client.waitForDiagnostics({ path: file, version, mode })
          await client.connection.sendNotification("test/publish-diagnostics", {
            uri: pathToFileURL(file).href,
            version,
            diagnostics: [diagnostic],
          })
          return wait
        })

        expect(answer).toBe(true)
        expect(pending).toEqual([])
      }),
    )

    // The window is nearly spent when the wait starts, as in the timeout test above, so it ends on its own timer.
    test.each(waits)("%s mode leaves no timer pending when the wait runs out", (mode, windowMs) =>
      withOpenFile(async (client, file, version) => {
        const started = Date.now()

        const { answer, pending } = await leftoverTimers(() =>
          client.waitForDiagnostics({ path: file, version, mode, after: started - (windowMs - 500) }),
        )

        expect(answer).toBe(false)
        expect(pending).toEqual([])
      }),
    )
  })
})
