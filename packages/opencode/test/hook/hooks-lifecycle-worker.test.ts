import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../fixture/fixture"
for (const { move, v2 } of [
  { move: false, v2: false },
  { move: true, v2: false },
  { move: false, v2: true },
])
  test(`real TUI worker RPC ${v2 ? "V2 " : ""}creation${move ? ", move" : ""} and shutdown own the local session lifecycle`, async () => {
    await using tmp = await tmpdir({ git: move })
    const audit = path.join(tmp.path, "audit.jsonl")
    const hook = path.join(tmp.path, "hook.ts")
    await fs.mkdir(path.join(tmp.path, ".config/opencode"), { recursive: true })
    await fs.writeFile(
      hook,
      `const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:input.hook_event_name,session:input.session_id,reason:input.reason,cwd:input.cwd})+"\\n")`,
    )
    const entry = { type: "command", command: process.execPath, args: [hook] }
    await fs.writeFile(
      path.join(tmp.path, ".config/opencode/hooks.json"),
      JSON.stringify({
        SessionStart: [{ hooks: [entry] }],
        SessionEnd: [{ hooks: [entry] }],
        CwdChanged: [{ hooks: [entry] }],
      }),
    )
    const proc = Bun.spawn(
      [process.execPath, "run", fileURLToPath(new URL("./fixtures/lifecycle-worker.ts", import.meta.url))],
      {
        cwd: tmp.path,
        env: {
          ...process.env,
          HOME: tmp.path,
          PWD: tmp.path,
          LIFECYCLE_MOVE: move ? "1" : "0",
          LIFECYCLE_V2: v2 ? "1" : "0",
          OPENCODE_TEST_HOME: tmp.path,
          OPENCODE_PURE: "1",
          OPENCODE_CONFIG_CONTENT: '{"enabled_providers":[]}',
          OPENCODE_AUTH_CONTENT: "{}",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_LOG_LEVEL: "DEBUG",
          OPENCODE_PRINT_LOGS: "1",
          XDG_DATA_HOME: path.join(tmp.path, ".local/share"),
          XDG_CONFIG_HOME: path.join(tmp.path, ".config"),
          XDG_CACHE_HOME: path.join(tmp.path, ".cache"),
          XDG_STATE_HOME: path.join(tmp.path, ".state"),
          LIFECYCLE_DIRECTORY: tmp.path,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => proc.kill(), 15000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, stdout }).toEqual({ code: 0, stdout: "" })
      expect(stderr).not.toContain("lifecycle.")
      const rows = (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.map((row) => row.event)).toEqual(
        move ? ["SessionStart", "CwdChanged", "SessionEnd"] : ["SessionStart", "SessionEnd"],
      )
      expect(rows.at(-1).session).toBe(rows[0].session)
      expect(rows.at(-1).reason).toBe("prompt_input_exit")
      expect(rows.at(-1).cwd).toBe(move ? path.join(tmp.path, "moved") : tmp.path)
    } finally {
      clearTimeout(timer)
      if (proc.exitCode === null) proc.kill()
    }
  })
