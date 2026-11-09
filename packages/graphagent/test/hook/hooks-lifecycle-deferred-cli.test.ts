// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt, type RunOpts } from "../lib/cli-process"

for (const command of [false, true]) {
  cliIt.live(
    `CLI restart resumes the same deferred tool then its durable supplied ${command ? "command" : "prompt"}`,
    ({ home, env, llm, opencode }) =>
      Effect.gen(function* () {
        const target = path.join(home, "deferred-write.txt")
        const allow = path.join(home, "allow-write")
        const audit = path.join(home, "deferred-audit.jsonl")
        const script = path.join(home, "deferred-hook.ts")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,id:i.tool_use_id})+"\\n");if(i.hook_event_name==='SessionStart'&&i.source==='startup')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'INITIAL_DEFERRED_WRITE'}}));if(i.hook_event_name==='PreToolUse')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:await Bun.file(${JSON.stringify(allow)}).exists()?'allow':'defer'}}));`,
          )
          const hook = { type: "command", command: process.execPath, args: [script] }
          await fs.writeFile(
            path.join(home, ".config/graphagent/hooks.json"),
            JSON.stringify({
              SessionStart: [{ hooks: [hook] }],
              PreToolUse: [{ matcher: "Write", hooks: [hook] }],
              Stop: [{ hooks: [hook] }],
            }),
          )
        })
        const cfg = {
          ...JSON.parse(env.GRAPHAGENT_CONFIG_CONTENT),
          permission: { "*": "allow" },
          command: { followup: { template: "COMMAND_FOLLOWUP_MARKER" } },
        }
        const opts: RunOpts = {
          format: "json",
          env: {
            PWD: home,
            GRAPHAGENT_DB: path.join(home, "restart.sqlite"),
            GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(cfg),
          },
        }
        yield* llm.tool("write", { filePath: target, content: "REAL_DEFERRED_CONTENT" })
        const first = yield* opencode.run(command ? "" : "PROMPT_FOLLOWUP_MARKER", {
          ...opts,
          ...(command ? { command: "followup" } : {}),
        })
        opencode.expectExit(first, 0)
        const result = opencode.parseJsonEvents(first.stdout).find((event) => event.type === "result")
        expect(result).toMatchObject({
          stop_reason: "tool_deferred",
          is_error: false,
          deferred_tool_use: { name: "write", input: { filePath: target, content: "REAL_DEFERRED_CONTENT" } },
        })
        const sessionID = result?.session_id
        expect(typeof sessionID).toBe("string")
        if (typeof sessionID !== "string") throw new Error("Deferred session ID missing")
        expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
        const rowsBefore = yield* Effect.promise(async () =>
          (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        )
        expect(rowsBefore.some((row) => row.event === "Stop")).toBe(false)
        yield* Effect.promise(() => fs.writeFile(allow, "allow"))
        yield* llm.text("DEFERRED_TOOL_FINISHED")
        yield* llm.text("DURABLE_FOLLOWUP_FINISHED")
        const resumed = yield* opencode.run("", { ...opts, timeoutMs: 10000, extraArgs: ["--session", sessionID] })
        opencode.expectExit(resumed, 0)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("REAL_DEFERRED_CONTENT")
        expect(resumed.stdout).toContain("DEFERRED_TOOL_FINISHED")
        expect(resumed.stdout).toContain("DURABLE_FOLLOWUP_FINISHED")
        const inputs = (yield* llm.inputs).filter(
          (input) => !JSON.stringify(input).includes("Generate a title for this conversation"),
        )
        expect(inputs.length).toBe(3)
        expect(JSON.stringify(inputs[1]).includes(command ? "COMMAND_FOLLOWUP_MARKER" : "PROMPT_FOLLOWUP_MARKER")).toBe(
          false,
        )
        expect(JSON.stringify(inputs[2]).includes(command ? "COMMAND_FOLLOWUP_MARKER" : "PROMPT_FOLLOWUP_MARKER")).toBe(
          true,
        )
        const rows = yield* Effect.promise(async () =>
          (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        )
        const attempts = rows.filter((row) => row.event === "PreToolUse")
        expect(attempts.length).toBe(2)
        expect(new Set(attempts.map((row) => row.id)).size).toBe(1)
      }),
  )
}

cliIt.live("CLI restart reports a missing deferred tool without a new model request", ({ home, env, llm, opencode }) =>
  Effect.gen(function* () {
    const hook = path.join(home, "missing-tool-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        hook,
        `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==='SessionStart'&&i.source==='startup')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'defer experimental tool'}}));if(i.hook_event_name==='PreToolUse')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'defer'}}));`,
      )
      const handler = { type: "command", command: process.execPath, args: [hook] }
      await fs.writeFile(
        path.join(home, ".config/graphagent/hooks.json"),
        JSON.stringify({
          SessionStart: [{ hooks: [handler] }],
          PreToolUse: [{ matcher: "lsp", hooks: [handler] }],
        }),
      )
    })
    const cfg = { ...JSON.parse(env.GRAPHAGENT_CONFIG_CONTENT), permission: { "*": "allow" } }
    const opts: RunOpts = {
      format: "json",
      env: {
        PWD: home,
        // The experimental LSP tool exists in the first run and is withdrawn
        // for the restart, which is how a persisted deferred call loses its tool.
        GRAPHAGENT_LSP_TOOL: "1",
        GRAPHAGENT_DB: path.join(home, "restart.sqlite"),
        GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(cfg),
      },
    }
    yield* llm.tool("lsp", {
      operation: "documentSymbol",
      filePath: path.join(home, "fixture.ts"),
      line: 1,
      character: 1,
    })
    const first = yield* opencode.run("", opts)
    opencode.expectExit(first, 0)
    const initial = opencode.parseJsonEvents(first.stdout).find((event) => event.type === "result")
    expect(initial?.stop_reason).toBe("tool_deferred")
    if (typeof initial?.session_id !== "string") throw new Error("Deferred session ID missing")
    const calls = yield* llm.calls
    const second = yield* opencode.run("", {
      ...opts,
      timeoutMs: 10000,
      env: { ...opts.env, GRAPHAGENT_LSP_TOOL: "false" },
      extraArgs: ["--session", initial?.session_id ?? ""],
    })
    opencode.expectExit(second, 1)
    const result = opencode.parseJsonEvents(second.stdout).find((event) => event.type === "result")
    expect(result).toMatchObject({
      stop_reason: "tool_deferred_unavailable",
      is_error: true,
      deferred_tool_use: { name: "lsp", input: { operation: "documentSymbol" } },
    })
    expect(yield* llm.calls).toBe(calls)
  }),
)

// A deferred call that is resumed later still completes its assistant batch, so PostToolBatch must run
// before the next model request and honor its decision.
for (const stop of [false, true]) {
  cliIt.live(
    `CLI resume of a deferred tool runs PostToolBatch before the next model request${stop ? " and honors block" : ""}`,
    ({ home, env, llm, opencode }) =>
      Effect.gen(function* () {
        const target = path.join(home, "batch-write.txt")
        const allow = path.join(home, "allow-batch-write")
        const audit = path.join(home, "batch-audit.jsonl")
        const script = path.join(home, "batch-deferred-hook.ts")
        const batchOutput = stop
          ? { decision: "block", reason: "BATCH_BLOCK_REASON" }
          : { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "BATCH_CONTEXT_MARKER" } }
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');if(i.hook_event_name==='PostToolBatch'){await fs.appendFile(${JSON.stringify(audit)},JSON.stringify(i)+"\\n");process.stdout.write(JSON.stringify(${JSON.stringify(batchOutput)}))}if(i.hook_event_name==='PreToolUse')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:await Bun.file(${JSON.stringify(allow)}).exists()?'allow':'defer'}}));`,
          )
          const hook = { type: "command", command: process.execPath, args: [script] }
          await fs.writeFile(
            path.join(home, ".config/graphagent/hooks.json"),
            JSON.stringify({
              PreToolUse: [{ matcher: "Write", hooks: [hook] }],
              PostToolBatch: [{ hooks: [hook] }],
            }),
          )
        })
        const cfg = { ...JSON.parse(env.GRAPHAGENT_CONFIG_CONTENT), permission: { "*": "allow" } }
        const opts: RunOpts = {
          format: "json",
          env: {
            PWD: home,
            GRAPHAGENT_DB: path.join(home, "restart.sqlite"),
            GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(cfg),
          },
        }
        yield* llm.tool("write", { filePath: target, content: "BATCH_DEFERRED_CONTENT" })
        const first = yield* opencode.run("start batch", opts)
        opencode.expectExit(first, 0)
        const result = opencode.parseJsonEvents(first.stdout).find((event) => event.type === "result")
        expect(result?.stop_reason).toBe("tool_deferred")
        const sessionID = result?.session_id
        if (typeof sessionID !== "string") throw new Error("Deferred session ID missing")
        yield* Effect.promise(() => fs.writeFile(allow, "allow"))
        yield* llm.text("AFTER_DEFERRED_BATCH")
        const resumed = yield* opencode.run("", { ...opts, timeoutMs: 15000, extraArgs: ["--session", sessionID] })
        opencode.expectExit(resumed, 0)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("BATCH_DEFERRED_CONTENT")
        const rows = yield* Effect.promise(async () =>
          (await fs.readFile(audit, "utf8").catch(() => ""))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].tool_calls).toHaveLength(1)
        expect(rows[0].tool_calls[0].tool_name.toLowerCase()).toBe("write")
        const inputs = (yield* llm.inputs).filter(
          (input) => !JSON.stringify(input).includes("Generate a title for this conversation"),
        )
        if (stop) {
          expect(inputs.length).toBe(1)
          expect(resumed.stdout).not.toContain("AFTER_DEFERRED_BATCH")
        } else {
          expect(inputs.length).toBe(2)
          expect(JSON.stringify(inputs[1])).toContain("BATCH_CONTEXT_MARKER")
          expect(resumed.stdout).toContain("AFTER_DEFERRED_BATCH")
        }
      }),
  )
}
