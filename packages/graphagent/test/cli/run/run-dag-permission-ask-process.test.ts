// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Subprocess integration test for `opencode run` under `dag.permission: "ask"`
// (#1324). A workflow node that wants to run a command waits for the user, and
// a non-interactive run has nobody to ask: it rejects the node's request, the
// node's turn ends, and the workflow still reaches a terminal state instead of
// hanging on a question nobody answers. That holds wherever the node runs: a
// node isolated in its own worktree asks from another directory, whose events
// the run's own event stream never carries. The tier is global-only, so it is
// handed to the child process through GRAPHAGENT_CONFIG_CONTENT.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const SKIP_PERMISSIONS = ["--dangerously-skip-permissions"]

function bodyIncludes(marker: string) {
  return (hit: { body: unknown }) => JSON.stringify(hit.body).includes(marker)
}

/** The global configuration of the child process: the test provider and the `ask` tier. */
const askConfig = (llmUrl: string) => JSON.stringify({ ...testProviderConfig(llmUrl), dag: { permission: "ask" } })

// The shell expands the arithmetic, so the output (RAN-MARK-42) differs from the command text.
const RAN_COMMAND = "printf RAN-MARK-$((20+22))"
const RAN_OUTPUT = "RAN-MARK-42"

// Worktree isolation needs a clean git target: the run's directory becomes a repository whose one
// commit holds the workflow spec, and the harness's own state directories are ignored.
const initRepository = (directory: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args], {
        cwd: directory,
        stdout: "ignore",
        stderr: "pipe",
      })
      if ((await child.exited) !== 0)
        throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`)
    }
    await Bun.write(path.join(directory, ".gitignore"), ".config/\n.local/\n.cache/\n")
    for (const [name, content] of Object.entries({ "README.md": "fixture\n", ...files }))
      await Bun.write(path.join(directory, name), content)
    await git("init", "-q")
    await git("add", "-A")
    await git("commit", "-q", "-m", "fixture")
  })

// The same command, naming the directory it ran in.
const WHERE_COMMAND = 'printf "RAN-MARK-$((20+22)) %s" "$PWD"'

// One node that runs a shell command.
const askSpec = `title: cli-ask-tier
config:
  name: cli-ask-tier
  nodes:
    - id: only
      name: only
      worker_type: general
      depends_on: []
      report_to_parent: true
      prompt_template:
        inline: "ASK-TIER-NODE marker: run the command."
