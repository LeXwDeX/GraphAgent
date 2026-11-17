// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../src/i18n"
import { backgroundCard, backgroundCardTitle, resultBody } from "../../src/session/background-card"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const CHILD = "ses_child"

/** The notice the server writes for a run that ended: `renderTask` of the server, with its summary and element. */
function notice(
  state: "completed" | "error",
  summary: string,
  text: string,
  tag: "task_result" | "task_error" = state === "error" ? "task_error" : "task_result",
) {
  return [
    `<task id="${CHILD}" state="${state}">`,
    `<summary>${summary}</summary>`,
    `<${tag}>`,
    text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

type Metadata = Record<string, unknown>

function metadata(overrides: Metadata = {}): Metadata {
  return {
    backgroundResult: {
      childSessionID: CHILD,
      initiator: "agent",
      title: "Scan src",
      status: "completed",
      startedAt: 1_000,
      endedAt: 66_000,
      ...overrides,
    },
  }
}

/** A text part as the server adds it to the parent session. */
function part(text: string, extra: { synthetic?: boolean; metadata?: Metadata | undefined } = {}) {
  return {
    id: "prt_result",
    sessionID: "ses_root",
    messageID: "msg_result",
    type: "text" as const,
    synthetic: true,
    text,
    metadata: metadata(),
    ...extra,
  }
}

describe("backgroundCard: what the card says", () => {
  test("a completed run: its body is the content of the result element, the rest comes from the metadata", () => {
    const card = backgroundCard(
      part(notice("completed", "Background task completed: Scan src", "Found 3 issues\nin src/a.ts")),
    )
    expect(card).toEqual({
      childSessionID: CHILD,
      status: "completed",
      title: "Scan src",
      kind: "agent",
      elapsedMs: 65_000,
      body: "Found 3 issues\nin src/a.ts",
      firstLine: "Found 3 issues",
    })
  })

  test("a failed run: the content of the error element", () => {
    const card = backgroundCard(
      part(notice("error", "Background task failed: Scan src", "boom: connection refused"), {
        metadata: metadata({ status: "error" }),
      }),
    )
    expect(card).toMatchObject({
      status: "error",
      body: "boom: connection refused",
      firstLine: "boom: connection refused",
    })
  })

  test("an interrupted run: the error element says it left no result", () => {
    const text = `The background task was interrupted before it finished, so it left no result. If its work is still needed, continue it with task_id="${CHILD}".`
    const card = backgroundCard(
      part(notice("error", "Background task interrupted: Scan src", text), {
        metadata: metadata({ status: "interrupted" }),
      }),
    )
    expect(card).toMatchObject({ status: "interrupted", body: text, firstLine: text })
  })

  test("the instruction above a run the user started is not part of the result", () => {
    const text = [
      "The user ran /review in the background and it has finished. Present its findings to the user faithfully and concisely, grouped by severity. Do not edit files or act on the findings unless the user asks.",
      "",
      notice("completed", "Background task completed: review", "1 high\n2 low"),
    ].join("\n")
    const card = backgroundCard(part(text, { metadata: metadata({ initiator: "user", command: "review" }) }))
    expect(card?.body).toBe("1 high\n2 low")
    expect(card?.firstLine).toBe("1 high")
  })

  test("the child's kind is the one the caller passes, cleaned to a line, and `agent` when there is none", () => {
    const text = notice("completed", "s", "ok")
    expect(backgroundCard(part(text), "explore")?.kind).toBe("explore")
    expect(backgroundCard(part(text), "\u001b[31mexplore\u001b[0m\n")?.kind).toBe("explore")
    expect(backgroundCard(part(text), "")?.kind).toBe("agent")
    expect(backgroundCard(part(text), undefined)?.kind).toBe("agent")
  })

  test("the time is the span the server reported, never negative", () => {
    const text = notice("completed", "s", "ok")
    expect(backgroundCard(part(text, { metadata: metadata({ startedAt: 5_000, endedAt: 5_000 }) }))?.elapsedMs).toBe(0)
    expect(backgroundCard(part(text, { metadata: metadata({ startedAt: 9_000, endedAt: 4_000 }) }))?.elapsedMs).toBe(0)
  })

  test("the title is one clean line, and a title that is nothing once cleaned is a dash", () => {
    const text = notice("completed", "s", "ok")
    expect(
      backgroundCard(part(text, { metadata: metadata({ title: "\u001b[1mScan\u001b[0m\nsrc\u0007" }) }))?.title,
    ).toBe("Scan src")
    expect(backgroundCard(part(text, { metadata: metadata({ title: " \u0007 " }) }))?.title).toBe("—")
  })

  test("a run that left nothing has an empty body and no first line", () => {
    const card = backgroundCard(part(notice("completed", "s", "")))
    expect(card).toMatchObject({ body: "", firstLine: "" })
    expect(backgroundCard(part(notice("completed", "s", "  \n\n  ")))).toMatchObject({ body: "", firstLine: "" })
  })
})

describe("backgroundCard: the first line", () => {
  test("is the first line that has text, trimmed", () => {
    expect(backgroundCard(part(notice("completed", "s", "\n\n   first real line   \nsecond line")))?.firstLine).toBe(
      "first real line",
    )
  })

  test("is cleaned of escapes and controls, and skips a line that is nothing once cleaned", () => {
    expect(backgroundCard(part(notice("completed", "s", "\u001b[31mred\u001b[0m boom\u0007\nnext")))?.firstLine).toBe(
      "red boom",
    )
    expect(backgroundCard(part(notice("completed", "s", "\u001b[0m\n\u0007\nreal")))?.firstLine).toBe("real")
  })

  test("leaves the body whole, with its lines", () => {
    const body = "# Findings\n\n- one\n- two"
    expect(backgroundCard(part(notice("completed", "s", body)))?.body).toBe(body)
  })
})

describe("backgroundCard: only the metadata says that a part is a result", () => {
  const text = notice("completed", "Background task completed: Scan src", "ok")

  test("a part without the metadata is not one, whatever its text looks like", () => {
    expect(backgroundCard(part(text, { metadata: undefined }))).toBeUndefined()
    expect(backgroundCard(part(text, { metadata: {} }))).toBeUndefined()
    expect(backgroundCard(part(text, { metadata: { backgroundResult: "yes" } }))).toBeUndefined()
  })

  test("the follow-up a command leaves for the model is not one", () => {
    const summarize = "Summarize the task tool output above and continue with your task."
    expect(backgroundCard(part(summarize, { metadata: undefined }))).toBeUndefined()
  })

  test("a part the user wrote is not one, even with the metadata", () => {
    expect(backgroundCard(part(text, { synthetic: false }))).toBeUndefined()
    expect(backgroundCard(part(text, { synthetic: undefined }))).toBeUndefined()
  })

  test("a malformed result is not one: every field that identifies the run has to be well formed", () => {
    for (const bad of [
      { childSessionID: "" },
      { childSessionID: 7 },
      { title: "" },
      { title: undefined },
      { status: "cancelled" },
      { status: "running" },
      { status: undefined },
      { startedAt: "1000" },
      { startedAt: Number.NaN },
      { endedAt: undefined },
      { endedAt: Number.POSITIVE_INFINITY },
    ]) {
      expect({ bad, card: backgroundCard(part(text, { metadata: metadata(bad) })) }).toEqual({ bad, card: undefined })
    }
  })

  test("a malformed initiator or command is left out and the result stays", () => {
    expect(backgroundCard(part(text, { metadata: metadata({ initiator: 3, command: 4 }) }))?.status).toBe("completed")
  })
})

describe("resultBody", () => {
  test("ends at the last closing tag, so a result that mentions one keeps it", () => {
    const written = "the notice ends with </task_result> and </task>, and so does this line"
    expect(resultBody(notice("completed", "s", written))).toBe(written)
  })

  test("looks for the element after the summary, which holds a title that can say anything", () => {
    const text = notice("completed", "Background task completed: odd <task_error> title", "the body")
    expect(resultBody(text)).toBe("the body")
  })

  test("a run's text that holds the other element is still its body", () => {
    const written = "<task_error>\nnot an error\n</task_error>"
    expect(resultBody(notice("completed", "s", written))).toBe(written)
  })

  test("an element that is not closed runs to the end of the notice", () => {
    expect(resultBody('<task id="a" state="completed">\n<summary>s</summary>\n<task_result>\ncut off here')).toBe(
      "cut off here",
    )
    expect(resultBody('<task id="a" state="completed">\n<summary>s</summary>\n<task_result>\ncut off\n</task>')).toBe(
      "cut off",
    )
  })

  test("a text with neither element is shown with the wrapper taken off", () => {
    expect(resultBody("Background task ses_x finished")).toBe("Background task ses_x finished")
    expect(
      resultBody('<task id="a" state="completed">\n<summary>Background task completed: x</summary>\n</task>'),
    ).toBe("")
    expect(resultBody('<task id="a" state="completed">\nloose words\n</task>')).toBe("loose words")
  })

  test("a tag that only starts like the task element is not the wrapper", () => {
    expect(resultBody("<tasks>a list</tasks>")).toBe("<tasks>a list</tasks>")
    expect(resultBody("<task_note>kept</task_note>")).toBe("<task_note>kept</task_note>")
  })
})

describe("backgroundCardTitle", () => {
  const card = { kind: "explore", title: "Scan src", status: "completed", elapsedMs: 65_000 } as const

  test("says what ran, how it ended and how long it took, in each language", () => {
    setLanguage("en")
    expect(backgroundCardTitle(card)).toBe("background result · explore · Scan src · done · 1m 5s")
    expect(backgroundCardTitle({ ...card, status: "error" })).toBe(
      "background result · explore · Scan src · failed · 1m 5s",
    )
    expect(backgroundCardTitle({ ...card, status: "interrupted", elapsedMs: 800 })).toBe(
      "background result · explore · Scan src · interrupted · 800ms",
    )
    setLanguage("zh-CN")
    expect(backgroundCardTitle(card)).toBe("后台结果 · explore · Scan src · 完成 · 1m 5s")
    expect(backgroundCardTitle({ ...card, status: "error" })).toBe("后台结果 · explore · Scan src · 失败 · 1m 5s")
    expect(backgroundCardTitle({ ...card, status: "interrupted", elapsedMs: 800 })).toBe(
      "后台结果 · explore · Scan src · 已中断 · 800ms",
    )
  })

  test("takes the title a caller has cut to its width, so the status and the time stay", () => {
    setLanguage("en")
    expect(backgroundCardTitle(card, "Sc…")).toBe("background result · explore · Sc… · done · 1m 5s")
  })
})
