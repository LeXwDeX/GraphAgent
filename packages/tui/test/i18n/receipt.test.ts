// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage, t } from "../../src/i18n"
import { parseDagModeReceipt, renderDagModeReceipt, renderUserTextPart } from "../../src/i18n/receipt"

const ctx = { key: "<leader>d" }

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

test("renders the enabled receipt with every value", () => {
  setLanguage("zh-CN")
  const text = renderDagModeReceipt({ kind: "on", values: { cap: 4, nodes: 32, budget: 200000 } }, t, ctx)
  expect(text).toContain("并发上限 4")
  expect(text).toContain("单工作流节点上限 32")
  expect(text).toContain("token 预算 200000")
  expect(text).toContain("<leader>d")
})

test("appends the no-budget and unavailable sentences", () => {
  setLanguage("zh-CN")
  const text = renderDagModeReceipt(
    { kind: "on", values: { cap: 2, nodes: 8, budget: "—", noBudget: true, unavailable: "模型不支持工具调用" } },
    t,
    ctx,
  )
  expect(text).toContain("当前未设 token 预算")
  expect(text).toContain("注意：模型不支持工具调用，主 agent 无法启动工作流")
})

test("renders off, status and budget receipts", () => {
  setLanguage("en")
  expect(renderDagModeReceipt({ kind: "off", values: { n: 2 } }, t, ctx)).toContain("2 running workflow(s)")
  const status = renderDagModeReceipt(
    { kind: "status", values: { state: "on", default: "off", running: 1, cap: 4, nodes: 32, used: 100, budget: 200 } },
    t,
    ctx,
  )
  expect(status).toContain("Mode on")
  expect(status).toContain("concurrency 1/4")
  expect(status).toContain("tokens 100/200")
  expect(renderDagModeReceipt({ kind: "budget", values: { N: 5000, k: 1 } }, t, ctx)).toContain("5000 tokens")
})

test("shows a dash for missing values", () => {
  setLanguage("en")
  expect(renderDagModeReceipt({ kind: "off" }, t, ctx)).toContain("— running workflow(s)")
})

test("renders in the language active at call time", () => {
  setLanguage("zh-CN")
  const chinese = renderDagModeReceipt({ kind: "off", values: { n: 1 } }, t, ctx)
  setLanguage("en")
  const english = renderDagModeReceipt({ kind: "off", values: { n: 1 } }, t, ctx)
  expect(chinese).not.toBe(english)
  expect(english).toContain("DAG mode is off")
})

test("parses known receipts and rejects malformed metadata", () => {
  expect(parseDagModeReceipt({ receipt: { kind: "off", values: { n: 2 } } })).toEqual({
    kind: "off",
    values: { n: 2 },
  })
  expect(parseDagModeReceipt({ receipt: { kind: "status" } })?.kind).toBe("status")
  expect(parseDagModeReceipt({ receipt: { kind: "future", values: {} } })).toBeUndefined()
  expect(parseDagModeReceipt({ receipt: { kind: "on", values: "invalid" } })).toEqual({
    kind: "on",
    values: undefined,
  })
  expect(parseDagModeReceipt({})).toBeUndefined()
  expect(parseDagModeReceipt(undefined)).toBeUndefined()
})

test("user text parts render receipts and fall back to the server text", () => {
  setLanguage("en")
  const localized = renderUserTextPart(
    { text: "server fallback", metadata: { receipt: { kind: "off", values: { n: 1 } } } },
    ctx,
  )
  expect(localized).toContain("DAG mode is off")
  expect(localized).not.toContain("server fallback")
  expect(renderUserTextPart({ text: "plain text" }, ctx)).toBe("plain text")
  expect(
    renderUserTextPart({ text: "unknown receipt", metadata: { receipt: { kind: "future", values: {} } } }, ctx),
  ).toBe("unknown receipt")
})

test("a memo re-renders a historical receipt after a language switch", () => {
  setLanguage("zh-CN")
  const part = { text: "fallback", metadata: { receipt: { kind: "off", values: { n: 1 } } } }
  createRoot((dispose) => {
    const rendered = createMemo(() => renderUserTextPart(part, ctx))
    expect(rendered()).toContain("DAG 模式已关闭")
    setLanguage("en")
    expect(rendered()).toContain("DAG mode is off")
    dispose()
  })
})
