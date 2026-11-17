// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@graphagent/sdk"
import { createSignal } from "solid-js"
import { PermissionPrompt } from "../../src/routes/session/permission"
import { QuestionPrompt } from "../../src/routes/session/question"
import { ChoiceAskPrompt, ConfirmAskPrompt } from "../../src/ask/local"
import type { Ticker } from "../../src/context/ticker"
import { t } from "../../src/i18n"
import { renderAppPanel } from "../panel/contexts"
import { shellState } from "../shell/contexts"
import { json, type FetchHandler } from "../fixture/tui-sdk"

const rootSessionID = "ses_root"
const childSessionID = "ses_child"

function session(id: string, parentID?: string, title = id): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory: `/repo/${id}`,
    title,
    version: "test",
    parentID,
    time: { created: 1, updated: 2 },
  }
}

function permission(sessionID: string, id = "per_000000000001"): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "bash",
    patterns: ["npm publish"],
    metadata: {},
    always: ["npm publish"],
  }
}

function question(sessionID: string, id = "que_000000000001"): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Which target?",
        header: "Target",
        options: [
          { label: "staging", description: "Deploy to staging" },
          { label: "production", description: "Deploy to production" },
        ],
      },
    ],
  }
}

function seed(context: { sync: { set(path: string, ...values: unknown[]): void } }, sessions: Session[]) {
  context.sync.set("session", sessions)
  context.sync.set("taskIndex", childSessionID, {
    parentSessionID: rootSessionID,
    parentMessageID: "msg_1",
    partID: "part_1",
    kind: "explore",
    description: "扫描破坏性变更",
  })
}

interface ReplyCall {
  path: string
  body: unknown
}

function replyHandler(calls: ReplyCall[]): FetchHandler {
  return async (url, request) => {
    if (/\/(permission|question)\/[^/]+\/(reply|reject|interact)$/.test(url.pathname)) {
      const body = request
        ? await request
            .clone()
            .json()
            .catch(() => undefined)
        : undefined
      calls.push({ path: url.pathname, body })
      return json({})
    }
    return undefined
  }
}

function fakeTicker(clock: { time: number }) {
  const [second, setSecond] = createSignal(0)
  const ticker: Ticker = {
    frame: () => 0,
    second,
    subscribe: () => () => {},
    subscribeSecond: () => () => {},
    at: () => () => {},
    now: () => clock.time,
  }
  return { ticker, setSecond }
}

async function settle(app: { renderOnce(): Promise<unknown> }) {
  await Bun.sleep(20)
  await app.renderOnce()
  await app.renderOnce()
}

