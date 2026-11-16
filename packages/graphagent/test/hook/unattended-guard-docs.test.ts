// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readJSONFile } from "@/hook/config/load"
import { isRecord } from "@/util/record"

/**
 * #1324 P4, acceptance D (documentation): the unattended-permissions guide
 * exists in both languages, `SECURITY.md` points at it, the hook configuration
 * it shows is one the hook loader accepts, and the repository ships nothing of
 * the external guard it uses as its example, only the project link.
 */

const packageDir = path.resolve(import.meta.dir, "../..")
const repoRoot = path.resolve(packageDir, "../..")
const GUIDES = { zh: "docs/unattended-permissions.md", en: "docs/unattended-permissions.en.md" } as const

// The example guard's names are assembled here so that this file is not itself a hit of the scan below.
const GUARD_REPO = ["destructive", "command", "guard"].join("_")
const GUARD_OWNER = ["Dickles", "worthstone"].join("")
const GUARD_LINK = `https://github.com/${GUARD_OWNER}/${GUARD_REPO}`

const read = (file: string) => fs.readFile(path.join(repoRoot, file), "utf8")

/** The fenced blocks of one language tag, in order. */
const blocks = (text: string, language: string) =>
  [...text.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1])

const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe("the unattended-permissions guide", () => {
  test("is there in both languages, tracked, and SECURITY.md points at it from the No Sandbox section", async () => {
    for (const file of Object.values(GUIDES)) {
      expect((await read(file)).trim().length).toBeGreaterThan(500)
      // The public tree ignores top-level docs unless `.gitignore` names them: an ignored guide would never ship.
      expect(git("check-ignore", "-q", file).code).toBe(1)
    }
    const security = await read("SECURITY.md")
    const section = security.slice(security.indexOf("### No Sandbox"), security.indexOf("### Server Mode"))
    expect(section).toContain("docs/unattended-permissions.en.md")
    expect(section).toContain("docs/unattended-permissions.md")
  })

  for (const [language, file] of Object.entries(GUIDES))
    test(`${language}: names the tiers, the guard configuration, its limits and the layering rule`, async () => {
      const text = await read(file)
      for (const term of [
        "dag.permission",
        "readonly",
        "hooks.json",
        "~/.config/graphagent/hooks.json",
        "PreToolUse",
        "inputFormat",
        "claude-code",
        "onFailure",
        "timeout",
        "disableAllHooks",
        "#1325",
        "permission_mode",
        "dontAsk",
        "plan",
        "NodeSafetyDenied",
        "HOOK",
        "SF-6",
        "RO-1",
        "Docker",
        "allow-once",
        "dcg",
        GUARD_LINK,
      ])
        expect(text).toContain(term)
      // The guide says what the safety list and the guard are not.
      expect(text).toMatch(language === "zh" ? /不是安全边界/ : /not a security boundary/i)
      expect(text).toMatch(language === "zh" ? /不内置|不随.*分发/ : /does not (bundle|ship)|not (bundled|shipped)/i)
    })

  test("both languages show the same configuration, and the hook loader accepts it", async () => {
    const [zh, en] = await Promise.all([read(GUIDES.zh), read(GUIDES.en)])
    const shown = blocks(en, "json")
    expect(shown.length).toBeGreaterThan(0)
    expect(blocks(zh, "json")).toEqual(shown)

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "unattended-guide-"))
    try {
      let guards = 0
      for (const [index, block] of shown.entries()) {
        const parsed: unknown = JSON.parse(block)
        // The tier block is plain configuration; the other blocks are hooks.json files.
        if (isRecord(parsed) && "dag" in parsed) {
          expect(parsed).toEqual({ dag: { permission: expect.stringMatching(/^(allow|ask|readonly)$/) } })
          continue
        }
        const file = path.join(directory, `hooks-${index}.json`)
        await fs.writeFile(file, block)
        const loaded = readJSONFile(file, "global")
        expect(loaded.invalid).toBeUndefined()
        const groups = loaded.settings?.hooks?.PreToolUse ?? []
        expect(groups.length).toBeGreaterThan(0)
        // Nothing in the example is dropped as invalid: the loader keeps as many hooks as the file holds.
        const written = isRecord(parsed)
          ? Object.values(parsed)
              .flatMap((entries) => (Array.isArray(entries) ? entries : []))
              .flatMap((group) => (isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []))
          : []
        expect(written.length).toBeGreaterThan(0)
        expect(groups.flatMap((group) => group.hooks)).toHaveLength(written.length)
        for (const group of groups)
          for (const hook of group.hooks) {
            guards++
            expect(hook.type).toBe("command")
            expect(hook.inputFormat).toBe("claude-code")
            // A relative or bare name resolves against the session's PATH, which may not hold the guard.
            expect(path.isAbsolute(hook.command ?? "")).toBe(true)
          }
      }
      expect(guards).toBeGreaterThan(0)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("the repository ships nothing of the example guard: its link appears only in the guide, only as the project link", async () => {
    const inside = git("rev-parse", "--is-inside-work-tree")
    if (inside.code !== 0 || inside.out.trim() !== "true")
      throw new Error(`the scan needs a git work tree at ${repoRoot}: ${inside.err.trim()}`)

    // Whatever tracked file names the guard, by project, owner or release path.
    const hits = git("grep", "-I", "-l", "-i", "-e", GUARD_REPO, "-e", GUARD_OWNER)
    expect(hits.code === 0 || hits.code === 1).toBe(true)
    const guides: string[] = Object.values(GUIDES)
    const named = hits.out
      .split("\n")
      .filter(Boolean)
      .filter((file) => !guides.includes(file))
    expect(named).toEqual([])

    // No binary or source of it is tracked either.
    const tracked = git("ls-files").out.split("\n").filter(Boolean)
    expect(
      tracked.filter((file) => /(^|\/)dcg(\.exe)?$/i.test(file) || file.toLowerCase().includes(GUARD_REPO)),
    ).toEqual([])

    // In the guide every address that names it is the project link itself: no release asset, raw file or installer.
    for (const file of Object.values(GUIDES)) {
      const addresses = [...(await read(file)).matchAll(/https?:\/\/[^\s)>\]"'`]+/g)]
        .map((match) => match[0].replace(/[.,;:]+$/, ""))
        .filter((address) => address.toLowerCase().includes(GUARD_REPO) || address.toLowerCase().includes(GUARD_OWNER))
      expect(addresses.length).toBeGreaterThan(0)
      for (const address of addresses) expect(address).toBe(GUARD_LINK)
    }
  })
})
