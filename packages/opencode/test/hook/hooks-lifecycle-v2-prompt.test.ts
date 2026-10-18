import { decodeV2Session } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live("V2 HTTP prompt admission runs UserPromptSubmit exactly once per durable ID", ({ home, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "v2-prompt-audit.jsonl")
    const allow = path.join(home, "allow-v2-prompt")
    const script = path.join(home, "v2-prompt-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify(input)+"\\n");if(!await Bun.file(${JSON.stringify(allow)}).exists())process.stderr.write("PROMPT_POLICY_DENIED"),process.exit(2);`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          UserPromptSubmit: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    const server = yield* opencode.serve()
    const request = (route: string, method: string, body?: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method,
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
    const created = yield* request("/api/session", "POST", { location: { directory: home } })
    expect(created.status).toBe(200)
    const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
    // V2 sessions share the V1 session row; the title route records a custom
    // title, which is what UserPromptSubmit may expose as session_title.
    const titled = yield* request(`/session/${id}`, "PATCH", { title: "V2 chosen title" })
    expect(titled.status).toBe(200)
    const route = `/api/session/${id}/prompt`
    const body = { id: "msg_v2_hook", prompt: { text: "POLICY_SAMPLE" }, hookMode: "interactive", resume: false }
    const denied = yield* request(route, "POST", body)
    expect(denied.status).toBe(400)
    expect(yield* Effect.promise(() => denied.text())).toContain("PROMPT_POLICY_DENIED")
    yield* Effect.promise(() => fs.writeFile(allow, "yes"))
    const accepted = yield* request(route, "POST", body)
    expect(accepted.status).toBe(200)
    const first = yield* Effect.promise(() => accepted.json())
    expect(first).toMatchObject({ data: { prompt: { text: "POLICY_SAMPLE", hookMode: "interactive" } } })
    const retried = yield* request(route, "POST", body)
    expect(retried.status).toBe(200)
    expect(yield* Effect.promise(() => retried.json())).toEqual(first)
    const conflict = yield* request(route, "POST", { ...body, prompt: { text: "different" } })
    expect(conflict.status).toBe(409)
    const generated = yield* request("/api/session", "POST", { location: { directory: home } })
    const generatedID = decodeV2Session(yield* Effect.promise(() => generated.json())).data.id
    const generatedPrompt = yield* request(`/api/session/${generatedID}/prompt`, "POST", {
      id: "msg_v2_generated",
      prompt: { text: "GENERATED_SAMPLE" },
      hookMode: "interactive",
      resume: false,
    })
    expect(generatedPrompt.status).toBe(200)
    const rows = yield* Effect.promise(async () =>
      (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    expect(rows).toHaveLength(3)
    const titledRows = rows.filter((row) => row.session_id === id)
    expect(titledRows).toHaveLength(2)
    expect(
      titledRows.every(
        (row) =>
          row.hook_event_name === "UserPromptSubmit" &&
          row.prompt === "POLICY_SAMPLE" &&
          // CC names the prompt being submitted, even though its durable row
          // only exists after UserPromptSubmit has run.
          row.prompt_id === "msg_v2_hook" &&
          // session_title is present only for a title the user or a hook chose.
          row.session_title === "V2 chosen title",
      ),
    ).toBe(true)
    const generatedRows = rows.filter((row) => row.session_id === generatedID)
    expect(generatedRows).toHaveLength(1)
    expect(generatedRows[0]).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "GENERATED_SAMPLE",
      prompt_id: "msg_v2_generated",
    })
    // A generated title is not a title the user chose.
    expect(generatedRows[0]).not.toHaveProperty("session_title")
  }),
)
