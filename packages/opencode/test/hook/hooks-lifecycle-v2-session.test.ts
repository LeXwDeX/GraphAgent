import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

cliIt.live(
  "real V2 create consumes startup metadata environment watch and durable contexts once",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-lifecycle-audit.jsonl")
      const script = path.join(home, "v2-lifecycle-hook.ts")
      const watched = path.join(home, "v2-external.txt")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify({...i,env:process.env.V2_START_ENV,readable:await Bun.file(i.transcript_path).exists()})+'\\n');if(i.hook_event_name==='SessionStart'){await (await import('node:fs/promises')).appendFile(process.env.CLAUDE_ENV_FILE,'export V2_START_ENV=real-startup\\n');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',sessionTitle:'V2 custom title',additionalContext:'V2_START_CONTEXT',watchPaths:[${JSON.stringify(watched)}]}}));}if(i.hook_event_name==='UserPromptSubmit')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'V2_SUBMIT_CONTEXT'}}));`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify(
            Object.fromEntries(
              ["SessionStart", "UserPromptSubmit", "FileChanged", "SessionEnd"].map((event) => [
                event,
                [{ hooks: [hook] }],
              ]),
            ),
          ),
        )
      })
      const server = yield* opencode.serve()
      const request = (route: string, method: string, body?: object) =>
        Effect.promise(async () => {
          const response = await fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
          expect(response.status).toBe(200)
          return response.json()
        })
      const created = yield* request("/api/session", "POST", { location: { directory: home } })
      const id = created.data.id
      const rows = () =>
        Effect.promise(async () =>
          (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        )
      expect((yield* rows()).filter((row) => row.hook_event_name === "SessionStart")).toEqual([
        expect.objectContaining({ session_id: id, source: "startup", readable: true }),
      ])
      expect((yield* request(`/api/session/${id}`, "GET")).data.title).toBe("V2 custom title")
      const input = { id: "msg_v2_lifecycle_submit", prompt: { text: "CANONICAL_USER_INPUT" }, resume: false }
      yield* request(`/api/session/${id}/prompt`, "POST", input)
      yield* request(`/api/session/${id}/prompt`, "POST", input)
      const context = JSON.stringify((yield* request(`/api/session/${id}/context`, "GET")).data)
      expect(context).toContain("V2_START_CONTEXT")
      expect(context).toContain("V2_SUBMIT_CONTEXT")
      expect(context.match(/V2_SUBMIT_CONTEXT/g)).toHaveLength(1)
      const submitted = (yield* rows()).filter((row) => row.hook_event_name === "UserPromptSubmit")
      expect(submitted).toEqual([
        expect.objectContaining({ session_id: id, prompt: "CANONICAL_USER_INPUT", env: "real-startup" }),
      ])
      const fileChanged = () =>
        rows().pipe(Effect.map((records) => records.filter((row) => row.hook_event_name === "FileChanged")))
      yield* Effect.promise(() => fs.writeFile(watched, "external V2 write"))
      yield* pollWithTimeout(
        fileChanged().pipe(Effect.map((records) => (records.length > 0 ? records : undefined))),
        "V2 startup file watcher did not fire",
        "5 seconds",
      )
      // A single write may report a rename/change pair asynchronously. Let the first
      // write settle so the post-delete assertion measures new events, not old ones.
      yield* Effect.sleep("300 millis")
      const before = (yield* fileChanged()).length
      yield* request(`/session/${id}`, "DELETE")
      expect((yield* rows()).filter((row) => row.hook_event_name === "SessionEnd")).toHaveLength(1)
      // Session removal clears the dynamic watch; give the clear a CI-sized window.
      yield* Effect.sleep("300 millis")
      yield* Effect.promise(() => fs.writeFile(watched, "after deletion"))
      yield* Effect.sleep("500 millis")
      expect((yield* fileChanged()).length).toBe(before)
    }),
)

