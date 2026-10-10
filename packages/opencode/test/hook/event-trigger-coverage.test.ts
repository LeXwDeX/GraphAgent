import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"
import { VALID_HOOK_EVENTS } from "@/hook/settings"
import { ConfigureHooksDescription } from "@opencode-ai/core/plugin/skill"

/**
 * Regression guard (hook-event-wiring D4): every event declared in the
 * HookEvent union must have at least one real trigger call site in non-test
 * source, so declaration-only events cannot ship silently.
 *
 * Textual scan: counts `event: "<name>"` occurrences under packages/opencode/src,
 * excluding hook/settings.ts itself (its payload type union and envelope builder
 * mention every event by construction).
 */

const SRC_ROOT = path.resolve(import.meta.dir, "../../src")
const EXCLUDED = new Set([path.join(SRC_ROOT, "hook", "settings.ts")])

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
    const skill = readFileSync(path.resolve(SRC_ROOT, "../../core/src/plugin/skill/configure-hooks.md"), "utf8")
    expect(create).toContain(`${VALID_HOOK_EVENTS.size}-event list`)
    expect(create).toContain(`all ${VALID_HOOK_EVENTS.size} events`)
    expect(migrate).toContain(`${VALID_HOOK_EVENTS.size} events total`)
    expect(skill).toContain(`Events (${VALID_HOOK_EVENTS.size} total)`)
    expect(ConfigureHooksDescription).toContain(`the ${VALID_HOOK_EVENTS.size} supported events`)
    expect(create).toContain("Names using letters, digits or underscores — exact match (case-insensitive)")
    expect(skill).toContain("containing only letters, digits, underscores, and `|`")
    expect(migrate).toContain("Entries naming it are silently skipped")
    expect(skill).toContain("silently skipped")
  })

  const haystack = sourceFiles(SRC_ROOT)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  // settings.ts mentions every event in its payload type union and envelope
  // builder, so it is excluded from the general scan — but events triggered from
  // inside settings.ts itself (e.g. ConfigChange on hot-reload) count via the
  // stricter `trigger({ event: "..." })` call shape.
  const settingsSource = readFileSync(path.join(SRC_ROOT, "hook", "settings.ts"), "utf8")

  for (const event of VALID_HOOK_EVENTS) {
    test(`event "${event}" has at least one trigger site`, () => {
      const wired = haystack.includes(`event: "${event}"`) || settingsSource.includes(`trigger({ event: "${event}"`)
      expect(wired).toBe(true)
    })
  }
})
