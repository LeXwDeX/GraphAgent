// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextareaRenderable, type Renderable } from "@opentui/core"
import { afterEach, expect, test } from "bun:test"
import { setLanguage } from "../src/i18n"
import { cellWidth } from "../src/ui/width"
import { captureFrame, promptShown, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { json, type FetchHandler } from "./fixture/tui-sdk"

// The real app against a server that offers more models than the configuration names. `/model` lists the models the
// configuration declares and no others, writes the note of a model on the model's own row, and the list that opens
// after connecting a provider shows that provider's whole catalog (#1666).

afterEach(() => {
  setLanguage("zh-CN")
})

type Language = "zh-CN" | "en"

const TEXT = {
  "zh-CN": {
    command: "选择当前会话使用的模型",
    title: "选择模型",
    favorites: "收藏",
    recent: "最近",
    empty: "没有已声明的模型。请在 graphagent.json 的 provider.<id>.models 里声明。",
  },
  en: {
    command: "Choose the model for this session",
    title: "Select model",
    favorites: "Favorites",
    recent: "Recent",
    empty: "No declared models. Add them under provider.<id>.models in graphagent.json",
  },
} as const

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

function model(providerID: string, id: string, name: string, releaseDate: string) {
  return { id, name, providerID, release_date: releaseDate, status: "active", capabilities: { reasoning: false } }
}

function provider(id: string, name: string, models: ReturnType<typeof model>[]) {
  return {
    id,
    name,
    source: "env",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((item) => [item.id, item])),
  }
}

/** Longer than the room an 80-column row has, and with the note next to it than a 120-column row has. */
const LONG_TITLE =
  "Beta One Extended Reasoning Preview Build 2026-11-19 With A Very Long Display Name For The Narrow Case"
/** The name of a provider (22 wide characters): the note of its models in the favorites and the recents. */
const LONG_NOTE = "阿尔法提供商的一个相当长的名称用来检查窄终端"
const MIDDLE_TITLE = "Alpha One With A Rather Long Display Name For Testing"

/** Ten models of four providers. With `long`, the title of two of them and the name of one provider are long. */
function catalog(options: { long?: boolean } = {}) {
  const long = options.long === true
  return [
    provider("alpha", long ? LONG_NOTE : "Alpha", [
      model("alpha", "a1", long ? MIDDLE_TITLE : "Alpha One", "2026-03-01"),
      model("alpha", "a2", "Alpha Two", "2026-02-01"),
      model("alpha", "a3", "Alpha Three", "2026-01-01"),
      model("alpha", "a4", "Alpha Four", "2025-12-01"),
    ]),
    provider("beta", "Beta", [
      model("beta", "b1", long ? LONG_TITLE : "Beta One", "2026-03-15"),
      model("beta", "b2", "Beta Two", "2026-01-15"),
      model("beta", "b3", "Beta Three", "2025-12-15"),
    ]),
    // Has a key from the environment, and the configuration does not mention it.
    provider("gamma", "Gamma", [
      model("gamma", "g1", "Gamma One", "2026-03-20"),
      model("gamma", "g2", "Gamma Two", "2026-02-20"),
    ]),
    // The configuration mentions it, for its options only.
    provider("delta", "Delta", [model("delta", "d1", "Delta One", "2026-03-25")]),
  ]
}

/**
 * The server. The configuration declares three of the ten models: two of alpha by `models` and one of beta by
 * `whitelist`. Connecting gamma is accepted.
 */
function server(language: Language, options: { long?: boolean } = {}): FetchHandler {
  const providers = catalog(options)
  return (url, request) => {
    if (url.pathname === "/config") {
      return json({
        language,
        provider: {
          alpha: { models: { a1: {}, a2: {} } },
          beta: { whitelist: ["b1"] },
          delta: { options: { baseURL: "http://delta.test" } },
        },
      })
    }
    if (url.pathname === "/config/providers") return json({ providers, default: {} })
    if (url.pathname === "/provider") {
      return json({ all: providers, default: {}, connected: providers.map((item) => item.id) })
    }
    if (request?.method === "PUT" && url.pathname === "/auth/gamma") return json(true)
    if (request?.method === "POST" && url.pathname === "/instance/dispose") return json(true)
    return undefined
  }
}

type App = Awaited<ReturnType<typeof runApp>>

