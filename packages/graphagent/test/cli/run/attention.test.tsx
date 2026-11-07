/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createTestRenderer, MockTreeSitterClient } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { RunFooter } from "@/cli/cmd/run/footer"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("mini actual keypress and visible subagent panels report attention without reporting key content", async () => {
  const app = await createTestRenderer({
    width: 100,
    height: 32,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  const keymap = createDefaultOpenTuiKeymap(app.renderer)
  const tuiConfig = createTuiResolvedConfig({ keybinds: { session_child_first: "ctrl+g", editor_open: "none" } })
  const off = registerOpencodeKeymap(keymap, app.renderer, tuiConfig)
  const activity: unknown[][] = []
  const views: boolean[] = []
  const selected: Array<string | undefined> = []
  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })
  const options = {
    directory: "/tmp",
    findFiles: async () => [],
    agents: [],
    resources: [],
    commands: [],
    sessionID: () => "ses_mini_attention",
    agentLabel: "Build",
    modelLabel: "Test",
    model: undefined,
    variant: undefined,
    first: true,
    history: [],
    theme: RUN_THEME_FALLBACK,
    keymap,
    tuiConfig,
    backgroundSubagents: true,
    diffStyle: "auto" as const,
    onPermissionReply: () => {},
    onQuestionReply: () => {},
    onQuestionReject: () => {},
    onQuestionInteract: () => {},
    onEditorOpen: async () => undefined,
    onActivity: (...args: unknown[]) => activity.push(args),
    onBackgroundView: (visible: boolean) => views.push(visible),
    onSubagentSelect: (id: string | undefined) => selected.push(id),
    treeSitterClient,
  }
  const footer = new RunFooter(app.renderer, options)
  try {
    await app.renderOnce()
    app.mockInput.pressKey("s")
    await app.renderOnce()
    expect(activity.length).toBeGreaterThan(0)
    expect(activity.every((args) => args.length === 0)).toBe(true)
    const updateChild = (background: boolean) =>
      footer.event({
        type: "stream.subagent",
        state: {
          tabs: [
            {
              sessionID: "ses_child_attention",
              partID: "prt_child_attention",
              callID: "child-call",
              label: "Reviewer",
              description: "Actual background child",
              status: "running",
              background,
              lastUpdatedAt: 1,
            },
          ],
          details: {},
          permissions: [],
          questions: [],
        },
      })
    updateChild(false)
    await app.renderOnce()
    expect(views).toEqual([])
    // Clear the typed draft using real input, then open the actual child panel.
    app.mockInput.pressKey("c", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressKey("g", { ctrl: true })
    await app.renderOnce()
    expect(views).toEqual([])
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(selected).toContain("ses_child_attention")
    expect(views).toEqual([])
    updateChild(true)
    await app.renderOnce()
    expect(views).toEqual([true])
    app.mockInput.pressEscape()
    await Bun.sleep(100)
    await app.renderOnce()
    expect(views).toEqual([true, false])
    app.mockInput.pressKey("g", { ctrl: true })
    await app.renderOnce()
    expect(views).toEqual([true, false, true])
    updateChild(false)
    await app.renderOnce()
    expect(views).toEqual([true, false, true, false])
    updateChild(true)
    await app.renderOnce()
    expect(views).toEqual([true, false, true, false, true])
    footer.close()
    expect(views).toEqual([true, false, true, false, true, false])
    const before = activity.length
    app.mockInput.pressKey("z")
    await app.renderOnce()
    expect(activity).toHaveLength(before)
  } finally {
    footer.destroy()
    off()
    app.renderer.destroy()
  }
})
