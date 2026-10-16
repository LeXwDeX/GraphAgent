import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import { SessionAttentionInput } from "@opencode-ai/schema/session-attention"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "/tmp/hooks-attention-browser"
const sessionID = "ses_attention_first"
const nextID = "ses_attention_second"

test("web typing reports activity without content and closes the prior session on navigation", async ({ page }) => {
  const updates: Array<{ sessionID: string; value: SessionAttentionInput; keys: string[] }> = []
  const sessions = [sessionID, nextID].map((id, index) => ({
    id,
    slug: id,
    projectID: "proj_attention",
    directory,
    title: `Attention ${index + 1}`,
    version: "dev",
    time: { created: index + 1, updated: index + 1 },
  }))
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "proj_attention", worktree: directory, vcs: "git", sandboxes: [], time: { created: 1, updated: 1 } },
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/session/*/attention*", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/^\/session\/([^/]+)\/attention$/)
    if (!match) return route.fallback()
    const body: unknown = route.request().postDataJSON()
    const value = Schema.decodeUnknownSync(SessionAttentionInput)(body)
    if (!body || typeof body !== "object") throw new Error("Invalid attention payload")
    updates.push({ sessionID: match[1], value, keys: Object.keys(body) })
    return route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
  await page.addInitScript(
    ({ directory, sessionIDs, dirBase64, server }) => {
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(
          sessionIDs.map((sessionId) => ({
            type: "session",
            server,
            dirBase64,
            sessionId,
          })),
        ),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory, sessionIDs: [sessionID, nextID], dirBase64: base64Encode(directory), server: "http://127.0.0.1:4096" },
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expect.poll(() => updates.some((item) => item.sessionID === sessionID)).toBe(true)
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.click()
  await editor.pressSequentially("private draft")
  await expect
    .poll(() => updates.some((item) => item.sessionID === sessionID && (item.value.activity ?? 0) > 0))
    .toBe(true)
  expect(updates.every((item) => item.value.clientType === "web" && item.value.backgroundView === false)).toBe(true)
  expect(
    updates.every((item) =>
      item.keys.every((key) => ["clientID", "clientType", "activity", "backgroundView", "closed"].includes(key)),
    ),
  ).toBe(true)
  await page.locator(`a[href$="/session/${nextID}"]`).first().click()
  await expect.poll(() => updates.some((item) => item.sessionID === nextID && !item.value.closed)).toBe(true)
  await expect.poll(() => updates.some((item) => item.sessionID === sessionID && item.value.closed)).toBe(true)
  await page.locator('[contenteditable="true"]').first().click()
  await page.keyboard.press("x")
  await expect
    .poll(() => updates.some((item) => item.sessionID === nextID && (item.value.activity ?? 0) > 0))
    .toBe(true)
})
