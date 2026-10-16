import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { decodeRecord, decodeRecords, decodeSession } from "../lib/hook-json"

cliIt.live(
  "SessionStart environment reaches both V1 InstructionsLoaded paths once per session",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const hostValue = process.env.INSTRUCTION_SESSION_VALUE
      const audit = path.join(home, "instructions-environment.jsonl")
      const script = path.join(home, "instructions-environment.ts")
      let nested = path.join(home, "nested", "value.txt")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(nested), { recursive: true })
        await fs.writeFile(
          path.join(home, ".config/opencode/AGENTS.md"),
          "# Root instruction\nUse fixture conventions.\n",
        )
        await fs.writeFile(path.join(home, "nested/AGENTS.md"), "# Nested instruction\nRead this local fixture.\n")
        await fs.writeFile(nested, "ACTUAL_NESTED_INPUT")
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');if(i.hook_event_name==='SessionStart'){await fs.appendFile(process.env.CLAUDE_ENV_FILE,'export INSTRUCTION_SESSION_VALUE='+i.session_id+'\\nunset INSTRUCTION_REMOVE\\n')}else{await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({session:i.session_id,reason:i.load_reason,path:i.file_path??i.path,value:process.env.INSTRUCTION_SESSION_VALUE,removed:!("INSTRUCTION_REMOVE" in process.env),transcriptReadable:await Bun.file(i.transcript_path).exists()})+'\\n')}`,
        )
        const handlers = [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }]
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ SessionStart: handlers, InstructionsLoaded: handlers }),
        )
      })
      // Instance directories are canonicalized; use the same real path for
      // traversal instead of macOS's /var alias for the temporary directory.
      nested = yield* Effect.promise(() => fs.realpath(nested))
      const server = yield* opencode.serve({ env: { INSTRUCTION_REMOVE: "HOST_BASELINE" } })
      const post = (route: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const ids: string[] = []
      for (let session = 0; session < 2; session++) {
        const created = yield* post("/session", {
          title: "Instruction environment fixture",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        expect(created.status).toBe(200)
        const id = decodeSession(yield* Effect.promise(() => created.json())).id
        ids.push(id)
        for (let turn = 0; turn < 2; turn++) {
          yield* llm.tool("read", { filePath: nested })
          yield* llm.text("INSTRUCTION_ENVIRONMENT_DONE")
          const response = yield* post(`/session/${id}/message`, {
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "Read the nested fixture file" }],
          })
          expect(response.status).toBe(200)
          const result = decodeRecord(yield* Effect.promise(() => response.json()))
          expect(decodeRecord(result.info).error).toBeUndefined()
          const history = yield* Effect.promise(async () =>
            decodeRecords(
              await (
                await fetch(server.url + `/session/${id}/message`, {
                  headers: { "x-opencode-directory": home },
                })
              ).json(),
            ),
          )
          const reads = history
            .flatMap((message) => decodeRecords(message.parts))
            .filter((part) => part.type === "tool" && part.tool === "read")
          expect(reads.length).toBeGreaterThan(0)
          expect(
            reads.some((read) => {
              const loaded = decodeRecord(decodeRecord(read.state).metadata).loaded
              return Array.isArray(loaded) && loaded.includes(path.join(path.dirname(nested), "AGENTS.md"))
            }),
          ).toBe(true)
          for (const read of reads) {
            const state = decodeRecord(read.state)
            expect(state.status).toBe("completed")
            expect(state.output).toContain("ACTUAL_NESTED_INPUT")
          }
        }
      }
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => decodeRecord(JSON.parse(line)))
      expect(
        rows.map((row) => ({ session: row.session, reason: row.reason, value: row.value, removed: row.removed })),
      ).toEqual(
        ids.flatMap((id) => [
          { session: id, reason: "session_start", value: id, removed: true },
          { session: id, reason: "nested_traversal", value: id, removed: true },
        ]),
      )
      expect(rows).toHaveLength(4)
      for (const id of ids) {
        const sessionRows = rows.filter((row) => row.session === id)
        expect(sessionRows.map((row) => String(row.reason)).sort((left, right) => left.localeCompare(right))).toEqual([
          "nested_traversal",
          "session_start",
        ])
        for (const row of sessionRows) expect(row).toMatchObject({ value: id, removed: true, transcriptReadable: true })
      }
      expect(new Set(rows.map((row) => row.value)).size).toBe(2)
      expect(yield* llm.calls).toBe(8)
      expect(process.env.INSTRUCTION_SESSION_VALUE).toBe(hostValue)
    }),
)
