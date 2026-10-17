import { decodeJsonRecord, decodeV2Context, decodeV2Session, decodeRecords, decodeRecord } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"

const writeLocalModel = (home: string, url: string) =>
  fs.writeFile(
    path.join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      providers: {
        test: {
          name: "Test",
          api: {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url,
            settings: { apiKey: "test-key" },
          },
          request: { body: { apiKey: "test-key" } },
          models: {
            "test-model": {
              name: "Test Model",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    }),
  )

cliIt.live(
  "V2 HTTP prompt runs configured turn hooks through the real local model and replays canonical text",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-turn-audit.jsonl")
      const script = path.join(home, "v2-turn-hook.ts")
      const source = path.join(home, "source.txt")
      yield* Effect.promise(async () => {
        await fs.writeFile(source, "SOURCE_CONTENT")
        await writeLocalModel(home, llm.url)
        await fs.writeFile(
          script,
          `
const i=JSON.parse(await Bun.stdin.text());
const audit=${JSON.stringify(audit)};
const rows=(await Bun.file(audit).text().catch(()=>""));
await Bun.write(audit,rows+JSON.stringify(i)+"\\n");
const e=i.hook_event_name;
if(e==="PreToolUse") process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:e,permissionDecision:"allow"}}));
if(e==="PostToolBatch") process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:e,additionalContext:"BATCH_CONTEXT"}}));
if(e==="Stop" && !i.stop_hook_active) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:e,additionalContext:"STOP_CONTINUATION"}}));
if(e==="MessageDisplay") process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:e,displayContent:i.delta.replaceAll("SECRET","REDACTED")}}));
`,
        )
        const handler = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify(
            Object.fromEntries(
              ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolBatch", "Stop", "MessageDisplay"].map(
                (event) => [event, [{ hooks: [handler] }]],
              ),
            ),
          ),
        )
      })
      yield* llm.tool("read", { path: source })
      yield* llm.text("SECRET first answer")
      yield* llm.text("SECRET final answer")
      const server = yield* opencode.serve()
      const request = (route: string, method: string, body?: object) =>
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
      const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
      const submitted = yield* request(`/api/session/${id}/prompt`, "POST", {
        prompt: { text: "Read source" },
        hookMode: "interactive",
        resume: true,
      })
      if (submitted.status !== 200) {
        const readback = yield* request(`/api/session/${id}`, "GET")
        throw new Error(
          JSON.stringify({
            promptStatus: submitted.status,
            promptBody: yield* Effect.promise(() => submitted.text()),
            getStatus: readback.status,
            getBody: yield* Effect.promise(() => readback.text()),
            dataFiles: yield* Effect.promise(() =>
              fs.readdir(path.join(home, ".local/share/opencode")).catch(() => []),
            ),
          }),
        )
      }
      expect(submitted.status).toBe(200)
      const messages = yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const response = await fetch(server.url + `/api/session/${id}/context`, {
            headers: { "x-opencode-directory": home },
          })
          expect(response.status).toBe(200)
          const data = decodeV2Context(await response.json()).data
          if (JSON.stringify(data).includes("REDACTED final answer")) return data
          await Bun.sleep(100)
        }
        const response = await fetch(server.url + `/api/session/${id}/context`, {
          headers: { "x-opencode-directory": home },
        })
        const models = await fetch(server.url + "/api/model", {
          headers: { "x-opencode-directory": home },
        })
        const modelList = decodeV2Context(await models.json()).data
        const logDir = path.join(home, ".local/share/opencode/log")
        const logs = await Promise.all(
          (await fs.readdir(logDir).catch(() => [])).map(async (name) => [
            name,
            (await fs.readFile(path.join(logDir, name), "utf8").catch(() => ""))
              .split("\n")
              .filter((line) => /V2 diagnostic|failed|ERROR|WARN/.test(line))
              .slice(-30),
          ]),
        )
        throw new Error(
          `V2 turn did not finish: ${JSON.stringify({ calls: await Effect.runPromise(llm.calls), context: await response.json(), modelStatus: models.status, testModelAvailable: modelList.some((model) => model.providerID === "test" && model.id === "test-model"), audit: await fs.readFile(audit, "utf8").catch(() => "no hook audit"), stderr: server.stderrTail(), logs })}`,
        )
      })
      const assistant = messages.filter((item) => item.type === "assistant")
      const text = assistant.flatMap((item) => decodeRecords(item.content ?? []).filter((part) => part.type === "text"))
      expect(text.map((part) => part.text)).toContain("SECRET final answer")
      expect(text.map((part) => part.displayText)).toContain("REDACTED final answer")
      const rows = yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const rows = (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => decodeJsonRecord(line))
          if (rows.some((row) => row.hook_event_name === "Stop" && row.stop_hook_active === true)) return rows
          await Bun.sleep(50)
        }
        throw new Error("V2 Stop continuation hook did not finish after the final model response")
      })
      const events = rows.map((row) => row.hook_event_name)
      for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolBatch", "Stop", "MessageDisplay"])
        expect(events).toContain(event)
      expect(rows.filter((row) => row.hook_event_name === "Stop").map((row) => row.stop_hook_active)).toEqual([
        false,
        true,
      ])
      expect(rows.filter((row) => row.hook_event_name === "Stop").map((row) => row.background_tasks)).toEqual([[], []])
      expect(rows.filter((row) => row.hook_event_name === "Stop").map((row) => row.session_crons)).toEqual([[], []])
      const inputs = (yield* llm.inputs).filter(
        (input) => !JSON.stringify(input).includes("Generate a title for this conversation"),
      )
      expect(inputs).toHaveLength(3)
      expect(JSON.stringify(inputs[1])).toContain("BATCH_CONTEXT")
      expect(JSON.stringify(inputs[2])).toContain("STOP_CONTINUATION")
      expect(JSON.stringify(inputs[2])).toContain("SECRET first answer")
    }),
)

