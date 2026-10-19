import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"
import { decodeRecords, decodeV2Session } from "../lib/hook-json"

cliIt.live(
  "V2 read/write/edit hooks preserve native output and provide Claude file responses",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "claude-output.jsonl")
      const hook = path.join(home, "claude-output-hook.ts")
      const source = path.join(home, "source.txt")
      const edited = path.join(home, "edited.txt")
      yield* Effect.promise(async () => {
        await fs.writeFile(source, "SOURCE_CONTENT")
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({
            providers: {
              test: {
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llm.url,
                  settings: { apiKey: "fixture" },
                },
                models: { "test-model": {} },
              },
            },
          }),
        )
        await fs.writeFile(
          hook,
          `
const i = JSON.parse(await Bun.stdin.text());
if (i.hook_event_name === "PreToolUse") process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}));
if (i.hook_event_name === "PostToolUse") await (await import("node:fs/promises")).appendFile(${JSON.stringify(audit)}, JSON.stringify(i) + "\\n");
`,
        )
        const handler = { type: "command", command: process.execPath, args: [hook] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PreToolUse: [{ hooks: [handler] }],
            PostToolUse: [{ hooks: [handler, { ...handler, inputFormat: "claude-code" }] }],
          }),
        )
      })
      yield* llm.tool("read", { path: source })
      yield* llm.tool("write", { path: edited, content: "before" })
      yield* llm.tool("edit", { path: edited, oldString: "before", newString: "after" })
      yield* llm.text("Done")
      const server = yield* opencode.serve()
      const headers = { "content-type": "application/json", "x-opencode-directory": home }
      const request = (route: string, body: object) =>
        Effect.promise(() => fetch(server.url + route, { method: "POST", headers, body: JSON.stringify(body) }))
      const created = yield* request("/api/session", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
      const submitted = yield* request(`/api/session/${id}/prompt`, {
        prompt: { text: "Read source, write before, then edit to after" },
        resume: true,
      })
      expect(submitted.status).toBe(200)
      const rows = yield* pollWithTimeout(
        Effect.promise(async () => {
          const text = await fs.readFile(audit, "utf8").catch(() => "")
          const rows = text.trim()
            ? decodeRecords(
                text
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line)),
              )
            : []
          return rows.length === 6 ? rows : undefined
        }),
        "V2 file hook responses did not arrive",
        "15 seconds",
      )
      const resolvedEdited = yield* Effect.promise(() => fs.realpath(edited))
      const byName = (name: string) => rows.find((row) => row.tool_name === name)?.tool_response
      expect(byName("read")).toMatchObject({ content: "SOURCE_CONTENT" })
      expect(byName("Read")).toEqual({ file: { filePath: source, content: "SOURCE_CONTENT" } })
      expect(byName("write")).toMatchObject({ operation: "write", target: resolvedEdited, existed: false })
      expect(byName("Write")).toEqual({ filePath: resolvedEdited, structuredPatch: [], success: true })
      expect(byName("edit")).toMatchObject({ operation: "write", target: resolvedEdited, replacements: 1 })
      expect(byName("Edit")).toEqual({ filePath: resolvedEdited, structuredPatch: [], success: true })
      expect(rows.every((row) => !Object.hasOwn(row, "toolOutput"))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(edited, "utf8"))).toBe("after")
    }),
)
