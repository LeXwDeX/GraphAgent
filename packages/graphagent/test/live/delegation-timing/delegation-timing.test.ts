// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline checks of the delegation-timing evaluation (Issue #1057, plan 6): the
 * scenario catalogue, the call classification, the verdict and gate rules, the
 * stop hook, the workspace builder and the stub. They call no model; the real
 * evaluation is the script `run.ts`.
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ACCURACY_MIN,
  B_RATE_MIN,
  allPass,
  classifyCall,
  classifyShell,
  decide,
  gates,
  judge,
  rates,
  renderReport,
  type Decision,
  type RunRecord,
  withWorkspaceCheck,
} from "./classify"
import {
  applyEdits,
  buildWorkspace,
  discoverModels,
  hostConfig,
  hostEnv,
  optionsFromEnv,
  parseOriginConfig,
  referencedEnv,
  resolveFileReferences,
  selectScenarios,
  startStub,
  workspaceDigest,
} from "./harness"
import { SCENARIOS, expectationOf } from "./scenarios"

const HERE = import.meta.dir

describe("scenario catalogue", () => {
  test("has the annotated mix: 8 foreground (2 injected reviews), 6 background, 6 either", () => {
    expect(SCENARIOS).toHaveLength(20)
    expect(SCENARIOS.filter((scenario) => scenario.class === "F")).toHaveLength(8)
    expect(SCENARIOS.filter((scenario) => scenario.class === "B")).toHaveLength(6)
    expect(SCENARIOS.filter((scenario) => scenario.class === "A")).toHaveLength(6)
    const injected = SCENARIOS.filter((scenario) => scenario.review)
    expect(injected.map((scenario) => scenario.class)).toEqual(["F", "F"])
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(20)
  })

  test("annotates each class with an accepted set that matches its rule", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.accept.length).toBeGreaterThan(0)
      expect(scenario.accept.includes("error")).toBe(false)
      if (scenario.class === "F") expect(scenario.accept.includes("task_bg")).toBe(false)
      if (scenario.class === "B") expect(scenario.accept).toEqual(["task_bg"])
      if (scenario.class === "A") {
        expect(scenario.accept.includes("task_fg") && scenario.accept.includes("task_bg")).toBe(true)
        expect(scenario.accept).not.toContain("error")
      }
      expect(scenario.request === "").toBe(scenario.review !== undefined)
    }
  })

  test("every working-tree edit has its anchor in the fixture", async () => {
    for (const scenario of SCENARIOS) {
      for (const edit of scenario.uncommitted) {
        const source = await Bun.file(path.join(HERE, "fixtures", "pocketshop", `${edit.file}.txt`)).text()
        expect(source.includes(edit.find)).toBe(true)
      }
    }
  })

  test("keeps the fixture free of source files the repository would compile or run as tests", async () => {
    const files = await fs.readdir(path.join(HERE, "fixtures", "pocketshop"), { recursive: true })
    for (const file of files) {
      const full = path.join(HERE, "fixtures", "pocketshop", file)
      if ((await fs.stat(full)).isFile()) expect(file.endsWith(".txt")).toBe(true)
    }
  })
})

