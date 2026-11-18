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
})
