// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline checks of the case export and replay of the model matrix (Issue #1474): the case file, `eval:case`, the
 * hook that stops a replayed tool call, the judge of a live replay, the `--case` option of `eval:models`, and the
 * hand-written cases in `cases/`. No model and no credential is involved. The one test that starts hosts plays
 * the whole live path (import, hook, judge) against the scripted server; `replay.test.ts` plays the cases the CI way.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { readdirSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isRecord } from "../delegation-timing/classify"
import { sessionPermission, stopAllHosts, type ModelRef } from "../delegation-timing/harness"
import { startScriptServer, type Reply } from "../lib/script-server"
import { buildCase, findingLines, parseCaseOptions, runCaseCommand, type Output } from "./case"
import { caseName, caseScenario, expectationFailures, loadCaseFile, parseCaseFile, type CaseFile } from "./case-file"
import { firstStoppedCall, stoppedCallOf } from "./case-hook"
import { argumentFailure, CHECKED_TOOLS, caseFailures } from "./case-judge"
import { attemptCase, replayRequest, replaySessionInfo, seedCaseHome, type CaseJob } from "./case-run"
import { insideRepo, REPO_ROOT } from "./cli"
import { replayOrigin } from "./host-config"
import { redactDeep } from "./runner"
import { parseOptions } from "./run"
import { SCENARIOS } from "./scenarios"
import type { Call, RunView } from "./types"

const CASES_DIR = path.join(import.meta.dir, "cases")
const HOOK = path.join(import.meta.dir, "case-hook.ts")
const posix = process.platform !== "win32"

const roots: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "case-test-")))
  roots.push(dir)
  return dir
}

afterAll(async () => {
  await stopAllHosts()
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

function capture() {
  const lines: string[] = []
  const output: Output = { log: (line) => lines.push(line), error: (line) => lines.push(line) }
  return { lines, output }
}

// A key-shaped value is built here, never written out whole, so no secret scanner has anything to find in this file.
const KEY = ["sk", "a1B2c3D4e5F6g7H8i9J0k1L2"].join("-")
const ENV_VALUE = ["env", "value", "0123456789abcdef"].join("-")

const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: value, ...extra })
const tool = (name: string, input: Record<string, unknown>, status: string) => ({
  type: "tool",
  tool: name,
  callID: `call_${name}`,
  state: { status, input },
})
const message = (id: string, role: "user" | "assistant", ...parts: Record<string, unknown>[]) => ({
  info: { id, role, sessionID: "ses_test" },
  parts,
})
const exportOf = (...messages: unknown[]) => ({
  info: { id: "ses_test", title: "a session", directory: "/workspace/demo" },
  messages,
})
/** A message of an export the way the runtime writes a user message: it names the agent it was sent to. */
const sentTo = (entry: ReturnType<typeof message>, agent: unknown) => ({ ...entry, info: { ...entry.info, agent } })

/** Three user messages: a text reply, a reply that says something and calls tools, and a bash call. */
const SESSION = exportOf(
  message("m1", "user", text("first question")),
  message("m2", "assistant", text("first answer")),
  message("m3", "user", text("fix the bug"), text("in src/a.ts"), text("[file context]", { synthetic: true })),
  message(
    "m4",
    "assistant",
    { type: "step-start" },
    text("Let me look."),
    tool("read", { filePath: "src/a.ts" }, "error"),
    tool("grep", { pattern: "bug" }, "completed"),
  ),
  message("m5", "assistant", tool("todowrite", { todos: [] }, "completed")),
  message("m6", "user", text("now run the tests")),
  message("m7", "assistant", tool("bash", { command: "bun test", description: "run" }, "completed")),
)

