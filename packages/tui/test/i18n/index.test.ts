import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { getLanguage, initLanguage, setLanguage, t } from "../../src/i18n"
import { en } from "../../src/i18n/en"
import { zhCN } from "../../src/i18n/zh-CN"

function placeholders(template: string) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
}

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

test("both message tables contain exactly the same keys", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort())
})

test("both message tables use the same placeholders per key", () => {
  for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
    expect({ key, placeholders: placeholders(en[key]) }).toEqual({
      key,
      placeholders: placeholders(zhCN[key]),
    })
  }
})

test("no message is empty", () => {
  for (const table of [zhCN, en]) {
    for (const [key, value] of Object.entries(table)) {
      expect({ key, empty: value.trim().length === 0 }).toEqual({ key, empty: false })
    }
  }
})

test("translates with parameters", () => {
  setLanguage("zh-CN")
  expect(t("goal.turns", { used: 1, max: 5 })).toBe("1/5 轮")
  setLanguage("en")
  expect(t("goal.turns", { used: 1, max: 5 })).toBe("1/5 turns")
})

test("keeps missing placeholders visible", () => {
  setLanguage("en")
  expect(t("goal.turns", { used: 2 })).toBe("2/{max} turns")
  expect(t("dagmode.receipt.off", { n: 0 })).toBe(
    "DAG mode is off. 0 running workflow(s) will finish; after that the main agent starts workflows only when you ask.",
  )
})

test("switching the language affects later translations", () => {
  setLanguage("zh-CN")
  expect(getLanguage()).toBe("zh-CN")
  expect(t("goal.title")).toBe("目标")
  setLanguage("en")
  expect(getLanguage()).toBe("en")
  expect(t("goal.title")).toBe("Goal")
})

test("startup initialization resolves the language from the environment", () => {
  initLanguage(undefined, { LANG: "zh_CN.UTF-8" })
  expect(getLanguage()).toBe("zh-CN")
  initLanguage(undefined, { LANG: "en_US.UTF-8" })
  expect(getLanguage()).toBe("en")
  initLanguage("zh-CN", { LANG: "en_US.UTF-8" })
  expect(getLanguage()).toBe("zh-CN")
})
