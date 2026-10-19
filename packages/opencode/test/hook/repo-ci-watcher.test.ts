import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook/settings"
import { HookRewake } from "@/hook/rewake"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../fixture/fixture"
import { install } from "../../../../.opencode/hooks/install-ci-watcher"
import { requestedPR, watch, type Run } from "../../../../.opencode/hooks/watch-ci"

const url = "https://github.com/example/project/pull/42"
const head = "a".repeat(40)
const envelope = (scratchpad: string, command = "gh pr create --body-file /tmp/body") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { output: url },
  scratchpad_dir: scratchpad,
  cwd: scratchpad,
  session_id: "original-session",
})
const fakeRun =
  (buckets: string[], mutate?: (command: string[]) => void): Run =>
  async (args) => {
    mutate?.(args)
    return {
      code: 0,
      stdout: JSON.stringify(
        args[1] === "view" ? { number: 42, headRefOid: head, url } : buckets.map((bucket) => ({ bucket })),
      ),
    }
  }
const runWatch = (directory: string, run: Run, signal = new AbortController().signal, timeoutMs = 1000) =>
  watch({ url, scratchpad: directory, session: "original-session", run, signal, intervalMs: 5, timeoutMs })

async function until<T>(get: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await get()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}
const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    // Reparented exited children can briefly remain zombies until the OS reaps
    // them. A zombie cannot poll or retain a GitHub child; it is already stopped.
    if (process.platform !== "win32") {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
      if (!state || state.startsWith("Z")) return false
    }
    return true
  } catch {
    return false
  }
}
const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    let stderr = ""
    child.stderr?.on("data", (data) => {
      stderr += data.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr }))
  })