describe("the case file", () => {
  const file = (recorded: unknown, extra: Record<string, unknown> = {}) => ({
    version: 1,
    session: { info: { id: "ses_x" }, messages: [] },
    request: "do it",
    recorded,
    ...extra,
  })
  const call = { calls: [{ name: "read", input: { filePath: "a.ts" } }] }

  test("a valid case parses, with and without expect", () => {
    expect(parseCaseFile(file(call, { expect: { status: "completed" } }))).toMatchObject({
      ok: true,
      value: { request: "do it", recorded: call, expect: { status: "completed" } },
    })
    const plain = parseCaseFile(file({ text: "hi" }))
    expect(plain).toMatchObject({ ok: true, value: { recorded: { text: "hi" } } })
    expect(plain.ok && "expect" in plain.value).toBe(false)
  })

  test("the agent the message was sent to is optional, and a name when it is there; the version stays", () => {
    const named = parseCaseFile(file(call, { agent: "plan" }))
    expect(named).toMatchObject({ ok: true, value: { version: 1, agent: "plan", request: "do it" } })
    // A case written before the field existed is still a case, and has no agent.
    const old = parseCaseFile(file(call))
    expect(old.ok && "agent" in old.value).toBe(false)
    for (const bad of ["", "  ", 3, null, ["plan"], { name: "plan" }]) {
      expect(parseCaseFile(file(call, { agent: bad }))).toEqual({
        ok: false,
        error: "agent must be the name of an agent",
      })
    }
  })

  test("what is not a case is refused, and says why", () => {
    const why = (json: unknown) => {
      const parsed = parseCaseFile(json)
      return parsed.ok ? undefined : parsed.error
    }
    expect(why("x")).toContain("JSON object")
    expect(why({ ...file(call), version: 2 })).toContain("version")
    expect(why({ ...file(call), session: { info: {}, messages: [] } })).toContain("info.id")
    expect(
      why({ ...file(call), session: { info: { id: "s" }, messages: [{ info: { id: "m" }, parts: [] }] } }),
    ).toContain("id and a role")
    expect(why({ ...file(call), request: "  " })).toContain("request")
    expect(why(file({ text: " " }))).toContain("empty")
    expect(why(file({ text: "a", calls: call.calls }))).toContain("recorded")
    expect(why(file({ calls: [...call.calls, ...call.calls] }))).toContain("exactly one call")
    expect(why(file({ calls: [{ name: "read", input: "a.ts" }] }))).toContain("input object")
    expect(why(file(call, { expect: {} }))).toContain("expect")
    expect(why(file({ text: "hi" }, { expect: { status: "completed" } }))).toContain("only for a recorded call")
  })

  test("the CI replay of a call wants the recorded tool first, in the state the case expects", () => {
    const parsed = parseCaseFile(file(call, { expect: { status: "completed" } }))
    if (!parsed.ok) throw new Error(parsed.error)
    const view = (...calls: Call[]): RunView => ({ files: {}, calls, reply: "", todos: [], children: 0 })
    const ran = (tool: string, status: Call["status"]): Call => ({ tool, input: {}, status, outcome: "ok", text: "" })
    expect(expectationFailures(parsed.value, view(ran("read", "completed")))).toEqual([])
    expect(expectationFailures(parsed.value, view(ran("read", "error")))).toEqual([
      "calls: first call is error, expected completed",
    ])
    expect(expectationFailures(parsed.value, view(ran("glob", "completed"), ran("read", "completed")))).toEqual([
      "calls: first call is glob, expected read",
    ])
    expect(expectationFailures(parsed.value, view())).toEqual(["calls: no read call"])
    // Without `expect` the state is not looked at.
    const open = parseCaseFile(file(call))
    if (!open.ok) throw new Error(open.error)
    expect(expectationFailures(open.value, view(ran("read", "error")))).toEqual([])
  })

  test("the CI replay of a text wants no call and the text", () => {
    const parsed = parseCaseFile(file({ text: "You use bun." }))
    if (!parsed.ok) throw new Error(parsed.error)
    const view = (reply: string, ...calls: Call[]): RunView => ({ files: {}, calls, reply, todos: [], children: 0 })
    const ran: Call = { tool: "glob", input: {}, status: "completed", outcome: "ok", text: "" }
    expect(expectationFailures(parsed.value, view("You use bun."))).toEqual([])
    expect(expectationFailures(parsed.value, view("You use bun.", ran))).toEqual([
      "calls: expected no tool call, got glob",
    ])
    expect(expectationFailures(parsed.value, view("npm"))).toEqual(['reply: missing "You use bun."'])
  })

  test("a case is replayed as a scenario named like its file: an empty workspace, the request, the recorded reply", () => {
    const parsed = parseCaseFile(file(call))
    if (!parsed.ok) throw new Error(parsed.error)
    const scenario = caseScenario("my-case", parsed.value)
    expect(scenario).toMatchObject({ id: "my-case", files: {}, prompt: "do it" })
    expect(scenario.scripts.default).toEqual({ replies: [call] })
    expect(scenario.scripts.apply_patch).toBeUndefined()
    expect(caseName("/some/dir/my-case.json")).toBe("my-case")
  })

  test("loadCaseFile reads a file, and says when it cannot", async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "ok.json"), JSON.stringify(file({ text: "hi" })))
    await fs.writeFile(path.join(dir, "bad.json"), `{ not json ${KEY}`)
    expect((await loadCaseFile(path.join(dir, "ok.json"))).ok).toBe(true)
    // A parse error does not quote the text around the mistake.
    expect(await loadCaseFile(path.join(dir, "bad.json"))).toEqual({
      ok: false,
      error: "cannot read the case file: not valid JSON",
    })
    expect(await loadCaseFile(path.join(dir, "missing.json"))).toMatchObject({ ok: false })
  })
})

