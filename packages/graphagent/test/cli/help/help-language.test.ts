// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// The CLI help text follows the configured `language`, not the system locale,
// and the CLI copy exists in both message tables.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { resolveLanguage } from "@graphagent/core/config/language"
import { en } from "../../../../tui/src/i18n/en"
import { zhCN } from "../../../../tui/src/i18n/zh-CN"
import { cliIt } from "../../lib/cli-process"
import { configuredLanguage } from "../../../src/cli/language-init"

const config = (language: string) => JSON.stringify({ language })

describe("CLI help language", () => {
  cliIt.live(
    "language zh-CN prints Chinese help even under an English locale",
    ({ graphagent }) =>
      Effect.gen(function* () {
        const env = { COLUMNS: "120", LC_ALL: "en_US.UTF-8", GRAPHAGENT_CONFIG_CONTENT: config("zh-CN") }
        const root = yield* graphagent.spawn(["--help"], { env })
        expect(root.exitCode).toBe(0)
        expect(root.stderr).toContain("选项：")
        expect(root.stderr).toContain("显示帮助")
        expect(root.stderr).not.toContain("show help")

        const uninstall = yield* graphagent.spawn(["uninstall", "--help"], { env })
        expect(uninstall.exitCode).toBe(0)
        expect(uninstall.stderr).toContain("卸载 graphagent 并删除所有相关文件")
        expect(uninstall.stderr).not.toContain("uninstall graphagent and remove all related files")
      }),
    60_000,
  )

  cliIt.live(
    "language en prints English help even under a Chinese locale",
    ({ graphagent }) =>
      Effect.gen(function* () {
        const env = { COLUMNS: "120", LC_ALL: "zh_CN.UTF-8", GRAPHAGENT_CONFIG_CONTENT: config("en") }
        const root = yield* graphagent.spawn(["--help"], { env })
        expect(root.exitCode).toBe(0)
        expect(root.stderr).toContain("Options:")
        expect(root.stderr).toContain("show help")
        expect(root.stderr).not.toContain("显示帮助")

        const uninstall = yield* graphagent.spawn(["uninstall", "--help"], { env })
        expect(uninstall.exitCode).toBe(0)
        expect(uninstall.stderr).toContain("uninstall graphagent and remove all related files")
      }),
    60_000,
  )
})

describe("configuredLanguage", () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  test("reads the global config files in loader order, then GRAPHAGENT_CONFIG_CONTENT", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "graphagent-language-"))
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ language: "en" }))
    await writeFile(path.join(dir, "graphagent.jsonc"), '{\n  // comment\n  "language": "zh-CN",\n}\n')
    expect(configuredLanguage({ GRAPHAGENT_TEST_CONFIG_DIR: dir })).toBe("zh-CN")
    expect(configuredLanguage({ GRAPHAGENT_TEST_CONFIG_DIR: dir, GRAPHAGENT_CONFIG_CONTENT: config("en") })).toBe("en")
  })

  test("expands {env:} and {file:} substitutions like the config loader", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "graphagent-language-"))
    await writeFile(path.join(dir, "graphagent.json"), JSON.stringify({ language: "{env:UI_LANGUAGE}" }))
    expect(configuredLanguage({ GRAPHAGENT_TEST_CONFIG_DIR: dir, UI_LANGUAGE: "zh-CN" })).toBe("zh-CN")
    await writeFile(path.join(dir, "language.txt"), "en\n")
    await writeFile(path.join(dir, "graphagent.jsonc"), JSON.stringify({ language: "{file:language.txt}" }))
    expect(configuredLanguage({ GRAPHAGENT_TEST_CONFIG_DIR: dir, UI_LANGUAGE: "zh-CN" })).toBe("en")
  })

  test("ignores malformed files and missing keys", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "graphagent-language-"))
    await writeFile(path.join(dir, "graphagent.json"), "{ not json")
    expect(configuredLanguage({ GRAPHAGENT_TEST_CONFIG_DIR: dir })).toBeUndefined()
    expect(configuredLanguage({ GRAPHAGENT_TEST_CONFIG_DIR: dir, GRAPHAGENT_CONFIG_CONTENT: "{}" })).toBeUndefined()
  })

  test("without a configured language or a conclusive locale the CLI speaks English", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "graphagent-language-"))
    const env = { GRAPHAGENT_TEST_CONFIG_DIR: dir, LC_ALL: "C", LANG: "C" }
    expect(resolveLanguage(configuredLanguage(env), env, undefined)).toBe("en")
  })
})

describe("CLI message tables", () => {
  test("cli.* keys exist in both tables and are non-empty", () => {
    const zh = Object.keys(zhCN).filter((key) => key.startsWith("cli."))
    const english = Object.keys(en).filter((key) => key.startsWith("cli."))
    expect(zh.length).toBeGreaterThan(0)
    expect(english.sort()).toEqual(zh.sort())
    for (const key of zh) {
      expect((zhCN as Record<string, string>)[key].trim().length).toBeGreaterThan(0)
      expect((en as Record<string, string>)[key].trim().length).toBeGreaterThan(0)
    }
  })
})