`

describe("opencode run under dag.permission ask (#1324)", () => {
  cliIt.concurrent(
    "rejects the node's command request, tells the user on stderr, and the workflow still ends",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-ask-tier.yaml")
        yield* Effect.promise(() => Bun.write(spec, askSpec))
        yield* llm.tool("workflow", { params: { action: "run", operation: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("ASK-TIER-NODE"),
          reply().tool("bash", { command: RAN_COMMAND, description: "Print a line" }).item(),
        )
        yield* llm.pushMatch(bodyIncludes("[DAG Workflow"), reply().text("wake handled").stop().item())

        const result = yield* opencode.run("ASK-TIER start the single node workflow", {
          extraArgs: SKIP_PERMISSIONS,
          timeoutMs: 150_000,
          env: { GRAPHAGENT_CONFIG_CONTENT: askConfig(llm.url) },
        })

        // The process did not hang on the node's question and exited cleanly.
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("wake handled")
        // One stderr line names the tier at startup; the node's request was refused, not answered.
        const hints = result.stderr.split("\n").filter((line) => line.includes('dag.permission is "ask"'))
        expect(hints).toHaveLength(1)
        // The request reaches the run on two paths (its own event stream and the process-wide
        // bus); it is answered, and reported, once.
        expect(result.stderr.match(/permission requested/g)).toHaveLength(1)
        expect(result.stderr).toMatch(/permission requested: bash \(.*\); auto-rejecting/)
        expect(result.stderr).not.toContain("could not be answered")
        // The refused command never ran, so its output never reached a model request.
        expect(JSON.stringify(yield* llm.inputs)).not.toContain(RAN_OUTPUT)
      }),
    180_000,
  )

  cliIt.concurrent(
    "the default tier prints no hint and lets the node run its command",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-ask-default.yaml")
        yield* Effect.promise(() => Bun.write(spec, askSpec))
        yield* llm.tool("workflow", { params: { action: "run", operation: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("ASK-TIER-NODE"),
          reply().tool("bash", { command: RAN_COMMAND, description: "Print a line" }).item(),
        )
        yield* llm.pushMatch(bodyIncludes("[DAG Workflow"), reply().text("wake handled").stop().item())

        const result = yield* opencode.run("ASK-TIER start the single node workflow", {
          extraArgs: SKIP_PERMISSIONS,
          timeoutMs: 150_000,
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("wake handled")
        expect(result.stderr).not.toContain('dag.permission is "ask"')
        expect(result.stderr).not.toContain("auto-rejecting")
        // The control: here the node's command did run, and its output went back to the model.
        expect(JSON.stringify(yield* llm.inputs)).toContain(RAN_OUTPUT)
      }),
    180_000,
  )

  // A node isolated in a worktree runs, and asks, in another directory: its
  // events carry that directory, so they never reach the run's own event stream.
  const worktreeSpec = askSpec
    .replaceAll("cli-ask-tier", "cli-ask-worktree")
    .replace("      report_to_parent: true\n", "      report_to_parent: true\n      isolation: worktree\n")

  cliIt.concurrent(
    "rejects the request of a node that runs in its own worktree, and the workflow still ends",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* initRepository(home, { "wf-ask-worktree.yaml": worktreeSpec })
        const spec = path.join(home, "wf-ask-worktree.yaml")
        yield* llm.tool("workflow", { params: { action: "run", operation: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("ASK-TIER-NODE"),
          reply().tool("bash", { command: WHERE_COMMAND, description: "Print a line" }).item(),
        )
        yield* llm.pushMatch(bodyIncludes("[DAG Workflow"), reply().text("wake handled").stop().item())

        const result = yield* opencode.run("ASK-TIER start the worktree node workflow", {
          extraArgs: SKIP_PERMISSIONS,
          timeoutMs: 90_000,
          env: { GRAPHAGENT_CONFIG_CONTENT: askConfig(llm.url) },
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("wake handled")
        expect(result.stderr.match(/permission requested/g)).toHaveLength(1)
        expect(result.stderr).toMatch(/permission requested: bash \(.*\); auto-rejecting/)
        expect(result.stderr).not.toContain("could not be answered")
        expect(JSON.stringify(yield* llm.inputs)).not.toContain(RAN_OUTPUT)
      }),
    120_000,
  )

  cliIt.concurrent(
    "the control: under the default tier the same node runs its command inside its worktree",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* initRepository(home, { "wf-ask-worktree-default.yaml": worktreeSpec })
        const spec = path.join(home, "wf-ask-worktree-default.yaml")
        yield* llm.tool("workflow", { params: { action: "run", operation: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("ASK-TIER-NODE"),
          reply().tool("bash", { command: WHERE_COMMAND, description: "Print a line" }).item(),
        )
        yield* llm.pushMatch(bodyIncludes("[DAG Workflow"), reply().text("wake handled").stop().item())

        const result = yield* opencode.run("ASK-TIER start the worktree node workflow", {
          extraArgs: SKIP_PERMISSIONS,
          timeoutMs: 90_000,
        })

        opencode.expectExit(result, 0)
        expect(result.stderr).not.toContain("auto-rejecting")
        // The command ran, and it ran in a worktree, not in the run's own directory.
        expect(JSON.stringify(yield* llm.inputs)).toMatch(/RAN-MARK-42 [^"\\]*worktree/)
      }),
    120_000,
  )

  // A task agent is unattended while its root session runs in DAG mode, and it
  // asks as a session of its own below the one the run drives.
  const taskCall = {
    description: "Run the command",
    prompt: "TASK-ASK-CHILD marker: run the command.",
    subagent_type: "general",
  }

  cliIt.concurrent(
    "rejects a task agent's command request too when the session is in DAG mode, and the run ends",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("task", taskCall)
        yield* llm.pushMatch(
          bodyIncludes("TASK-ASK-CHILD"),
          reply().tool("bash", { command: RAN_COMMAND, description: "Print a line" }).item(),
        )

        const result = yield* opencode.run("ASK-TIER delegate the command", {
          extraArgs: [...SKIP_PERMISSIONS, "--dag-mode", "on"],
          timeoutMs: 150_000,
          env: { GRAPHAGENT_CONFIG_CONTENT: askConfig(llm.url) },
        })

        opencode.expectExit(result, 0)
        expect(result.stderr).toMatch(/permission requested: bash \(.*\); auto-rejecting/)
        expect(JSON.stringify(yield* llm.inputs)).not.toContain(RAN_OUTPUT)
      }),
    180_000,
  )

  cliIt.concurrent(
    "a task agent outside DAG mode is attended: the tier does not reach it",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("task", taskCall)
        yield* llm.pushMatch(
          bodyIncludes("TASK-ASK-CHILD"),
          reply().tool("bash", { command: RAN_COMMAND, description: "Print a line" }).item(),
        )

        const result = yield* opencode.run("ASK-TIER delegate the command", {
          extraArgs: [...SKIP_PERMISSIONS, "--dag-mode", "off"],
          timeoutMs: 150_000,
          env: { GRAPHAGENT_CONFIG_CONTENT: askConfig(llm.url) },
        })

        opencode.expectExit(result, 0)
        expect(result.stderr).not.toContain("auto-rejecting")
        expect(JSON.stringify(yield* llm.inputs)).toContain(RAN_OUTPUT)
      }),
    180_000,
  )
})
