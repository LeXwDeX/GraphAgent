// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA } from "@opentui/core"
import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@graphagent/sdk"
import { DEFAULT_THEME } from "../../../src/context/theme"
import { setLanguage } from "../../../src/i18n"
import { PANEL_NARROW_WIDTH } from "../../../src/panel/shell"
import { fitDiff, PermissionPrompt, type DiffFit } from "../../../src/routes/session/permission"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../../src/ui/width"
import { json, type FetchHandler } from "../../fixture/tui-sdk"
import { readSpans, renderUntilFrame } from "../../fixture/frames"
import { renderAppPanel } from "../../panel/contexts"
import { shellState } from "../../shell/contexts"

/**
 * The shell of the permission ask (#1619 PR C): the title names the tool, the object of the request sits in a dark
 * block, the chosen option is drawn in the brand color, and the queue position moves to the top right.
 */

type Language = "zh-CN" | "en"
const LANGUAGES: readonly Language[] = ["zh-CN", "en"]

const ROOT = "ses_root"
const CHILD = "ses_child"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

afterEach(() => {
  setLanguage("zh-CN")
})

function session(id: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    role: parentID ? "task_child" : "root",
    projectID: "proj_test",
    directory: `/repo/${id}`,
    title: id,
    version: "test",
    parentID,
    time: { created: 1, updated: 2 },
  }
}

const DIFF = [
  "Index: src/app.ts",
  "===================================================================",
  "--- src/app.ts",
  "+++ src/app.ts",
  "@@ -1,3 +1,3 @@",
  " export function value() {",
  "-  return 41",
  "+  return 42",
  " }",
  "",
].join("\n")

/**
 * A diff of 40 rows, more than the panel can show: 6 lines of context, 14 lines removed, 14 added and 6 lines of context.
 * An ask that has to shorten it says `+14 −14`.
 */
