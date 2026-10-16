import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "/tmp/hooks-display-ui-fixture"
const sessionID = "ses_hook_display_ui"
const userID = "msg_hook_display_user"
const assistantID = "msg_hook_display_assistant"
const partID = "prt_hook_display_assistant"
const model = { providerID: "opencode", modelID: "fixture" }
const clock = 1700000000000

test("Hook display text survives streaming, copy and reload without exposing canonical text", async ({ page }) => {
  const part = {
    id: partID,
    sessionID,
    messageID: assistantID,
    type: "text",
    text: "SECRET canonical answer",
    displayText: "",
    time: { start: clock + 1, end: clock + 2 },
  }
  const user = {
    info: { id: userID, sessionID, role: "user", agent: "build", model, time: { created: clock } },
    parts: [{ id: "prt_hook_user", sessionID, messageID: userID, type: "text", text: "Show a safe response." }],
  }
  const assistant = {
    info: {
      id: assistantID,
      sessionID,
      parentID: userID,
      role: "assistant",
      agent: "build",
      mode: "build",
      ...model,
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: clock + 1, completed: clock + 2 },
    },
    parts: [part],
  }
  const events: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_hooks_ui",
      worktree: directory,
      vcs: "git",
      sandboxes: [],
      time: { created: clock, updated: clock },
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            fixture: { id: "fixture", name: "Fixture", limit: { context: 100000 } },
            other: { id: "other", name: "Other model", limit: { context: 100000 } },
            accepted: { id: "accepted", name: "Accepted model", limit: { context: 100000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: model,
    },
    sessions: [
      {
        id: sessionID,
        slug: "hooks-ui",
        projectID: "proj_hooks_ui",
        directory,
        title: "Hook display",
        version: "dev",
        time: { created: clock, updated: clock },
      },
    ],
    pageMessages: () => ({ items: [user, assistant] }),
    events: () => events.splice(0),
    eventRetry: 16,
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    const state = window as typeof window & { __hookClipboard?: string }
    document.execCommand = (command: string) => {
      if (command !== "copy") return false
      state.__hookClipboard = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.value : ""
      return true
    }
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expect(page.getByText("Show a safe response.", { exact: true })).toBeVisible()
  await expect(page.getByText("SECRET canonical answer", { exact: true })).toHaveCount(0)
  part.displayText = "REDACTED visible answer"
  events.push({ directory, payload: { type: "message.part.updated", properties: { part: { ...part } } } })
  const visible = page.locator(`[data-component="text-part"][data-timeline-part-id="${partID}"]`)
  await expect(visible).toContainText("REDACTED visible answer")
  await visible.hover()
  await visible.locator('[data-slot="text-part-copy-wrapper"] button').click()
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __hookClipboard?: string }).__hookClipboard))
    .toBe("REDACTED visible answer")
  await page.reload()
  await expect(visible).toContainText("REDACTED visible answer")
  await expect(page.getByText("SECRET canonical answer", { exact: true })).toHaveCount(0)
  expect(part.text).toBe("SECRET canonical answer")
  part.displayText = ""
  events.push({ directory, payload: { type: "message.part.updated", properties: { part: { ...part } } } })
  await expect(visible).toHaveCount(0)

  events.push({
    directory,
    payload: {
      type: "session.hook.status",
      properties: {
        sessionID,
        hookID: "visible-policy",
        statusMessage: "Checking model policy",
        phase: "started",
      },
    },
  })
  await expect(page.getByText("Checking model policy", { exact: true })).toBeVisible()
  events.push({
    directory,
    payload: { type: "session.hook.message", properties: { sessionID, message: "Hook warning visible to user" } },
  })
  await expect(page.getByText("Hook warning visible to user", { exact: true })).toBeVisible()
  events.push({
    directory,
    payload: {
      type: "session.hook.status",
      properties: {
        sessionID,
        hookID: "visible-policy",
        statusMessage: "Checking model policy",
        phase: "finished",
      },
    },
  })
  await expect(page.getByText("Checking model policy", { exact: true })).toHaveCount(0)
  let requested: unknown
  await page.route(`**/session/${sessionID}/model`, async (route) => {
    requested = route.request().postDataJSON()
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ _tag: "InvalidRequestError", message: "MODEL_POLICY_REFUSAL" }),
    })
  })
  await page.getByRole("button", { name: "Fixture", exact: true }).click()
  const other = page.getByText("Other model", { exact: true })
  await other.click()
  await expect(page.getByText("MODEL_POLICY_REFUSAL", { exact: true })).toBeVisible()
  await expect(other).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("button", { name: "Fixture", exact: true })).toBeVisible()
  expect(requested).toMatchObject({
    model: { providerID: "opencode", modelID: "other" },
    source: "picker",
    hookMode: "interactive",
  })

  let acceptFirst!: () => void
  const firstAccepted = new Promise<void>((resolve) => {
    acceptFirst = resolve
  })
  const switches: string[] = []
  await page.route(`**/session/${sessionID}/model`, async (route) => {
    const body: unknown = route.request().postDataJSON()
    if (
      !body ||
      typeof body !== "object" ||
      !("model" in body) ||
      !body.model ||
      typeof body.model !== "object" ||
      !("modelID" in body.model) ||
      typeof body.model.modelID !== "string"
    )
      throw new Error("Invalid model selection request")
    const selected = body.model.modelID
    switches.push(selected)
    if (selected === "accepted") {
      await firstAccepted
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "true",
      })
      return
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ _tag: "InvalidRequestError", message: "SECOND_MODEL_REFUSED" }),
    })
  })
  await page.getByRole("button", { name: "Fixture", exact: true }).click()
  await page.getByText("Accepted model", { exact: true }).click()
  await expect.poll(() => switches).toEqual(["accepted"])
  await page.getByText("Other model", { exact: true }).click()
  acceptFirst()
  await expect(page.getByText("SECOND_MODEL_REFUSED", { exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("button", { name: "Accepted model", exact: true })).toBeVisible()
  expect(switches).toEqual(["accepted", "other"])
})