cliIt.live(
  "V2 StopFailure sends only the displayed provider error to a configured local hook",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-stop-failure.json")
      const script = path.join(home, "v2-stop-failure.ts")
      yield* Effect.promise(async () => {
        await writeLocalModel(home, llm.url)
        await fs.writeFile(script, `await Bun.write(${JSON.stringify(audit)},await Bun.stdin.text())`)
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            StopFailure: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      yield* llm.error(400, { error: { message: "invalid request shown" } })
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
      const submitted = yield* Effect.promise(() =>
        fetch(server.url + `/api/session/${id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: { text: "fail once" }, resume: true }),
        }),
      )
      expect(submitted.status).toBe(200)
      const envelope = yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const value = await fs.readFile(audit, "utf8").catch(() => "")
          if (value) return decodeJsonRecord(value)
          await Bun.sleep(40)
        }
        const context = await fetch(server.url + `/api/session/${id}/context`, { headers })
        throw new Error(
          `StopFailure was not delivered: ${JSON.stringify({ stderr: server.stderrTail(), calls: await Effect.runPromise(llm.calls), context: await context.json() })}`,
        )
      })
      expect(envelope.hook_event_name).toBe("StopFailure")
      expect(envelope.error).toBe("invalid_request")
      expect(envelope.error_details).toContain("invalid request shown")
      expect(envelope.last_assistant_message).toBe(envelope.error_details)
      if (typeof envelope.error_details !== "string") throw new Error("StopFailure error details missing")
      const context = yield* Effect.promise(() =>
        fetch(server.url + `/api/session/${id}/context`, { headers }).then((res) => res.json()),
      )
      const shown = decodeV2Context(context).data.find((item) => item.error)?.error
      expect(shown === undefined ? undefined : decodeRecord(shown).message).toBe(envelope.error_details)
    }),
)

cliIt.live("V2 HTTP loads instruction, skill and agent hooks from their real sources", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "v2-source-audit.jsonl")
    const script = path.join(home, "v2-source-hook.ts")
    yield* Effect.promise(async () => {
      await writeLocalModel(home, llm.url)
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({kind:process.argv[2],event:i.hook_event_name,session:i.session_id,file:i.file_path,memory:i.memory_type,reason:i.load_reason})+'\\n');`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/AGENTS.md"),
        "# User instructions\nRead the fixture skill when asked.\n",
      )
      await fs.mkdir(path.join(home, ".opencode/skills/hooked"), { recursive: true })
      const command = (kind: string) => ({ type: "command", command: process.execPath, args: [script, kind] })
      await fs.writeFile(
        path.join(home, ".opencode/skills/hooked/SKILL.md"),
        `---\n${JSON.stringify({ name: "hooked", description: "V2 scoped hook fixture", hooks: { UserPromptSubmit: [{ once: true, hooks: [command("skill")] }] } })}\n---\n# Hooked fixture\nLoaded by the skill tool.\n`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ InstructionsLoaded: [{ hooks: [command("instructions")] }] }),
      )
      const configPath = path.join(home, ".config/opencode/opencode.json")
      const config = JSON.parse(await fs.readFile(configPath, "utf8"))
      config.agents = {
        build: { hooks: { Stop: [{ hooks: [command("build")] }] } },
        alternate: {
          description: "Alternate scoped agent",
          mode: "primary",
          hooks: { Stop: [{ hooks: [command("alternate")] }] },
        },
      }
      await fs.writeFile(configPath, JSON.stringify(config))
    })
    yield* llm.tool("skill", { name: "hooked" })
    yield* llm.text("FIRST_DONE")
    yield* llm.text("SECOND_DONE")
    yield* llm.text("THIRD_DONE")
    const server = yield* opencode.serve()
    const request = (route: string, method: string, body?: object) =>
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
    const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
    const prompt = (text: string) =>
      request(`/api/session/${id}/prompt`, "POST", { prompt: { text }, hookMode: "noninteractive", resume: true })
    const waitText = (needle: string) =>
      Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const response = await fetch(server.url + `/api/session/${id}/context`, {
            headers: { "x-opencode-directory": home },
          })
          const data = decodeV2Context(await response.json()).data
          if (JSON.stringify(data).includes(needle)) return data
          await Bun.sleep(50)
        }
        throw new Error(
          `V2 source turn did not reach ${needle}: ${await fs.readFile(audit, "utf8").catch(() => "no audit")}`,
        )
      })
    expect((yield* prompt("Load hooked skill")).status).toBe(200)
    yield* waitText("FIRST_DONE")
    expect((yield* prompt("Use loaded hooks")).status).toBe(200)
    yield* waitText("SECOND_DONE")
    expect((yield* request(`/api/session/${id}/agent`, "POST", { agent: "alternate" })).status).toBe(204)
    expect((yield* prompt("Now alternate agent")).status).toBe(200)
    yield* waitText("THIRD_DONE")
    const rows = yield* Effect.promise(async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const text = await fs.readFile(audit, "utf8").catch(() => "")
        const rows = text.trim()
          ? text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : []
        if (rows.some((row: { kind: string }) => row.kind === "alternate")) return rows
        await Bun.sleep(50)
      }
      const context = await fetch(server.url + `/api/session/${id}/context`, {
        headers: { "x-opencode-directory": home },
      })
      throw new Error(
        `Alternate agent Stop hook did not run: ${JSON.stringify({ audit: await fs.readFile(audit, "utf8").catch(() => "none"), context: await context.json(), calls: await Effect.runPromise(llm.calls), stderr: server.stderrTail() })}`,
      )
    })
    expect(rows.filter((row: { kind: string }) => row.kind === "skill")).toHaveLength(1)
    expect(rows.filter((row: { kind: string }) => row.kind === "build")).toHaveLength(2)
    expect(rows.filter((row: { kind: string }) => row.kind === "alternate")).toHaveLength(1)
    const canonicalHome = yield* Effect.promise(() => fs.realpath(home))
    expect(rows.filter((row: { kind: string }) => row.kind === "instructions")).toEqual([
      expect.objectContaining({
        event: "InstructionsLoaded",
        file: path.join(canonicalHome, ".config/opencode/AGENTS.md"),
        memory: "User",
        reason: "session_start",
      }),
    ])
  }),
)

