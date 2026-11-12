import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import stripAnsi from "strip-ansi"
import { setLanguage } from "../../src/i18n"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MINI, LOGO_MIN_COLUMNS } from "../../src/logo"
import { cellWidth } from "../../src/ui/width"
import { sessionEpilogue } from "../../src/util/presentation"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

function lines(epilogue: string) {
  return stripAnsi(epilogue).split("\n")
}

test("formats session continuation summary with the graphagent command", () => {
  setLanguage("en")
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("graphagent -s ses_123")
  expect(epilogue).not.toMatch(/opencode/i)
  expect(lines(epilogue)).toContain("  Session   A session")
  expect(lines(epilogue)).toContain("  Continue  graphagent -s ses_123")
})

test("labels follow the interface language and stay aligned by display width", () => {
  setLanguage("zh-CN")
  const rows = lines(sessionEpilogue({ title: "排查渲染", sessionID: "ses_9" }))
  const session = rows.find((row) => row.includes("排查渲染"))!
  const resume = rows.find((row) => row.includes("graphagent -s ses_9"))!
  expect(session.startsWith("  会话")).toBe(true)
  expect(resume.startsWith("  继续")).toBe(true)
  expect(cellWidth(session.slice(0, session.indexOf("排查渲染")))).toBe(2 + 10)
  expect(cellWidth(resume.slice(0, resume.indexOf("graphagent")))).toBe(2 + 10)
})

test("a terminal that is not wide enough gets only the single-line mark", () => {
  setLanguage("en")
  for (const columns of [undefined, 40, LOGO_MIN_COLUMNS - 1]) {
    const rows = lines(sessionEpilogue({ title: "T", sessionID: "s", columns }))
    expect(rows[0]).toBe(`  ${LOGO_MINI}`)
    expect(rows.some((row) => row.includes("█"))).toBe(false)
  }
})

test("a wide terminal gets the six-row wordmark", () => {
  setLanguage("en")
  const rows = lines(sessionEpilogue({ title: "T", sessionID: "s", columns: LOGO_MIN_COLUMNS }))
  const gap = " ".repeat(LOGO_GAP)
  for (const [index, graph] of LOGO_GRAPH.entries()) {
    expect(rows[index]).toBe(`  ${graph}${gap}${LOGO_AGENT[index]}`.trimEnd())
  }
  expect(rows[LOGO_GRAPH.length]).toBe("")
  expect(rows.join("\n")).not.toContain(LOGO_MINI)
})