async function fakeCLI(directory: string, scenario = "pass", timeoutMs = 5000) {
  const bin = path.join(directory, "bin")
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(
    path.join(bin, "gh"),
    `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[1]==='view'){console.log(JSON.stringify({number:42,headRefOid:'${head}',url:'${url}'}))}else{await Bun.write(${JSON.stringify(path.join(directory, "checking"))},String(process.pid));if(${JSON.stringify(scenario)}==='hold')setInterval(()=>{},1000);else {if(${JSON.stringify(scenario)}==='controlled')while(!(await Bun.file(${JSON.stringify(path.join(directory, "release"))}).exists()))await Bun.sleep(10);console.log(JSON.stringify([{bucket:${JSON.stringify(scenario === "controlled" ? "pass" : scenario)}}]));}}`,
    { mode: 0o755 },
  )
  const module = fileURLToPath(new URL("../../../../.opencode/hooks/watch-ci.ts", import.meta.url))
  const wrapper = path.join(directory, "watch.ts")
  await fs.writeFile(
    wrapper,
    `import {main} from ${JSON.stringify(module)};process.env.PATH=${JSON.stringify(bin)}+${JSON.stringify(path.delimiter)}+process.env.PATH;process.exitCode=await main([], {intervalMs:10,timeoutMs:${timeoutMs},commandTimeoutMs:10000,parentCheckMs:20});`,
  )
  return { wrapper, env: { ...process.env, GH_HOST: "github.com", PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
}

describe("repository CI watcher", () => {
  test("recognizes successful PR creation without evaluating commands", () => {
    expect(requestedPR(envelope("/tmp/scratch"))?.url).toBe(url)
    expect(requestedPR(envelope("/tmp/scratch", "echo 'gh pr create'"))).toBeUndefined()
    for (const field of ["exit", "exitCode", "exit_code"]) {
      expect(requestedPR({ ...envelope("/tmp/scratch"), tool_response: { output: url, [field]: 1 } })).toBeUndefined()
      expect(requestedPR({ ...envelope("/tmp/scratch"), tool_response: { output: url, [field]: 0 } })?.url).toBe(url)
    }
    expect(
      requestedPR({ ...envelope("/tmp/scratch"), tool_response: { output: "https://evil.example/x/y/pull/42" } }),
    ).toBeUndefined()
    expect(
      requestedPR({
        ...envelope("/tmp/scratch", "bun .opencode/hooks/watch-ci.ts request 42"),
        tool_response: { output: `OPENCODE_CI_WATCH ${url}` },
      })?.url,
    ).toBe(url)
  })
  for (const [buckets, conclusion] of [
    [["pass", "skipping"], "success"],
    [["pass", "fail"], "failure"],
    [["cancel"], "failure"],
    [["pending"], "timeout"],
    [[], "timeout"],
  ] as const) {
    test(`reports ${conclusion} for ${buckets.join(",") || "no checks"}`, async () => {
      await using tmp = await tmpdir()
      const result = await runWatch(tmp.path, fakeRun([...buckets]), undefined, conclusion === "timeout" ? 100 : 1000)
      expect(result).toContain(`PR #42, head ${head}, ${conclusion}`)
      expect(await fs.readdir(path.join(tmp.path, "pr-ci-watch"))).not.toContain(expect.stringContaining(".lock"))
    })
  }
  test("deduplicates concurrent and already delivered PR/head watchers", async () => {
    await using tmp = await tmpdir()
    let checks = 0
    const run: Run = async (args, signal) => {
      if (args[1] === "checks") {
        checks++
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return fakeRun(["pass"])(args, signal)
    }
    const results = await Promise.all(Array.from({ length: 5 }, () => runWatch(tmp.path, run)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(checks).toBe(1)
    expect(await runWatch(tmp.path, run)).toBeUndefined()
    expect(checks).toBe(1)
  })
  test("concurrent retries reclaim one crashed owner's lock", async () => {
    await using tmp = await tmpdir()
    const prior = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
    await exited(prior)
    const key = createHash("sha256").update(`${url}\n${head}`).digest("hex")
    const lock = path.join(tmp.path, "pr-ci-watch", `${key}.lock`)
    await fs.mkdir(lock, { recursive: true })
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: prior.pid, token: "crashed" }))
    let checks = 0
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runWatch(
          tmp.path,
          fakeRun(["pass"], (args) => {
            if (args[1] === "checks") checks++
          }),
        ),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(checks).toBe(1)
  })
  test("does not report success after the head changes while checking", async () => {
    await using tmp = await tmpdir()
    let views = 0
    const run: Run = async (args, signal) => {
      const result = await fakeRun(["pass"])(args, signal)
      return args[1] === "view" && ++views >= 3
        ? { code: 0, stdout: JSON.stringify({ number: 42, headRefOid: "b".repeat(40), url }) }
        : result
    }
    expect(await runWatch(tmp.path, run)).toContain("superseded")
  })
  test("cancellation releases the lock and emits no result", async () => {
    await using tmp = await tmpdir()
    const controller = new AbortController()
    const run = fakeRun(["pending"], (args) => {
      if (args[1] === "checks") controller.abort()
    })
    expect(await runWatch(tmp.path, run, controller.signal)).toBeUndefined()
    expect(await runWatch(tmp.path, fakeRun(["pass"]))).toContain("success")
  })
  test("unavailable queries notify without leaking stderr and can be retried", async () => {
    await using tmp = await tmpdir()
    let checks = 0
    const run: Run = async (args, signal) =>
      args[1] === "checks" ? (checks++, { code: 4, stdout: "private upstream error" }) : fakeRun(["pass"])(args, signal)
    const result = await runWatch(tmp.path, run)
    expect(checks).toBe(3)
    expect(result).toContain("unavailable")
    expect(result).not.toContain("private upstream error")
    expect(await runWatch(tmp.path, fakeRun(["pass"]))).toContain("success")
  })
  test("a new head has an independent watcher receipt", async () => {
    await using tmp = await tmpdir()
    expect(await runWatch(tmp.path, fakeRun(["pass"]))).toContain(head)
    const run: Run = async (args, signal) => {
      const result = await fakeRun(["pass"])(args, signal)
      return { ...result, stdout: result.stdout.replaceAll(head, "b".repeat(40)) }
    }
    expect(await runWatch(tmp.path, run)).toContain("b".repeat(40))
  })
  test("installer is idempotent and preserves user hooks; malformed config stays intact", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "hooks.json")
    const user = { type: "command", command: "user-owned-handler" }
    await fs.writeFile(
      target,
      JSON.stringify({ PostToolUse: [{ matcher: "Bash", hooks: [user] }], Stop: [{ hooks: [user] }] }),
    )
    expect(await install(tmp.path)).toBe(true)
    const installed = await fs.readFile(target, "utf8")
    expect(await install(tmp.path)).toBe(false)
    expect(JSON.parse(installed).PostToolUse[0].hooks).toEqual([user])
    expect(JSON.parse(installed).Stop[0].hooks).toEqual([user])
    await fs.writeFile(target, "broken json")
    expect(
      await install(tmp.path).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error)
    expect(await fs.readFile(target, "utf8")).toBe("broken json")
  })
  test("installer preserves legacy wrapped hooks and installs into the loaded container", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "hooks.json")
    const user = { type: "command", command: "user-owned-handler" }
    await fs.writeFile(
      target,
      JSON.stringify({
        allowedHttpHookUrls: ["https://example.com/*"],
        hooks: {
          SessionStart: [{ hooks: [user] }],
          PostToolUse: [{ matcher: "Bash", hooks: [user] }],
          Stop: [{ hooks: [user] }],
        },
      }),
    )
    expect(await install(tmp.path)).toBe(true)
    expect(await install(tmp.path)).toBe(false)
    const settings = SettingsHook.readJSON(target)
    expect(settings?.hooks?.SessionStart).toHaveLength(2)
    expect(settings?.hooks?.PostToolUse).toHaveLength(2)
    expect(settings?.hooks?.Stop).toHaveLength(1)
    for (const event of ["SessionStart", "PostToolUse", "Stop"] as const) {
      expect(settings?.hooks?.[event]?.[0]?.hooks[0]?.command).toBe(user.command)
    }
    expect(settings?.hooks?.PostToolUse?.[1]?.hooks[0]?.asyncRewake).toBe(true)
    expect(settings?.allowedHttpHookUrls).toEqual(["https://example.com/*"])
    await fs.writeFile(target, JSON.stringify({ hooks: "invalid" }))
    expect(
      await install(tmp.path).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toMatchObject({ message: "hooks must be an object" })
    expect(await fs.readFile(target, "utf8")).toBe(JSON.stringify({ hooks: "invalid" }))
  })
  test("actual watcher exits 2 with a bounded summary", async () => {
    await using tmp = await tmpdir()
    const fixture = await fakeCLI(tmp.path)
    const child = spawn(process.execPath, [fixture.wrapper], { env: fixture.env, stdio: ["pipe", "ignore", "pipe"] })
    const done = exited(child)
    child.stdin.end(JSON.stringify(envelope(tmp.path)))
    try {
      expect(await done).toEqual({ code: 2, stderr: expect.stringContaining(`PR #42, head ${head}, success`) })
    } finally {
      child.kill("SIGKILL")
    }
  })
  test("SIGTERM cancels a watcher and its in-flight GitHub query", async () => {
    await using tmp = await tmpdir()
    const fixture = await fakeCLI(tmp.path, "hold")
    const child = spawn(process.execPath, [fixture.wrapper], { env: fixture.env, stdio: ["pipe", "ignore", "pipe"] })
    const done = exited(child)
    child.stdin.end(JSON.stringify(envelope(tmp.path)))
    let queryPID: number | undefined
    try {
      queryPID = await until(
        () => fs.readFile(path.join(tmp.path, "checking"), "utf8").then(Number, () => undefined),
        "query never started",
      )
      child.kill("SIGTERM")
      expect(await done).toEqual({ code: 0, stderr: "" })
      await until(async () => (!running(queryPID!) ? true : undefined), "GitHub query survived cancellation")
    } finally {
      child.kill("SIGKILL")
      if (queryPID && running(queryPID)) process.kill(queryPID, "SIGKILL")
    }
  })
  test("host crash stops the direct child watcher and its GitHub query", async () => {
    await using tmp = await tmpdir()
    const fixture = await fakeCLI(tmp.path, "hold")
    const hostScript = path.join(tmp.path, "host.ts")
    await fs.writeFile(
      hostScript,
      `import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(fixture.wrapper)}],{stdio:['pipe','ignore','ignore']});child.stdin.end(${JSON.stringify(JSON.stringify(envelope(tmp.path)))});await Bun.write(${JSON.stringify(path.join(tmp.path, "watch-pid"))},String(child.pid));setInterval(()=>{},1000);`,
    )
    const host = spawn(process.execPath, [hostScript], { env: fixture.env, stdio: "ignore" })
    const hostDone = exited(host)
    let watchPID: number | undefined, queryPID: number | undefined
    try {
      watchPID = await until(
        () => fs.readFile(path.join(tmp.path, "watch-pid"), "utf8").then(Number, () => undefined),
        "watcher never started",
      )
      queryPID = await until(
        () => fs.readFile(path.join(tmp.path, "checking"), "utf8").then(Number, () => undefined),
        "query never started",
      )
      host.kill("SIGKILL")
      await hostDone
      await until(async () => (!running(watchPID!) ? true : undefined), "watcher survived its host")
      await until(async () => (!running(queryPID!) ? true : undefined), "GitHub query survived its host")
    } finally {
      host.kill("SIGKILL")
      for (const pid of [watchPID, queryPID]) if (pid && running(pid)) process.kill(pid, "SIGKILL")
    }
  })
})