describe("permission ask surface", () => {
  test("counts the queue and lets the root request enter a rejection reason", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const app = await renderAppPanel(
      () => (
        <PermissionPrompt
          request={permission(rootSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={3}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("1/3")
      expect(frame).toContain("请求权限")
      expect(frame).toContain("允许这一次")
      expect(frame).toContain("本会话内都允许")
      expect(frame).toContain("拒绝")
      expect(frame).not.toContain("转达")

      app.mockInput.pressKey("3")
      await settle(app)
      expect(app.captureCharFrame()).toContain("拒绝权限")
      expect(app.captureCharFrame()).toContain("告诉 agent 应如何调整")

      for (const key of ["c", "l", "e", "a", "n"]) app.mockInput.pressKey(key)
      await settle(app)
      app.mockInput.pressEnter()
      await settle(app)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.path).toBe("/permission/per_000000000001/reply")
      expect(calls[0]?.body).toEqual({ reply: "reject", message: "clean" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("labels a subagent request and relays the rejection to the root draft", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const prefills: string[] = []
    const app = await renderAppPanel(
      () => (
        <PermissionPrompt
          request={permission(childSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={1}
          prefill={(text) => prefills.push(text)}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID), session(childSessionID, rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("explore · 扫描破坏性变更 请求权限")
      expect(frame).toContain("拒绝，并请主 agent 转达…")
      expect(frame).not.toContain("自己输入")

      app.mockInput.pressKey("4")
      await settle(app)
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "reject" } }])
      expect(prefills).toEqual([t("ask.permission.relayPrompt", { source: "explore · 扫描破坏性变更" })])
    } finally {
      app.renderer.destroy()
    }
  })

  test("key 1 allows once and sends the reply kind in the request body", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const app = await renderAppPanel(
      () => (
        <PermissionPrompt
          request={permission(rootSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={1}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      app.mockInput.pressKey("1")
      await settle(app)
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "once" } }])
    } finally {
      app.renderer.destroy()
    }
  })

  test("key 2 allows the session and sends the reply kind in the request body", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const app = await renderAppPanel(
      () => (
        <PermissionPrompt
          request={permission(rootSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={1}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      app.mockInput.pressKey("2")
      await settle(app)
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "always" } }])
    } finally {
      app.renderer.destroy()
    }
  })

  test("enter replies for the highlighted option", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const app = await renderAppPanel(
      () => (
        <PermissionPrompt
          request={permission(rootSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={1}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      app.mockInput.pressArrow("down")
      await settle(app)
      app.mockInput.pressEnter()
      await settle(app)
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "always" } }])
    } finally {
      app.renderer.destroy()
    }
  })

  test("escape rejects without offering the reason editor or the relay draft", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const prefills: string[] = []
    const app = await renderAppPanel(
      () => (
        <PermissionPrompt
          request={permission(rootSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={2}
          total={4}
          prefill={(text) => prefills.push(text)}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      app.mockInput.pressEscape()
      await settle(app)
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "reject" } }])
      expect(prefills).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("question ask surface", () => {
  function multiQuestion(sessionID: string): QuestionRequest {
    return {
      id: "que_000000000002",
      sessionID,
      questions: [
        {
          question: "Which target?",
          header: "Target",
          options: [
            { label: "staging", description: "" },
            { label: "production", description: "" },
          ],
        },
        {
          question: "Which checks?",
          header: "Checks",
          multiple: true,
          options: [
            { label: "unit", description: "" },
            { label: "e2e", description: "" },
          ],
        },
      ],
    }
  }

  test("shows tabs, drives the timeout from ticker.second, toggles multi and submits", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const clock = { time: 1_000_000 }
    const { ticker, setSecond } = fakeTicker(clock)
    const request = multiQuestion(rootSessionID)
    request.expiresAt = clock.time + 3_000
    const app = await renderAppPanel(
      () => (
        <QuestionPrompt
          request={request}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={2}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID)]),
        handler: replyHandler(calls),
        ticker,
      },
    )
    try {
      let frame = app.captureCharFrame()
      expect(frame).toContain("1/2")
      expect(frame).toContain("Which target?")
      expect(frame).toContain("Target")
      expect(frame).toContain("Checks")
      expect(frame).toContain("3 秒后超时")

      clock.time += 1_400
      setSecond(1)
      await settle(app)
      expect(app.captureCharFrame()).toContain("2 秒后超时")

      app.mockInput.pressKey("1")
      await settle(app)
      expect(app.captureCharFrame()).toContain("Which checks?")
      expect(app.captureCharFrame()).toContain("（可多选）")

      app.mockInput.pressKey("2")
      await settle(app)
      app.mockInput.pressKey("1")
      await settle(app)
      frame = app.captureCharFrame()
      expect(frame).toContain("[✓] unit")
      expect(frame).toContain("[✓] e2e")

      app.mockInput.pressArrow("right")
      await settle(app)
      frame = app.captureCharFrame()
      expect(frame).toContain("确认答案")
      expect(frame).toContain("staging")
      expect(frame).toContain("e2e, unit")

      app.mockInput.pressEnter()
      await settle(app)
      expect(calls.map((call) => call.path)).toContain("/question/que_000000000002/reply")
    } finally {
      app.renderer.destroy()
    }
  })

  test("hides the free-text answer for a subagent question", async () => {
    await using tmp = await shellState()
    const calls: ReplyCall[] = []
    const app = await renderAppPanel(
      () => (
        <QuestionPrompt
          request={question(childSessionID)}
          currentSessionID={rootSessionID}
          rootSessionID={rootSessionID}
          position={1}
          total={1}
        />
      ),
      {
        width: 100,
        height: 40,
        state: tmp.path,
        setup: (context) => seed(context, [session(rootSessionID), session(childSessionID, rootSessionID)]),
        handler: replyHandler(calls),
      },
    )
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("explore · 扫描破坏性变更 提问")
      expect(frame).toContain("staging")
      expect(frame).not.toContain("自己输入答案")

      app.mockInput.pressEscape()
      await settle(app)
      expect(calls.map((call) => call.path)).toContain("/question/que_000000000001/reject")
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("local ask variants", () => {
  test("confirm renders fewer options and resolves a boolean", async () => {
    await using tmp = await shellState()
    const resolved: boolean[] = []
    const app = await renderAppPanel(
      () => (
        <ConfirmAskPrompt
          ask={{
            kind: "confirm",
            id: "confirm-1",
            title: "删除会话",
            body: "此操作不可撤销",
            confirmLabel: "删除",
            cancelLabel: "取消",
            danger: true,
            resolve: (ok) => resolved.push(ok),
          }}
        />
      ),
      { width: 100, height: 30, state: tmp.path },
    )
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("删除会话")
      expect(frame).toContain("此操作不可撤销")
      expect(frame).toContain("删除")
      expect(frame).toContain("取消")
      app.mockInput.pressKey("2")
      await settle(app)
      expect(resolved).toEqual([false])
    } finally {
      app.renderer.destroy()
    }
  })

  test("choice renders its options and resolves the chosen id", async () => {
    await using tmp = await shellState()
    const resolved: (string | undefined)[] = []
    const app = await renderAppPanel(
      () => (
        <ChoiceAskPrompt
          ask={{
            kind: "choice",
            id: "choice-1",
            title: "选择工作区",
            options: [
              { id: "one", label: "第一个" },
              { id: "two", label: "第二个" },
            ],
            resolve: (id) => resolved.push(id),
          }}
        />
      ),
      { width: 100, height: 30, state: tmp.path },
    )
    try {
      expect(app.captureCharFrame()).toContain("选择工作区")
      expect(app.captureCharFrame()).toContain("第二个")
      app.mockInput.pressKey("2")
      await settle(app)
      expect(resolved).toEqual(["two"])
    } finally {
      app.renderer.destroy()
    }
  })
})