describe("call classification", () => {
  test("reads run, edits and tasks decide", () => {
    expect(classifyCall({ tool: "read", input: { filePath: "a.ts" } }).kind).toBe("read")
    expect(classifyCall({ tool: "grep", input: {} }).kind).toBe("read")
    expect(classifyCall({ tool: "edit", input: {} }).kind).toBe("edit")
    expect(classifyCall({ tool: "write", input: {} }).kind).toBe("edit")
    expect(classifyCall({ tool: "apply_patch", input: {} }).kind).toBe("edit")
    expect(classifyCall({ tool: "question", input: {} }).kind).toBe("ask")
    expect(classifyCall({ tool: "workflow", input: {} }).kind).toBe("other")
  })

  test("a task is background for the boolean and for the string the runtime repairs", () => {
    expect(classifyCall({ tool: "task", input: { background: true } })).toEqual({ kind: "task", background: true })
    expect(classifyCall({ tool: "task", input: { background: "true" } })).toEqual({ kind: "task", background: true })
    expect(classifyCall({ tool: "task", input: { background: false } })).toEqual({ kind: "task", background: false })
    expect(classifyCall({ tool: "task", input: {} })).toEqual({ kind: "task", background: false })
  })

  test("the review command's own task call is the harness's, not the model's", () => {
    const input = { command: "review", subagent_type: "review", background: true }
    const own = { tool: "task", input, callID: "01JABCDEFGHJKMNPQRSTVWXYZ0" }
    expect(classifyCall(own).kind).toBe("command")
    expect(decide({ calls: [own], steps: 0, stepCap: 8 }).outcome).toBe("none")
    expect(classifyCall({ tool: "task", input: { subagent_type: "review", background: true } }).kind).toBe("task")
    // A model that fills in the command field is still a model: its call id is the provider's.
    expect(classifyCall({ tool: "task", input, callID: "call_00_abc123" }).kind).toBe("task")
    expect(classifyCall({ tool: "task", input }).kind).toBe("task")
  })

  test("shell commands: read-only forms read, writes edit, the rest executes", () => {
    for (const command of [
      "ls -la",
      "git log --oneline -5 && git status --short",
      "git -C . diff HEAD~1",
      "cat package.json | head -20",
      "grep -rn login src 2>/dev/null",
      "find src -type f | sort",
      "sed -n '1,20p' README.md",
      "echo hi; git branch --show-current",
      "cd src && ls",
      'for f in src/auth/*.ts; do echo "== $f =="; cat -n "$f"; done',
      "ls src | while read f; do wc -l src/$f; done",
      "if [ -f README.md ]; then cat README.md; fi",
      "(cd src && ls) | head",
      "find src -name '*.ts' | xargs wc -l",
      "grep -rl login src | xargs -I{} head -5 {}",
      "bun --version; tsc --version && node -v",
    ]) {
      expect(classifyShell(command)).toBe("read")
    }
    for (const command of [
      "rm -rf dist",
      "echo x > notes.txt",
      "cat a >> b",
      "sed -i 's/a/b/' README.md",
      "git commit -am wip",
      "git checkout -b topic",
      "git diff --output=src/auth/login.ts",
      "git show HEAD --output src/a.ts",
      "git log -p --output-directory=out",
      "git branch topic",
      "git stash",
      "bun install",
      "mkdir -p out && ls",
      "find . -name '*.log' -delete",
      "tee out.txt",
      "for f in src/*.ts; do rm $f; done",
      "ls | xargs rm",
    ]) {
      expect(classifyShell(command)).toBe("edit")
    }
    for (const command of [
      "bun test",
      "npm run build",
      "node script.js",
      "curl https://example.com",
      "tsc --noEmit",
      "ls | xargs sh -c 'echo $0'",
    ]) {
      expect(classifyShell(command)).toBe("exec")
    }
  })

  test("command substitution is judged by what it runs", () => {
    expect(classifyShell("echo $(git rev-parse HEAD)")).toBe("read")
    expect(classifyShell("echo $(rm -rf x)")).toBe("edit")
    expect(classifyShell("echo `touch y`")).toBe("edit")
  })
})

const decision = (outcome: Decision["outcome"], extra: Partial<Decision> = {}): Decision => ({
  outcome,
  tasks: [],
  edits: 0,
  ...extra,
})