const writeV2Model = (home: string, url: string) =>
  fs.writeFile(
    path.join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      providers: {
        test: {
          name: "Test",
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url, settings: { apiKey: "test-key" } },
          request: { body: { apiKey: "test-key" } },
          models: {
            "test-model": {
              name: "Test",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    }),
  )

cliIt.live(
  "V2 startup initial input passes prompt hooks and remains a separate held first turn before immediate steer",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-initial-audit.jsonl")
      const script = path.join(home, "v2-initial-hook.ts")
      yield* Effect.promise(async () => {
        await writeV2Model(home, llm.url)
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');if(i.hook_event_name==='SessionStart')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'V2_INITIAL_REAL_INPUT',additionalContext:'V2_INITIAL_CONTEXT'}}));if(i.hook_event_name==='UserPromptSubmit')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'INITIAL_SUBMIT_GUARD_CONTEXT'}}));`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ SessionStart: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }] }),
        )
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      yield* Effect.addFinalizer(() => Effect.sync(release))
      yield* llm.hold("V2_INITIAL_ANSWER", gate)
      yield* llm.text("V2_FOLLOWUP_ANSWER")
      const server = yield* opencode.serve()
      const request = (route: string, body: object) =>
        Effect.promise(async () => {
          const response = await fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          })
          expect(response.status).toBe(200)
          return response.json()
        })
      const created = yield* request("/api/session", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      const id = created.data.id
      yield* llm.wait(1)
      const prompt = {
        id: "msg_v2_immediate_followup",
        prompt: { text: "V2_PROVIDED_NEXT_INPUT" },
        delivery: "steer",
        resume: true,
      }
      const admitted = yield* request(`/api/session/${id}/prompt`, prompt)
      expect(admitted.data.delivery).toBe("queue")
      release()
      yield* pollWithTimeout(
        Effect.promise(async () => {
          const response = await fetch(server.url + `/api/session/${id}/context`, {
            headers: { "x-opencode-directory": home },
          })
          const data = await response.json()
          return JSON.stringify(data).includes("V2_FOLLOWUP_ANSWER") ? data : undefined
        }),
        "V2 initial and followup did not finish in separate turns",
        "10 seconds",
      )
      expect((yield* request(`/api/session/${id}/prompt`, prompt)).data).toMatchObject({
        id: admitted.data.id,
        prompt: admitted.data.prompt,
        delivery: admitted.data.delivery,
      })
      const changed = yield* Effect.promise(() =>
        fetch(server.url + `/api/session/${id}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify({ ...prompt, delivery: "queue" }),
        }),
      )
      expect(changed.status).toBe(409)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[0])).toContain("V2_INITIAL_REAL_INPUT")
      expect(JSON.stringify(inputs[0])).toContain("V2_INITIAL_CONTEXT")
      expect(JSON.stringify(inputs[0])).toContain("INITIAL_SUBMIT_GUARD_CONTEXT")
      expect(JSON.stringify(inputs[0])).not.toContain("V2_PROVIDED_NEXT_INPUT")
      expect(JSON.stringify(inputs[1])).toContain("V2_PROVIDED_NEXT_INPUT")
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows.filter((row) => row.hook_event_name === "SessionStart")).toHaveLength(1)
      expect(rows.filter((row) => row.hook_event_name === "UserPromptSubmit").map((row) => row.prompt)).toEqual([
        "V2_INITIAL_REAL_INPUT",
        "V2_PROVIDED_NEXT_INPUT",
      ])
    }),
)

cliIt.live(
  "V2 initial defer survives process restart and resumes before queued user with lifecycle and PostModelSwitch once",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-restart-audit.jsonl")
      const script = path.join(home, "v2-restart-hook.ts")
      const source = path.join(home, "v2-source.txt")
      const allow = path.join(home, "v2-allow")
      yield* Effect.promise(async () => {
        await writeV2Model(home, llm.url)
        await fs.writeFile(source, "ACTUAL_V2_DEFERRED_FILE_CONTENT")
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({...i,transcript:await Bun.file(i.transcript_path).text()})+'\\n');if(i.hook_event_name==='SessionStart')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'V2_RESTART_INITIAL',additionalContext:i.source==='resume'?'V2_RESUME_CONTEXT':'V2_START_CONTEXT'}}));if(i.hook_event_name==='PreToolUse')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:await Bun.file(${JSON.stringify(allow)}).exists()?'allow':'defer'}}));if(i.hook_event_name==='PostModelSwitch')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostModelSwitch',additionalContext:'V2_RESUME_MODEL_POST_CONTEXT'}}));`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify(
            Object.fromEntries(
              [
                "SessionStart",
                "UserPromptSubmit",
                "PreToolUse",
                "PreModelSwitch",
                "PostModelSwitch",
                "PostToolBatch",
              ].map((event) => [event, [{ hooks: [hook] }]]),
            ),
          ),
        )
      })
      yield* llm.tool("read", { path: source })
      yield* llm.text("V2_RESTART_INITIAL_DONE")
      yield* llm.text("V2_RESTART_FOLLOWUP_DONE")
      const opts = { env: { OPENCODE_DB: path.join(home, "v2-restart.sqlite") } }
      const first = yield* opencode.serve(opts)
      const request = (url: string, route: string, method: string, body?: object) =>
        Effect.promise(() =>
          fetch(url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const created = yield* request(first.url, "/api/session", "POST", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const id = (yield* Effect.promise(() => created.json())).data.id
      yield* pollWithTimeout(
        Effect.promise(async () => {
          const response = await fetch(first.url + `/api/session/${id}/context`, {
            headers: { "x-opencode-directory": home },
          })
          const text = await response.text()
          return text.includes('"deferred":true') && text.includes('"finish":"tool_deferred"') ? text : undefined
        }),
        "V2 initial tool was not durably deferred",
        "10 seconds",
      )
      const body = {
        id: "msg_v2_restart_followup",
        prompt: { text: "V2_RESTART_PROVIDED" },
        delivery: "steer",
        resume: false,
      }
      const queued = yield* request(first.url, `/api/session/${id}/prompt`, "POST", body)
      expect(queued.status).toBe(200)
      expect((yield* Effect.promise(() => queued.json())).data.delivery).toBe("queue")
      first.kill()
      yield* Effect.promise(() => first.exited)
      yield* Effect.promise(() => fs.writeFile(allow, "allow"))
      const restarted = yield* opencode.serve(opts)
      const resumed = yield* request(restarted.url, `/api/session/${id}/resume`, "POST")
      if (resumed.status !== 204)
        throw new Error(`V2 resume failed ${resumed.status}: ${yield* Effect.promise(() => resumed.text())}`)
      expect(resumed.status).toBe(204)
      const completed = yield* pollWithTimeout(
        Effect.promise(async () => {
          const response = await fetch(restarted.url + `/api/session/${id}/context`, {
            headers: { "x-opencode-directory": home },
          })
          const data = await response.json()
          return JSON.stringify(data).includes("V2_RESTART_FOLLOWUP_DONE") ? data.data : undefined
        }),
        "V2 deferred initial and queued followup did not resume",
        "10 seconds",
      )
      expect(
        completed
          .filter((message: { type: string }) => message.type === "user")
          .map((message: { text: string }) => message.text),
      ).toEqual(["V2_RESTART_INITIAL", "V2_RESTART_PROVIDED"])
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(3)
      expect(JSON.stringify(inputs[0])).not.toContain("V2_RESTART_PROVIDED")
      expect(JSON.stringify(inputs[1])).toContain("ACTUAL_V2_DEFERRED_FILE_CONTENT")
      expect(JSON.stringify(inputs[1])).toContain("V2_RESUME_CONTEXT")
      expect(JSON.stringify(inputs[1])).toContain("V2_RESUME_MODEL_POST_CONTEXT")
      expect(JSON.stringify(inputs[1])).not.toContain("V2_RESTART_PROVIDED")
      expect(JSON.stringify(inputs[2])).toContain("V2_RESTART_PROVIDED")
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows.filter((row) => row.hook_event_name === "SessionStart").map((row) => row.source)).toEqual([
        "startup",
        "resume",
      ])
      expect(rows.filter((row) => row.hook_event_name === "PostModelSwitch").map((row) => row.source)).toEqual([
        "resume",
      ])
      const nativeStart = rows.find((row) => row.hook_event_name === "SessionStart" && row.source === "resume")
      expect(nativeStart.transcript).toContain("V2_RESTART_INITIAL")
      const nativeBatch = rows.find((row) => row.hook_event_name === "PostToolBatch")
      expect(nativeBatch.transcript).toContain("ACTUAL_V2_DEFERRED_FILE_CONTENT")
      const nativeRows = nativeBatch.transcript
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line))
      expect(
        nativeRows.some((row: { message: { content: { type: string; name?: string; input?: { path?: string } }[] } }) =>
          row.message.content.some(
            (part) => part.type === "tool_use" && part.name === "read" && part.input?.path === source,
          ),
        ),
      ).toBe(true)
      expect(
        nativeRows.some((row: { message: { content: { type: string; content?: string }[] } }) =>
          row.message.content.some(
            (part) => part.type === "tool_result" && part.content?.includes("ACTUAL_V2_DEFERRED_FILE_CONTENT"),
          ),
        ),
      ).toBe(true)
      const resumedStart = rows.find((row) => row.hook_event_name === "SessionStart" && row.source === "resume")
      expect(typeof resumedStart.seconds_since_last_response).toBe("number")
      expect(typeof resumedStart.context_tokens).toBe("number")
      expect(typeof resumedStart.prompt_cache_likely_expired).toBe("boolean")
      expect(rows.filter((row) => row.hook_event_name === "PreModelSwitch")).toHaveLength(0)
      expect(rows.filter((row) => row.hook_event_name === "UserPromptSubmit").map((row) => row.prompt)).toEqual([
        "V2_RESTART_INITIAL",
        "V2_RESTART_PROVIDED",
      ])
    }),
)

