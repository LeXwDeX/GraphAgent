// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE, type UiLanguage } from "@graphagent/core/config/language"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { testRender } from "@opentui/solid"
import { ErrorComponent } from "../../src/component/error-component"
import { ExitProvider } from "../../src/context/exit"
import { setLanguage } from "../../src/i18n"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

async function renderCrash(language: UiLanguage, error: Error) {
  setLanguage(language)
  const app = await testRender(
    () => (
      <ExitProvider exit={() => {}}>
        <ErrorComponent error={error} reset={() => {}} mode="dark" />
      </ExitProvider>
    ),
    { width: 100, height: 30 },
  )
  await app.renderOnce()
  return app
}

test("the crash page names GraphAgent in English", async () => {
  const app = await renderCrash("en", new Error("boom"))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("GraphAgent crashed")
    expect(frame).toContain("An unexpected error stopped the session.")
    expect(frame).toContain("boom")
    expect(frame).toContain("Copy report")
    expect(frame).toContain("Restart")
    expect(frame).toContain("Quit")
    expect(frame).toContain("Stack trace")
    expect(frame).toContain(`GraphAgent ${InstallationVersion}`)
    expect(frame).not.toMatch(/opencode/i)
  } finally {
    app.renderer.destroy()
  }
})

test("the crash page follows the interface language", async () => {
  const app = await renderCrash("zh-CN", new Error(""))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("GraphAgent 已崩溃")
    expect(frame).toContain("意外错误中止了本次会话。")
    expect(frame).toContain("发生未知错误。")
    expect(frame).toContain("复制报告")
    expect(frame).toContain("重启")
    expect(frame).toContain("退出")
    expect(frame).toContain("堆栈")
    expect(frame).toContain(`GraphAgent ${InstallationVersion}`)
    expect(frame).not.toMatch(/opencode/i)
  } finally {
    app.renderer.destroy()
  }
})