describe("decisions and verdicts", () => {
  test("the first non-read call decides; reads before it are free", () => {
    const calls = [
      { tool: "read", input: {} },
      { tool: "bash", input: { command: "git status" } },
      { tool: "task", input: { subagent_type: "review", description: "audit", background: true } },
      { tool: "edit", input: {} },
    ]
    const result = decide({ calls, steps: 3, stepCap: 8 })
    expect(result.outcome).toBe("task_bg")
    expect(result.tasks).toHaveLength(1)
    expect(result.edits).toBe(1)
  })

  test("a scenario with only reads ends as none, or as cap when it used the whole budget", () => {
    const calls = [{ tool: "read", input: {} }]
    expect(decide({ calls, steps: 2, stepCap: 8 }).outcome).toBe("none")
    expect(decide({ calls, steps: 8, stepCap: 8 }).outcome).toBe("cap")
    expect(decide({ calls, steps: 2, stepCap: 8, error: "boom" }).outcome).toBe("error")
  })

  test("foreground: any background task is a violation, even behind a foreground one", () => {
    const f = expectationOf(SCENARIOS[0])
    const bg = { subagent: "explore", background: true, description: "d", prompt: "p" }
    const fg = { ...bg, background: false }
    expect(judge(f, decision("task_fg", { tasks: [fg] }))).toEqual({ accurate: true, violation: false, hit: false })
    expect(judge(f, decision("task_fg", { tasks: [fg, bg] })).violation).toBe(true)
    expect(judge(f, decision("task_bg", { tasks: [bg] })).accurate).toBe(false)
    expect(judge(f, decision("edit")).accurate).toBe(true)
    expect(judge(f, decision("error")).accurate).toBe(false)
  })

  test("an edit after an injected review is a violation; relaying is accurate", () => {
    const review = expectationOf(SCENARIOS.find((scenario) => scenario.review)!)
    expect(judge(review, decision("none"))).toEqual({ accurate: true, violation: false, hit: false })
    expect(judge(review, decision("edit", { edits: 1 })).violation).toBe(true)
    expect(judge(review, decision("task_fg")).accurate).toBe(false)
  })

  test("background: only the first decision being a background task is a hit", () => {
    const b = expectationOf(SCENARIOS.find((scenario) => scenario.class === "B")!)
    expect(judge(b, decision("task_bg"))).toEqual({ accurate: true, violation: false, hit: true })
    expect(judge(b, decision("task_fg")).hit).toBe(false)
    expect(judge(b, decision("none")).accurate).toBe(false)
  })
})

const record = (over: Partial<RunRecord>): RunRecord => ({
  model: "p/m",
  family: "deepseek",
  round: 1,
  scenario: "s",
  class: "A",
  outcome: "task_fg",
  accurate: true,
  violation: false,
  hit: false,
  tasks: [],
  decidedBy: "-",
  steps: 1,
  durationMs: 1,
  attempts: 1,
  ...over,
})

describe("metrics, gates and report", () => {
  test("gates use the issue's thresholds", () => {
    const six = Array.from({ length: 6 }, (_, index) => record({ class: "B", hit: index < 5, accurate: index < 5 }))
    const eight = Array.from({ length: 8 }, () => record({ class: "F" }))
    const six2 = Array.from({ length: 6 }, () => record({ class: "A" }))
    const good = rates([...six, ...eight, ...six2])
    expect(good).toMatchObject({ runs: 20, fRuns: 8, fViolations: 0, bRuns: 6, bHits: 5, correct: 19 })
    expect(allPass(gates(good))).toBe(true)
    expect(B_RATE_MIN).toBeCloseTo(5 / 6)
    expect(ACCURACY_MIN).toBe(0.85)
    const violated = rates([record({ class: "F", violation: true, accurate: false }), ...six])
    expect(gates(violated).fViolations).toBe(false)
    const slow = rates(
      Array.from({ length: 6 }, (_, index) => record({ class: "B", hit: index < 4, accurate: index < 4 })),
    )
    expect(gates(slow).bRate).toBe(false)
  })

  test("the report names each family, its gates and every miss", () => {
    const records = [
      record({
        scenario: "f1",
        class: "F",
        violation: true,
        accurate: false,
        outcome: "task_fg",
        decidedBy: "task(explore, background=true) x",
      }),
      record({
        scenario: "b1",
        class: "B",
        hit: true,
        tasks: [{ subagent: "review", background: true, description: "d", prompt: "p" }],
        outcome: "task_bg",
      }),
    ]
    const report = renderReport(records, {
      rounds: 1,
      stepCap: 8,
      scenarios: [
        { id: "f1", class: "F", note: "foreground" },
        { id: "b1", class: "B", note: "background" },
      ],
    })
    expect(report).toContain("| deepseek | p/m |")
    expect(report).toContain("FAIL")
    expect(report).toContain("f1 [F] VIOLATION")
    expect(report).toContain("| b1 | B | task_bg/review (ok) |")
    expect(report).toContain("| deepseek | B | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |")
  })
})

