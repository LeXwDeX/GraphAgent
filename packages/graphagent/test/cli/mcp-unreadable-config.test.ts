// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

// Issue #1575: a layer of mcp.json that cannot be read used to end `mcp list`, `mcp auth` and `mcp debug` with an
// uncaught error. Each one now warns about the file and goes on with the servers of the other layer.
const userFile = (home: string) => path.join(home, ".config", "graphagent", "mcp.json")

const servers = (value: Record<string, unknown>) => JSON.stringify({ mcpServers: value })

// Writes the user layer and the project layer (a `project` directory under `home`); resolves to the project path.
const layers = (home: string, input: { user: string; project: string }) =>
  Effect.promise(async () => {
    const project = path.join(home, "project")
    await mkdir(path.join(project, ".agents"), { recursive: true })
    await writeFile(userFile(home), input.user)
    await writeFile(path.join(project, ".agents", "mcp.json"), input.project)
    // The process reports the resolved path of its working directory.
    return await realpath(project)
  })

const remote = (name: string, extra: Record<string, unknown> = {}) =>
  servers({ [name]: { type: "remote", url: `https://example.com/${name}`, disabled: true, ...extra } })

describe("graphagent mcp with an mcp.json layer that cannot be read (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "mcp list warns about a project layer that cannot be read and lists the user layer's servers",
    ({ home, graphagent }) =>
      Effect.gen(function* () {
        const project = yield* layers(home, { user: remote("user-server"), project: "{ not json" })

        const result = yield* graphagent.spawn(["mcp", "list"], { cwd: project })

        graphagent.expectExit(result, 0)
        expect(result.stdout).toContain(path.join(project, ".agents", "mcp.json"))
        expect(result.stdout).toContain("not valid JSONC")
        expect(result.stdout).toContain("user-server")
        expect(result.stdout).toContain("1 server(s)")
      }),
    60_000,
  )

  cliIt.concurrent(
    "mcp list warns about a user layer that cannot be read and lists the project layer's servers",
    ({ home, graphagent }) =>
      Effect.gen(function* () {
        // A V1 document: server names at the top level.
        const project = yield* layers(home, {
          user: JSON.stringify({ old: { type: "local", command: ["echo"] } }),
          project: remote("project-server"),
        })

        const result = yield* graphagent.spawn(["mcp", "list"], { cwd: project })

        graphagent.expectExit(result, 0)
        expect(result.stdout).toContain(userFile(home))
        expect(result.stdout).toContain("removed V1 shape")
        expect(result.stdout).toContain("project-server")
        expect(result.stdout).toContain("1 server(s)")
      }),
    60_000,
  )

  cliIt.concurrent(
    "mcp auth list warns about the file and lists the OAuth-capable servers that can be read",
    ({ home, graphagent }) =>
      Effect.gen(function* () {
        const project = yield* layers(home, {
          user: remote("user-server"),
          project: servers({ extra: { type: "remote", url: "https://example.com/extra", unknown: true } }),
        })

        const result = yield* graphagent.spawn(["mcp", "auth", "list"], { cwd: project })

        graphagent.expectExit(result, 0)
        expect(result.stdout).toContain(path.join(project, ".agents", "mcp.json"))
        expect(result.stdout).toContain("is not a valid MCP server entry")
        expect(result.stdout).toContain("user-server")
        expect(result.stdout).toContain("1 OAuth-capable server(s)")
      }),
    60_000,
  )

  cliIt.concurrent(
    "mcp debug warns about the file and still finds a server of the layer that can be read",
    ({ home, graphagent }) =>
      Effect.gen(function* () {
        const project = yield* layers(home, {
          user: remote("user-server", { oauth: false }),
          project: "{ not json",
        })

        const result = yield* graphagent.spawn(["mcp", "debug", "user-server"], { cwd: project })

        graphagent.expectExit(result, 0)
        expect(result.stdout).toContain(path.join(project, ".agents", "mcp.json"))
        expect(result.stdout).toContain("not valid JSONC")
        expect(result.stdout).toContain("MCP server user-server has OAuth explicitly disabled")
      }),
    60_000,
  )
})