/** The rows of the panel on screen, from its top edge to its bottom edge. */
function panelRows(frame: string) {
  const rows = frame.split("\n").map((row) => row.trimEnd())
  const top = rows.findIndex((row) => row.startsWith("╭"))
  const bottom = rows.findIndex((row, index) => index > top && row.startsWith("╰"))
  return top < 0 || bottom < 0 ? [] : rows.slice(top, bottom + 1)
}

/** The text of a panel row without its border and padding. */
function cell(row: string) {
  return row.slice(1, -1).trim()
}

/** The text of a list row without the marker that the cursor, or the current model, puts in front of it. */
function entry(row: string) {
  return cell(row).replace(/^[●›]\s+/, "")
}

/** What the list itself shows: the rows between the panel's filter row and its hint row, without the blank ones. */
function listRows(frame: string) {
  return panelRows(frame)
    .filter((row) => row.startsWith("│"))
    .slice(2, -1)
    .map(entry)
    .filter((row) => row !== "")
}

/** Closes the panel that is open, so that the exit key of the harness reaches the app instead of it, and stops the app. */
async function finish(app: App) {
  try {
    if (!promptShown(await captureFrame(app.setup))) {
      app.setup.mockInput.pressEscape()
      await waitForFrame(app.setup, promptShown, "the prompt again", 2000)
    }
  } catch {
    // The report is the failure of the test itself; stopping the app below does not depend on this.
  }
  clearDrafts(app.setup)
  await app.stop()
}

async function command(app: App, text: string, description: string) {
  await waitForFrame(app.setup, promptShown, "the prompt")
  clearDrafts(app.setup)
  await app.setup.mockInput.typeText(text)
  await waitForFrame(app.setup, (frame) => frame.includes(description), "the command popup")
  app.setup.mockInput.pressEnter()
}

async function openModelList(app: App, language: Language) {
  await command(app, "/model", TEXT[language].command)
  return waitForFrame(app.setup, (frame) => frame.includes(TEXT[language].title), "the model list")
}

for (const language of ["zh-CN", "en"] as const) {
  test(`/model lists the three declared models and no others, ${language}`, async () => {
    const app = await runApp({ sessions: [], args: {}, handler: server(language) })
    try {
      // The providers that declare a model are the groups; the one with a key and no declaration, and the one the
      // configuration mentions for its options, have none. Nothing is written by looking.
      expect(listRows(await openModelList(app, language))).toEqual([
        "Alpha",
        "Alpha One",
        "Alpha Two",
        "Beta",
        "Beta One",
      ])
      expect(app.writes()).toEqual([])
    } finally {
      await finish(app)
    }
  })

  test(`the favorites and the recents hold declared models only, ${language}`, async () => {
    const app = await runApp({
      sessions: [],
      args: {},
      handler: server(language),
      state: {
        "model.json": {
          favorite: [
            { providerID: "alpha", modelID: "a2" },
            { providerID: "gamma", modelID: "g2" },
          ],
          recent: [
            { providerID: "alpha", modelID: "a3" },
            { providerID: "gamma", modelID: "g1" },
            { providerID: "beta", modelID: "b1" },
          ],
        },
      },
    })
    try {
      // Each of the three parts has a declared model and an undeclared one waiting; only the declared ones are shown.
      expect(listRows(await openModelList(app, language))).toEqual([
        TEXT[language].favorites,
        "Alpha Two  Alpha",
        TEXT[language].recent,
        "Beta One  Beta",
        "Alpha",
        "Alpha One",
      ])
    } finally {
      await finish(app)
    }
  })

  test(`a configuration that declares no model leaves the list empty and says where to declare one, ${language}`, async () => {
    const providers = catalog()
    const app = await runApp({
      sessions: [],
      args: {},
      handler: (url) => {
        if (url.pathname === "/config") return json({ language, provider: { delta: { options: {} } } })
        if (url.pathname === "/config/providers") return json({ providers, default: {} })
        if (url.pathname === "/provider") return json({ all: providers, default: {}, connected: ["alpha"] })
        return undefined
      },
    })
    try {
      expect(listRows(await openModelList(app, language))).toEqual([TEXT[language].empty])
    } finally {
      await finish(app)
    }
  })
}