describe("configuration discovery", () => {
  const source = `{
    // a comment
    "provider": {
      "gateway": {
        "options": { "apiKey": "{env:EVAL_KEY}", "baseURL": "{env:EVAL_URL}", },
        "models": {
          "deepseek": { "id": "deepseek", "name": "deepseek" },
          "qwen-max": { "id": "qwen-max-latest" },
          "gpt": { "id": "gpt-x", "family": "GPT" },
        },
      },
    },
  }`

  test("reads JSONC and finds only the authorised families", () => {
    const origin = parseOriginConfig(source)
    expect(discoverModels(origin).map((model) => `${model.providerID}/${model.modelID}:${model.family}`)).toEqual([
      "gateway/deepseek:deepseek",
      "gateway/qwen-max:qwen",
    ])
  })

  test("refuses a selected model outside the authorised families", () => {
    const origin = parseOriginConfig(source)
    expect(discoverModels(origin, ["gateway/qwen-max"])).toHaveLength(1)
    expect(() => discoverModels(origin, ["gateway/gpt"])).toThrow("authorised families")
    expect(() => discoverModels(origin, ["gateway/missing"])).toThrow("not a configured")
  })

  test("the host config keeps the provider block as written, stubs the review, and closes the file system", () => {
    const origin = parseOriginConfig(source)
    const model = discoverModels(origin)[0]
    const config = hostConfig({ origin, model, stubURL: "http://127.0.0.1:1/v1", stepCap: 8, home: "/tmp/h" })
    const text = JSON.stringify(config)
    expect(text).toContain("{env:EVAL_KEY}")
    expect(config.model).toBe("gateway/deepseek")
    expect(config.small_model).toBe("stub/reviewer")
    expect(config).toMatchObject({
      agent: { build: { steps: 8 }, review: { model: "stub/reviewer" } },
      permission: { "*": "allow", external_directory: { "*": "deny" } },
    })
    const env = hostEnv({ home: "/tmp/h", config, passthrough: { EVAL_KEY: "k" } })
    expect(env.HOME).toBe("/tmp/h")
    expect(env.TMPDIR).toBe("/tmp/h/tmp")
    expect(env.EVAL_KEY).toBe("k")
    // An allow-list: nothing else of the developer's environment is inherited.
    expect(
      Object.keys(env).every(
        (name) =>
          ["PATH", "SHELL", "LANG", "TMPDIR", "EVAL_KEY"].includes(name) ||
          name.startsWith("GRAPHAGENT_") ||
          name.startsWith("XDG_") ||
          ["HOME", "PWD"].includes(name),
      ),
    ).toBe(true)
  })

  test("lists the environment variables a provider block refers to", () => {
    const origin = parseOriginConfig(source)
    expect(referencedEnv(origin.providers.gateway).toSorted()).toEqual(["EVAL_KEY", "EVAL_URL"])
  })
})

describe("stop hook", () => {
  const run = async (payload: unknown) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gaeval-hook-"))
    try {
      const audit = path.join(dir, "audit.jsonl")
      const child = Bun.spawn([process.execPath, path.join(HERE, "hook.ts"), audit], {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      const lines = (await fs.readFile(audit, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
      return { out: out.trim(), code, lines }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  test("lets a read through and stops a task, an edit and a write-like command", async () => {
    const read = await run({ session_id: "s", tool_name: "read", tool_input: { filePath: "a.ts" } })
    expect(read).toMatchObject({ out: "", code: 0 })
    expect(read.lines).toHaveLength(1)
    for (const call of [
      { tool_name: "task", tool_input: { subagent_type: "review", background: true } },
      { tool_name: "edit", tool_input: { filePath: "a.ts" } },
      { tool_name: "bash", tool_input: { command: "rm -rf src" } },
    ]) {
      const stopped = await run({ session_id: "s", ...call })
      expect(JSON.parse(stopped.out)).toMatchObject({ continue: false })
    }
  })

  test("lets the review command's own task through", async () => {
    const input = { command: "review", subagent_type: "review", background: true }
    const own = await run({
      session_id: "s",
      tool_name: "task",
      tool_use_id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
      tool_input: input,
    })
    expect(own.out).toBe("")
    const imitation = await run({ session_id: "s", tool_name: "task", tool_use_id: "call_00_abc", tool_input: input })
    expect(JSON.parse(imitation.out)).toMatchObject({ continue: false })
  })
})

describe("workspace and stub", () => {
  test("builds the fixture as a history with a merged auth pull request and the scenario's uncommitted edits", async () => {
    const scenario = SCENARIOS.find((item) => item.id === "b2-review-billing-wip")!
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gaeval-ws-"))
    try {
      const dir = path.join(root, "ws")
      await buildWorkspace(dir, scenario, root)
      const git = async (...args: string[]) => {
        const child = Bun.spawn(["git", ...args], {
          cwd: dir,
          stdout: "pipe",
          env: { PATH: process.env.PATH ?? "", HOME: root },
        })
        return (await new Response(child.stdout).text()).trimEnd()
      }
      expect(await git("log", "--oneline", "--merges")).toContain("Merge pull request #42")
      expect(await git("status", "--porcelain")).toBe(" M src/billing/invoice.ts")
      expect(await git("branch", "--list")).toBe("* main")
      expect(await fs.readFile(path.join(dir, "log/auth-2026-11.log"), "utf8")).toContain("merged PR #42")
      expect(await Bun.file(path.join(dir, "scratch/experiments.txt")).exists()).toBe(true)
      const first = await workspaceDigest(dir)
      await applyEdits(dir, [{ file: "README.md", find: "# PocketShop", replace: "# Changed" }])
      expect(await workspaceDigest(dir)).not.toBe(first)
      const failure = await applyEdits(dir, [{ file: "README.md", find: "no such text", replace: "x" }]).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure instanceof Error ? failure.message : "").toContain("anchor")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("the stub answers the request that names its directory, once released", async () => {
    const stub = startStub()
    try {
      const held = stub.expect("/work/one", "FINDINGS ONE")
      const response = fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "system", content: "cwd /work/one" }] }),
      })
      await held.arrived
      let done = false
      void response.then(() => (done = true))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(done).toBe(false)
      held.release()
      expect(await (await response).text()).toContain("FINDINGS ONE")
      const other = await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ title: true }),
      })
      expect(await other.text()).toContain("No findings.")
      expect(stub.unmatched()).toBe(1)
    } finally {
      stub.stop()
    }
  })
})

