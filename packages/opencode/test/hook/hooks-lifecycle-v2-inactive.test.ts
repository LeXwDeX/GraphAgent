import { expect } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

cliIt.live("V2 inactive prompt and tool hooks leave the startup transcript untouched", ({ home, opencode, llm }) =>
  Effect.gen(function* () {
    const source = path.join(home, "inactive-source.txt")
    yield* Effect.promise(async () => {
      await fs.writeFile(source, "INACTIVE_HOOK_READ_CONTENT")
      await fs.writeFile(
        path.join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          providers: {
            test: {
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: llm.url,
                settings: { apiKey: "test-key" },
              },
              models: { "test-model": {} },
            },
          },
        }),
      )
    })
    const server = yield* opencode.serve()
    const request = (route: string, body?: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
    const created = yield* request("/api/session", {
      location: { directory: home },
      model: { providerID: "test", id: "test-model" },
    })
    expect(created.status).toBe(200)
    const id = (yield* Effect.promise(() => created.json())).data.id
    const transcript = path.join(
      home,
      ".local/share/opencode/hooks/transcripts",
      createHash("sha256").update(id).digest("hex") + ".jsonl",
    )
    const before = yield* Effect.promise(() => fs.stat(transcript))
    yield* llm.tool("read", { path: source })
    yield* llm.text("INACTIVE_HOOK_DONE")
    expect((yield* request(`/api/session/${id}/prompt`, { prompt: { text: "Read the local file" } })).status).toBe(200)
    const context = yield* pollWithTimeout(
      request(`/api/session/${id}/context`).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((value) => (JSON.stringify(value).includes("INACTIVE_HOOK_DONE") ? value : undefined)),
      ),
      "V2 read turn did not finish",
    )
    yield* pollWithTimeout(
      request("/session/status").pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((statuses) => (statuses[id] === undefined ? true : undefined)),
      ),
      "V2 turn did not settle idle",
    )
    expect(yield* llm.calls).toBe(2)
    expect(JSON.stringify(context)).toContain("INACTIVE_HOOK_READ_CONTENT")
    const after = yield* Effect.promise(() => fs.stat(transcript))
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
  }),
)