cliIt.live(
  "V2 initial UserPromptSubmit refusal emits user notification without admitting or running the user",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const script = path.join(home, "v2-initial-deny.ts")
      yield* Effect.promise(async () => {
        await writeV2Model(home, llm.url)
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==='SessionStart')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'INITIAL_MUST_BE_DENIED'}}));else{process.stderr.write('V2_INITIAL_POLICY_REFUSAL');process.exit(2)}`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ SessionStart: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }] }),
        )
      })
      const server = yield* opencode.serve()
      const controller = new AbortController()
      const events: { type: string; properties?: { sessionID?: string; message?: string } }[] = []
      const stream = yield* Effect.promise(() =>
        fetch(server.url + "/event", { headers: { "x-opencode-directory": home }, signal: controller.signal }),
      )
      const reading = (async () => {
        const reader = stream.body!.getReader()
        const decoder = new TextDecoder()
        let buffered = ""
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffered += decoder.decode(chunk.value, { stream: true })
            const lines = buffered.split("\n")
            buffered = lines.pop()!
            for (const line of lines) if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5)))
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error
        } finally {
          reader.releaseLock()
        }
      })()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          controller.abort()
          await reading
        }),
      )
      const created = yield* Effect.promise(async () => {
        const response = await fetch(server.url + "/api/session", {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify({ location: { directory: home }, model: { providerID: "test", id: "test-model" } }),
        })
        expect(response.status).toBe(200)
        return response.json()
      })
      const id = created.data.id
      yield* pollWithTimeout(
        Effect.sync(() =>
          events.find(
            (event) =>
              event.type === "session.hook.message" &&
              event.properties?.sessionID === id &&
              event.properties?.message?.includes("V2_INITIAL_POLICY_REFUSAL"),
          ),
        ),
        "V2 initial refusal did not reach user notification stream",
        "5 seconds",
      )
      const context = yield* Effect.promise(async () => {
        const response = await fetch(server.url + `/api/session/${id}/context`, {
          headers: { "x-opencode-directory": home },
        })
        expect(response.status).toBe(200)
        return response.json()
      })
      expect(context.data.some((message: { type: string }) => message.type === "user")).toBe(false)
      expect(yield* llm.calls).toBe(0)
    }),
)

cliIt.live("V2 SessionStart reloadSkills refreshes the actual current Location skill cache", ({ home, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "v2-reload-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `await Bun.write(${JSON.stringify(path.join(home, ".opencode/skills/v2-hook-installed/SKILL.md"))},'---\\nname: v2-hook-installed\\ndescription: actual V2 hook installation\\n---\\nbody\\n');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',reloadSkills:true}}))`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] }),
      )
    })
    const server = yield* opencode.serve({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" } })
    const get = () =>
      Effect.promise(async () => {
        const response = await fetch(server.url + "/api/skill?directory=" + encodeURIComponent(home), {
          headers: { "x-opencode-directory": home },
        })
        expect(response.status).toBe(200)
        return response.json()
      })
    expect(JSON.stringify(yield* get())).not.toContain("v2-hook-installed")
    const response = yield* Effect.promise(() =>
      fetch(server.url + "/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": home },
        body: JSON.stringify({ location: { directory: home } }),
      }),
    )
    expect(response.status).toBe(200)
    expect(JSON.stringify(yield* get())).toContain("v2-hook-installed")
  }),
)