// Exercise the installed mechanism, including non-blocking dispatch and exit-2 rewake.
const rewakes: { sessionID: string; text: string }[] = []
const hookIt = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
    Layer.provideMerge(
      Layer.mock(HookRewake.Service, {
        rewake: (input) =>
          Effect.sync(() => {
            rewakes.push(input)
          }),
      }),
    ),
  ),
)
const configure = (scenario: string, timeoutMs?: number) => (directory: string) =>
  Effect.promise(async () => {
    const fixture = await fakeCLI(directory, scenario, timeoutMs)
    await fs.mkdir(path.join(directory, ".opencode", "hooks"), { recursive: true })
    await fs.copyFile(fixture.wrapper, path.join(directory, ".opencode", "hooks", "watch-ci.ts"))
    await install(path.join(directory, ".opencode"))
  })
for (const [scenario, conclusion] of [
  ["controlled", "success"],
  ["fail", "failure"],
  ["pending", "timeout"],
] as const) {
  hookIt.instance(
    `repository watcher delivers ${conclusion} through asyncRewake to the originating session`,
    () =>
      Effect.gen(function* () {
        rewakes.length = 0
        const instance = yield* TestInstance
        const sessionID = `ses_ci_${scenario}_${path.basename(instance.directory)}`
        const hook = yield* SettingsHook.Service
        const result = yield* hook.trigger(
          {
            event: "PostToolUse",
            toolName: "Bash",
            toolInput: { command: "gh pr create" },
            toolResponse: { output: url },
          },
          { sessionID, transcriptPath: "" },
        )
        expect(result.blocked).toBeUndefined()
        expect(rewakes).toHaveLength(0)
        if (scenario === "controlled") {
          yield* Effect.promise(() =>
            until(
              () => fs.readFile(path.join(instance.directory, "checking"), "utf8").then(Number, () => undefined),
              "background checks never started",
            ),
          )
          expect(rewakes).toHaveLength(0)
          yield* Effect.promise(() => fs.writeFile(path.join(instance.directory, "release"), "ready"))
        }
        const notification = yield* pollWithTimeout(
          Effect.sync(() => rewakes[0]),
          "CI result did not rewake the session",
          "10 seconds",
        )
        expect(notification.sessionID).toBe(sessionID)
        expect(notification.text).toContain(`PR #42, head ${head}, ${conclusion}`)
        expect(rewakes).toHaveLength(1)
      }),
    { init: configure(scenario, scenario === "pending" ? 1500 : 5000) },
  )
}
hookIt.instance(
  "SessionEnd cancels the repository watcher without rewaking a closed session",
  () =>
    Effect.gen(function* () {
      rewakes.length = 0
      const instance = yield* TestInstance
      const hook = yield* SettingsHook.Service
      yield* hook.trigger(
        {
          event: "PostToolUse",
          toolName: "Bash",
          toolInput: { command: "gh pr create" },
          toolResponse: { output: url },
        },
        { sessionID: "ses_ci_ended", transcriptPath: "" },
      )
      const queryPID = yield* Effect.promise(() =>
        until(
          () => fs.readFile(path.join(instance.directory, "checking"), "utf8").then(Number, () => undefined),
          "background checks never started",
        ),
      )
      yield* hook.trigger(
        { event: "SessionEnd", reason: "prompt_input_exit" },
        { sessionID: "ses_ci_ended", transcriptPath: "" },
      )
      yield* Effect.promise(() =>
        until(async () => (!running(queryPID) ? true : undefined), "query survived SessionEnd"),
      )
      expect(rewakes).toHaveLength(0)
    }),
  { init: configure("hold") },
)
