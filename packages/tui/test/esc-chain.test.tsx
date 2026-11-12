// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { InputRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import type { PermissionRequest, QuestionRequest, Session } from "@graphagent/sdk"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { afterEach, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import { setLanguage } from "../src/i18n"
import { EscapePriority, GraphagentKeymapProvider, registerGraphagentKeymap } from "../src/keymap"
import { ListPanel, type ListItem } from "../src/panel/list"
import { PanelSurface, renderPanel } from "./panel/contexts"
import { sessionFixture } from "./routes/dag-mode-harness"
import { mountSessionShell } from "./routes/session-shell"
import { shellState } from "./shell/contexts"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

function createResolvedKeymapConfig() {
  const keybinds = TuiKeybind.parse({})
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("escape priorities follow the documented chain", () => {
  expect(EscapePriority.autocomplete).toBeGreaterThan(EscapePriority.drawer)
  expect(EscapePriority.drawer).toBeGreaterThan(EscapePriority.askSub)
  expect(EscapePriority.askSub).toBeGreaterThan(EscapePriority.ask)
  expect(EscapePriority.ask).toBeGreaterThan(EscapePriority.modalHelp)
  expect(EscapePriority.modalHelp).toBeGreaterThan(EscapePriority.modal)
  expect(EscapePriority.modal).toBeGreaterThan(EscapePriority.detail)
  expect(EscapePriority.detail).toBeGreaterThan(EscapePriority.subagent)
  expect(EscapePriority.subagent).toBeGreaterThan(EscapePriority.shell)
  expect(EscapePriority.shell).toBeGreaterThan(EscapePriority.interrupt)
  expect(EscapePriority.interrupt).toBeGreaterThan(EscapePriority.none)
})

test("the innermost enabled escape layer wins and disabled layers fall through", async () => {
  const calls: string[] = []
  const enabled = {
    askSub: true,
    ask: true,
    modalHelp: true,
    modal: true,
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const offKeymap = registerGraphagentKeymap(keymap, renderer, createResolvedKeymapConfig())
    const layers = [
      ["interrupt", EscapePriority.interrupt],
      ["modal", EscapePriority.modal],
      ["modalHelp", EscapePriority.modalHelp],
      ["ask", EscapePriority.ask],
      ["askSub", EscapePriority.askSub],
    ].map(([name, priority]) =>
      keymap.registerLayer({
        priority: priority as number,
        enabled: () => name === "interrupt" || enabled[name as keyof typeof enabled],
        commands: [
          {
            name: `test.escape.${name}`,
            run: () => {
              calls.push(name as string)
            },
          },
        ],
        bindings: [{ key: "escape", cmd: `test.escape.${name}` }],
      }),
    )
    onCleanup(() => {
      layers.forEach((dispose) => dispose())
      offKeymap()
    })

    return (
      <GraphagentKeymapProvider keymap={keymap}>
        <box />
      </GraphagentKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    await app.renderOnce()
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub"])

    enabled.askSub = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask"])

    enabled.ask = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask", "modalHelp"])

    enabled.modalHelp = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask", "modalHelp", "modal"])

    enabled.modal = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask", "modalHelp", "modal", "interrupt"])
  } finally {
    app.renderer.destroy()
  }
})

/*
 * The eight layers of #886 4.5, each mounted for real. Every test uses the production
 * components that own the layer and records which keymap layer ran its binding for each
 * escape press (`layer.priority` of the dispatch event). "Only the highest layer" is then an
 * exact assertion: one press runs exactly one layer, the layers below keep their state, and
 * the next press falls through to the layer right under it.
 *
 * Where the layers live in the app:
 * - autocomplete (700) and interrupt (100, and shell/edit above it): the prompt in `Main`.
 * - drawer (600) and subagent (200): `Main`; the drawer itself is drawn by `AppFrame`.
 * - ask (500) and askSub (501): the permission and question surfaces, shown by `BottomZone`.
 * - modal (400): `PanelHost`, inside `BottomZone`.
 * - detail (300): the aside of `BottomZone`.
 *
 * The scene is `mountSessionShell`: a trimmed copy of `app.tsx` (`AppFrame`, `BottomZone` and
 * `Main`, inside the provider stack of `mountRoute`).
 */

const rootID = "ses_esc_root"
const childID = "ses_esc_child"

function permissionRequest(sessionID: string): PermissionRequest {
  return {
    id: "per_000000000001",
    sessionID,
    permission: "bash",
    patterns: ["npm publish"],
    metadata: {},
    always: ["npm publish"],
  }
}

function questionRequest(sessionID: string): QuestionRequest {
  return {
    id: "que_000000000001",
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

async function mountChain(options: { sessionID?: string; sessions?: readonly Session[] } = {}) {
  const shell = await mountSessionShell({
    sessionID: options.sessionID ?? rootID,
    sessions: options.sessions ?? [sessionFixture(rootID)],
  })

  const layers: number[] = []
  shell.keymap().on("dispatch", (event) => {
    if (event.phase === "binding-execute" && event.layer) layers.push(event.layer.priority)
  })

  return {
    ...shell,
    /** Presses escape once and returns the priorities of the layers that ran a binding. */
    async esc() {
      layers.length = 0
      shell.app.mockInput.pressEscape()
      await shell.settle()
      return [...layers]
    },
    busy(sessionID = rootID) {
      shell.sync().set("session_status", sessionID, { type: "busy" })
    },
    /** Paths of the requests that reject or answer an ask, in order. */
    answers: () => shell.writes().filter((item) => /\/(reply|reject)$/.test(item.path)),
  }
}

const abort = (sessionID: string) => ({ method: "POST", path: `/session/${sessionID}/abort`, body: undefined })

test("autocomplete (1): esc closes the popup before the drawer, and the drawer before the interrupt", async () => {
  const chain = await mountChain()
  try {
    chain.busy()
    await chain.openDrawer()
    await chain.app.mockInput.typeText("/")
    await chain.settle()
    expect(chain.frame()).toContain("/config")
    expect(chain.drawer().visible()).toBe(true)

    expect(await chain.esc()).toEqual([EscapePriority.autocomplete])
    expect(chain.frame()).not.toContain("/config")
    expect(chain.drawer().visible()).toBe(true)
    expect(chain.writes()).toEqual([])

    expect(await chain.esc()).toEqual([EscapePriority.drawer])
    expect(chain.drawer().visible()).toBe(false)
    expect(chain.writes()).toEqual([])

    // The busy session is only counted now, and stopped by the second press.
    expect(await chain.esc()).toEqual([EscapePriority.interrupt])
    expect(chain.writes()).toEqual([])
    expect(await chain.esc()).toEqual([EscapePriority.interrupt])
    expect(chain.writes()).toEqual([abort(rootID)])
  } finally {
    await chain.dispose()
  }
})

test("drawer (2): esc closes the drawer before it rejects the pending request", async () => {
  const chain = await mountChain()
  try {
    await chain.openDrawer()
    chain.sync().set("permission", rootID, [permissionRequest(rootID)])
    await chain.settle()
    expect(chain.bottomZone().state().kind).toBe("ask")
    expect(chain.frame()).toContain("抽屉")

    expect(await chain.esc()).toEqual([EscapePriority.drawer])
    expect(chain.drawer().visible()).toBe(false)
    expect(chain.frame()).not.toContain("抽屉")
    expect(chain.bottomZone().state().kind).toBe("ask")
    expect(chain.writes()).toEqual([])

    expect(await chain.esc()).toEqual([EscapePriority.ask])
    expect(chain.answers()).toEqual([
      { method: "POST", path: "/permission/per_000000000001/reply", body: { reply: "reject" } },
    ])
  } finally {
    await chain.dispose()
  }
})

test("ask (3): esc rejects the pending permission and leaves the busy session running", async () => {
  const chain = await mountChain()
  try {
    chain.busy()
    chain.sync().set("permission", rootID, [permissionRequest(rootID)])
    await chain.settle()
    expect(chain.bottomZone().state().kind).toBe("ask")

    expect(await chain.esc()).toEqual([EscapePriority.ask])
    expect(chain.writes()).toEqual([
      { method: "POST", path: "/permission/per_000000000001/reply", body: { reply: "reject" } },
    ])
    // Nothing was aborted or counted toward an interrupt: a second press still rejects, it does not stop the run.
    expect(await chain.esc()).toEqual([EscapePriority.ask])
    expect(chain.writes().some((item) => item.path.endsWith("/abort"))).toBe(false)
  } finally {
    await chain.dispose()
  }
})

test("askSub (3): esc cancels the answer being typed before it rejects the question", async () => {
  const chain = await mountChain()
  try {
    chain.sync().set("question", rootID, [questionRequest(rootID)])
    await chain.settle()
    expect(chain.bottomZone().state().kind).toBe("ask")

    // The third row is the free-text answer: it opens the editor, a sub-state of the ask.
    chain.app.mockInput.pressKey("3")
    await chain.settle()
    expect(chain.answers()).toEqual([])

    expect(await chain.esc()).toEqual([EscapePriority.askSub])
    expect(chain.answers()).toEqual([])
    expect(chain.bottomZone().state().kind).toBe("ask")

    expect(await chain.esc()).toEqual([EscapePriority.ask])
    expect(chain.answers()).toEqual([{ method: "POST", path: "/question/que_000000000001/reject", body: undefined }])
  } finally {
    await chain.dispose()
  }
})

test("askSub (3): esc in the rejection reason of a permission ends the ask without a reason", async () => {
  const chain = await mountChain()
  try {
    chain.sync().set("permission", rootID, [permissionRequest(rootID)])
    await chain.settle()
    // Option 3 asks the agent how to adjust: the reason editor replaces the option list.
    chain.app.mockInput.pressKey("3")
    await chain.settle()
    expect(chain.answers()).toEqual([])

    expect(await chain.esc()).toEqual([EscapePriority.askSub])
    expect(chain.answers()).toEqual([
      { method: "POST", path: "/permission/per_000000000001/reply", body: { reply: "reject" } },
    ])
  } finally {
    await chain.dispose()
  }
})

test("modal (4): esc closes only the top panel and then the one below it", async () => {
  const chain = await mountChain()
  try {
    chain.busy()
    const closed: string[] = []
    const host = chain.bottomZone().host
    host.push({ id: "root", render: () => <text>根面板</text>, onClose: () => closed.push("root") })
    host.push({ id: "child", render: () => <text>子面板</text>, onClose: () => closed.push("child") })
    await chain.settle()
    expect(chain.frame()).toContain("子面板")
    expect(chain.bottomZone().dimmed()).toBe(true)

    expect(await chain.esc()).toEqual([EscapePriority.modal])
    expect(closed).toEqual(["child"])
    expect(host.depth()).toBe(1)
    expect(chain.frame()).toContain("根面板")

    expect(await chain.esc()).toEqual([EscapePriority.modal])
    expect(closed).toEqual(["child", "root"])
    expect(host.depth()).toBe(0)
    expect(chain.bottomZone().dimmed()).toBe(false)
    // The busy session was never touched by the panel presses.
    expect(chain.writes()).toEqual([])
  } finally {
    await chain.dispose()
  }
})

test("detail (5): esc closes the aside while the composer keeps focus, then falls through to the interrupt", async () => {
  const chain = await mountChain()
  try {
    chain.busy()
    const closed: string[] = []
    chain
      .bottomZone()
      .openAside({ id: "aside", render: () => <text>旁注答案</text>, onClose: () => closed.push("aside") })
    await chain.settle()
    expect(chain.frame()).toContain("旁注答案")
    expect(chain.bottomZone().dimmed()).toBe(false)

    expect(await chain.esc()).toEqual([EscapePriority.detail])
    expect(closed).toEqual(["aside"])
    expect(chain.frame()).not.toContain("旁注答案")
    expect(chain.writes()).toEqual([])

    // With the aside gone the busy session is next in line.
    expect(await chain.esc()).toEqual([EscapePriority.interrupt])
    expect(chain.writes()).toEqual([])
  } finally {
    await chain.dispose()
  }
})

test("subagent (6): esc returns to the parent session and sends nothing, even while the child is busy", async () => {
  const chain = await mountChain({
    sessionID: childID,
    sessions: [sessionFixture(rootID), sessionFixture(childID, { parentID: rootID })],
  })
  try {
    chain.busy(childID)
    expect(chain.route().data).toEqual({ type: "session", sessionID: childID })

    expect(await chain.esc()).toEqual([EscapePriority.subagent])
    expect(chain.route().data).toMatchObject({ type: "session", sessionID: rootID })
    expect(chain.writes()).toEqual([])

    // The parent is idle: nothing is left to act on.
    expect(await chain.esc()).toEqual([])
    expect(chain.route().data).toMatchObject({ type: "session", sessionID: rootID })
    expect(chain.writes()).toEqual([])
  } finally {
    await chain.dispose()
  }
})

test("interrupt (7): a busy session needs two presses before it is aborted", async () => {
  const chain = await mountChain()
  try {
    chain.busy()

    // The first press only arms the interrupt.
    expect(await chain.esc()).toEqual([EscapePriority.interrupt])
    expect(chain.writes()).toEqual([])

    expect(await chain.esc()).toEqual([EscapePriority.interrupt])
    expect(chain.writes()).toEqual([abort(rootID)])
  } finally {
    await chain.dispose()
  }
})

test("none (8): esc does nothing when no layer is active", async () => {
  const chain = await mountChain()
  try {
    await chain.app.mockInput.typeText("keep me")
    await chain.settle()
    expect(chain.promptDraft()).toBe("keep me")
    const before = chain.frame()

    expect(await chain.esc()).toEqual([])
    expect(await chain.esc()).toEqual([])
    expect(chain.promptDraft()).toBe("keep me")
    expect(chain.route().data).toEqual({ type: "session", sessionID: rootID })
    expect(chain.writes()).toEqual([])
    expect(chain.frame()).toBe(before)
  } finally {
    await chain.dispose()
  }
})

// #886 4.1 rule 3: a list panel with a filter input keeps `left` and `right` for the cursor of
// that input and switches tabs with `tab` and `shift+tab`; only a panel without a filter uses
// the arrows for its tabs.

const listItems: ListItem<string>[] = [
  { id: "alpha", value: "alpha", title: "alpha" },
  { id: "beta", value: "beta", title: "beta" },
]

const listTabs = [
  { id: "one", label: "一" },
  { id: "two", label: "二" },
  { id: "three", label: "三" },
]

function descendants(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) descendants(child, result)
  return result
}

async function renderListPanel(options: { filter: boolean; tabs: string[]; state: string }) {
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <ListPanel
              title="选择"
              items={listItems}
              filter={options.filter}
              tabs={listTabs}
              activeTab="two"
              onTab={(id) => options.tabs.push(id)}
              onSelect={() => {}}
            />
          ),
        }}
      />
    ),
    { width: 100, height: 30, state: options.state },
  )
  const input = () =>
    descendants(app.renderer.root).find((node): node is InputRenderable => node instanceof InputRenderable)
  return { app, input }
}

