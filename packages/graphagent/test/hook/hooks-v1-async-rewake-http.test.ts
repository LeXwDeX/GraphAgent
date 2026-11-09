// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

// A legacy (V1) session served by the full server graph also has the V2 rewake
// bridge registered. An asyncRewake callback started by a V1 tool must wake the
// V1 SessionPrompt loop that the TUI renders, not a hidden V2 runner turn.
cliIt.live("V1 PostToolUse asyncRewake exit-2 wakes the legacy session it came from", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "v1-async-post-tool.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `await Bun.stdin.text();await Bun.sleep(100);console.error('V1_ASYNC_REWAKE_CONTEXT');process.exit(2)`,
      )
      await fs.writeFile(
        path.join(home, ".config/graphagent/hooks.json"),
        JSON.stringify({
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: process.execPath, args: [script], asyncRewake: true }],
            },
          ],
        }),
      )
    })
    yield* llm.tool("bash", { command: "echo V1_TOOL_RAN", description: "Print a marker" })
    yield* llm.text("FIRST_DONE")
    yield* llm.text("REWAKE_DONE")
    const server = yield* opencode.host()
    const request = (route: string, body?: object) =>
      Effect.promise(async () => {
        const result = await fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-graphagent-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!result.ok) throw new Error(`${route}: ${result.status} ${await result.text()}`)
        return result.json()
      })
    const session = yield* request("/session", {
      title: "V1 async rewake",
      model: { providerID: "test", id: "test-model" },
    })
    yield* request(`/session/${session.id}/message`, { parts: [{ type: "text", text: "run the marker" }] })
    const messages = yield* pollWithTimeout(
      Effect.gen(function* () {
        const list = yield* request(`/session/${session.id}/message`)
        return JSON.stringify(list).includes("REWAKE_DONE") ? list : undefined
      }),
      "async rewake never reached the legacy session transcript",
      15_000,
    )
    const text = JSON.stringify(messages)
    expect(text).toContain("V1_TOOL_RAN")
    expect(text).toContain("FIRST_DONE")
    expect(text).toContain("V1_ASYNC_REWAKE_CONTEXT")
  }),
)
