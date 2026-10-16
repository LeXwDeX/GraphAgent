import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

cliIt.live(
  "raw V2 permission transcript retains actual tool names and readable tool errors",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-permission-transcript.jsonl")
      const hook = path.join(home, "v2-transcript-hook.ts")
      yield* Effect.promise(async () => {
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
        await fs.writeFile(
          hook,
          `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==="PreToolUse"&&(i.tool_name==="Write"||i.tool_name==="write"))process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask"}}));if(i.hook_event_name==="PermissionRequest"){await Bun.write(${JSON.stringify(audit)},await Bun.file(i.transcript_path).text());process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"}}}));}`,
        )
        const handler = { type: "command", command: process.execPath, args: [hook] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ PreToolUse: [{ hooks: [handler] }], PermissionRequest: [{ hooks: [handler] }] }),
        )
      })
      yield* llm.tool("read", { path: "actual-missing-transcript-file.txt" })
      yield* llm.text("READ_ERROR_COMPLETE")
      const server = yield* opencode.serve()
      const request = (route: string, method = "GET", body?: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const created = yield* request("/api/session", "POST", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const id = (yield* Effect.promise(() => created.json())).data.id
      yield* request(`/api/session/${id}/prompt`, "POST", {
        prompt: { text: "Read the missing synthetic file" },
        resume: true,
      })
      yield* pollWithTimeout(
        request(`/api/session/${id}/context`).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json())),
          Effect.map((value) => (JSON.stringify(value).includes("READ_ERROR_COMPLETE") ? true : undefined)),
        ),
        "actual read failure must complete",
      )
      yield* llm.tool("write", { path: "transcript-approved.txt", content: "approved" })
      yield* llm.text("WRITE_TRANSCRIPT_DONE")
      yield* request(`/api/session/${id}/prompt`, "POST", {
        prompt: { text: "Write the synthetic file" },
        resume: true,
      })
      const pending = yield* pollWithTimeout(
        request(`/api/session/${id}/permission`).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json())),
          Effect.map((value) => value.data?.[0]),
        ),
        "actual second-turn permission must arrive",
      )
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const blocks = rows.flatMap((row) => row.message.content)
      const read = blocks.find((block) => block.type === "tool_use" && block.name === "read")
      expect(read).toBeDefined()
      expect(blocks.filter((block) => block.type === "tool_use").every((block) => typeof block.name === "string")).toBe(
        true,
      )
      const result = blocks.find((block) => block.type === "tool_result" && block.tool_use_id === read.id)
      expect(result.is_error).toBe(true)
      expect(typeof result.content).toBe("string")
      expect(result.content).toContain("actual-missing-transcript-file.txt")
      yield* request(`/api/session/${id}/permission/${pending.id}/reply`, "POST", { reply: "once" })
      yield* llm.wait(4)
    }),
)