cliIt.live(
  "real V2 interrupt cancels a pending command UserPromptSubmit without admitting it and accepts the next prompt",
  ({ home, opencode, llm }) =>
    Effect.gen(function* () {
      const ready = path.join(home, "v2-cancel-hook-ready")
      const release = path.join(home, "v2-cancel-hook-release")
      const script = path.join(home, "v2-cancel-hook.ts")
      yield* Effect.promise(async () => {
        await writeV2Model(home, llm.url)
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());if(i.prompt==='V2_CANCEL_OLD_INPUT'){await Bun.write(${JSON.stringify(ready)},'ready');while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(20);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'V2_CANCEL_OLD_CONTEXT'}}));}`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: process.execPath, args: [script], timeout: 20 }] },
            ],
          }),
        )
      })
      yield* llm.text("V2_CANCEL_NEW_ANSWER")
      const server = yield* opencode.serve()
      const request = (route: string, body?: object) =>
        fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      const created = yield* Effect.promise(async () =>
        (
          await request("/api/session", {
            location: { directory: home },
            model: { providerID: "test", id: "test-model" },
          })
        ).json(),
      )
      const id = created.data.id
      const pending = request(`/api/session/${id}/prompt`, {
        id: "msg_v2_cancel_old",
        prompt: { text: "V2_CANCEL_OLD_INPUT" },
      })
      yield* pollWithTimeout(
        Effect.promise(async () => ((await Bun.file(ready).exists()) ? true : undefined)),
        "long UPS hook did not start",
        5000,
      )
      const cancelled = yield* Effect.promise(async () => {
        const response = request(`/api/session/${id}/interrupt`, {})
        // Always release the fixture, including the RED locked-cancel case.
        try {
          return await Promise.race([
            response,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
          ])
        } finally {
          await fs.writeFile(release, "release")
        }
      })
      expect(cancelled?.status).toBe(204)
      const old = yield* Effect.promise(() => pending)
      expect(old.status).toBe(400)
      expect(yield* llm.calls).toBe(0)
      const fresh = yield* Effect.promise(() =>
        request(`/api/session/${id}/prompt`, { id: "msg_v2_cancel_new", prompt: { text: "V2_CANCEL_NEW_INPUT" } }),
      )
      expect(fresh.status).toBe(200)
      const context = yield* pollWithTimeout(
        Effect.promise(async () => {
          const value = await (await request(`/api/session/${id}/context`)).json()
          return JSON.stringify(value).includes("V2_CANCEL_NEW_ANSWER") ? JSON.stringify(value) : undefined
        }),
        "new prompt did not complete after cancelling the old hook",
        10000,
      )
      expect(context).toContain("V2_CANCEL_NEW_INPUT")
      expect(context).not.toContain("V2_CANCEL_OLD_INPUT")
      expect(context).not.toContain("V2_CANCEL_OLD_CONTEXT")
      expect(yield* llm.calls).toBe(1)
    }),
)

cliIt.live(
  "real V2 interrupt preserves a created session but cancels the pending startup initial input",
  ({ home, opencode, llm }) =>
    Effect.gen(function* () {
      const ready = path.join(home, "v2-cancel-start-ready")
      const release = path.join(home, "v2-cancel-start-release")
      const script = path.join(home, "v2-cancel-start.ts")
      yield* Effect.promise(async () => {
        await writeV2Model(home, llm.url)
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());if(i.source==='startup'){await Bun.write(${JSON.stringify(ready)},'ready');while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(20);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'V2_CANCEL_START_INITIAL',additionalContext:'V2_CANCEL_START_CONTEXT'}}));}`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script], timeout: 20 }] }],
          }),
        )
      })
      yield* llm.text("V2_CANCEL_START_NEXT_ANSWER")
      const server = yield* opencode.serve()
      const id = "ses_v2_cancel_start"
      const request = (route: string, body?: object) =>
        fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      const pending = request("/api/session", {
        id,
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      yield* pollWithTimeout(
        Effect.promise(async () => ((await Bun.file(ready).exists()) ? true : undefined)),
        "startup hook did not start",
        5000,
      )
      const cancelled = yield* Effect.promise(async () => {
        try {
          return await Promise.race([
            request(`/api/session/${id}/interrupt`, {}),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
          ])
        } finally {
          await fs.writeFile(release, "release")
        }
      })
      expect(cancelled?.status).toBe(204)
      expect((yield* Effect.promise(() => pending)).status).toBe(200)
      expect((yield* Effect.promise(() => request(`/api/session/${id}`))).status).toBe(200)
      expect(yield* llm.calls).toBe(0)
      expect(
        (yield* Effect.promise(() =>
          request(`/api/session/${id}/prompt`, { prompt: { text: "V2_CANCEL_START_NEXT_INPUT" } }),
        )).status,
      ).toBe(200)
      const context = yield* pollWithTimeout(
        Effect.promise(async () => {
          const value = JSON.stringify(await (await request(`/api/session/${id}/context`)).json())
          return value.includes("V2_CANCEL_START_NEXT_ANSWER") ? value : undefined
        }),
        "new prompt did not run after startup cancellation",
        10000,
      )
      expect(context).not.toContain("V2_CANCEL_START_INITIAL")
      expect(context).not.toContain("V2_CANCEL_START_CONTEXT")
      expect(context).toContain("V2_CANCEL_START_NEXT_INPUT")
      expect(yield* llm.calls).toBe(1)
    }),
)