describe("the workspace is the final word on edits", () => {
  const decision = { outcome: "none" as const, tasks: [], edits: 0 }
  test("a run that changed the workspace counts as an edit, whatever its calls were classified as", () => {
    expect(withWorkspaceCheck(decision, true)).toMatchObject({ outcome: "edit", edits: 1 })
    expect(withWorkspaceCheck({ ...decision, outcome: "exec" }, true).outcome).toBe("edit")
  })
  test("an unchanged workspace and a failed run keep their decision", () => {
    expect(withWorkspaceCheck(decision, false)).toBe(decision)
    const failed = { ...decision, outcome: "error" as const }
    expect(withWorkspaceCheck(failed, true)).toBe(failed)
  })
})

describe("scenario selection", () => {
  test("an unknown id is an error, not an empty and passing run", () => {
    expect(() => selectScenarios(["f1-login-fix", "no-such-scenario"])).toThrow("no-such-scenario")
  })
  test("no selection runs every scenario; a known selection runs just those", () => {
    expect(selectScenarios(undefined)).toHaveLength(20)
    expect(selectScenarios(["b1-review-merged-auth"]).map((scenario) => scenario.id)).toEqual(["b1-review-merged-auth"])
  })
})

describe("provider file references", () => {
  test("{file:} resolves next to the original config and {env:} is kept", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gaeval-ref-"))
    try {
      await fs.writeFile(path.join(dir, "key.txt"), "secret-from-file\n")
      const origin = {
        providers: { p: { options: { apiKey: "{file:./key.txt}", baseURL: "{env:SOME_BASE_URL}" } } },
      }
      const resolved = await resolveFileReferences(origin, path.join(dir, "graphagent.json"))
      expect(resolved.providers.p).toEqual({
        options: { apiKey: "secret-from-file", baseURL: "{env:SOME_BASE_URL}" },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("shell comments", () => {
  test("a comment line or trailing comment does not change a read-only command", () => {
    expect(classifyShell("# Inspect the project\nls -la")).toBe("read")
    expect(classifyShell("ls -la # list everything")).toBe("read")
  })
  test("a # inside a word or quotes is literal", () => {
    expect(classifyShell("grep -n 'a#b' README.md")).toBe("read")
    expect(classifyShell("echo a#b > notes.txt")).toBe("edit")
  })
})

describe("evaluation counts", () => {
  test("a fractional, zero or non-numeric count is rejected; unset keeps the default", () => {
    const base = { GRAPHAGENT_LIVE_EVAL_CONFIG: "/x/graphagent.json" }
    for (const bad of ["0.5", "0", "-1", "abc"]) {
      expect(() => optionsFromEnv({ ...base, GRAPHAGENT_LIVE_EVAL_ROUNDS: bad })).toThrow("positive integer")
      expect(() => optionsFromEnv({ ...base, GRAPHAGENT_LIVE_EVAL_CONCURRENCY: bad })).toThrow("positive integer")
    }
    expect(optionsFromEnv(base).rounds).toBe(3)
    expect(optionsFromEnv({ ...base, GRAPHAGENT_LIVE_EVAL_ROUNDS: "2" }).rounds).toBe(2)
  })
})

describe("host isolation", () => {
  test("system-managed configuration points at an empty task-owned directory", () => {
    const env = hostEnv({ home: "/tmp/h", config: {}, passthrough: {} })
    expect(env.GRAPHAGENT_TEST_MANAGED_CONFIG_DIR).toBe(path.join("/tmp/h", "managed"))
  })
})

describe("a read-only shell call stays in the workspace", () => {
  test("anything that reads the environment or leaves the workspace stops like an execution", () => {
    for (const command of [
      "printenv",
      "env",
      "env | grep KEY",
      "echo $HOME",
      "printf '%s' \"$GRAPHAGENT_CONFIG_CONTENT\"",
      "cat /proc/self/environ",
      "cat ~/.ssh/id_rsa",
      "ls ../",
      "grep -rn key ../../etc",
      "git -C /tmp log",
      "cd / && ls",
      "grep --file=/etc/passwd x src",
      "grep -f /etc/passwd src",
      "grep -n login /etc/passwd",
      "sed -n 1p ../secret.txt",
      "sed -n '1r /etc/passwd' README.md",
      "sed 's/a/b/w out.txt' README.md",
      "sed -n '1w /tmp/x' README.md",
      "sed -e '1e id' README.md",
      "awk '{print ENVIRON[\"HOME\"]}' README.md",
      "awk '{ while ((getline line < \"/etc/passwd\") > 0) print line }' README.md",
      "awk '{print > \"out.txt\"}' README.md",
      "rg --pre cat token src",
      `git -c 'diff.external=sh -c "touch /tmp/probe"' diff --ext-diff HEAD~1 HEAD`,
      "git -c core.pager=cat log",
      "git --config-env=core.pager=X log",
      "git -p log",
      "git diff --ext-diff HEAD~1",
      "git log -p --textconv",
      "GIT_EXTERNAL_DIFF=./x.sh git diff HEAD~1",
      "PAGER=./x git log",
    ]) {
      expect(classifyShell(command), command).toBe("exec")
    }
  })
  test("reads inside the workspace still run", () => {
    for (const command of [
      "ls -la",
      "git log --oneline -5",
      "cat src/auth/login.ts 2>/dev/null",
      "grep -rn formatDate src",
      "diff src/a.ts /dev/null",
      "grep -n '/api/login' src/api/server.ts",
      "rg -n '/auth/(login|logout)' src",
      "grep -rn -e '/api/' -e '~user' src",
      "sed -n '/^export/p' src/utils/date.ts",
      "sed -n '1,40p' src/auth/login.ts",
      "sed -n '/route/,/end/p' src/api/server.ts",
      "awk '{print $1}' src/api/routes.txt",
      "awk 'NR<=20' README.md",
    ]) {
      expect(classifyShell(command), command).toBe("read")
    }
  })
})

describe("after an injected review", () => {
  test("an execution the hook stopped is a violation, not restraint", () => {
    for (const id of ["f7-review-relay-findings", "f8-review-single-fix"]) {
      const scenario = SCENARIOS.find((entry) => entry.id === id)
      expect(scenario, id).toBeDefined()
      const exec = decide({
        calls: [
          {
            tool: "bash",
            input: { command: `python3 -c 'from pathlib import Path; Path("src/ui/Button.ts").write_text("fixed")'` },
          },
        ],
        steps: 1,
        stepCap: 8,
      })
      expect(exec.outcome).toBe("exec")
      expect(judge(expectationOf(scenario!), exec)).toMatchObject({ accurate: false, violation: true })
      const relay = decide({ calls: [], steps: 1, stepCap: 8 })
      expect(judge(expectationOf(scenario!), relay)).toMatchObject({ accurate: true, violation: false })
    }
  })
})
