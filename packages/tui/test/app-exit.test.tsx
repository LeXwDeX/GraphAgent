// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextareaRenderable, type Renderable } from "@opentui/core"
import { afterEach, expect, test } from "bun:test"
import { setLanguage } from "../src/i18n"
import { promptShown, runApp, waitFor, waitForFrame, type Setup } from "./fixture/run-app"
import { json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app: what is typed in the input box and entered quits the client when it is `exit`, `/exit` or `/quit`
// (#1666), and sends nothing. Anything else that merely starts with `exit` is a message like any other.

afterEach(() => {
  setLanguage("zh-CN")
})

const mainID = "ses_exit_main"

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

/** An unmounting prompt keeps its draft in module state; leave nothing for the next test in the process. */
function clearDrafts(setup: Setup) {
  for (const item of collect(setup.renderer.root)) {
    if (item instanceof TextareaRenderable && !item.isDestroyed) item.setText("")
  }
}

/** The server takes the writes a message or a shell command makes, so that the app has nothing to report. */
const accepting: FetchHandler = (url, request) => {
  if (request?.method !== "POST") return undefined
  if (url.pathname === `/session/${mainID}/message` || url.pathname === `/session/${mainID}/shell`) return json({})
  return undefined
}

type App = Awaited<ReturnType<typeof runApp>>

/** Waits for the app to quit by itself; a quit that never comes fails the test instead of hanging it. */
async function quits(app: App, timeout = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      app.task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the app did not quit")), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function enter(app: App, text: string) {
  await waitForFrame(app.setup, promptShown, "the prompt")
  clearDrafts(app.setup)
  await app.setup.mockInput.typeText(text)
  await app.setup.renderOnce()
  app.setup.mockInput.pressEnter()
}

const views = [
  { name: "home", sessions: [], args: {} },
  { name: "session", sessions: [sessionFixture(mainID)], args: { continue: true } },
] as const

// The two slash forms went through the command registry already; the bare word and the words with blanks around them
// are what the input box added. All of them quit the same way, and write nothing: no session is created and no
// message sent.
for (const view of views) {
  for (const word of ["exit", "/exit", "/quit", "  exit  ", " /exit", "/quit "]) {
    test(`${view.name}: entering ${JSON.stringify(word)} quits the app and writes nothing`, async () => {
      const app = await runApp({ sessions: [...view.sessions], args: view.args, handler: accepting })
      try {
        await enter(app, word)
        await quits(app)
        expect(app.setup.renderer.isDestroyed).toBe(true)
        expect(app.writes()).toEqual([])
      } finally {
        clearDrafts(app.setup)
        await app.stop()
      }
    })
  }
}

// `exit now` is a sentence to the model, not the word: it goes out as a message, and the app stays.
test("session: `exit now` is sent as a message and the app keeps running", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, handler: accepting })
  try {
    await enter(app, "exit now")
    await waitFor(() => app.writes().length > 0)
    expect(app.writes()).toHaveLength(1)
    expect(app.writes()[0]).toMatchObject({ method: "POST", path: `/session/${mainID}/message` })
    expect(JSON.stringify(app.writes()[0]?.body)).toContain("exit now")
    expect(app.setup.renderer.isDestroyed).toBe(false)
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

// In shell mode what is entered is a command for the shell, `exit` included: nothing is intercepted there.
test("session: `exit` entered in shell mode goes to the shell and the app keeps running", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, handler: accepting })
  try {
    await waitForFrame(app.setup, promptShown, "the prompt")
    clearDrafts(app.setup)
    app.setup.mockInput.pressKey("!")
    await app.setup.renderOnce()
    await app.setup.mockInput.typeText("exit")
    await app.setup.renderOnce()
    app.setup.mockInput.pressEnter()
    await waitFor(() => app.writes().length > 0)
    expect(app.writes()).toHaveLength(1)
    expect(app.writes()[0]).toMatchObject({ method: "POST", path: `/session/${mainID}/shell` })
    expect(app.writes()[0]?.body).toMatchObject({ command: "exit" })
    expect(app.setup.renderer.isDestroyed).toBe(false)
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