cliIt.live(
  "real V2 interrupt does not wait for a deferred resume joining a held model response",
  ({ home, opencode, llm }) =>
    Effect.gen(function* () {
      const source = path.join(home, "resume-cancel-source.txt")
      const allow = path.join(home, "resume-cancel-allow")
      const script = path.join(home, "resume-cancel-hook.ts")
      yield* Effect.promise(async () => {
        await writeV2Model(home, llm.url)
        await fs.writeFile(source, "ACTUAL_RESUME_CANCEL_READ")
        await fs.writeFile(
          script,
          `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:await Bun.file(${JSON.stringify(allow)}).exists()?'allow':'defer'}}))`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] }),
        )
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      yield* Effect.addFinalizer(() => Effect.sync(release))
      yield* llm.tool("read", { path: source })
      yield* llm.hold("V2_CANCEL_RESUME_OLD_ANSWER", gate)
      yield* llm.text("V2_CANCEL_RESUME_NEW_ANSWER")
      const server = yield* opencode.serve()
      const request = (route: string, body?: object) =>
        fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      const created = yield* Effect.promise(async () =>
        (
          await request("/api/session", {
            location: { directory: home },
            model: { providerID: "test", id: "test-model" },
          })
        ).json(),
      )
      const id = created.data.id
      expect(
        (yield* Effect.promise(() =>
          request(`/api/session/${id}/prompt`, { prompt: { text: "V2_CANCEL_RESUME_QUEUED" } }),
        )).status,
      ).toBe(200)
      yield* pollWithTimeout(
        Effect.promise(async () =>
          JSON.stringify(await (await request(`/api/session/${id}/context`)).json()).includes("tool_deferred")
            ? true
            : undefined,
        ),
        "initial tool was not deferred",
        8000,
      )
      yield* Effect.promise(() => fs.writeFile(allow, "allow"))
      const pending = request(`/api/session/${id}/resume`, {})
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((count) => (count >= 2 ? true : undefined))),
        "deferred resume did not reach held model response",
        8000,
      )
      const cancelled = yield* Effect.promise(async () => {
        try {
          return await Promise.race([
            request(`/api/session/${id}/interrupt`, {}),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
          ])
        } finally {
          release()
        }
      })
      expect(cancelled?.status).toBe(204)
      expect((yield* Effect.promise(() => pending)).status).toBe(204)
      expect(
        (yield* Effect.promise(() =>
          request(`/api/session/${id}/prompt`, { prompt: { text: "V2_CANCEL_RESUME_NEW_INPUT" } }),
        )).status,
      ).toBe(200)
      const context = yield* pollWithTimeout(
        Effect.promise(async () => {
          const value = JSON.stringify(await (await request(`/api/session/${id}/context`)).json())
          return value.includes("V2_CANCEL_RESUME_NEW_ANSWER") ? value : undefined
        }),
        "new prompt did not complete after cancelling resume",
        10000,
      )
      expect(context).not.toContain("V2_CANCEL_RESUME_OLD_ANSWER")
      expect(yield* llm.calls).toBe(3)
    }),
)
