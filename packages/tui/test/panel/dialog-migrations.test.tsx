// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Session, TextPart, UserMessage } from "@graphagent/sdk"
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { PromptEditRequest } from "../../src/component/prompt"
import { setLanguage } from "../../src/i18n"
import { DiffSourcePanel } from "../../src/panel/diff-source"
import { ForkPanel } from "../../src/panel/fork"
import type { PanelHostApi } from "../../src/panel/host"
import { MessagePanel } from "../../src/panel/message"
import { TimelinePanel } from "../../src/panel/timeline"
import type { PromptInfo } from "../../src/prompt/history"
import { json } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel, renderPanel, type AppPanelTestContext } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const sessionID = "ses_dialog"
const messageA = "msg_alpha"
const messageB = "msg_beta"

function user(id: string, created: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created },
  }
}

function text(messageID: string, value: string): TextPart {
  return { id: `prt_${messageID}`, sessionID, messageID, type: "text", text: value }
}

function seedMessages(context: AppPanelTestContext) {
  context.sync.set("message", {
    [sessionID]: [user(messageA, 1), user(messageB, 2)],
  })
  context.sync.set("part", {
    [messageA]: [text(messageA, "alpha message")],
    [messageB]: [text(messageB, "beta message")],
  })
}

function sessionFixture(parentID?: string): Session {
  return {
    id: sessionID,
    slug: "dialog",
    projectID: "proj_test",
    directory: "/repo/session",
    title: "Dialog session",
    version: "test",
    parentID,
    time: { created: 1, updated: 2 },
  }
}

async function settle(app: { renderOnce(): Promise<unknown> }) {
  await Bun.sleep(30)
  await app.renderOnce()
}