// The list after connecting a provider is where its first model gets picked: all of the provider's models, declared or
// not, and nothing of the other providers.
test("the list that opens after connecting a provider holds all of that provider's models", async () => {
  const app = await runApp({ sessions: [], args: {}, handler: server("zh-CN") })
  try {
    await command(app, "/connect", "添加或连接模型提供商")
    await waitForFrame(app.setup, (frame) => frame.includes("连接提供商"), "the provider list")
    await app.setup.mockInput.typeText("Gamma")
    await waitForFrame(
      app.setup,
      (frame) => listRows(frame).some((row) => row.endsWith("Gamma")),
      "the filtered provider list",
    )
    app.setup.mockInput.pressEnter()
    await waitForFrame(app.setup, (frame) => frame.includes("API key"), "the credential input")
    await app.setup.mockInput.typeText("test-key-not-a-secret")
    app.setup.mockInput.pressEnter()

    const frame = await waitForFrame(
      app.setup,
      (value) => panelRows(value).some((row) => row.endsWith("/model │")),
      "the model list of the provider",
    )
    // Neither of gamma's models is declared; both are listed, newest first, under the provider's name, which is the title.
    expect(listRows(frame)).toEqual(["Gamma", "Gamma One", "Gamma Two"])
    expect(cell(panelRows(frame)[1] ?? "")).toStartWith("Gamma")
    expect(app.writes().map((item) => `${item.method} ${item.path}`)).toEqual([
      "PUT /auth/gamma",
      "POST /instance/dispose",
    ])
  } finally {
    await finish(app)
  }
})

// The note of a model, its provider in the favorites and the recents, is on the model's own row. Where the cursor stands
// changes neither what the list shows nor how tall it is, and no row is wider than the panel at either setting of
// `ambiguous_width`. At 80 columns the note of the recent model is cut and the title of the favorite one, which has no
// room left for its note; at 120 columns the note of the recent model fits.
for (const language of ["zh-CN", "en"] as const) {
  for (const width of [80, 120] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`the note stays on its model's row and the list keeps its height, ${language}, ${width} columns, ambiguous_width ${ambiguousWidth}`, async () => {
        const app = await runApp({
          sessions: [],
          args: {},
          width,
          height: 30,
          ambiguousWidth,
          handler: server(language, { long: true }),
          state: {
            "model.json": {
              favorite: [{ providerID: "beta", modelID: "b1" }],
              recent: [{ providerID: "alpha", modelID: "a1" }],
            },
          },
        })
        try {
          await openModelList(app, language)
          const looks: string[] = []
          const heights = new Set<number>()
          const screens = new Set<number>()
          for (let position = 0; position < 3; position++) {
            const frame = await waitForFrame(
              app.setup,
              (value) => panelRows(value).length > 0,
              `the model list, position ${position}`,
            )
            const rows = panelRows(frame)
            heights.add(rows.length)
            screens.add(frame.split("\n").filter((row) => row.trim() !== "").length)
            looks.push(rows.join("\n"))

            for (const row of rows.filter((value) => value.startsWith("│") && value.endsWith("│"))) {
              const inner = row.slice(1, -1).trimEnd()
              expect({ row, fits: cellWidth(inner, ambiguousWidth) <= width - 3 }).toEqual({ row, fits: true })
            }

            // One row for each model, with its note on it: the list is what it was before the cursor moved.
            const favorite = listRows(frame).filter((row) => row.startsWith("Beta One"))
            const recent = listRows(frame).filter((row) => row.startsWith("Alpha One"))
            expect(favorite).toHaveLength(1)
            expect(recent).toHaveLength(1)
            if (width === 120) {
              expect(favorite[0]).toBe(`${LONG_TITLE}  Beta`)
              expect(recent[0]).toBe(`${MIDDLE_TITLE}  ${LONG_NOTE}`)
            } else {
              // The favorite title does not fit with anything else: it is cut and its note gives way entirely.
              expect(favorite[0]).toMatch(/^Beta One Extended .*…$/)
              expect(favorite[0]).not.toMatch(/Beta$/)
              // The recent title fits whole, and its note is cut to the room that is left.
              expect(recent[0]).toStartWith(`${MIDDLE_TITLE}  阿尔法`)
              expect(recent[0]).toEndWith("…")
              expect(recent[0]).not.toContain(LONG_NOTE)
            }
            expect(listRows(frame)).toContain("Alpha Two")
            app.setup.mockInput.pressArrow("down")
            await app.setup.renderOnce()
          }
          expect([...heights]).toHaveLength(1)
          expect([...screens]).toHaveLength(1)
          expect(looks.join("\n\n")).toMatchSnapshot()
        } finally {
          await finish(app)
        }
      })
    }
  }
}
