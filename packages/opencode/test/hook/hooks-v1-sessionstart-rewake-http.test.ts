import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

// SessionStart hooks are not wrapped by the V1 prompt loop. The V2 bridge is
// still registered in a served graph, so it must decline the legacy session
// instead of starting a hidden V2 turn that the V1 transcript never shows.
cliIt.live("V1 SessionStart asyncRewake exit-2 wakes the legacy session", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "v1-async-session-start.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `await Bun.stdin.text();await Bun.sleep(100);console.error('V1_SESSIONSTART_REWAKE');process.exit(2)`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: process.execPath, args: [script], asyncRewake: true }],
            },
          ],
        }),
      )
    })
    yield* llm.text("REWAKE_DONE")
    const server = yield* opencode.serve()
    const request = (route: string, body?: object) =>
      Effect.promise(async () => {
        const result = await fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!result.ok) throw new Error(`${route}: ${result.status} ${await result.text()}`)
        return result.json()
      })
    const session = yield* request("/session", {
      title: "V1 SessionStart rewake",
      model: { providerID: "test", id: "test-model" },
    })
    const messages = yield* pollWithTimeout(
      Effect.gen(function* () {
        const list = yield* request(`/session/${session.id}/message`)
        return JSON.stringify(list).includes("REWAKE_DONE") ? list : undefined
      }),
      "SessionStart rewake never reached the legacy session transcript",
      15_000,
    )
    const text = JSON.stringify(messages)
    expect(text).toContain("V1_SESSIONSTART_REWAKE")
    expect(text).toContain("REWAKE_DONE")
  }),
)
