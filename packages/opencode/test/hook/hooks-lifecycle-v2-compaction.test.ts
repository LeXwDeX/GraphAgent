import { decodeV2Context, decodeV2Session } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "V2 automatic compaction honors PreCompact and runs PostCompact then SessionStart(compact)",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const configPath = path.join(home, ".config/opencode/opencode.json")
      const audit = path.join(home, "v2-compact-audit.jsonl")
      const script = path.join(home, "v2-compact-hook.ts")
      const block = path.join(home, "block-compaction")
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(home, ".config/opencode/AGENTS.md"), "# Compact fixture instructions\n")
        await fs.writeFile(
          configPath,
          JSON.stringify({
            compaction: { keep: { tokens: 1_000 } },
            providers: {
              test: {
                name: "Test",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llm.url,
                  settings: { apiKey: "test-key" },
                },
                request: { body: { apiKey: "test-key" } },
                models: {
                  "test-model": {
                    name: "Test Model",
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    limit: { context: 30_000, output: 1_000 },
                    cost: { input: 0, output: 0 },
                  },
                },
              },
            },
          }),
        )
        await fs.writeFile(block, "blocked")
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,source:i.source,trigger:i.trigger,summary:i.compact_summary,reason:i.load_reason,file:i.file_path})+'\\n');if(i.hook_event_name==='PreCompact'&&await Bun.file(${JSON.stringify(block)}).exists())process.stdout.write(JSON.stringify({decision:'block',reason:'blocked before summary'}));if(i.hook_event_name==='SessionStart')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'COMPACT_REINJECTION'}}));`,
        )
        const command = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PreCompact: [{ hooks: [command] }],
            PostCompact: [{ hooks: [command] }],
            SessionStart: [{ matcher: "compact", hooks: [command] }],
            InstructionsLoaded: [{ hooks: [command] }],
          }),
        )
      })
      yield* llm.text("BLOCKED_TURN")
      yield* llm.text("BLOCKED_SECOND")
      yield* llm.text("SUMMARY_MARKER")
      yield* llm.text("AFTER_COMPACT")
      const server = yield* opencode.serve()
      const headers = { "content-type": "application/json", "x-opencode-directory": home }
      const created = yield* Effect.promise(() =>
        fetch(server.url + "/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ location: { directory: home }, model: { providerID: "test", id: "test-model" } }),
        }),
      )
      expect(created.status).toBe(200)
      const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
      const prompt = (text: string) =>
        Effect.promise(() =>
          fetch(server.url + `/api/session/${id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: { text }, hookMode: "noninteractive", resume: true }),
          }),
        )
      const context = () =>
        Effect.promise(async () => {
          const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
          expect(response.status).toBe(200)
          return decodeV2Context(await response.json()).data
        })
      const waitText = (needle: string) =>
        Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const rows = await Effect.runPromise(context())
            if (JSON.stringify(rows).includes(needle)) return rows
            await Bun.sleep(50)
          }
          const messages = await Effect.runPromise(context())
          throw new Error(
            `Automatic compaction did not reach ${needle}: ${JSON.stringify({ audit: await fs.readFile(audit, "utf8").catch(() => "none"), context: messages.map((message) => ({ type: message.type, finish: message.finish, text: typeof message.text === "string" ? message.text.slice(0, 80) : undefined, summary: typeof message.summary === "string" ? message.summary.slice(0, 80) : undefined })), calls: await Effect.runPromise(llm.calls), stderr: server.stderrTail() })}`,
          )
        })
      expect((yield* prompt("X".repeat(60_000))).status).toBe(200)
      yield* waitText("BLOCKED_TURN")
      expect((yield* context()).filter((message) => message.type === "compaction")).toHaveLength(0)
      expect((yield* prompt("Y".repeat(10_000))).status).toBe(200)
      yield* waitText("BLOCKED_SECOND")
      expect((yield* context()).filter((message) => message.type === "compaction")).toHaveLength(0)
      let rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.filter((row: { event: string }) => row.event === "PreCompact")).toHaveLength(1)
      yield* Effect.promise(() => fs.unlink(block))

      expect((yield* prompt("Z".repeat(1_000))).status).toBe(200)
      const finished = yield* waitText("AFTER_COMPACT")
      expect(finished.filter((message) => message.type === "compaction")).toHaveLength(1)
      rows = yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const rows = (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          if (
            rows.some(
              (row: { event: string; source?: string }) => row.event === "SessionStart" && row.source === "compact",
            ) &&
            rows.some(
              (row: { event: string; reason?: string }) =>
                row.event === "InstructionsLoaded" && row.reason === "compact",
            )
          )
            return rows
          await Bun.sleep(50)
        }
        throw new Error(`Compaction hooks did not complete: ${await fs.readFile(audit, "utf8")}`)
      })
      expect(rows.filter((row: { event: string }) => row.event !== "InstructionsLoaded").slice(1)).toEqual([
        expect.objectContaining({ event: "PreCompact", trigger: "auto" }),
        expect.objectContaining({ event: "PostCompact", trigger: "auto", summary: "SUMMARY_MARKER" }),
        expect.objectContaining({ event: "SessionStart", source: "compact" }),
      ])
      const inputs = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))
      expect(inputs).toHaveLength(4)
      expect(JSON.stringify(inputs[3])).toContain("COMPACT_REINJECTION")
      expect(finished).toContainEqual(expect.objectContaining({ type: "synthetic", text: "COMPACT_REINJECTION" }))
      const compactLoads = rows.filter(
        (row: { event: string; reason?: string }) => row.event === "InstructionsLoaded" && row.reason === "compact",
      )
      expect(compactLoads, JSON.stringify(rows)).toHaveLength(1)
      expect(compactLoads[0].file).toBe(
        path.join(yield* Effect.promise(() => fs.realpath(home)), ".config/opencode/AGENTS.md"),
      )

      // A failed summarizer may run PreCompact, but it must not publish a
      // completed compaction or its PostCompact/SessionStart follow-up.
      yield* llm.fail("summary failed")
      expect((yield* prompt("W".repeat(10_000))).status).toBe(200)
      const afterFailure = yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const latest = (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          const calls = await Effect.runPromise(llm.calls)
          if (latest.filter((row: { event: string }) => row.event === "PreCompact").length >= 3 && calls >= 5) {
            await Bun.sleep(100)
            return latest
          }
          await Bun.sleep(50)
        }
        throw new Error(`Summary failure was not reached: ${await fs.readFile(audit, "utf8")}`)
      })
      expect(afterFailure.filter((row: { event: string }) => row.event === "PostCompact")).toHaveLength(1)
      expect(afterFailure.filter((row: { event: string }) => row.event === "SessionStart")).toHaveLength(1)
      expect((yield* context()).filter((message) => message.type === "compaction")).toHaveLength(1)
    }),
)