describe("the hand-written cases", () => {
  const files = readdirSync(CASES_DIR).filter((name) => name.endsWith(".json"))

  async function load(name: string): Promise<CaseFile> {
    const parsed = await loadCaseFile(path.join(CASES_DIR, name))
    if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`)
    return parsed.value
  }

  test("there are at least a recorded call that completes and a recorded text", async () => {
    const cases = await Promise.all(files.map(load))
    expect(cases.length).toBeGreaterThanOrEqual(2)
    expect(cases.some((item) => "calls" in item.recorded && item.expect?.status === "completed")).toBe(true)
    expect(cases.some((item) => "text" in item.recorded)).toBe(true)
  })

  test("each is named so that [case <name>] reaches the scripted server, and no scenario has the name", () => {
    const scenarios = new Set(SCENARIOS.map((scenario) => scenario.id))
    for (const name of files.map(caseName)) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(scenarios.has(name)).toBe(false)
    }
  })

  test("each is synthetic: no credential-shaped value, no path of this machine", async () => {
    for (const name of files) {
      expect(findingLines(await load(name))).toEqual([])
      const raw = await fs.readFile(path.join(CASES_DIR, name), "utf8")
      for (const place of [os.homedir(), os.tmpdir()].filter((item) => item.length > 3)) {
        expect(raw).not.toContain(place)
      }
    }
  })
})

describe("eval:case: the case of a user message", () => {
  const built = (...args: Parameters<typeof buildCase>) => {
    const result = buildCase(...args)
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  const error = (...args: Parameters<typeof buildCase>) => {
    const result = buildCase(...args)
    return result.ok ? undefined : result.error
  }
  const ids = (item: CaseFile) => item.session.messages.map((entry) => entry.info.id)

  test("the last user message by default: the messages before it, its text, the first call of the next message", () => {
    const item = built(SESSION)
    expect(ids(item)).toEqual(["m1", "m2", "m3", "m4", "m5"])
    expect(item.request).toBe("now run the tests")
    expect(item.recorded).toEqual({ calls: [{ name: "bash", input: { command: "bun test", description: "run" } }] })
    expect(item.expect).toEqual({ status: "completed" })
    expect(item.session.info).toMatchObject({ id: "ses_test", title: "a session" })
  })

  test("a user message is chosen by its number among the user messages; synthetic text is not part of the request", () => {
    const item = built(SESSION, 1)
    expect(ids(item)).toEqual(["m1", "m2"])
    expect(item.request).toBe("fix the bug\nin src/a.ts")
  })

  test("the recorded step is the first tool call when the message has one, whatever it said before", () => {
    const item = built(SESSION, 1)
    expect(item.recorded).toEqual({ calls: [{ name: "read", input: { filePath: "src/a.ts" } }] })
    expect(item.expect).toEqual({ status: "error" })
  })

  test("a message without a tool call is recorded as its text, and has no expect", () => {
    const item = built(SESSION, 0)
    expect(item.recorded).toEqual({ text: "first answer" })
    expect(item.session.messages).toEqual([])
    expect("expect" in item).toBe(false)
  })

  test("the result is a case file: it parses back", () => {
    for (const number of [0, 1, 2])
      expect(parseCaseFile(JSON.parse(JSON.stringify(built(SESSION, number)))).ok).toBe(true)
  })

  test("the agent the chosen user message was sent to is recorded, and no other message's", () => {
    const planned = exportOf(
      message("m1", "user", text("look around")),
      message("m2", "assistant", text("sure")),
      sentTo(message("m3", "user", text("make a plan")), "plan"),
      message("m4", "assistant", text("ok")),
      sentTo(message("m5", "user", text("now build it")), "build"),
      message("m6", "assistant", text("done")),
    )
    expect(built(planned, 1).agent).toBe("plan")
    expect(built(planned).agent).toBe("build")
    // A message that names no agent records none, and the replay keeps asking the host's default agent.
    expect("agent" in built(planned, 0)).toBe(false)
    // So does one whose agent is not a name.
    for (const agent of ["", "  ", 7, null]) {
      const odd = exportOf(sentTo(message("m1", "user", text("hi")), agent), message("m2", "assistant", text("x")))
      expect("agent" in built(odd)).toBe(false)
    }
    expect(parseCaseFile(JSON.parse(JSON.stringify(built(planned, 1))))).toMatchObject({
      ok: true,
      value: { agent: "plan" },
    })
  })

  test("what makes no case is refused, and says why", () => {
    expect(error("x")).toContain("expected { info, messages }")
    expect(error({ info: {}, messages: [] })).toContain("no id")
    expect(error({ info: { id: "s" }, messages: [{}] })).toContain("{ info, parts }")
    expect(error(exportOf())).toBe("the session has no user message")
    expect(error(SESSION, 3)).toContain("--user-message 3 is out of range: the session has 3 user messages")
    // No assistant message follows the last user message.
    expect(error(exportOf(message("m1", "user", text("hi"))))).toContain("follows user message 0")
    // The next message is another user message: the reply belongs to that one.
    const queued = exportOf(
      message("m1", "user", text("one")),
      message("m2", "user", text("two")),
      message("m3", "assistant", text("both")),
    )
    expect(error(queued, 0)).toContain("follows user message 0")
    expect(built(queued, 1).recorded).toEqual({ text: "both" })
    // An assistant message with neither a tool call nor text, and a user message with no text.
    expect(
      error(exportOf(message("m1", "user", text("hi")), message("m2", "assistant", { type: "step-start" }))),
    ).toContain("follows user message 0")
    expect(error(exportOf(message("m1", "user", { type: "file" }), message("m2", "assistant", text("x"))))).toContain(
      "has no text",
    )
  })
})

describe("eval:case: the command line", () => {
  const error = (argv: string[]) => {
    const parsed = parseCaseOptions(argv)
    return parsed.ok ? undefined : parsed.error
  }

  test("--from and --out are required, a user message is a number, nothing is repeated", () => {
    expect(error([])).toContain("--from is required")
    expect(error(["--from", "e.json"])).toContain("--out is required")
    expect(error(["--from", "e.json", "--out", "c.json", "--user-message", "last"])).toContain("number from 0")
    expect(error(["--from", "e.json", "--out", "c.json", "--user-message", "-1"])).toContain("number from 0")
    expect(error(["--from", "a", "--from", "b", "--out", "c"])).toBe("--from may be given once")
    expect(error(["--from", "e.json", "--out"])).toBe("--out needs a value")
    expect(error(["--from", "e.json", "--out", "c.json", "--verbose"])).toBe("unknown argument --verbose")
  })

  test("a word that is a property of every object is an unknown argument, not a flag", () => {
    expect(error(["constructor"])).toBe("unknown argument constructor")
    expect(error(["--from", "e.json", "toString", "--out", "c.json"])).toBe("unknown argument toString")
  })

  test("both flag spellings, resolved to absolute paths", () => {
    expect(parseCaseOptions(["--from=e.json", "--out", "/o/c.json", "--user-message=2"])).toEqual({
      ok: true,
      value: { from: path.resolve("e.json"), out: path.resolve("/o/c.json"), userMessage: 2 },
    })
    expect(parseCaseOptions(["--from", "e.json", "--out", "/o/c.json"])).toEqual({
      ok: true,
      value: { from: path.resolve("e.json"), out: path.resolve("/o/c.json") },
    })
  })
})

describe("eval:case: the command", () => {
  const original = { ...process.env }
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]
    Object.assign(process.env, original)
  })

  async function exported(content: unknown): Promise<{ dir: string; from: string; out: string }> {
    const dir = await tempDir()
    const from = path.join(dir, "export.json")
    await fs.writeFile(from, JSON.stringify(content))
    return { dir, from, out: path.join(dir, "case.json") }
  }
  const exists = (file: string) =>
    fs.stat(file).then(
      () => true,
      () => false,
    )

  test("writes the case of the last user message, prints no content, and leaves the file readable by its owner only", async () => {
    const { from, out } = await exported(SESSION)
    const { lines, output } = capture()
    expect(await runCaseCommand(["--from", from, "--out", out], output)).toBe(0)
    const parsed = parseCaseFile(JSON.parse(await fs.readFile(out, "utf8")))
    expect(parsed).toMatchObject({ ok: true, value: { request: "now run the tests" } })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("recorded a bash call")
    for (const content of ["now run the tests", "fix the bug", "bun test"])
      expect(lines.join("\n")).not.toContain(content)
  })

  test("the file holds the agent the message was sent to, so that the replay asks the same agent", async () => {
    const session = exportOf(
      sentTo(message("m1", "user", text("plan it")), "plan"),
      message("m2", "assistant", text("ok")),
    )
    const { from, out } = await exported(session)
    expect(await runCaseCommand(["--from", from, "--out", out], capture().output)).toBe(0)
    expect(JSON.parse(await fs.readFile(out, "utf8"))).toMatchObject({ version: 1, agent: "plan", request: "plan it" })
  })

  test.skipIf(!posix)("the file has mode 0600, also when it already existed with another mode", async () => {
    const { from, out } = await exported(SESSION)
    await runCaseCommand(["--from", from, "--out", out], capture().output)
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600)
    await fs.chmod(out, 0o644)
    expect(await runCaseCommand(["--from", from, "--out", out, "--user-message", "0"], capture().output)).toBe(0)
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600)
  })

  test("a case holding a key-shaped value is refused, and neither the file nor the output has the value", async () => {
    const leaked = exportOf(
      message("m1", "user", text(`use this key ${KEY} for the call`)),
      message("m2", "assistant", text("ok")),
    )
    const { from, out } = await exported(leaked)
    const { lines, output } = capture()
    expect(await runCaseCommand(["--from", from, "--out", out], output)).toBe(1)
    expect(await exists(out)).toBe(false)
    // The request holds it: the finding is on the request, and only its path and kind are printed.
    expect(lines.join("\n")).toContain("request: API key")
    expect(lines.join("\n")).not.toContain(KEY)
    expect(lines.join("\n")).not.toContain("a1B2c3D4")
  })

  test("so is the value of a secret-looking environment variable of this process", async () => {
    process.env.CASE_TEST_API_TOKEN = ENV_VALUE
    const leaked = exportOf(
      message("m1", "user", text("earlier")),
      message("m2", "assistant", text(`the token is ${ENV_VALUE}`)),
      message("m3", "user", text("go on")),
      message("m4", "assistant", text("ok")),
    )
    const { from, out } = await exported(leaked)
    const { lines, output } = capture()
    expect(await runCaseCommand(["--from", from, "--out", out], output)).toBe(1)
    expect(await exists(out)).toBe(false)
    expect(lines.join("\n")).toContain("session.messages[1].parts[0].text: environment secret CASE_TEST_API_TOKEN")
    expect(lines.join("\n")).not.toContain(ENV_VALUE)
  })

  test("a path that itself holds a secret is not printed", () => {
    const value = { input: { [KEY]: KEY } }
    const printed = findingLines(value).join("\n")
    expect(printed).toContain("API key")
    expect(printed).not.toContain(KEY)
    expect(findingLines({ a: "plain" })).toEqual([])
  })

  test("many findings are cut to a limit and counted", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, KEY]))
    const lines = findingLines(many, 5)
    expect(lines).toHaveLength(6)
    expect(lines[5]).toBe("... and 25 more")
  })

  test("--out inside this repository is refused, before anything is read", async () => {
    const target = path.join(REPO_ROOT, "case-test-must-not-exist.json")
    const { lines, output } = capture()
    expect(await runCaseCommand(["--from", "/nowhere/export.json", "--out", target], output)).toBe(1)
    expect(lines.join("\n")).toContain("inside this repository")
    expect(await exists(target)).toBe(false)
    expect(insideRepo(target)).toBe(true)
    // An explicit root says the same of its own tree.
    const dir = await tempDir()
    const { from } = await exported(SESSION)
    expect(await runCaseCommand(["--from", from, "--out", path.join(dir, "x.json")], capture().output, dir)).toBe(1)
    expect(await exists(path.join(dir, "x.json"))).toBe(false)
  })

  test("--help prints the usage and exits with 0", async () => {
    const { lines, output } = capture()
    expect(await runCaseCommand(["--help"], output)).toBe(0)
    expect(lines.join("\n")).toContain("bun run eval:case --from")
  })

  test("usage errors exit with 2 and write nothing", async () => {
    const { dir, from, out } = await exported(SESSION)
    const run = async (argv: string[]) => {
      const { lines, output } = capture()
      return { code: await runCaseCommand(argv, output), text: lines.join("\n") }
    }
    expect(await run([])).toMatchObject({ code: 2, text: expect.stringContaining("--from is required") })
    expect(await run(["--from", path.join(dir, "missing.json"), "--out", out])).toMatchObject({
      code: 2,
      text: expect.stringContaining("cannot read --from"),
    })
    // A parse error does not quote the text around the mistake.
    await fs.writeFile(path.join(dir, "bad.json"), `{ nope ${KEY}`)
    expect(await run(["--from", path.join(dir, "bad.json"), "--out", out])).toMatchObject({
      code: 2,
      text: expect.stringContaining("not valid JSON"),
    })
    expect((await run(["--from", path.join(dir, "bad.json"), "--out", out])).text).not.toContain("a1B2c3D4")
    expect(await run(["--from", from, "--out", from])).toMatchObject({
      code: 2,
      text: expect.stringContaining("the export itself"),
    })
    await fs.writeFile(path.join(dir, "other.json"), JSON.stringify({ hello: "world" }))
    expect((await run(["--from", path.join(dir, "other.json"), "--out", out])).code).toBe(2)
    expect(await run(["--from", from, "--out", out, "--user-message", "9"])).toMatchObject({
      code: 2,
      text: expect.stringContaining("out of range"),
    })
    expect(await run(["--from", from, "--out", path.join(dir, "no", "such", "dir", "c.json")])).toMatchObject({
      code: 2,
      text: expect.stringContaining("cannot write --out"),
    })
    expect(await exists(out)).toBe(false)
  })
})

/** The command of the one PreToolUse hook in a `hooks.json`. */
function hookCommand(hooks: unknown): string {
  const group = isRecord(hooks) && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse[0] : undefined
  const entry = isRecord(group) && Array.isArray(group.hooks) ? group.hooks[0] : undefined
  if (!isRecord(entry) || typeof entry.command !== "string") throw new Error("hooks.json has no hook command")
  return entry.command
}

describe("the hook that stops a replayed tool call", () => {
  const payload = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s",
      tool_name: "bash",
      tool_input: { command: "echo hi" },
      tool_use_id: "c1",
      ...extra,
    })

  async function runCommand(cmd: string[], stdin: string) {
    const child = Bun.spawn(cmd, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { stdout: stdout.trim(), code }
  }
  const stops = (stdout: string) => {
    const decision: unknown = JSON.parse(stdout)
    return typeof decision === "object" && decision !== null && "continue" in decision && decision.continue === false
  }

  test("a payload is read as the tool and the arguments, and nothing else is a call", () => {
    expect(stoppedCallOf(JSON.parse(payload()))).toEqual({ tool: "bash", input: { command: "echo hi" }, id: "c1" })
    expect(stoppedCallOf({ tool_name: "glob" })).toEqual({ tool: "glob", input: {} })
    expect(stoppedCallOf({ tool_name: "glob", tool_input: "x" })).toEqual({ tool: "glob", input: {} })
    for (const value of [undefined, null, "x", [], {}, { tool_name: "" }, { tool_name: 3 }]) {
      expect(stoppedCallOf(value)).toBeUndefined()
    }
  })

  test("the first call is the one the model made first, whichever hook finished first", () => {
    const line = (tool: string, id?: string) => JSON.stringify({ tool, input: {}, ...(id ? { id } : {}) })
    const audit = [line("read", "call_2"), line("glob", "call_1"), line("bash", "call_3")].join("\n")
    // The hook of the second call finished first; the transcript says which call came first.
    expect(firstStoppedCall(audit, ["call_1", "call_2", "call_3"])?.tool).toBe("glob")
    expect(firstStoppedCall(audit, ["call_3", "call_2"])?.tool).toBe("bash")
    // Without an order, or with ids it does not know, the audit's own order stands.
    expect(firstStoppedCall(audit)?.tool).toBe("read")
    expect(firstStoppedCall(audit, ["other"])?.tool).toBe("read")
    expect(firstStoppedCall(audit, ["call_3"])?.tool).toBe("bash")
    // A call with no id comes after the ones the transcript knows.
    expect(firstStoppedCall([line("grep"), line("read", "call_2")].join("\n"), ["call_2"])?.tool).toBe("read")
    expect(firstStoppedCall(audit, ["call_1"])?.id).toBe("call_1")
  })

  test("the audit is read back as its first call; a line that is not a call is skipped", () => {
    const line = (tool: string) => JSON.stringify({ tool, input: { n: tool } })
    expect(firstStoppedCall(`\n{ broken\n${JSON.stringify({ tool: 3 })}\n${line("read")}\n${line("glob")}\n`)).toEqual({
      tool: "read",
      input: { n: "read" },
    })
    expect(firstStoppedCall("")).toBeUndefined()
    expect(firstStoppedCall("not json\n")).toBeUndefined()
  })

  test.skipIf(!posix)("the script stops a call, records it, and stops one it cannot read as well", async () => {
    const dir = await tempDir()
    const audit = path.join(dir, "audit.jsonl")
    const first = await runCommand([process.execPath, HOOK, audit], payload())
    expect(first.code).toBe(0)
    expect(stops(first.stdout)).toBe(true)
    const second = await runCommand(
      [process.execPath, HOOK, audit],
      payload({ tool_name: "read", tool_input: { filePath: "a" } }),
    )
    expect(stops(second.stdout)).toBe(true)
    expect(firstStoppedCall(await fs.readFile(audit, "utf8"))).toEqual({
      tool: "bash",
      input: { command: "echo hi" },
      id: "c1",
    })
    expect((await fs.readFile(audit, "utf8")).trim().split("\n")).toHaveLength(2)
    // Unreadable input, no audit argument, an audit that cannot be written: each is still stopped.
    const unreadable = await runCommand([process.execPath, HOOK, audit], "{ not json")
    expect(stops(unreadable.stdout)).toBe(true)
    expect(stops((await runCommand([process.execPath, HOOK], payload())).stdout)).toBe(true)
    expect(
      stops((await runCommand([process.execPath, HOOK, path.join(dir, "no", "dir", "a.jsonl")], payload())).stdout),
    ).toBe(true)
    expect((await fs.readFile(audit, "utf8")).trim().split("\n")).toHaveLength(2)
  })

  test.skipIf(!posix)(
    "seedCaseHome installs it as the one PreToolUse hook, and the command it writes runs",
    async () => {
      const dir = await tempDir()
      const home = path.join(dir, "home")
      const audit = path.join(dir, "it's here", "audit.jsonl")
      await fs.mkdir(path.dirname(audit), { recursive: true })
      await seedCaseHome(home, audit)
      const hooks: unknown = JSON.parse(
        await fs.readFile(path.join(home, ".config", "graphagent", "hooks.json"), "utf8"),
      )
      expect(hooks).toMatchObject({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }] })
      const command = hookCommand(hooks)
      expect(command).toContain("case-hook.ts")
      expect((await fs.stat(path.join(home, ".config", "graphagent", "memory.jsonc"))).isFile()).toBe(true)
      const ran = await runCommand(["sh", "-c", command], payload())
      expect(stops(ran.stdout)).toBe(true)
      expect(firstStoppedCall(await fs.readFile(audit, "utf8"))?.tool).toBe("bash")
    },
  )
})

describe("the judge of a live replay", () => {
  const recorded = (name: string, input: Record<string, unknown> = {}): CaseFile => ({
    version: 1,
    session: { info: { id: "ses_x" }, messages: [] },
    request: "do it",
    recorded: { calls: [{ name, input }] },
  })
  const said = (value: string): CaseFile => ({ ...recorded("x"), recorded: { text: value } })
  const made = (tool: string, input: Record<string, unknown> = {}): Call => ({
    tool,
    input,
    status: "completed",
    outcome: "ok",
    text: "",
  })

  test("the tools whose arguments are checked are the ones the parameters test covers, the engine's own apart", () => {
    expect([...CHECKED_TOOLS].sort()).toEqual(
      [
        "agent",
        "apply_patch",
        "bash",
        "edit",
        "glob",
        "grep",
        "lsp",
        "plan_exit",
        "question",
        "read",
        "skill",
        "task",
        "todowrite",
        "webfetch",
        "websearch",
        "workflow",
        "write",
      ].sort(),
    )
    expect(CHECKED_TOOLS).not.toContain("invalid")
  })

  test("arguments are checked against the tool's own parameters, and the failure names paths, never values", () => {
    expect(argumentFailure("read", { filePath: "a.ts" })).toBeUndefined()
    expect(argumentFailure("bash", { command: "ls" })).toBeUndefined()
    expect(argumentFailure("read", { path: "a.ts" })).toBe('["filePath"] missing required field, expected string')
    expect(argumentFailure("bash", {})).toContain("command")
    expect(argumentFailure("todowrite", { todos: [{ content: "x", status: "done", priority: "medium" }] })).toContain(
      '"in_progress"',
    )
    expect(argumentFailure("read", { filePath: 424242424242 })).toBe('["filePath"] wrong type, expected string')
    expect(argumentFailure("grep", { pattern: KEY, include: 7 })).not.toContain(KEY)
    // A tool that is not checked is compared by name only.
    expect(argumentFailure("memory_search", 5)).toBeUndefined()
    expect(argumentFailure("invalid", {})).toBeUndefined()
    expect(argumentFailure("mcp__server__tool", { anything: true })).toBeUndefined()
  })

  test("a recorded call is made again by a first call of the same tool with valid arguments", () => {
    const read = recorded("read", { filePath: "a.ts" })
    const stopped = (tool: string, input: Record<string, unknown>) => ({
      stopped: { tool, input },
      calls: [],
      reply: "",
    })
    expect(caseFailures(read, stopped("read", { filePath: "b.ts" }))).toEqual([])
    expect(caseFailures(read, stopped("glob", { pattern: "*" }))).toEqual(["calls: first call is glob, expected read"])
    expect(caseFailures(read, stopped("read", { path: "b.ts" }))).toEqual([
      'arguments: read ["filePath"] missing required field, expected string',
    ])
    expect(caseFailures(read, { calls: [], reply: "I would read it." })).toEqual(["calls: no tool call, expected read"])
    // Only the first call counts, and the audit has its arguments: it is the call of the transcript's first id.
    const both = {
      stopped: { tool: "read", input: { filePath: "a" }, id: "call_1" },
      calls: [made("read"), made("bash")],
      firstCallID: "call_1",
      reply: "",
    }
    expect(caseFailures(read, both)).toEqual([])
  })

  test("a call that never reached the hook is judged from the transcript", () => {
    const read = recorded("read")
    expect(caseFailures(read, { calls: [made("read", { path: "a" })], reply: "" })).toEqual([
      'arguments: read ["filePath"] missing required field, expected string',
    ])
    expect(caseFailures(read, { calls: [made("bash", { command: "ls" })], reply: "" })).toEqual([
      "calls: first call is bash, expected read",
    ])
  })

  test("a first call the SDK refused before any hook ran is still the first call, whatever the hook saw after it", () => {
    const read = recorded("read", { filePath: "a.ts" })
    const good = { filePath: "a.ts" }
    // The audit has only the call that reached the hook: the second one, a valid read.
    const audited = { tool: "read", input: good, id: "call_2" }
    const seen = (calls: Call[]) => ({ stopped: audited, calls, firstCallID: "call_1", reply: "" })
    // An unknown tool first: the model's first call is not the recorded tool.
    expect(caseFailures(read, seen([made("no_such_tool"), made("read", good)]))).toEqual([
      "calls: first call is no_such_tool, expected read",
    ])
    // Arguments that are not JSON for the recorded tool first: the transcript has none for it.
    expect(caseFailures(read, seen([made("read"), made("read", good)]))).toEqual([
      'arguments: read ["filePath"] missing required field, expected string',
    ])
    // The same when the recorded step is a text: the call the model made first is the one named.
    expect(caseFailures(said("hi"), seen([made("no_such_tool"), made("read", good)]))).toEqual([
      "calls: expected no tool call, the model called no_such_tool",
    ])
  })

  test("the audit's arguments are the first call's when the ids say so, and then they are judged as given", () => {
    const read = recorded("read", { filePath: "a.ts" })
    const wrong = { path: "a.ts" }
    const right = { filePath: "a.ts" }
    // The tool repaired the model's arguments before the transcript kept them: the audit has what was given.
    const first = { stopped: { tool: "read", input: wrong, id: "call_1" }, calls: [made("read", right)], reply: "" }
    expect(caseFailures(read, { ...first, firstCallID: "call_1" })).toEqual([
      'arguments: read ["filePath"] missing required field, expected string',
    ])
    // An audit entry that cannot be told to be the first call (another id, or an id on one side only) is not.
    expect(caseFailures(read, { ...first, firstCallID: "call_0" })).toEqual([])
    expect(caseFailures(read, first)).toEqual([])
    const unnamed = { ...first, stopped: { tool: "read", input: wrong }, firstCallID: "call_1" }
    expect(caseFailures(read, unnamed)).toEqual([])
    // With no call in the transcript the audit stands, as it did.
    expect(caseFailures(read, { stopped: first.stopped, calls: [], reply: "" })).toEqual([
      'arguments: read ["filePath"] missing required field, expected string',
    ])
  })

  test("a tool that is not checked passes on its name", () => {
    const mcp = recorded("mcp__docs__search", { q: "x" })
    expect(
      caseFailures(mcp, { stopped: { tool: "mcp__docs__search", input: { whatever: 1 } }, calls: [], reply: "" }),
    ).toEqual([])
  })

  test("a recorded text is made again by an answer with no tool call", () => {
    expect(caseFailures(said("hi"), { calls: [], reply: "something else" })).toEqual([])
    expect(caseFailures(said("hi"), { calls: [], reply: "  \n" })).toEqual(["reply: empty"])
    expect(caseFailures(said("hi"), { calls: [], reply: "" })).toEqual(["reply: empty"])
    expect(caseFailures(said("hi"), { stopped: { tool: "glob", input: {} }, calls: [], reply: "text" })).toEqual([
      "calls: expected no tool call, the model called glob",
    ])
    expect(caseFailures(said("hi"), { calls: [made("bash")], reply: "text" })).toEqual([
      "calls: expected no tool call, the model called bash",
    ])
  })
})

describe("what a live replay sends and imports", () => {
  const model = { providerID: "script", modelID: "scripted" }
  const base = (extra: Partial<CaseFile> = {}): CaseFile => ({
    version: 1,
    session: { info: { id: "ses_x" }, messages: [] },
    request: "do it",
    recorded: { text: "hi" },
    ...extra,
  })

  test("the request goes to the agent the case recorded, and to the host's default one when it recorded none", () => {
    const body = { model, parts: [{ type: "text", text: "do it" }] }
    expect(replayRequest(base({ agent: "plan" }), model)).toEqual({ ...body, agent: "plan" })
    // Without an agent the request is the one it was before the field existed.
    const plain = replayRequest(base(), model)
    expect(plain).toEqual(body)
    expect("agent" in plain).toBe(false)
  })

  test("the session is imported as a root of its own: no parent, no child role, the permission of every matrix session", () => {
    const child = {
      id: "ses_x",
      title: "a worker",
      agent: "coding",
      parentID: "ses_parent",
      role: "dag_node",
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
      metadata: { engine: "v1" },
    }
    const replayed = replaySessionInfo(child, "/tmp/home")
    expect("parentID" in replayed).toBe(false)
    expect(replayed).toMatchObject({ id: "ses_x", title: "a worker", agent: "coding", metadata: { engine: "v1" } })
    expect(replayed.role).toBe("root")
    expect(replayed.permission).toEqual(sessionPermission("/tmp/home"))
    // A root keeps all it had, and the case file's own session is not changed.
    const root = { id: "ses_y", title: "a chat", role: "root" }
    expect(replaySessionInfo(root, "/tmp/home")).toEqual({ ...root, permission: sessionPermission("/tmp/home") })
    expect(child.parentID).toBe("ses_parent")
    // An export from before roles existed has none: it is a root as well.
    expect(replaySessionInfo({ id: "ses_z" }, "/tmp/home").role).toBe("root")
  })
})

describe("the transcript of a case run", () => {
  test("is cleaned in its keys and in its values, at any depth", () => {
    const redact = (value: string) => value.replaceAll("SECRET", "<redacted>")
    const dirty = { "a-SECRET": ["x SECRET", { n: 1, deep: "SECRET", off: false }, null, 2] }
    expect(redactDeep(dirty, redact)).toEqual({
      "a-<redacted>": ["x <redacted>", { n: 1, deep: "<redacted>", off: false }, null, 2],
    })
  })
})

describe("eval:models --case", () => {
  const configured: ModelRef[] = [{ providerID: "bailian", modelID: "qwen3-coder", family: "qwen" }]
  const env = { GRAPHAGENT_LIVE_EVAL_CONFIG: "/somewhere/graphagent.json" }
  const parse = (...flags: string[]) => parseOptions(["--model", "bailian/qwen3-coder", ...flags], env, configured)

  test("the case file is resolved, and the scenarios are then none", () => {
    expect(parse("--case", "cases/mine.json")).toEqual({
      ok: true,
      options: {
        configFile: "/somewhere/graphagent.json",
        models: configured,
        scenarios: [],
        caseFile: path.resolve("cases/mine.json"),
      },
    })
    expect(parse("--case=/x/y.json")).toMatchObject({ ok: true, options: { caseFile: "/x/y.json" } })
    const plain = parse()
    expect(plain.ok && "caseFile" in plain.options).toBe(false)
  })

  test("it cannot be combined with --scenario, and is given once", () => {
    expect(parse("--case", "a.json", "--scenario", "read.call")).toEqual({
      ok: false,
      error: "--case and --scenario cannot be used together",
    })
    expect(parse("--case", "a.json", "--case", "b.json")).toEqual({ ok: false, error: "--case may be given once" })
    expect(parse("--case")).toEqual({ ok: false, error: "--case needs a value" })
  })

  test("a word that is a property of every object is an unknown argument, not a flag", () => {
    expect(parse("constructor")).toEqual({ ok: false, error: "unknown argument constructor" })
  })

  test("the other usage errors still apply to it", () => {
    expect(parse("--case", "a.json", "--out", path.join(REPO_ROOT, "results"))).toMatchObject({ ok: false })
    expect(parseOptions(["--case", "a.json"], env, configured)).toMatchObject({ ok: false })
  })
})

describe("a live replay of a case, played end to end", () => {
  const server = startScriptServer()
  afterAll(() => server.stop())

  /** The committed synthetic case, its history marked so that the scripted server answers for it. */
  async function marked(name: string, key: string): Promise<CaseFile> {
    const parsed = await loadCaseFile(path.join(CASES_DIR, `${name}.json`))
    if (!parsed.ok) throw new Error(parsed.error)
    const [first, ...rest] = parsed.value.session.messages
    const [part, ...parts] = first?.parts ?? []
    if (!first || !part || typeof part.text !== "string") throw new Error(`${name} has no history to mark`)
    const edited = { ...first, parts: [{ ...part, text: `${part.text}\n[case ${key}]` }, ...parts] }
    return { ...parsed.value, session: { ...parsed.value.session, messages: [edited, ...rest] } }
  }

  /** The scripted model answers the request that follows the one assistant message of the history. */
  const job = (file: CaseFile, key: string, answer: Reply): CaseJob => {
    server.register(key, [{ text: "not used: the history's own answer" }, answer])
    return {
      origin: replayOrigin(server.baseURL),
      model: { providerID: "script", modelID: "scripted", family: "qwen" },
      file,
      script: server,
      passthrough: {},
      redact: (value) => value,
      timeoutMs: 120_000,
    }
  }

  test("the session is imported, every tool call is stopped before it runs, and the judge decides on the first", async () => {
    const read = { name: "read", input: { filePath: "src/main.ts" } }
    const [right, wrongArgs, wrongTool, extra] = await Promise.all([
      attemptCase(
        job(await marked("glob-call", "live.glob"), "live.glob", {
          calls: [{ name: "glob", input: { pattern: "**/*.ts" } }],
        }),
        1,
      ),
      // The hook sees the arguments as the model gave them, before the tool would have rejected them.
      attemptCase(
        job(await marked("read-missing", "live.args"), "live.args", {
          calls: [{ name: "read", input: { path: "src/main.ts" } }],
        }),
        1,
      ),
      // Two calls in one message: the first one the model made counts, and the other is stopped as well.
      attemptCase(
        job(await marked("read-missing", "live.order"), "live.order", {
          calls: [{ name: "glob", input: { pattern: "*" } }, read],
        }),
        1,
      ),
      attemptCase(
        job(await marked("plain-answer", "live.text"), "live.text", {
          calls: [{ name: "bash", input: { command: "touch pwned", description: "x" } }],
        }),
        1,
      ),
    ])
    expect(right.result).toMatchObject({ status: "pass", failures: [], attempts: 1 })
    expect(wrongArgs.result).toMatchObject({
      status: "fail",
      failures: ['arguments: read ["filePath"] missing required field, expected string'],
    })
    expect(wrongTool.result).toMatchObject({ status: "fail", failures: ["calls: first call is glob, expected read"] })
    expect(extra.result).toMatchObject({
      status: "fail",
      failures: ["calls: expected no tool call, the model called bash"],
    })
    // No call ran: each one was stopped by the hook, and the imported history is not the run's own.
    for (const item of [right, wrongArgs, wrongTool, extra]) {
      const calls = item.result.view?.calls ?? []
      expect(calls.length).toBeGreaterThanOrEqual(1)
      for (const call of calls) expect(call.text).toContain("[Hook stopped]")
      expect(item.result.view?.reply).toBe("")
    }
    expect(wrongTool.result.view?.calls.map((call) => call.tool)).toEqual(["glob", "read"])
  }, 180_000)

  test("a first call the SDK refuses before any hook runs is still the first call the model made", async () => {
    const read = { name: "read", input: { filePath: "src/main.ts" } }
    // An unknown tool is refused with no hook run: only the read after it is audited, and it is a valid read.
    const refused = await attemptCase(
      job(await marked("read-missing", "live.refused"), "live.refused", {
        calls: [{ name: "no_such_tool", input: {} }, read],
      }),
      1,
    )
    expect(refused.result).toMatchObject({
      status: "fail",
      failures: ["calls: first call is no_such_tool, expected read"],
    })
    const calls = refused.result.view?.calls ?? []
    expect(calls.map((call) => call.tool)).toEqual(["no_such_tool", "read"])
    expect(calls[0]?.text).not.toContain("[Hook stopped]")
    expect(calls[1]?.text).toContain("[Hook stopped]")
  }, 180_000)

  /** The synthetic case as the export of a child session makes it: the parent is named, and the role when given. */
  async function childOf(key: string, role?: "task_child" | "dag_node"): Promise<CaseFile> {
    const file = await marked("glob-call", key)
    const { role: _exported, ...rest } = file.session.info
    const info = { ...rest, parentID: "ses_00000000a000SyntheticRoot1", ...(role ? { role } : {}) }
    return { ...file, session: { ...file.session, info } }
  }

  test("the session of a task or DAG child is replayed as a session of its own, and the request is admitted", async () => {
    const glob = { calls: [{ name: "glob", input: { pattern: "**/*.ts" } }] }
    const [dag, task, old] = await Promise.all([
      attemptCase(job(await childOf("live.dag", "dag_node"), "live.dag", glob), 1),
      attemptCase(job(await childOf("live.task", "task_child"), "live.task", glob), 1),
      // An export from before roles existed names the parent only.
      attemptCase(job(await childOf("live.old"), "live.old", glob), 1),
    ])
    for (const item of [dag, task, old]) expect(item.result).toMatchObject({ status: "pass", failures: [] })
  }, 180_000)

  /** What `run` returns, and the bodies of the messages this process posted to a host meanwhile: what was asked. */
  async function posting<T>(run: () => Promise<T>): Promise<{ result: T; posted: Record<string, unknown>[] }> {
    const posted: Record<string, unknown>[] = []
    const real = globalThis.fetch
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (init?.method === "POST" && /\/session\/[^/]+\/message$/.test(url) && typeof init.body === "string") {
            const body: unknown = JSON.parse(init.body)
            if (isRecord(body)) posted.push(body)
          }
          return real(input, init)
        },
        { preconnect: (target: string | URL) => real.preconnect(target) },
      ),
    )
    try {
      return { result: await run(), posted }
    } finally {
      spy.mockRestore()
    }
  }

  test("the request goes to the agent the case recorded, and one the host does not have is not swapped for another", async () => {
    const glob = { calls: [{ name: "glob", input: { pattern: "**/*.ts" } }] }
    const planned = { ...(await marked("glob-call", "live.plan")), agent: "plan" }
    const unknown = { ...(await marked("glob-call", "live.agent")), agent: "no-such-agent" }
    const plain = await marked("glob-call", "live.plain")
    const {
      result: [planRun, unknownRun, plainRun],
      posted,
    } = await posting(() =>
      Promise.all([
        attemptCase(job(planned, "live.plan", glob), 1),
        attemptCase(job(unknown, "live.agent", glob), 1),
        attemptCase(job(plain, "live.plain", glob), 1),
      ]),
    )
    expect(planRun.result).toMatchObject({ status: "pass", failures: [] })
    expect(plainRun.result).toMatchObject({ status: "pass", failures: [] })
    // The request of the case that recorded an agent carries it; the one that recorded none carries none.
    expect(posted.filter((body) => body.agent === "plan")).toHaveLength(1)
    expect(posted.filter((body) => !("agent" in body))).toHaveLength(1)
    // A host without the agent is told so in words, and the request never goes to another agent.
    expect(unknownRun.result.status).toBe("error")
    expect(unknownRun.result.failures).toEqual([
      expect.stringContaining(
        'the case was recorded for the agent "no-such-agent", which the replay host does not have',
      ),
    ])
    expect(unknownRun.result.failures[0]).toContain("plan")
    expect(posted).toHaveLength(2)
  }, 180_000)
})
