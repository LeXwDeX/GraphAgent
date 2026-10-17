import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { $ } from "bun"
import { pollWithTimeout } from "../lib/effect"
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

import type { OpencodeCli } from "../lib/cli-process"

const instructionSetup = (home: string, opencode: OpencodeCli, source: string) =>
  Effect.gen(function* () {
    const audit = path.join(home, "instructions-audit.jsonl")
    const script = path.join(home, "instructions-audit.ts")
    yield* Effect.promise(async () => {
      await $`git init`.cwd(home).quiet()
      await $`git config commit.gpgsign false`.cwd(home).quiet()
      await $`git -c user.name=Test -c user.email=test@example.test commit --allow-empty -m fixture`.cwd(home).quiet()
      await fs.mkdir(path.join(home, "nested"), { recursive: true })
      await fs.writeFile(path.join(home, ".config/opencode/AGENTS.md"), "# Global instruction\n")
      await fs.writeFile(path.join(home, "AGENTS.md"), "# Project instruction\n")
      await fs.writeFile(path.join(home, "nested/AGENTS.md"), "# Nested instruction\n")
      await fs.writeFile(path.join(home, "nested/value.txt"), "NESTED_VALUE")
      await fs.writeFile(script, source.replaceAll("__AUDIT__", JSON.stringify(audit)))
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          InstructionsLoaded: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    const server = yield* opencode.serve({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "" } })
    const post = (route: string, payload: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(payload),
        }),
      )
    const created = yield* post("/session", {})
    const id = decodeSession(yield* Effect.promise(() => created.json())).id
    const rows = Effect.promise(async () =>
      (await fs.readFile(audit, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeRecord(JSON.parse(line))),
    )
    const nested = yield* Effect.promise(() => fs.realpath(path.join(home, "nested/value.txt")))
    const turn = (text: string) =>
      Effect.gen(function* () {
        const response = yield* post(`/session/${id}/message`, {
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text }],
        })
        expect(response.status).toBe(200)
        yield* Effect.promise(() => response.text())
      })
    return { audit, post, id, rows, nested, turn }
  })

const record =
  'const i=JSON.parse(await Bun.stdin.text());const fs=await import("node:fs/promises");await fs.appendFile(__AUDIT__,JSON.stringify({reason:i.load_reason,path:i.file_path,type:i.memory_type,trigger:i.trigger_file_path})+"\\n");'

cliIt.live("V1 InstructionsLoaded reports real memory_type and the nested trigger file", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const fixture = yield* instructionSetup(home, opencode, record)
    yield* llm.tool("read", { filePath: fixture.nested })
    yield* llm.text("DONE")
    yield* fixture.turn("read nested")
    const rows = yield* pollWithTimeout(
      fixture.rows.pipe(Effect.map((items) => (items.length >= 3 ? items : undefined))),
      "InstructionsLoaded rows",
      "10 seconds",
    )
    const byPath = (suffix: string) => rows.find((row) => String(row.path).endsWith(suffix))
    expect(byPath(path.join(".config/opencode/AGENTS.md"))).toMatchObject({ reason: "session_start", type: "User" })
    expect(rows.find((row) => row.reason === "session_start" && row.type === "Project")).toBeDefined()
    expect(rows.find((row) => row.reason === "nested_traversal")).toMatchObject({
      type: "Project",
      trigger: fixture.nested,
    })
    expect(rows.some((row) => row.type === "Managed" || row.type === undefined)).toBe(false)
  }),
)

cliIt.live("V1 InstructionsLoaded observes in the background without delaying the model", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const done = path.join(home, "instructions-slow-done")
    const fixture = yield* instructionSetup(
      home,
      opencode,
      `${record}await new Promise((resolve)=>setTimeout(resolve,9000));await fs.writeFile(${JSON.stringify(done)},"done");`,
    )
    yield* llm.text("BACKGROUND_DONE")
    yield* fixture.turn("hello")
    expect(yield* Effect.promise(() => fs.exists(done))).toBe(false)
    yield* pollWithTimeout(
      Effect.promise(async () => ((await fs.exists(done)) ? true : undefined)),
      "background hook completion",
      "30 seconds",
    )
  }),
)

cliIt.live(
  "V1 InstructionsLoaded reloads with load_reason compact after a committed compaction",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const fixture = yield* instructionSetup(home, opencode, record)
      yield* llm.text("FIRST")
      yield* fixture.turn("first")
      yield* pollWithTimeout(
        fixture.rows.pipe(Effect.map((items) => (items.length >= 2 ? items : undefined))),
        "initial rows",
        "10 seconds",
      )
      yield* llm.text("COMPACT_SUMMARY")
      const summarized = yield* fixture.post(`/session/${fixture.id}/summarize`, {
        providerID: "test",
        modelID: "test-model",
        auto: false,
      })
      expect(summarized.status).toBe(200)
      yield* Effect.promise(() => summarized.text())
      yield* llm.text("AFTER_COMPACT")
      yield* fixture.turn("after")
      const rows = yield* pollWithTimeout(
        fixture.rows.pipe(Effect.map((items) => (items.some((row) => row.reason === "compact") ? items : undefined))),
        "compact reload rows",
        "10 seconds",
      )
      expect(
        rows
          .filter((row) => row.reason === "compact")
          .map((row) => row.type)
          .sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(["Project", "User"])
      expect(rows.filter((row) => row.reason === "session_start")).toHaveLength(2)
    }),
)