const LONG_DIFF = [
  "Index: src/app.ts",
  "===================================================================",
  "--- src/app.ts",
  "+++ src/app.ts",
  "@@ -1,26 +1,26 @@",
  ...Array.from({ length: 6 }, (_, index) => ` const keep${index + 1} = ${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => `-  old${index + 1}()`),
  ...Array.from({ length: 14 }, (_, index) => `+  new${index + 1}()`),
  ...Array.from({ length: 6 }, (_, index) => ` const tail${index + 1} = ${index + 1}`),
  "",
].join("\n")

interface Scene {
  id: string
  permission: string
  /** The input of the tool call, as its part holds it. */
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  patterns?: string[]
  always?: string[]
  /** What the title names the tool, by language. */
  tool: Record<Language, string>
  /** What the frame shows of the request, by language. */
  shows: Record<Language, string[]>
}

const same = (value: string): Record<Language, string> => ({ "zh-CN": value, en: value })
const both = (...values: string[]): Record<Language, string[]> => ({ "zh-CN": values, en: values })

/** One scene per kind of request the surface draws; the first five are the ones #1619 names. */
function scenes(long = false): Scene[] {
  const command = long
    ? "bun install --frozen-lockfile && bun run toolchain:check && cd packages/tui && bun test --timeout 30000 test/routes/session"
    : "bun install"
  const deep = long ? "/repo/packages/tui/src/routes/session/some-rather-deeply-nested-module.ts" : "/repo/src/app.ts"
  const description = long
    ? "扫描整个仓库里所有可能破坏兼容性的变更并按影响面逐项整理成一份清单".repeat(2)
    : "扫描破坏性变更"
  return [
    {
      id: "bash",
      permission: "bash",
      input: { command },
      patterns: ["bun install"],
      always: ["bun install"],
      tool: same("Bash"),
      shows: both(`$ ${command.split(" ").slice(0, 3).join(" ")}`),
    },
    {
      id: "edit",
      permission: "edit",
      metadata: { filepath: deep, diff: long ? LONG_DIFF : DIFF },
      always: ["src/*"],
      tool: same("Edit"),
      shows: { "zh-CN": ["路径:", "src/app.ts"], en: ["Path:", "src/app.ts"] },
    },
    {
      id: "read",
      permission: "read",
      input: { filePath: deep.replace("app.ts", "index.ts") },
      always: ["*"],
      tool: same("Read"),
      shows: { "zh-CN": ["路径:", "index.ts"], en: ["Path:", "index.ts"] },
    },
    {
      id: "task",
      permission: "task",
      input: { subagent_type: "explore", description },
      always: ["explore"],
      tool: same("Task"),
      shows: {
        "zh-CN": ["子 agent:", "Explore", description.slice(0, 6)],
        en: ["Subagent:", "Explore", description.slice(0, 6)],
      },
    },
    {
      id: "external_directory",
      permission: "external_directory",
      metadata: { parentDir: "/opt/data" },
      patterns: ["/opt/data/*"],
      always: ["/opt/data/*"],
      tool: { "zh-CN": "项目外目录", en: "External directory" },
      shows: {
        "zh-CN": ["路径:", "/opt/data", "模式", "- /opt/data/*"],
        en: ["Path:", "/opt/data", "Patterns", "- /opt/data/*"],
      },
    },
  ]
}

/** The kinds of request the five scenes above leave out; every string these draw sits in the message tables. */
function others(): Scene[] {
  return [
    {
      id: "edit-nodiff",
      permission: "edit",
      metadata: { filepath: "/repo/src/app.ts" },
      tool: same("Edit"),
      shows: { "zh-CN": ["路径:", "没有可显示的 diff"], en: ["Path:", "No diff provided"] },
    },
    {
      id: "glob",
      permission: "glob",
      input: { pattern: "**/*.ts" },
      tool: same("Glob"),
      shows: { "zh-CN": ["模式:", "**/*.ts"], en: ["Pattern:", "**/*.ts"] },
    },
    {
      id: "grep",
      permission: "grep",
      input: { pattern: "TODO" },
      tool: same("Grep"),
      shows: { "zh-CN": ["模式:", "TODO"], en: ["Pattern:", "TODO"] },
    },
    {
      id: "list",
      permission: "list",
      input: { path: "/repo/src" },
      tool: same("List"),
      shows: { "zh-CN": ["路径:", "src"], en: ["Path:", "src"] },
    },
    {
      id: "webfetch",
      permission: "webfetch",
      input: { url: "https://example.com/docs" },
      tool: same("WebFetch"),
      shows: both("URL: https://example.com/docs"),
    },
    {
      id: "websearch",
      permission: "websearch",
      input: { query: "bun test timeout", provider: "exa" },
      tool: same("Exa Web Search"),
      shows: { "zh-CN": ["查询:", "bun test timeout"], en: ["Query:", "bun test timeout"] },
    },
    {
      id: "doom_loop",
      permission: "doom_loop",
      tool: { "zh-CN": "继续运行", en: "Continue" },
      shows: {
        "zh-CN": ["即使反复失败，也会让会话继续运行。"],
        en: ["This keeps the session running despite repeated failures."],
      },
    },
    {
      id: "generic",
      permission: "skill",
      tool: same("skill"),
      shows: { "zh-CN": [], en: [] },
    },
    {
      id: "hook",
      permission: "todowrite",
      metadata: { hookAsk: true, reason: "needs a look", input: { path: "/repo/notes.md", todos: [] } },
      tool: same("todowrite"),
      shows: { "zh-CN": ["Hook：needs a look", "路径:", "notes.md"], en: ["Hook: needs a look", "Path:", "notes.md"] },
    },
  ]
}

function titleOf(scene: Scene, language: Language) {
  return language === "zh-CN" ? `${scene.tool[language]} 需要权限` : `${scene.tool[language]} needs permission`
}

interface ReplyCall {
  path: string
  body: unknown
}

function replyHandler(calls: ReplyCall[]): FetchHandler {
  return async (url, request) => {
    if (/\/permission\/[^/]+\/reply$/.test(url.pathname)) {
      const body = request
        ? await request
            .clone()
            .json()
            .catch(() => undefined)
        : undefined
      calls.push({ path: url.pathname, body })
      return json({})
    }
    return undefined
  }
}

interface PromptOptions {
  scene: Scene
  language?: Language
  width?: number
  height?: number
  ambiguousWidth?: AmbiguousWidth
  position?: number
  total?: number
  /** The request comes from a sub-agent session, so only the root has the reason editor. */
  child?: boolean
}

type App = Awaited<ReturnType<typeof renderAppPanel>>

/** Mounts the permission ask on a stable frame and hands the run to `body`. */
async function withPrompt<T>(options: PromptOptions, body: (app: App, calls: ReplyCall[]) => Promise<T>) {
  const language = options.language ?? "zh-CN"
  const calls: ReplyCall[] = []
  await using tmp = await shellState(options.ambiguousWidth === 2 ? { ambiguous_width: 2 } : {})
  const sessionID = options.child ? CHILD : ROOT
  const { scene } = options
  const request: PermissionRequest = {
    id: "per_000000000001",
    sessionID,
    permission: scene.permission,
    patterns: scene.patterns ?? [],
    metadata: scene.metadata ?? {},
    always: scene.always ?? [],
    ...(scene.input ? { tool: { messageID: `msg_${scene.id}`, callID: `call_${scene.id}` } } : {}),
  }
  const app = await renderAppPanel(
    () => (
      <PermissionPrompt
        request={request}
        currentSessionID={ROOT}
        rootSessionID={ROOT}
        position={options.position ?? 1}
        total={options.total ?? 1}
      />
    ),
    {
      width: options.width ?? 120,
      height: options.height ?? 40,
      state: tmp.path,
      handler: replyHandler(calls),
      setup: (context) => {
        setLanguage(language)
        context.sync.set("session", [session(ROOT), session(CHILD, ROOT)])
        context.sync.set("taskIndex", CHILD, {
          parentSessionID: ROOT,
          parentMessageID: "msg_1",
          partID: "part_1",
          kind: "explore",
          description: "扫描破坏性变更",
        })
        if (scene.input) {
          context.sync.set("part", `msg_${scene.id}`, [
            {
              id: `prt_${scene.id}`,
              sessionID,
              messageID: `msg_${scene.id}`,
              type: "tool",
              callID: `call_${scene.id}`,
              tool: scene.permission,
              state: { status: "running", input: scene.input, time: { start: 1 } },
            },
          ])
        }
      },
    },
  )
  try {
    await stable(app)
    return await body(app, calls)
  } finally {
    app.renderer.destroy()
  }
}

/** The first frame that no later render changes. */
async function stable(app: App) {
  let last = ""
  return renderUntilFrame(
    app,
    (frame) => {
      const unchanged = frame === last && frame.trim().length > 0
      last = frame
      return unchanged
    },
    "a frame that stops changing",
  )
}

/** The lines of the panel, from its top border to its bottom border. */
function panelLines(frame: string) {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.startsWith("╭"))
  const bottom = lines.findIndex((line) => line.startsWith("╰"))
  if (top < 0 || bottom < top) throw new Error(`no panel in the frame:\n${frame}`)
  return lines.slice(top, bottom + 1)
}

/** The text between the borders of one line. */
const inside = (line: string) => line.slice(1, -1)

async function spanOf(app: App, needle: string) {
  for (const line of (await readSpans(app)).lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span
  }
  throw new Error(`no span holds ${needle}`)
}

const isColor = (actual: RGBA, expected: RGBA) => actual.equals(expected)

/** An edit whose diff has more rows than the panel can show. */
function editLong(filepath = "/repo/src/app.ts"): Scene {
  return {
    id: "edit-long",
    permission: "edit",
    metadata: { filepath, diff: LONG_DIFF },
    always: ["src/*"],
    tool: same("Edit"),
    shows: { "zh-CN": ["路径:", "const keep1"], en: ["Path:", "const keep1"] },
  }
}

/** What the three options of a request from the root say, and what the hint row starts with, by language. */
const OPTIONS: Record<Language, string[]> = {
  "zh-CN": ["1. 允许这一次", "2. 本会话内都允许 src/*", "3. 拒绝，并告诉 agent 怎么做"],
  en: ["1. Allow once", "2. Allow src/* for this session", "3. Reject, and tell the agent what to do instead"],
}
const HINTS: Record<Language, string> = { "zh-CN": "或数字键选择", en: "or number keys to pick" }

/** The numbered lines of a diff in the frame: the context, the removed and the added rows. */
const diffRowsOf = (frame: string) => panelLines(frame).filter((line) => /^│ +\d+ [-+ ]/.test(line))

/** The lines of the options: the mark column, then `n.`. */
const optionRowsOf = (frame: string) => panelLines(frame).filter((line) => /^│ [› ] \d\. /.test(line))

/**
 * The thumb of a scroll bar is drawn with block characters, which are ambiguous in width. The panel lays the bar out as
 * one cell, so it is measured as one: how a terminal draws the glyph is not the layout's to say.
 */
const SCROLL_THUMB = /[█▀▄]/g

describe("the title names the tool", () => {
  for (const language of LANGUAGES) {
    test(`every kind of request leads with its tool, no longer with a generic line, ${language}`, async () => {
      for (const scene of [...scenes(), ...others()]) {
        await withPrompt({ scene, language }, async (app) => {
          const frame = await stable(app)
          const lines = panelLines(frame)
          // The title is the first row of the panel; nothing in the frame is the old generic wording.
          expect({ scene: scene.id, title: inside(lines[1]).trim() }).toEqual({
            scene: scene.id,
            title: titleOf(scene, language),
          })
          for (const retired of ["# Shell command", "Shell command", "请求权限", "Permission required", "Call tool"]) {
            expect({ scene: scene.id, retired, found: frame.includes(retired) }).toEqual({
              scene: scene.id,
              retired,
              found: false,
            })
          }
          for (const text of scene.shows[language])
            expect({ scene: scene.id, text, found: frame.includes(text) }).toEqual({
              scene: scene.id,
              text,
              found: true,
            })
          const options = frame.includes(language === "zh-CN" ? "允许这一次" : "Allow once")
          expect({ scene: scene.id, options }).toEqual({ scene: scene.id, options: true })
        })
      }
    })
  }

  test("a request from a sub-agent session leads with its source, then the tool", async () => {
    for (const [language, title] of [
      ["zh-CN", "explore · 扫描破坏性变更 · Bash 需要权限"],
      ["en", "explore · 扫描破坏性变更 · Bash needs permission"],
    ] as const) {
      await withPrompt({ scene: scenes()[0], language, child: true }, async (app) => {
        expect(inside(panelLines(await stable(app))[1]).trim()).toBe(title)
      })
    }
  })

  test("the title is painted bold in the warning color, on a warning border", async () => {
    await withPrompt({ scene: scenes()[0] }, async (app) => {
      const span = await spanOf(app, "Bash 需要权限")
      expect(isColor(span.fg, theme.warning)).toBe(true)
      expect((span.attributes & TextAttributes.BOLD) !== 0).toBe(true)
      expect(isColor((await spanOf(app, "╭")).fg, theme.borderWarning)).toBe(true)
    })
  })
})

describe("the object of the request sits in a dark block", () => {
  test("a command is a prompt in the muted color and the command in the text color, on the background token", async () => {
    await withPrompt({ scene: scenes()[0] }, async (app) => {
      const command = await spanOf(app, "bun install")
      expect(isColor(command.fg, theme.text)).toBe(true)
      expect(isColor(command.bg, theme.background)).toBe(true)
      const prompt = await spanOf(app, "$")
      expect(isColor(prompt.fg, theme.textMuted)).toBe(true)
      expect(isColor(prompt.bg, theme.background)).toBe(true)
      // The block is the dark one inside the panel, not the color of the panel itself.
      expect(isColor(theme.background, theme.backgroundPanel)).toBe(false)
      // One cell of padding on each side of the text, and the block spans the width of the panel.
      const line = panelLines(await stable(app)).find((row) => row.includes("$ bun install"))!
      expect(inside(line).startsWith("  $ bun install")).toBe(true)
    })
  })

  test("the block runs the width of the panel", async () => {
    await withPrompt({ scene: scenes()[0], width: 120, height: 40 }, async (app) => {
      const row = (await readSpans(app)).lines.find((line) =>
        line.spans.some((span) => span.text.includes("bun install")),
      )!
      const dark = row.spans.filter((span) => isColor(span.bg, theme.background))
      // The width of the terminal less the border and the padding of the panel on each side.
      expect(dark.reduce((sum, span) => sum + cellWidth(span.text), 0)).toBe(120 - 4)
    })
  })

  test("a path, a pattern, a URL and a query are drawn in the same block, by their label", async () => {
    for (const scene of others().filter((item) => ["glob", "webfetch", "websearch", "list"].includes(item.id))) {
      await withPrompt({ scene }, async (app) => {
        const label = await spanOf(app, ":")
        expect(isColor(label.fg, theme.textMuted)).toBe(true)
        expect(isColor(label.bg, theme.background)).toBe(true)
      })
    }
  })

  test("a request without an object draws no block, and the explanations come from the request itself", async () => {
    const doom = others().find((item) => item.id === "doom_loop")!
    await withPrompt({ scene: doom }, async (app) => {
      const sentence = await spanOf(app, "即使反复失败")
      expect(isColor(sentence.fg, theme.textMuted)).toBe(true)
      expect(isColor(sentence.bg, theme.background)).toBe(false)
    })
    // A task shows its description as the one muted line under its block; a command has no such line to show.
    const task = scenes().find((item) => item.id === "task")!
    await withPrompt({ scene: task }, async (app) => {
      const frame = await stable(app)
      const lines = panelLines(frame)
      const block = lines.findIndex((line) => line.includes("子 agent: Explore"))
      expect(block).toBeGreaterThan(1)
      expect(lines[block + 1]).toContain("扫描破坏性变更")
      expect(isColor((await spanOf(app, "扫描破坏性变更")).fg, theme.textMuted)).toBe(true)
    })
    await withPrompt({ scene: scenes()[0] }, async (app) => {
      const lines = panelLines(await stable(app))
      const block = lines.findIndex((line) => line.includes("$ bun install"))
      expect(inside(lines[block + 1]).trim()).toBe("")
      expect(inside(lines[block + 2])).toContain("允许这一次")
    })
    // The reason a hook forced the ask stays in the warning color above the block.
    const hook = others().find((item) => item.id === "hook")!
    await withPrompt({ scene: hook }, async (app) => {
      expect(isColor((await spanOf(app, "Hook")).fg, theme.warning)).toBe(true)
    })
  })
})

describe("the options", () => {
  test("the chosen option is drawn in the brand color on the selected background, the others in muted and text", async () => {
    await withPrompt({ scene: scenes()[0] }, async (app) => {
      for (const needle of ["›", "1.", "允许这一次"]) {
        const span = await spanOf(app, needle)
        expect({
          needle,
          brand: isColor(span.fg, theme.primary),
          selected: isColor(span.bg, theme.backgroundSelected),
        }).toEqual({
          needle,
          brand: true,
          selected: true,
        })
      }
      const number = await spanOf(app, "2.")
      expect(isColor(number.fg, theme.textMuted)).toBe(true)
      expect(isColor(number.bg, theme.backgroundSelected)).toBe(false)
      const label = await spanOf(app, "本会话内都允许")
      expect(isColor(label.fg, theme.text)).toBe(true)
      expect(isColor(label.bg, theme.backgroundSelected)).toBe(false)

      // The mark and the colors follow the selection.
      app.mockInput.pressArrow("down")
      await renderUntilFrame(app, (frame) => frame.includes("› 2."), "the selection on the second option")
      const moved = await spanOf(app, "本会话内都允许")
      expect(isColor(moved.fg, theme.primary)).toBe(true)
      expect(isColor(moved.bg, theme.backgroundSelected)).toBe(true)
      expect(isColor((await spanOf(app, "允许这一次")).fg, theme.text)).toBe(true)
    })
  })

  test("every kind of request draws the chosen option the same way", async () => {
    for (const scene of [...scenes(), ...others()]) {
      await withPrompt({ scene }, async (app) => {
        const mark = await spanOf(app, "›")
        expect({
          scene: scene.id,
          brand: isColor(mark.fg, theme.primary),
          selected: isColor(mark.bg, theme.backgroundSelected),
        }).toEqual({
          scene: scene.id,
          brand: true,
          selected: true,
        })
      })
    }
  })

  test("the second option names what it allows, without a colon", async () => {
    for (const [language, text] of [
      ["zh-CN", "2. 本会话内都允许 bun install"],
      ["en", "2. Allow bun install for this session"],
    ] as const) {
      await withPrompt({ scene: scenes()[0], language }, async (app) => {
        expect(await stable(app)).toContain(text)
      })
    }
  })

  test("the third option follows who the request comes from: the root can say why, a sub-agent's is plain", async () => {
    for (const [language, own, other] of [
      ["zh-CN", "3. 拒绝，并告诉 agent 怎么做", "3. 拒绝"],
      ["en", "3. Reject, and tell the agent what to do instead", "3. Reject"],
    ] as const) {
      await withPrompt({ scene: scenes()[0], language }, async (app) => {
        const frame = await stable(app)
        expect(frame).toContain(own)
        expect(frame).not.toContain("4.")
      })
      await withPrompt({ scene: scenes()[0], language, child: true }, async (app) => {
        const lines = (await stable(app)).split("\n")
        const third = lines.find((line) => line.includes("3."))!
        expect(inside(third).trim().endsWith(other.slice(3))).toBe(true)
        expect(third).not.toContain(own.slice(3))
        // The relay option stays the fourth.
        expect(lines.some((line) => line.includes("4."))).toBe(true)
      })
    }
  })

  test("choosing the third option from the root opens the reason editor, from a sub-agent it rejects at once", async () => {
    await withPrompt({ scene: scenes()[0] }, async (app, calls) => {
      app.mockInput.pressKey("3")
      await renderUntilFrame(app, (frame) => frame.includes("拒绝权限"), "the reason editor")
      expect(calls).toEqual([])
    })
    await withPrompt({ scene: scenes()[0], child: true }, async (app, calls) => {
      app.mockInput.pressKey("3")
      await renderUntilFrame(app, () => calls.length > 0, "the reply")
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "reject" } }])
    })
  })

  test("a click on an option still chooses it", async () => {
    await withPrompt({ scene: scenes()[0] }, async (app, calls) => {
      const lines = (await stable(app)).split("\n")
      const row = lines.findIndex((line) => line.includes("2. 本会话内都允许"))
      expect(row).toBeGreaterThan(0)
      await app.mockMouse.click(cellWidth(lines[row].slice(0, lines[row].indexOf("本会话"))), row)
      await renderUntilFrame(app, () => calls.length > 0, "the reply")
      expect(calls).toEqual([{ path: "/permission/per_000000000001/reply", body: { reply: "always" } }])
    })
  })
})

describe("the queue position", () => {
  test("a queue of two or more shows its position at the top right, in the dim color", async () => {
    for (const [position, total] of [
      [1, 2],
      [2, 3],
    ] as const) {
      await withPrompt({ scene: scenes()[0], position, total, width: 120, height: 40 }, async (app) => {
        const lines = panelLines(await stable(app))
        const mark = `${position}/${total}`
        expect(lines[1]).toMatch(new RegExp(`^│ Bash 需要权限 +${mark} │$`))
        expect(isColor((await spanOf(app, mark)).fg, theme.textDim)).toBe(true)
      })
    }
  })

  test("a single request shows no position, and the title no longer carries one", async () => {
    await withPrompt({ scene: scenes()[0], position: 1, total: 1 }, async (app) => {
      const frame = await stable(app)
      expect(frame).not.toContain("1/1")
      expect(inside(panelLines(frame)[1]).trim()).toBe("Bash 需要权限")
    })
  })

  test("a narrow terminal hides it by the rule of the panels", async () => {
    expect(PANEL_NARROW_WIDTH).toBe(100)
    await withPrompt({ scene: scenes()[0], position: 1, total: 2, width: 80, height: 24 }, async (app) => {
      const frame = await stable(app)
      expect(frame).not.toContain("1/2")
      expect(inside(panelLines(frame)[1]).trim()).toBe("Bash 需要权限")
    })
  })
})

describe("the hint row", () => {
  test("names the keys of the options as one pair, confirm and reject, in both languages", async () => {
    for (const [language, labels] of [
      ["zh-CN", ["或数字键选择", "确认", "拒绝"]],
      ["en", ["or number keys to pick", "Confirm", "Reject"]],
    ] as const) {
      await withPrompt({ scene: scenes()[0], language }, async (app) => {
        const lines = panelLines(await stable(app))
        const hints = inside(lines[lines.length - 2]).trim()
        // `<keys> <label>` pairs, in this order; the key names are whatever the keymap shows for them. Up and down are one
        // entry (`PanelHint.also`), so the separate previous and next labels are gone.
        const pattern = labels.map((label) => `\\S+ ${label}`).join(" · ")
        expect(hints).toMatch(new RegExp(`^${pattern}$`))
        for (const gone of language === "zh-CN" ? ["上一项", "下一项", "确认选择"] : ["Previous", "Next", "Select"])
          expect(hints).not.toContain(gone)
      })
    }
  })

  test("an edit that has a diff adds the fullscreen hint", async () => {
    await withPrompt({ scene: scenes()[1] }, async (app) => {
      const lines = panelLines(await stable(app))
      expect(inside(lines[lines.length - 2])).toContain("全屏")
    })
  })
})

describe("an edit whose diff is longer than the panel (#1651)", () => {
  for (const language of LANGUAGES) {
    // The terminal, and the rows of the diff in it.
    const sizes: Array<[number, number, number]> = [
      [80, 24, 4],
      [120, 40, 8],
    ]
    for (const [width, height, rows] of sizes) {
      test(`the options and the hint row stay in view and the diff takes the rows left, ${language}, ${width}x${height}`, async () => {
        await withPrompt({ scene: editLong(), language, width, height }, async (app) => {
          const frame = await stable(app)
          for (const text of [...OPTIONS[language], HINTS[language]])
            expect({ text, found: frame.includes(text) }).toEqual({ text, found: true })
          // The panel is as tall as the shell makes it, 45% of the terminal and 14 rows at the most, and the four rows
          // around them: the content rows are the path, the options, the two blank rows, and the diff has the rest.
          const content = Math.min(14, Math.floor(height * 0.45))
          expect(panelLines(frame).length).toBe(content + 4)
          expect(diffRowsOf(frame).length).toBe(rows)
          expect(rows).toBe(content - 1 - 3 - 2)
          // The diff starts at its first row; under its last row come a blank row and then the options.
          const lines = panelLines(frame)
          expect(diffRowsOf(frame)[0]).toContain("const keep1")
          const last = lines.indexOf(diffRowsOf(frame).at(-1)!)
          expect(inside(lines[last + 1]).trim()).toBe("")
          expect(lines[last + 2]).toContain(OPTIONS[language][0])
        })
      })
    }
  }

  test("the diff scrolls inside its area to its last row, and the options stay where they are", async () => {
    await withPrompt({ scene: editLong(), width: 80, height: 24 }, async (app) => {
      const before = await stable(app)
      const row = before.split("\n").findIndex((line) => line.includes("const keep1"))
      expect(row).toBeGreaterThan(0)
      expect(before).not.toContain("const tail6")
      for (let tick = 0; tick < 30; tick++) await app.mockMouse.scroll(10, row, "down")
      const after = await renderUntilFrame(app, (frame) => frame.includes("const tail6"), "the last row of the diff")
      expect(after).not.toContain("const keep1")
      // Nothing around the diff moved: the panel is as tall as it was, the same four rows of it, and the options sit
      // on the rows they had.
      expect(panelLines(after).length).toBe(panelLines(before).length)
      expect(diffRowsOf(after).length).toBe(4)
      expect(optionRowsOf(after)).toEqual(optionRowsOf(before))
      for (const text of [...OPTIONS["zh-CN"], HINTS["zh-CN"]]) expect(after).toContain(text)
    })
  })

  test("a short diff takes only its own rows and leaves no blank rows under it", async () => {
    await withPrompt({ scene: scenes()[1], width: 120, height: 40 }, async (app) => {
      const lines = panelLines(await stable(app))
      // Title, path, blank, the four rows of DIFF, blank, the three options, the hints and the borders.
      expect(lines.length).toBe(1 + 1 + 1 + 1 + 4 + 1 + 3 + 1 + 1)
    })
  })

  for (const language of LANGUAGES) {
    test(`at 12 rows the options stay in view and the diff is folded to one line of its counts, ${language}`, async () => {
      await withPrompt({ scene: editLong(), language, width: 80, height: 12 }, async (app) => {
        const frame = await stable(app)
        const lines = panelLines(frame)
        for (const text of [...OPTIONS[language], HINTS[language]])
          expect({ text, found: frame.includes(text) }).toEqual({ text, found: true })
        expect(diffRowsOf(frame)).toEqual([])
        expect(frame).not.toContain("const keep1")
        // The path, the counts and the three options with no blank row between them: five rows and the four around them,
        // which is all the 45% of 12 rows gives a panel.
        expect(lines.length).toBe(9)
        expect(inside(lines[3]).trim()).toBe("+14 \u221214")
        // The counts are those of a finished edit: added in the color of success, removed in the color of error.
        expect(isColor((await spanOf(app, "+14")).fg, theme.success)).toBe(true)
        expect(isColor((await spanOf(app, "\u221214")).fg, theme.error)).toBe(true)
      })
    })
  }

  test("a sub-agent's four options stay in view at 12 rows, and the counts give way to them", async () => {
    await withPrompt({ scene: editLong(), width: 80, height: 12, child: true }, async (app) => {
      const frame = await stable(app)
      expect(optionRowsOf(frame).length).toBe(4)
      expect(frame).not.toContain("+14")
      expect(panelLines(frame).length).toBe(9)
    })
  })

  test("with a few rows more the counts take blank rows to set them apart, and from 20 rows the diff comes back", async () => {
    for (const [height, shows] of [
      [14, "count"],
      [16, "count-gap"],
      [18, "count-gap"],
      [20, "diff"],
    ] as const) {
      await withPrompt({ scene: editLong(), width: 80, height }, async (app) => {
        const frame = await stable(app)
        const lines = panelLines(frame)
        expect({ height, options: optionRowsOf(frame).length }).toEqual({ height, options: 3 })
        const counts = lines.findIndex((row) => row.includes("+14"))
        const label = counts < 0 ? "diff" : inside(lines[counts - 1]).trim() === "" ? "count-gap" : "count"
        expect({ height, shows: label }).toEqual({ height, shows })
        if (shows === "diff") expect(diffRowsOf(frame).length).toBe(3)
      })
    }
  })

  test("a path that wraps takes its rows from the diff, never from the options", async () => {
    const path = `/repo/${"packages/tui/src/routes/session/".repeat(3)}app.ts`
    // A path of two rows leaves the diff its three rows; a longer one leaves it fewer than three, and then it is folded.
    for (const [file, rows] of [
      [path, 3],
      [`${path}, ${path}`, 0],
    ] as const) {
      await withPrompt({ scene: editLong(file), width: 80, height: 24 }, async (app) => {
        const frame = await stable(app)
        expect({ file: file.length, options: optionRowsOf(frame).length }).toEqual({ file: file.length, options: 3 })
        expect({ file: file.length, rows: diffRowsOf(frame).length }).toEqual({ file: file.length, rows })
        expect({ file: file.length, counts: frame.includes("+14 \u221214") }).toEqual({
          file: file.length,
          counts: rows === 0,
        })
        expect(panelLines(frame).length).toBeLessThanOrEqual(14)
      })
    }
  })

  test("the fullscreen ask gives the diff the rows of the terminal and keeps the options", async () => {
    await withPrompt({ scene: editLong(), width: 80, height: 24 }, async (app) => {
      app.mockInput.pressKey("f", { ctrl: true })
      // In this test renderer the fullscreen ask comes out without the side borders of the panel (it did before this
      // change too), so its rows are told by their indent and not by the border: a numbered line of the diff with
      // nothing to its left.
      const numbered = (frame: string) => frame.split("\n").filter((line) => /^ +\d+ [-+ ]/.test(line))
      const frame = await renderUntilFrame(app, (text) => numbered(text).length > 0, "the fullscreen ask")
      for (const text of OPTIONS["zh-CN"]) expect(frame).toContain(text)
      // 24 − 6 rows of content: the path, the options, the two blank rows and twelve rows of the diff.
      expect(numbered(frame).length).toBe(12)
    })
  })
})

describe("how the rows of an ask that has a diff are divided", () => {
  test("the diff takes what the path, the options and the two blank rows leave, and folds under three rows", () => {
    // [budget, rows that always stand] → what the ask draws of its diff.
    const cases: Array<[number, number, DiffFit]> = [
      [14, 4, { show: "diff", gap: 1 }],
      [10, 4, { show: "diff", gap: 1 }],
      [9, 4, { show: "diff", gap: 1 }],
      [8, 4, { show: "count", gap: 1 }],
      [7, 4, { show: "count", gap: 1 }],
      [6, 4, { show: "count", gap: 0 }],
      [5, 4, { show: "count", gap: 0 }],
      [4, 4, { show: "none", gap: 0 }],
      [5, 5, { show: "none", gap: 0 }],
      [6, 5, { show: "count", gap: 0 }],
      [10, 5, { show: "diff", gap: 1 }],
      [9, 5, { show: "count", gap: 1 }],
    ]
    for (const [budget, fixed, expected] of cases)
      expect({ budget, fixed, fit: fitDiff(budget, fixed) }).toEqual({ budget, fixed, fit: expected })
  })

  test("what it draws never needs more rows than the panel has, as long as the rows that always stand fit", () => {
    for (let budget = 1; budget <= 30; budget++) {
      for (let fixed = 1; fixed <= 8; fixed++) {
        if (fixed > budget) continue
        const fit = fitDiff(budget, fixed)
        const diff = fit.show === "diff" ? 3 : fit.show === "count" ? 1 : 0
        const gaps = fit.show === "none" ? 0 : 2 * fit.gap
        expect({ budget, fixed, fits: fixed + diff + gaps <= budget }).toEqual({ budget, fixed, fits: true })
      }
    }
  })
})

describe("frames", () => {
  // The five requests #1619 names, each once in either language at 80x24 (AGENTS.md 8: new panel text gets an 80-column
  // frame per language) and once in English at 120x40 laid out at ambiguous_width 2. A queue of two puts its position
  // at the top right wherever the panel is wide enough to show it.
  for (const scene of scenes()) {
    test(`${scene.id} at 80x24`, async () => {
      await withPrompt({ scene, language: "zh-CN", width: 80, height: 24, total: 2 }, async (app) => {
        expect(await stable(app)).toMatchSnapshot()
      })
    })

    test(`${scene.id} at 80x24 in English`, async () => {
      await withPrompt({ scene, language: "en", width: 80, height: 24, total: 2 }, async (app) => {
        expect(await stable(app)).toMatchSnapshot()
      })
    })

    test(`${scene.id} at 120x40 in English with ambiguous_width 2`, async () => {
      await withPrompt({ scene, language: "en", width: 120, height: 40, ambiguousWidth: 2, total: 2 }, async (app) => {
        expect(await stable(app)).toMatchSnapshot()
      })
    })
  }

  // The edit whose diff is longer than the panel (#1651): the diff scrolls in its area, and at 12 rows it is one line.
  for (const [width, height, language, ambiguousWidth] of [
    [80, 24, "zh-CN", 1],
    [80, 24, "en", 1],
    [120, 40, "en", 2],
    [80, 12, "zh-CN", 1],
    [80, 12, "en", 1],
  ] as const) {
    test(`edit-long at ${width}x${height} in ${language} with ambiguous_width ${ambiguousWidth}`, async () => {
      await withPrompt({ scene: editLong(), language, width, height, ambiguousWidth, total: 2 }, async (app) => {
        expect(await stable(app)).toMatchSnapshot()
      })
    })
  }
})

describe("it fits the terminal", () => {
  for (const language of LANGUAGES) {
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      for (const ambiguousWidth of [1, 2] as const) {
        test(`nothing is laid out wider than the panel, ${language}, ${width}x${height}, ambiguous_width ${ambiguousWidth}`, async () => {
          for (const scene of scenes(true)) {
            await withPrompt({ scene, language, width, height, ambiguousWidth, position: 2, total: 3 }, async (app) => {
              const frame = await stable(app)
              const lines = panelLines(frame)
              for (const line of lines.filter((row) => row.startsWith("│") && row.endsWith("│"))) {
                // Inside the border: the padding and what the panel itself laid out.
                const fits = cellWidth(inside(line).replace(SCROLL_THUMB, "#").trimEnd(), ambiguousWidth) <= width - 3
                expect({ scene: scene.id, line, fits }).toEqual({ scene: scene.id, line, fits: true })
              }
              // The title is on one row, with the tool in it, whatever the width.
              expect(inside(lines[1])).toContain(language === "zh-CN" ? "需要权限" : "needs permission")
              // The three options and the hint row are in view, whatever the request holds.
              expect({ scene: scene.id, options: optionRowsOf(frame).length }).toEqual({ scene: scene.id, options: 3 })
              expect(inside(lines[lines.length - 2])).toContain(HINTS[language])
            })
          }
        })
      }
    }
  }
})
