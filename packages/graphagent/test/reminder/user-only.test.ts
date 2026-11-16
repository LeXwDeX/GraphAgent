// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * #1072: only the user creates reminders. The one creation API is
 * `ReminderClock.create`, and its only caller is the `/remind` command; the
 * model has no tool for it (`test/tool/registry.test.ts` pins the registry).
 * This guard pins the other direction: it reads the source and names every file
 * that can reach the reminder module, so wiring the clock into a tool, an
 * agent, a hook, a skill or an MCP surface fails here, not in review.
 */

const src = path.resolve(import.meta.dir, "../../src")

const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: src })]
  .map((file) => file.replaceAll(path.sep, "/"))
  .toSorted()

/** Files outside `src/reminder` that import a reminder module or name its clock service. */
const reachingFiles = files.filter(
  (file) =>
    !file.startsWith("reminder/") &&
    /from "@\/reminder\/|\bReminderClock\b|\bReminderStore\b|\bReminderTable\b/.test(
      readFileSync(path.join(src, file), "utf8"),
    ),
)

describe("reminders are created by the user only", () => {
  test("the scan sees the source tree", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain("reminder/clock.ts")
  })

  test("only wiring and the /remind command reach the reminder module outside it", () => {
    expect(reachingFiles).toEqual([
      "effect/app-runtime.ts",
      "project/bootstrap.ts",
      "server/routes/instance/httpapi/server.ts",
      "session/command.ts",
    ])
  })

  test("nothing a model drives imports the reminder module", () => {
    const modelSurfaces = ["tool/", "agent/", "mcp/", "skill/", "hook/", "plugin/", "dag/", "goal/"]
    expect(reachingFiles.filter((file) => modelSurfaces.some((prefix) => file.startsWith(prefix)))).toEqual([])
  })

  test("the clock creates reminders for the user and no one else", () => {
    const clock = readFileSync(path.join(src, "reminder/clock.ts"), "utf8")
    // The creation input has no creator field, and the row is written as the user's.
    expect(clock).toContain('creator: "user"')
    expect(clock).not.toMatch(/creator\??:\s*string/)
    const creators = files
      .filter((file) => file.startsWith("reminder/"))
      .flatMap((file) => [...readFileSync(path.join(src, file), "utf8").matchAll(/creator:\s*"([^"]+)"/g)])
      .map((match) => match[1])
    expect(new Set(creators)).toEqual(new Set(["user"]))
  })

  test("`ReminderClock.create` is called from the /remind command only", () => {
    const callers = files.filter((file) =>
      /\bclock\.create\(|ReminderClock\.Service[\s\S]*\.create\(/.test(readFileSync(path.join(src, file), "utf8")),
    )
    expect(callers).toEqual(["reminder/command.ts"])
  })
})
