import { expect, test } from "bun:test"
import { DEFAULT_LANGUAGE, resolveLanguage } from "../../src/config/language"

test("an explicit configuration wins over the environment", () => {
  expect(resolveLanguage("zh-CN", { LC_ALL: "en_US.UTF-8" }, "en-US")).toBe("zh-CN")
  expect(resolveLanguage("en", { LANG: "zh_CN.UTF-8" }, "zh-TW")).toBe("en")
})

test("environment variables are read in order", () => {
  expect(resolveLanguage(undefined, { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "en-US")).toBe("zh-CN")
  expect(resolveLanguage(undefined, { LC_MESSAGES: "en_GB.UTF-8", LANG: "zh_CN.UTF-8" }, "zh-CN")).toBe("en")
  expect(resolveLanguage(undefined, { LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh-CN")
})

test("unusable environment values fall through", () => {
  expect(resolveLanguage(undefined, { LC_ALL: "C", LC_MESSAGES: "POSIX", LANG: "" }, "en-US")).toBe("en")
  expect(resolveLanguage(undefined, { LC_ALL: "fr_FR.UTF-8", LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh-CN")
})

test("a bare LANG=C is unusable on its own and falls through to the locale", () => {
  expect(resolveLanguage(undefined, { LANG: "C" }, "zh-CN")).toBe("zh-CN")
  expect(resolveLanguage(undefined, { LANG: "C" }, "en-US")).toBe("en")
  expect(resolveLanguage(undefined, { LANG: "C" }, "fr-FR")).toBe(DEFAULT_LANGUAGE)
})

test("the runtime locale is the last hint before the default", () => {
  expect(resolveLanguage(undefined, {}, "zh-Hans-CN")).toBe("zh-CN")
  expect(resolveLanguage(undefined, {}, "en-GB")).toBe("en")
  expect(resolveLanguage(undefined, {}, "fr-FR")).toBe(DEFAULT_LANGUAGE)
  expect(resolveLanguage(undefined, {}, undefined)).toBe(DEFAULT_LANGUAGE)
})

test("unsupported configured values are ignored", () => {
  expect(resolveLanguage("fr", { LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh-CN")
  expect(resolveLanguage("zh-TW", {}, "en-US")).toBe("en")
})