cliIt.live("V2 rejects defer for a multi-call provider batch and settles both tools", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const first = path.join(home, "first.txt")
    const second = path.join(home, "second.txt")
    const audit = path.join(home, "multi-defer-audit.jsonl")
    const script = path.join(home, "multi-defer-hook.ts")
    yield* Effect.promise(async () => {
      await writeLocalModel(home, llm.url)
      const configPath = path.join(home, ".config/opencode/opencode.json")
      const config = JSON.parse(await fs.readFile(configPath, "utf8"))
      config.agents = { build: { permissions: [{ action: "read", resource: "*", effect: "allow" }] } }
      await fs.writeFile(configPath, JSON.stringify(config))
      await fs.writeFile(first, "FIRST_TOOL_CONTENT")
      await fs.writeFile(second, "SECOND_TOOL_CONTENT")
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({id:i.tool_use_id,path:i.tool_input.file_path})+'\\n');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'defer'}}));`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    yield* llm.push(reply().toolAt(0, "read", { path: first }).toolAt(1, "read", { path: second }).item())
    yield* llm.text("MULTI_DONE")
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
    const submitted = yield* Effect.promise(() =>
      fetch(server.url + `/api/session/${id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: { text: "Read two files" }, hookMode: "noninteractive", resume: true }),
      }),
    )
    expect(submitted.status).toBe(200)
    const messages = yield* Effect.promise(async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
        const data = decodeV2Context(await response.json()).data
        if (JSON.stringify(data).includes("MULTI_DONE")) return data
        await Bun.sleep(50)
      }
      const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
      throw new Error(
        `Multi-call V2 turn did not finish: ${JSON.stringify({ audit: await fs.readFile(audit, "utf8").catch(() => "no audit"), context: await response.json(), calls: await Effect.runPromise(llm.calls), stderr: server.stderrTail() })}`,
      )
    })
    const tools = messages.flatMap((message) =>
      message.type === "assistant" ? decodeRecords(message.content ?? []).filter((part) => part.type === "tool") : [],
    )
    expect(tools).toHaveLength(2)
    expect(tools.map((tool) => decodeRecord(tool.state).status)).toEqual(["completed", "completed"])
    expect(JSON.stringify(messages)).not.toContain("tool_deferred")
    const inputs = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))
    expect(inputs).toHaveLength(2)
    expect(JSON.stringify(inputs[1])).toContain("FIRST_TOOL_CONTENT")
    expect(JSON.stringify(inputs[1])).toContain("SECOND_TOOL_CONTENT")
  }),
)

