// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { DiffRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { Session } from "@graphagent/sdk"
import { onCleanup } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider, useRoute, type Route } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { setLanguage } from "../../../src/i18n"
import { registerGraphagentKeymap, GraphagentKeymapProvider } from "../../../src/keymap"
import { Diff } from "../../../src/routes/diff"
import { useDiffFooterHints } from "../../../src/routes/diff/footer-hints"
import { BottomZone, BottomZoneProvider, createBottomZoneState } from "../../../src/shell/bottom-zone"
import { FooterToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

beforeEach(() => {
  setLanguage("en")
})

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const sessionID = "ses_diff_route"
const sessionDirectory = "/repo/session"

const session: Session = {
  id: sessionID,
  slug: "diff-route",
  projectID: "proj_test",
  directory: sessionDirectory,
  title: "Diff route",
  version: "test",
  time: { created: 1, updated: 2 },
}

const patchOne = `--- a/src/file-one.ts
+++ b/src/file-one.ts
@@ -1,3 +1,4 @@
 const first = true
-const oldFirst = true
+const newFirst = true
+const addedFirst = true
 const afterFirst = true`

const diffFiles = [
  {
    file: "src/file-one.ts",
    additions: 2,
    deletions: 1,
    status: "modified" as const,
    patch: patchOne,
  },
  {
    file: "z-small.ts",
    additions: 1,
    deletions: 0,
    status: "added" as const,
    patch: "--- /dev/null\n+++ b/z-small.ts\n@@ -0,0 +1 @@\n+small final",
  },
]

type Harness = Awaited<ReturnType<typeof renderDiff>>

async function renderDiff(
  input: { initialRoute?: Route; config?: Record<string, unknown>; diff?: unknown[]; height?: number } = {},
) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const vcsDiffRequests: URL[] = []
  const vcsDiffHeaders: Headers[] = []
  const sessionDiffRequests: URL[] = []
  const base = createFetch((url) => {
    if (url.pathname === "/config") return json(input.config ?? { language: "en" })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/vcs") return json({ branch: "feature", default_branch: "main" })
    return undefined
  }, events)
  const fetch = (async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.pathname === "/vcs/diff") {
      vcsDiffRequests.push(url)
      vcsDiffHeaders.push(request instanceof Request ? request.headers : new Headers())
      return json(input.diff ?? diffFiles)
    }
    if (url.pathname === `/session/${sessionID}/diff`) {
      sessionDiffRequests.push(url)
      return json([])
    }
    return base.fetch(request)
  }) as typeof globalThis.fetch

  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>
  let route!: ReturnType<typeof useRoute>
  let kv!: ReturnType<typeof useKV>
  let theme!: ReturnType<typeof useTheme>
  let sync!: ReturnType<typeof useSync>
  let footerHints!: ReturnType<typeof useDiffFooterHints>
  const initialRoute: Route = input.initialRoute ?? {
    type: "diff",
    params: { mode: "git", sessionID },
    returnRoute: { type: "session", sessionID },
  }

  function Probe() {
    route = useRoute()
    kv = useKV()
    theme = useTheme()
    sync = useSync()
    footerHints = useDiffFooterHints()
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const bottomZone = createBottomZoneState()
    onCleanup(registerGraphagentKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={directory} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
          <ClipboardProvider>
            <GraphagentKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <FooterToastProvider>
                    <RouteProvider initialRoute={initialRoute}>
                      <TuiConfigProvider config={config}>
                        <SDKProvider url="http://test" directory={directory} events={events.source} fetch={fetch}>
                          <ProjectProvider>
                            <SyncProvider>
                              <ThemeProvider mode="dark">
                                <BottomZoneProvider state={bottomZone}>
                                  <Probe />
                                  <Diff />
                                  <BottomZone state={bottomZone} composer={<></>} />
                                </BottomZoneProvider>
                              </ThemeProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </SDKProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </FooterToastProvider>
                </KVProvider>
              </ArgsProvider>
            </GraphagentKeymapProvider>
          </ClipboardProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: input.height ?? 28 })
  for (let attempt = 0; attempt < 100 && !hasCommand(keymap, "diff.close"); attempt++) {
    await app.renderOnce()
    await Bun.sleep(10)
  }
  return {
    app,
    keymap,
    route: () => JSON.parse(JSON.stringify(route.data)) as Route,
    kv: () => kv,
    theme: () => theme.theme,
    sync: () => sync,
    footerHints: () => footerHints(),
    vcsDiffRequests,
    vcsDiffHeaders,
    sessionDiffRequests,
    tmp,
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function waitForFrame(app: Harness["app"], text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}:\n${app.captureCharFrame()}`)
}

async function waitFor(app: Harness["app"], predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await app.renderOnce()
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition")
}

function runCommand(harness: Harness, command: string) {
  const result = harness.keymap.runCommand(command)
  expect(result.ok).toBe(true)
}

function hasCommand(keymap: Harness["keymap"], command: string) {
  return keymap.getCommands({ visibility: "registered" }).some((entry) => entry.name === command)
}

test("renders the diff title, file tree and patch body", async () => {
  const harness = await renderDiff()
  try {
    const frame = await waitForFrame(harness.app, "newFirst")
    expect(frame).toContain("Diff")
    expect(frame).toContain("working tree")
    expect(frame).toContain("2 files")
    expect(frame).toContain("file-one.ts")
    expect(frame).toContain("z-small.ts")
    expect(frame).toContain("small final")
    await waitFor(harness.app, () =>
      harness.vcsDiffHeaders.some(
        (headers) => decodeURIComponent(headers.get("x-graphagent-directory") ?? "") === sessionDirectory,
      ),
    )
    const index = harness.vcsDiffHeaders.findIndex(
      (headers) => decodeURIComponent(headers.get("x-graphagent-directory") ?? "") === sessionDirectory,
    )
    const request = harness.vcsDiffRequests[index]!
    expect(request.searchParams.get("directory")).toBeNull()
    expect(request.searchParams.get("mode")).toBe("git")
    expect(request.searchParams.get("context")).toBe("12")
  } finally {
    await harness.dispose()
  }
})

test("renders diff chrome in the configured language", async () => {
  setLanguage("zh-CN")
  const harness = await renderDiff({ config: { language: "zh-CN" } })
  try {
    const frame = await waitForFrame(harness.app, "newFirst")
    expect(frame).toContain("差异")
    expect(frame).toContain("工作区")
    expect(frame).toContain("2 个文件")
    const labels = harness.footerHints().map((hint) => hint.label)
    expect(labels).toContain("聚焦文件树")
    expect(labels).toContain("全部")
    runCommand(harness, "diff.help")
    const help = await waitForFrame(harness.app, "差异快捷键")
    expect(help).toContain("关闭查看器")
  } finally {
    await harness.dispose()
  }
})

test("switch focus highlights the first file row in the tree", async () => {
  const harness = await renderDiff()
  try {
    await waitForFrame(harness.app, "newFirst")
    const primary = harness.theme().primary
    expect(hasBackground(harness, "file-one.ts", primary)).toBe(false)
    runCommand(harness, "diff.switch_focus")
    await harness.app.renderOnce()
    await harness.app.flush()
    await waitFor(harness.app, () => hasBackground(harness, "file-one.ts", primary))
  } finally {
    await harness.dispose()
  }
})

test("next file moves the reviewed marker between files", async () => {
  const harness = await renderDiff()
  try {
    await waitForFrame(harness.app, "newFirst")
    runCommand(harness, "diff.next_file")
    await harness.app.renderOnce()
    runCommand(harness, "diff.mark_reviewed")
    const first = await waitForFrame(harness.app, "✓")
    expect(first.match(/✓/g)).toHaveLength(1)
    runCommand(harness, "diff.next_file")
    await harness.app.renderOnce()
    runCommand(harness, "diff.mark_reviewed")
    await waitFor(harness.app, () => (harness.app.captureCharFrame().match(/✓/g) ?? []).length === 2)
  } finally {
    await harness.dispose()
  }
})

test("toggle file tree writes the kv preference", async () => {
  const harness = await renderDiff()
  try {
    await waitForFrame(harness.app, "newFirst")
    expect(harness.kv().get("diff_viewer_show_file_tree")).toBeUndefined()
    runCommand(harness, "diff.toggle_file_tree")
    await waitFor(harness.app, () => harness.kv().get("diff_viewer_show_file_tree") === false)
    await waitFor(harness.app, async () => {
      const stored = JSON.parse(await Bun.file(`${harness.tmp.path}/kv.json`).text()) as Record<string, unknown>
      return stored.diff_viewer_show_file_tree === false
    })
  } finally {
    await harness.dispose()
  }
})

test("close returns to the recorded return route", async () => {
  const harness = await renderDiff()
  try {
    await waitForFrame(harness.app, "newFirst")
    expect(harness.route()).toEqual({
      type: "diff",
      params: { mode: "git", sessionID },
      returnRoute: { type: "session", sessionID },
    })
    runCommand(harness, "diff.close")
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({ type: "session", sessionID })
  } finally {
    await harness.dispose()
  }
})

test("switch source reopens the diff and keeps the original return route", async () => {
  const harness = await renderDiff()
  try {
    await waitForFrame(harness.app, "newFirst")
    await waitFor(harness.app, () => Boolean(harness.sync().data.vcs?.branch === "feature"))
    runCommand(harness, "diff.switch_source")
    await waitForFrame(harness.app, "Switch source")
    // The source panel starts on the current source ("git"), so one move lands
    // on the branch option.
    await Bun.sleep(30)
    await harness.app.renderOnce()
    runCommand(harness, "panel.next")
    await harness.app.renderOnce()
    runCommand(harness, "panel.submit")
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({
      type: "diff",
      params: { mode: "branch", sessionID },
      returnRoute: { type: "session", sessionID },
    })
    await waitFor(harness.app, () =>
      harness.vcsDiffRequests.some((url, index) => {
        const headers = harness.vcsDiffHeaders[index]!
        return (
          url.searchParams.get("mode") === "branch" &&
          decodeURIComponent(headers.get("x-graphagent-directory") ?? "") === sessionDirectory
        )
      }),
    )
  } finally {
    await harness.dispose()
  }
})

test("last-turn source requests the session diff", async () => {
  const messageID = "msg_diff"
  const harness = await renderDiff({
    initialRoute: {
      type: "diff",
      params: { mode: "last-turn", sessionID, messageID },
      returnRoute: { type: "session", sessionID },
    },
  })
  try {
    await waitFor(harness.app, () => harness.sessionDiffRequests.length > 0)
    const request = harness.sessionDiffRequests[0]!
    expect(request.pathname).toBe(`/session/${sessionID}/diff`)
    expect(request.searchParams.get("messageID")).toBe(messageID)
    expect(harness.vcsDiffRequests).toHaveLength(0)
  } finally {
    await harness.dispose()
  }
})

function buildHunk(start: number, name: string) {
  return [
    `@@ -${start},21 +${start},21 @@`,
    ...Array.from({ length: 10 }, (_, i) => ` const ${name}Before${i} = true`),
    `-const old${name} = true`,
    `+const new${name} = true`,
    ...Array.from({ length: 10 }, (_, i) => ` const ${name}After${i} = true`),
  ].join("\n")
}

const hunkPatch = `--- a/src/file.ts
+++ b/src/file.ts
${buildHunk(1, "first")}
${buildHunk(100, "second")}
${buildHunk(200, "third")}`

test("brackets navigate diff hunks", async () => {
  const harness = await renderDiff({
    height: 20,
    diff: [{ file: "src/file.ts", additions: 3, deletions: 3, status: "modified" as const, patch: hunkPatch }],
  })
  try {
    await waitForFrame(harness.app, "firstBefore0")
    await waitFor(harness.app, () => Boolean(findScrollBox(harness.app.renderer.root)))
    const scroll = findScrollBox(harness.app.renderer.root)!
    const initial = scroll.scrollTop

    runCommand(harness, "diff.next_hunk")
    await harness.app.renderOnce()
    const first = scroll.scrollTop
    expect(first).toBeGreaterThan(initial)

    runCommand(harness, "diff.next_hunk")
    await harness.app.renderOnce()
    const second = scroll.scrollTop
    expect(second).toBeGreaterThan(first)

    runCommand(harness, "diff.previous_hunk")
    await harness.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)

    runCommand(harness, "diff.next_hunk")
    await harness.app.renderOnce()
    expect(scroll.scrollTop).toBe(second)

    scroll.scrollTo(initial)
    runCommand(harness, "diff.next_hunk")
    await harness.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)
  } finally {
    await harness.dispose()
  }
})

test("large diff keeps file and hunk navigation across resize", async () => {
  const harness = await renderDiff({
    height: 20,
    diff: [
      {
        file: "a-large.ts",
        additions: 3000,
        deletions: 0,
        status: "added" as const,
        patch: `--- /dev/null\n+++ b/a-large.ts\n@@ -0,0 +1,3000 @@\n${Array.from({ length: 3000 }, (_, i) => `+large${i + 1}`).join("\n")}`,
      },
      {
        file: "z-small.ts",
        additions: 1,
        deletions: 1,
        status: "modified" as const,
        patch: "--- a/z-small.ts\n+++ b/z-small.ts\n@@ -1 +1 @@\n-old\n+small final",
      },
    ],
  })
  try {
    await waitForFrame(harness.app, "large1")
    const scroll = findScrollBox(harness.app.renderer.root)!
    scroll.scrollTo(1_000_000)
    await waitForFrame(harness.app, "small final")
    runCommand(harness, "diff.previous_file")
    await waitForFrame(harness.app, "large1")
    runCommand(harness, "diff.mark_reviewed")
    await harness.app.renderOnce()
    runCommand(harness, "diff.toggle_view")
    harness.app.resize(160, 20)
    await waitForFrame(harness.app, "large1")
    runCommand(harness, "diff.next_hunk")
    await harness.app.renderOnce()
    runCommand(harness, "diff.next_hunk")
    await waitForFrame(harness.app, "small final")
    runCommand(harness, "diff.close")
    await harness.app.renderOnce()
    expect(harness.route()).toEqual({ type: "session", sessionID })
  } finally {
    await harness.dispose()
  }
})

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && containsDiff(root)) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}

function containsDiff(root: Renderable): boolean {
  if (root instanceof DiffRenderable) return true
  return root.getChildren().some(containsDiff)
}

function hasBackground(harness: Harness, text: string, background: ReturnType<Harness["theme"]>["primary"]) {
  const frame = harness.app.captureSpans()
  return frame.lines.some((line) => line.spans.some((span) => span.text.includes(text) && span.bg.equals(background)))
}
