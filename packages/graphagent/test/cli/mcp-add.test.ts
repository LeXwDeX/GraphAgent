import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

const readJson = (file: string) => Effect.promise(() => Bun.file(file).json())

describe("graphagent mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers to the global mcp.json",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--global",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 0)

        const config = yield* readJson(path.join(home, ".config", "graphagent", "mcp.json"))
        expect(config).toEqual({
          mcpServers: {
            github: {
              type: "remote",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer {env:GITHUB_TOKEN}",
                "X-Option": "one=two",
              },
            },
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--global",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 0)

        const config = yield* readJson(path.join(home, ".config", "graphagent", "mcp.json"))
        expect(config.mcpServers.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "writes to the project layer by default",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const project = path.join(home, "project")
        yield* Effect.promise(() => mkdir(project, { recursive: true }))

        const result = yield* opencode.spawn(
          ["mcp", "add", "project-server", "--url", "https://example.com/project"],
          { cwd: project },
        )
        opencode.expectExit(result, 0)

        const config = yield* readJson(path.join(project, ".agents", "mcp.json"))
        expect(config.mcpServers["project-server"]).toEqual({
          type: "remote",
          url: "https://example.com/project",
        })
        const globalExists = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "graphagent", "mcp.json")).exists(),
        )
        expect(globalExists).toBe(false)
      }),
    60_000,
  )
})