cliIt.live(
  "V2 HTTP resume retries one durable deferred call across server restart before another model request",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const original = path.join(home, "original.txt")
      const replacement = path.join(home, "replacement.txt")
      const allow = path.join(home, "allow-resume")
      const audit = path.join(home, "v2-defer-audit.jsonl")
      const script = path.join(home, "v2-defer-hook.ts")
      yield* Effect.promise(async () => {
        await writeLocalModel(home, llm.url)
        await fs.writeFile(original, "ORIGINAL_CONTENT")
        await fs.writeFile(replacement, "REPLACEMENT_CONTENT")
        await fs.writeFile(
          script,
          `
const i=JSON.parse(await Bun.stdin.text());
const audit=${JSON.stringify(audit)};
if(i.hook_event_name==="PostToolBatch") {
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolBatch",additionalContext:"RESUMED_BATCH_CONTEXT"}}));
  process.exit(0);
}
await Bun.write(audit,(await Bun.file(audit).text().catch(()=>""))+JSON.stringify({id:i.tool_use_id,input:i.tool_input})+"\\n");
const approved=await Bun.file(${JSON.stringify(allow)}).exists();
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:approved?"allow":"defer",...(approved?{updatedInput:{path:${JSON.stringify(replacement)}}}:{})}}));
`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
            PostToolBatch: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      yield* llm.tool("read", { path: original })
      yield* llm.text("AFTER_RESUME")
      const request = (url: string, route: string, method: string, body?: object) =>
        Effect.promise(() =>
          fetch(url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const context = (url: string, id: string) =>
        Effect.promise(async () => {
          const response = await fetch(url + `/api/session/${id}/context`, {
            headers: { "x-opencode-directory": home },
          })
          if (response.status !== 200) throw new Error(`Context read failed: ${response.status}`)
          return decodeV2Context(await response.json()).data
        })
      const waitFor = (url: string, id: string, needle: string) =>
        Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const rows = await Effect.runPromise(context(url, id))
            if (JSON.stringify(rows).includes(needle)) return rows
            await Bun.sleep(100)
          }
          throw new Error(`V2 deferred state ${needle} did not appear`)
        })
      const serveOptions = { env: { OPENCODE_DB: path.join(home, "v2-defer-restart.sqlite") } }
      const server = yield* opencode.serve(serveOptions)
      const created = yield* request(server.url, "/api/session", "POST", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
      const submitted = yield* request(server.url, `/api/session/${id}/prompt`, "POST", {
        prompt: { text: "Read original" },
        hookMode: "noninteractive",
        resume: true,
      })
      expect(submitted.status).toBe(200)
      const first = yield* waitFor(server.url, id, "tool_deferred")
      expect(first).toMatchObject([
        { type: "user", text: "Read original" },
        {
          type: "assistant",
          finish: "tool_deferred",
          content: [
            {
              type: "tool",
              id: expect.any(String),
              state: { status: "running", deferred: true, input: { path: original } },
            },
          ],
        },
      ])
      expect((yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))).toHaveLength(1)
      const deferredAgain = yield* request(server.url, `/api/session/${id}/resume`, "POST")
      expect(deferredAgain.status).toBe(204)
      expect((yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))).toHaveLength(1)

      server.kill()
      yield* Effect.promise(() => server.exited)
      yield* Effect.promise(async () => {
        const configPath = path.join(home, ".config/opencode/opencode.json")
        const config = JSON.parse(await fs.readFile(configPath, "utf8"))
        config.agents = { build: { permissions: [{ action: "read", resource: "*", effect: "deny" }] } }
        await fs.writeFile(configPath, JSON.stringify(config))
      })
      const unavailableServer = yield* opencode.serve(serveOptions)
      const unavailable = yield* request(unavailableServer.url, `/api/session/${id}/resume`, "POST")
      expect(unavailable.status).toBe(204)
      const unavailableContext = yield* context(unavailableServer.url, id)
      if (!JSON.stringify(unavailableContext).includes("tool_deferred_unavailable"))
        throw new Error(
          JSON.stringify({
            unavailableContext,
            audit: yield* Effect.promise(() => fs.readFile(audit, "utf8")),
            agents: yield* Effect.promise(async () => {
              const response = await fetch(unavailableServer.url + "/api/agent", {
                headers: { "x-opencode-directory": home },
              })
              return [response.status, await response.text()]
            }),
          }),
        )
      expect(unavailableContext).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "tool_deferred_unavailable",
          content: [{ type: "tool", state: { status: "running", deferred: true, input: { path: original } } }],
        },
      ])
      expect((yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))).toHaveLength(1)
      unavailableServer.kill()
      yield* Effect.promise(() => unavailableServer.exited)
      yield* Effect.promise(async () => {
        await writeLocalModel(home, llm.url)
        await fs.writeFile(allow, "yes")
      })
      const restarted = yield* opencode.serve(serveOptions)
      const resumed = yield* request(restarted.url, `/api/session/${id}/resume`, "POST")
      expect(resumed.status).toBe(204)
      const finished = yield* waitFor(restarted.url, id, "AFTER_RESUME")
      expect(finished.filter((message) => message.type === "user")).toHaveLength(2)
      expect(finished).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          content: [{ type: "tool", state: { status: "completed", input: { path: replacement } } }],
        },
        { type: "user", text: "RESUMED_BATCH_CONTEXT" },
        { type: "assistant", content: [{ type: "text", text: "AFTER_RESUME" }] },
      ])
      const inputs = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain("REPLACEMENT_CONTENT")
      expect(JSON.stringify(inputs[1])).toContain("RESUMED_BATCH_CONTEXT")
      const attempts = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(attempts).toHaveLength(3)
      expect(new Set(attempts.map((attempt: { id: string }) => attempt.id)).size).toBe(1)
      const noPending = yield* request(restarted.url, `/api/session/${id}/resume`, "POST")
      expect(noPending.status).toBe(400)
    }),
)