test("timeline panel previews on move, restores on escape and jumps on select", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const previews: string[] = []
  const selected: string[] = []
  let restores = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "timeline",
          render: () => (
            <TimelinePanel
              sessionID={sessionID}
              onPreview={(messageID) => previews.push(messageID)}
              onRestore={() => (restores += 1)}
              onSelect={(messageID) => selected.push(messageID)}
            />
          ),
        }}
        onHost={(value) => (host = value)}
      />
    ),
    { width: 120, height: 40, state: tmp.path, setup: seedMessages },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("时间线")
    expect(frame).toContain("beta message")
    expect(previews).toEqual([])

    app.mockInput.pressArrow("down")
    await settle(app)
    expect(previews).toEqual([messageA])

    app.mockInput.pressKey("b")
    await settle(app)
    expect(previews.at(-1)).toBe(messageB)

    app.mockInput.pressEscape()
    await settle(app)
    expect(restores).toBe(1)
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("时间线")
    expect(selected).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("timeline panel commits the highlighted message without restoring", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const selected: string[] = []
  let restores = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "timeline",
          render: () => (
            <TimelinePanel
              sessionID={sessionID}
              onPreview={() => {}}
              onRestore={() => (restores += 1)}
              onSelect={(messageID) => selected.push(messageID)}
            />
          ),
        }}
        onHost={(value) => (host = value)}
      />
    ),
    { width: 120, height: 40, state: tmp.path, setup: seedMessages },
  )

  try {
    app.mockInput.pressEnter()
    await settle(app)
    expect(selected).toEqual([messageB])
    expect(restores).toBe(0)
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("fork panel forks the whole session from the first row", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  let forks = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "fork", render: () => <ForkPanel sessionID={sessionID} onPreview={() => {}} /> }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        seedMessages(context)
      },
      handler: (url) => {
        if (url.pathname === `/session/${sessionID}/fork`) {
          forks += 1
          return json({ id: "ses_forked" })
        }
        return undefined
      },
    },
  )

  try {
    expect(app.captureCharFrame()).toContain("分叉会话")
    expect(app.captureCharFrame()).toContain("整个会话")
    expect(app.captureCharFrame()).toContain("beta message")

    app.mockInput.pressEnter()
    await settle(app)
    expect(forks).toBe(1)
    expect(JSON.parse(JSON.stringify(ctx.route.data))).toEqual({ type: "session", sessionID: "ses_forked" })
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("fork panel forks from a selected user message and prefills its text", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  const previews: Array<string | undefined> = []
  let forks = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "fork",
          render: () => <ForkPanel sessionID={sessionID} onPreview={(messageID) => previews.push(messageID)} />,
        }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        seedMessages(context)
      },
      handler: (url) => {
        if (url.pathname === `/session/${sessionID}/fork`) {
          forks += 1
          return json({ id: "ses_forked" })
        }
        return undefined
      },
    },
  )

  try {
    app.mockInput.pressArrow("down")
    await settle(app)
    // The first move leaves the full-session row for the newest message.
    expect(previews).toEqual([messageB])

    app.mockInput.pressEnter()
    await settle(app)
    expect(forks).toBe(1)
    expect(JSON.parse(JSON.stringify(ctx.route.data))).toEqual({
      type: "session",
      sessionID: "ses_forked",
      prompt: { input: "beta message", parts: [] },
    })
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("queued message edit takes the prompt back into the composer", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const edits: PromptEditRequest[] = []
  let deletes = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "message",
          render: () => (
            <MessagePanel
              messageID={messageA}
              sessionID={sessionID}
              queued={true}
              editPrompt={(request) => edits.push(request)}
            />
          ),
        }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: seedMessages,
      handler: (url) => {
        if (url.pathname === `/session/${sessionID}/message/${messageA}/queued`) {
          deletes += 1
          return json(true)
        }
        return undefined
      },
    },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("消息操作")
    expect(frame).toContain("编辑")
    expect(frame).toContain("删除")
    expect(frame).toContain("复制")
    expect(frame).not.toContain("撤销到此")
    expect(frame).not.toContain("分叉")

    app.mockInput.pressEnter()
    await settle(app)
    expect(deletes).toBe(1)
    expect(edits).toEqual([{ label: "排队消息", value: "alpha message", parts: [] }])
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("queued message delete requires a second confirmation", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  let deletes = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "message",
          render: () => <MessagePanel messageID={messageA} sessionID={sessionID} queued={true} />,
        }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        seedMessages(context)
      },
      handler: (url) => {
        if (url.pathname === `/session/${sessionID}/message/${messageA}/queued`) {
          deletes += 1
          return json(true)
        }
        return undefined
      },
    },
  )

  try {
    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(ctx.toast.currentToast?.message).toBe("再次选择以删除")
    expect(deletes).toBe(0)
    expect(host?.depth()).toBe(1)

    app.mockInput.pressEnter()
    await settle(app)
    expect(deletes).toBe(1)
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("message actions are read-only in a subagent view", async () => {
  await using tmp = await shellState()
  const prompts: PromptInfo[] = []
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "message",
          render: () => (
            <MessagePanel messageID={messageA} sessionID={sessionID} setPrompt={(prompt) => prompts.push(prompt)} />
          ),
        }}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        seedMessages(context)
        context.sync.set("session", [sessionFixture("ses_parent")])
      },
    },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("消息操作")
    expect(frame).toContain("复制")
    expect(frame).not.toContain("编辑")
    expect(frame).not.toContain("删除")
    expect(frame).not.toContain("撤销到此")
    expect(frame).not.toContain("分叉")
    expect(prompts).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("normal message actions expose revert, copy and fork", async () => {
  await using tmp = await shellState()
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "message", render: () => <MessagePanel messageID={messageA} sessionID={sessionID} /> }}
      />
    ),
    { width: 120, height: 40, state: tmp.path, setup: seedMessages },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("撤销到此")
    expect(frame).toContain("复制")
    expect(frame).toContain("分叉")
    expect(frame).not.toContain("编辑")
    expect(frame).not.toContain("删除")
  } finally {
    app.renderer.destroy()
  }
})

test("diff source panel marks the current source and switches on select", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const selected: string[] = []
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          id: "diff-source",
          render: () => (
            <DiffSourcePanel
              current="git"
              options={[
                { mode: "git", title: "工作区", description: "查看当前 git 变更" },
                { mode: "branch", title: "主分支", description: "查看与主分支相比的变更" },
                { mode: "last-turn", title: "上一轮", description: "查看上一轮助手回复的变更" },
              ]}
              onSelect={(mode) => selected.push(mode)}
            />
          ),
        }}
        onHost={(value) => (host = value)}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("切换来源")
    expect(frame).toContain("● 工作区")
    expect(frame).toContain("主分支")
    expect(frame).toContain("上一轮")

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(selected).toEqual(["branch"])
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("切换来源")
  } finally {
    app.renderer.destroy()
  }
})
