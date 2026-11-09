// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"
import { VALID_HOOK_EVENTS } from "@/hook"
import { BUILTIN_SKILLS } from "@/skill/builtin"

/**
 * Regression guard (hook-event-wiring D4): every event declared in the
 * HookEvent union must have at least one real trigger call site in non-test
 * source, so declaration-only events cannot ship silently.
 *
 * Textual scan: counts `event: "<name>"` occurrences under packages/graphagent/src and packages/core/src,
 * excluding the settings module itself (its payload type union and envelope builder
 * mention every event by construction).
 */

const SRC_ROOT = path.resolve(import.meta.dir, "../../src")
const HOOK_ENGINE = path.join(SRC_ROOT, "hook", "engine")
const EXCLUDED = new Set([
  // The payload type union declares every event by construction.
  path.join(SRC_ROOT, "hook", "types.ts"),
  // Engine trigger sites are checked separately below (same `event: "<name>"` shape).
  ...readdirSync(HOOK_ENGINE)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(HOOK_ENGINE, entry)),
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith(".test.ts")) return []
    if (EXCLUDED.has(full)) return []
    return [full]
  })
}

describe("hook event trigger coverage", () => {
  test("bundled hook instructions name the supported event count", () => {
    const create = readFileSync(path.join(SRC_ROOT, "command/template/create-hook.txt"), "utf8")
    const migrate = readFileSync(path.join(SRC_ROOT, "command/template/import-claude-hooks.txt"), "utf8")
    const skill = readFileSync(path.join(SRC_ROOT, "skill/builtin/configure-hooks.md"), "utf8")
    const description = BUILTIN_SKILLS.find((item) => item.name === "configure-hooks")?.description ?? ""
    expect(VALID_HOOK_EVENTS.size).toBe(31)
    expect(create).toContain("event list in `configure-hooks`")
    expect(migrate).toContain(`${VALID_HOOK_EVENTS.size} events`)
    expect(migrate).toContain("all with a local trigger")
    expect(skill).toContain(`Events (${VALID_HOOK_EVENTS.size} total)`)
    expect(description).toContain(`the ${VALID_HOOK_EVENTS.size} supported events`)
    for (const event of VALID_HOOK_EVENTS) {
      expect(create).toContain(event)
      expect(skill).toContain(event)
    }
    expect(create).toContain("Matchers are case-sensitive")
    expect(skill).toContain("Matchers are case-sensitive")
    expect(migrate).toContain("silently discarding")
  })

  const haystack = [...sourceFiles(SRC_ROOT), ...sourceFiles(path.resolve(SRC_ROOT, "../../core/src"))]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  // Engine files are excluded from the general scan; events triggered inside
  // the engine itself (e.g. ConfigChange on hot-reload) are still counted below.
  const engineSource = readdirSync(HOOK_ENGINE)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => readFileSync(path.join(HOOK_ENGINE, entry), "utf8"))
    .join("\n")

  for (const event of VALID_HOOK_EVENTS) {
    test(`event "${event}" has at least one trigger site`, () => {
      const wired = haystack.includes(`event: "${event}"`) || engineSource.includes(`event: "${event}"`)
      expect(wired).toBe(true)
    })
  }
})