async function settle(app: { renderOnce(): Promise<unknown> }) {
  await Bun.sleep(30)
  await app.renderOnce()
}

test("a list panel with a filter moves the filter cursor on left and right and keeps its tab", async () => {
  await using tmp = await shellState()
  const tabs: string[] = []
  const { app, input } = await renderListPanel({ filter: true, tabs, state: tmp.path })
  try {
    const filter = input()
    expect(filter).toBeDefined()
    if (!filter) return
    expect(filter.focused).toBe(true)

    app.mockInput.pressKey("a")
    app.mockInput.pressKey("b")
    await settle(app)
    expect(filter.value).toBe("ab")
    expect(filter.cursorOffset).toBe(2)

    app.mockInput.pressArrow("left")
    await settle(app)
    expect(filter.cursorOffset).toBe(1)
    app.mockInput.pressArrow("left")
    await settle(app)
    expect(filter.cursorOffset).toBe(0)
    app.mockInput.pressArrow("right")
    await settle(app)
    expect(filter.cursorOffset).toBe(1)
    expect(filter.value).toBe("ab")
    expect(tabs).toEqual([])

    // The tab keys still switch tabs.
    app.mockInput.pressTab()
    await settle(app)
    expect(tabs).toEqual(["three"])
    app.mockInput.pressTab({ shift: true })
    await settle(app)
    expect(tabs).toEqual(["three", "one"])
  } finally {
    app.renderer.destroy()
  }
})

test("a list panel without a filter switches tabs with left and right", async () => {
  await using tmp = await shellState()
  const tabs: string[] = []
  const { app, input } = await renderListPanel({ filter: false, tabs, state: tmp.path })
  try {
    expect(input()).toBeUndefined()

    app.mockInput.pressArrow("right")
    await settle(app)
    expect(tabs).toEqual(["three"])
    app.mockInput.pressArrow("left")
    await settle(app)
    expect(tabs).toEqual(["three", "one"])
  } finally {
    app.renderer.destroy()
  }
})
