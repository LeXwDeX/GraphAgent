// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { askChoice, askConfirm } from "../../src/ask/local-ask"
import { setLanguage } from "../../src/i18n"
import { BottomZone, useBottomZone } from "../../src/shell/bottom-zone"
import { renderAppPanel } from "../panel/contexts"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

async function settle(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  await Bun.sleep(20)
  await app.renderOnce()
  await app.renderOnce()
}

async function waitFor(app: Awaited<ReturnType<typeof renderAppPanel>>, condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await Bun.sleep(20)
    await app.renderOnce()
    if (condition()) return
  }
  throw new Error(`timed out waiting for ${message}`)
}

/** Renders the ask surface of the shared zone; local requests enqueue there. */
function AskZone() {
  const zone = useBottomZone()
  return <BottomZone state={zone} composer={<></>} />
}

test("askConfirm enqueues a confirm and resolves true on enter", async () => {
  await using tmp = await shellState()
  let result: boolean | undefined

  const app = await renderAppPanel(() => <AskZone />, {
    width: 100,
    height: 30,
    state: tmp.path,
    setup: (context) => {
      void askConfirm(context.bottomZone, {
        title: "删除工作副本？",
        body: "删除 /tmp/copy-a",
        confirmLabel: "删除",
        cancelLabel: "取消",
        danger: true,
      }).then((value) => (result = value))
    },
  })

  try {
    expect(app.captureCharFrame()).toContain("删除工作副本？")
    expect(app.captureCharFrame()).toContain("删除 /tmp/copy-a")
    expect(app.captureCharFrame()).toContain("取消")

    app.mockInput.pressEnter()
    await waitFor(app, () => result !== undefined, "confirm resolution")
    expect(result).toBe(true)
    await settle(app)
    expect(app.captureCharFrame()).not.toContain("删除工作副本？")
  } finally {
    app.renderer.destroy()
  }
})

test("askConfirm resolves false on escape and removes its request", async () => {
  await using tmp = await shellState()
  let result: boolean | undefined

  const app = await renderAppPanel(() => <AskZone />, {
    width: 100,
    height: 30,
    state: tmp.path,
    setup: (context) => {
      void askConfirm(context.bottomZone, {
        title: "放弃更改？",
        confirmLabel: "放弃",
        cancelLabel: "保留",
      }).then((value) => (result = value))
    },
  })

  try {
    expect(app.captureCharFrame()).toContain("放弃更改？")

    app.mockInput.pressEscape()
    await waitFor(app, () => result !== undefined, "confirm cancellation")
    expect(result).toBe(false)
    await settle(app)
    expect(app.captureCharFrame()).not.toContain("放弃更改？")
  } finally {
    app.renderer.destroy()
  }
})

test("askChoice resolves the numbered option and clears the surface", async () => {
  await using tmp = await shellState()
  let result: string | undefined

  const app = await renderAppPanel(() => <AskZone />, {
    width: 100,
    height: 30,
    state: tmp.path,
    setup: (context) => {
      void askChoice(context.bottomZone, {
        title: "选择工作区",
        body: "请选择目标工作区",
        options: [
          { id: "one", label: "第一个" },
          { id: "two", label: "第二个" },
        ],
      }).then((value) => (result = value))
    },
  })

  try {
    expect(app.captureCharFrame()).toContain("选择工作区")
    expect(app.captureCharFrame()).toContain("第二个")

    app.mockInput.pressKey("2")
    await waitFor(app, () => result !== undefined, "choice resolution")
    expect(result).toBe("two")
    await settle(app)
    expect(app.captureCharFrame()).not.toContain("选择工作区")
  } finally {
    app.renderer.destroy()
  }
})

test("askChoice resolves undefined on escape", async () => {
  await using tmp = await shellState()
  let result: string | undefined = "pending"

  const app = await renderAppPanel(() => <AskZone />, {
    width: 100,
    height: 30,
    state: tmp.path,
    setup: (context) => {
      void askChoice(context.bottomZone, {
        title: "选择工作区",
        options: [{ id: "one", label: "第一个" }],
      }).then((value) => (result = value))
    },
  })

  try {
    expect(app.captureCharFrame()).toContain("选择工作区")

    app.mockInput.pressEscape()
    await waitFor(app, () => result !== "pending", "choice cancellation")
    expect(result).toBeUndefined()
    await settle(app)
    expect(app.captureCharFrame()).not.toContain("选择工作区")
  } finally {
    app.renderer.destroy()
  }
})
