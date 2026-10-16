import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const newLayoutDesigns of [false, true]) {
  test(`retired updater stays absent with legacy configuration and events (${newLayoutDesigns ? "new" : "legacy"})`, async ({
    page,
  }) => {
    const updateRequests: string[] = []
    page.on("request", (request) => {
      if (/\/global\/upgrade|api\.github\.com.*releases|opencode\.ai\/install/.test(request.url()))
        updateRequests.push(request.url())
    })
    await mockOpenCodeServer(page, {
      directory: "C:/OpenCode/UpdaterRetirement",
      project: {
        id: "proj_updater",
        worktree: "C:/OpenCode/UpdaterRetirement",
        sandboxes: [],
        time: { created: 1, updated: 1 },
      },
      provider: { all: [], connected: [], default: {} },
      sessions: [],
      pageMessages: () => ({ items: [] }),
      events: () => [
        { directory: "global", payload: { type: "installation.update-available", properties: { version: "99.0.0" } } },
      ],
    })
    await page.route("**/global/config*", (route) => route.fulfill({ json: { autoupdate: true } }))
    await page.addInitScript((newLayout) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: newLayout } }))
    }, newLayoutDesigns)
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Settings", exact: true }).first()).toBeVisible()
    if (newLayoutDesigns) await page.getByRole("button", { name: "Settings", exact: true }).first().click()
    else await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true")
    if (!newLayoutDesigns) await expect(dialog.locator('[data-action="settings-release-notes"]')).toBeVisible()
    await expect(page.getByRole("button", { name: /check.*updates|install.*restart|update to/i })).toHaveCount(0)
    await expect(page.getByText("Update available", { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-slot="titlebar-update-loader"]')).toHaveCount(0)
    expect(updateRequests).toEqual([])
  })
}
