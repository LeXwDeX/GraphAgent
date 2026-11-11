// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { access, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { hookCommand } from "../../fixture/claude-hook"
import { cliIt } from "../../lib/cli-process"

describe("run --trust-project", () => {
  cliIt.live("is mutually exclusive with --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["run", "--trust-project", "--mini", "hello"])
      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--trust-project cannot be used with --mini")
    }),
  )

  cliIt.live(
    "skips pending project hooks, trusts them only for the flagged run, and leaves trust.json untouched",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const project = path.join(home, "project")
        const marker = path.join(project, "session-start.txt")
        const trustFile = path.join(home, ".local", "state", "graphagent", "trust.json")
        yield* Effect.promise(async () => {
          await mkdir(path.join(project, ".agents"), { recursive: true })
          await writeFile(
            path.join(project, ".agents", "hooks.json"),
            JSON.stringify({
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: hookCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
                    },
                  ],
                },
              ],
            }),
          )
          await mkdir(path.dirname(trustFile), { recursive: true })
          await writeFile(trustFile, JSON.stringify({ version: 1, projects: {} }), { mode: 0o600 })
          // A fixed past mtime makes a rewrite visible even when the content
          // happens to serialize identically.
          await utimes(trustFile, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"))
        })
        const before = {
          content: yield* Effect.promise(() => readFile(trustFile, "utf8")),
          mtime: yield* Effect.promise(() => stat(trustFile).then((info) => info.mtimeMs)),
        }

        // The fixture pins PWD to the temporary home; point it at the project
        // so the CLI resolves the same project layer the hooks live in.
        yield* llm.text("skipped run")
        const skipped = yield* opencode.run("hello", { cwd: project, env: { PWD: project } })
        opencode.expectExit(skipped, 0)
        expect(skipped.stderr).toContain("Skipped 1 untrusted project entry")
        expect(
          yield* Effect.promise(() =>
            access(marker)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        yield* llm.text("trusted run")
        const trusted = yield* opencode.run("hello", {
          cwd: project,
          env: { PWD: project },
          extraArgs: ["--trust-project"],
        })
        opencode.expectExit(trusted, 0)
        expect(
          yield* Effect.promise(() =>
            access(marker)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(true)

        expect(yield* Effect.promise(() => readFile(trustFile, "utf8"))).toBe(before.content)
        expect(yield* Effect.promise(() => stat(trustFile).then((info) => info.mtimeMs))).toBe(before.mtime)
      }),
    180_000,
  )
})
