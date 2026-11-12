import { expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { RGBA, type TerminalColors } from "@opentui/core"
import { Schema } from "effect"
import {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  hasTheme,
  resolveTheme,
  terminalMode,
  tint,
  type Theme,
} from "../src/theme"
import { ThemeConfig } from "../src/theme/schema"
import { discoverThemes } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

test("bundled themes match the published theme schema", async () => {
  const assets = path.join(import.meta.dir, "../src/theme/assets")
  const files = (await readdir(assets)).filter((file) => file.endsWith(".json"))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const theme = await Bun.file(path.join(assets, file)).json()
    expect(
      () => Schema.decodeUnknownSync(ThemeConfig.Info)(theme),
      `${file} should match ThemeConfig.Info`,
    ).not.toThrow()
  }
})

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.graphagent)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.graphagent)
  const two = structuredClone(DEFAULT_THEMES.graphagent)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.graphagent)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.graphagent)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

test("ships graphagent as the default theme", () => {
  expect(DEFAULT_THEMES.graphagent).toBeDefined()
  expect(DEFAULT_THEMES.opencode).toBeUndefined()
})

/** Tokens added after the legacy themes were written; those theme files leave them out. */
const NEW_TOKENS = [
  "textDim",
  "backgroundSelected",
  "backgroundUser",
  "borderWarning",
  "logoFace",
  "logoAccent",
  "logoShadow",
  "statusRunning",
  "statusQueued",
  "statusPaused",
] as const satisfies readonly (keyof Theme)[]

const MODES = ["dark", "light"] as const
const legacyThemes = Object.entries(DEFAULT_THEMES).filter(([name]) => name !== "graphagent")

test("ships the 32 legacy themes next to graphagent", () => {
  expect(legacyThemes).toHaveLength(32)
  expect(Object.keys(DEFAULT_THEMES)).toHaveLength(33)
})

test("every bundled theme resolves each new token to a color in both modes", () => {
  for (const [name, json] of Object.entries(DEFAULT_THEMES)) {
    for (const mode of MODES) {
      const theme = resolveTheme(json, mode)
      for (const token of NEW_TOKENS) {
        const color: Theme[typeof token] | undefined = theme[token]
        expect(color, `${name} ${mode} ${token}`).toBeDefined()
        const channels = color?.toInts() ?? []
        expect(channels, `${name} ${mode} ${token}`).toHaveLength(4)
        expect(channels.every(Number.isFinite), `${name} ${mode} ${token}`).toBe(true)
      }
    }
  }
})

test("derives new token fallbacks for every legacy theme", () => {
  const ints = (color: { toInts(): number[] }) => color.toInts()
  let checked = 0
  let explicit = 0
  for (const [name, json] of legacyThemes) {
    for (const mode of MODES) {
      const theme = resolveTheme(json, mode)
      const textDim = tint(theme.textMuted, theme.background, 0.5)
      const expected: Record<(typeof NEW_TOKENS)[number], { toInts(): number[] }> = {
        textDim,
        backgroundSelected: tint(theme.backgroundPanel, theme.primary, 0.12),
        backgroundUser: theme.backgroundElement,
        borderWarning: tint(theme.border, theme.warning, 0.4),
        logoFace: theme.textMuted,
        logoAccent: theme.primary,
        logoShadow: tint(theme.background, theme.textMuted, 0.25),
        statusRunning: theme.primary,
        statusQueued: textDim,
        statusPaused: theme.warning,
      }
      for (const token of NEW_TOKENS) {
        // A legacy theme that defines the token itself keeps its own value.
        if (json.theme[token] !== undefined) {
          explicit++
          continue
        }
        expect(ints(theme[token]), `${name} ${mode} ${token}`).toEqual(ints(expected[token]))
        checked++
      }
    }
  }
  // 32 themes x 2 modes x 10 tokens: a loop that silently skips everything must not pass.
  expect(checked + explicit).toBe(legacyThemes.length * MODES.length * NEW_TOKENS.length)
  expect(checked).toBeGreaterThan(0)
})

function channel(value: number) {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(color: { toInts(): number[] }) {
  const [r = 0, g = 0, b = 0] = color.toInts()
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: { toInts(): number[] }, b: { toInts(): number[] }) {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

test("graphagent theme meets contrast requirements", () => {
  for (const mode of ["dark", "light"] as const) {
    const theme = resolveTheme(DEFAULT_THEMES.graphagent, mode)
    expect(contrast(theme.text, theme.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.text, theme.backgroundPanel)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.textMuted, theme.background)).toBeGreaterThanOrEqual(3)
    expect(contrast(theme.textMuted, theme.backgroundPanel)).toBeGreaterThanOrEqual(3)
    expect(contrast(theme.primary, theme.background)).toBeGreaterThanOrEqual(3)
    expect(contrast(theme.selectedListItemText, theme.backgroundSelected)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.diffAdded, theme.diffAddedBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.diffRemoved, theme.diffRemovedBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.diffHighlightAdded, theme.diffAddedBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.diffHighlightRemoved, theme.diffRemovedBg)).toBeGreaterThanOrEqual(4.5)
  }
})

function themeHex(value: unknown, mode: "dark" | "light") {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && mode in value) return (value as Record<string, string>)[mode]
  return undefined
}

test("graphagent theme keeps the brand color inside its whitelist", () => {
  const whitelist = new Set(["primary", "accent", "logoAccent", "statusRunning"])
  for (const mode of ["dark", "light"] as const) {
    const brand = themeHex(DEFAULT_THEMES.graphagent.theme.primary, mode)
    for (const [key, value] of Object.entries(DEFAULT_THEMES.graphagent.theme)) {
      if (key === "thinkingOpacity" || whitelist.has(key)) continue
      expect(themeHex(value, mode)?.toLowerCase(), key).not.toBe(brand?.toLowerCase())
    }
  }
})

test("graphagent theme keeps neutral roles gray", () => {
  const neutral = [
    "secondary",
    "info",
    "success",
    "text",
    "textMuted",
    "textDim",
    "background",
    "backgroundPanel",
    "backgroundElement",
    "backgroundSelected",
    "backgroundUser",
    "border",
    "borderActive",
    "borderSubtle",
    "logoFace",
    "logoShadow",
    "statusQueued",
  ]
  for (const mode of ["dark", "light"] as const) {
    for (const key of neutral) {
      const value = themeHex(DEFAULT_THEMES.graphagent.theme[key as keyof typeof DEFAULT_THEMES.graphagent.theme], mode)
      expect(value, key).toBeDefined()
      const channels = [1, 3, 5].map((index) => Number.parseInt(value!.slice(index, index + 2), 16))
      const chroma = (Math.max(...channels) - Math.min(...channels)) / 255
      expect(chroma, `${mode} ${key}`).toBeLessThanOrEqual(0.1)
    }
  }
})

/*
 * Palette lint (#886 1.3): `primary` is the one saturated hue of the `graphagent` theme; every
 * other place is gray or a muted tint. A token is saturated at an HSL saturation of 0.6 or more.
 * The only tokens allowed above the limit are the ones below; each entry says why, and the
 * tests after the lint keep the lists honest.
 */
const SATURATION_LIMIT = 0.6

/** The brand color and the tokens that carry its value by design (#886 1.1 and 1.2). */
const BRAND_TOKENS = ["primary", "accent", "logoAccent", "statusRunning"] as const

/**
 * Semantic status colors have to be recognizable at a glance, so they may be as saturated as they
 * need to be. Only tokens that really cross the limit are listed. `error` stays under it (0.57 dark,
 * 0.50 light) and has no entry of its own.
 */
const STATUS_TOKENS = {
  /** `warning` and the tokens that reuse its amber: 0.75 in the light variant (0.50 in the dark one). */
  warning: ["warning", "statusPaused", "markdownEmph", "syntaxKeyword", "syntaxNumber"],
  /** The lighter shade of `error` for highlighted removals: 0.65 in the dark variant. */
  error: ["diffHighlightRemoved"],
} as const

const EXEMPT = new Set<string>([...BRAND_TOKENS, ...STATUS_TOKENS.warning, ...STATUS_TOKENS.error])

/** HSL saturation: 0 for grays, 1 for a pure hue. */
function saturation(color: RGBA) {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  const lightness = (max + min) / 2
  const spread = 1 - Math.abs(2 * lightness - 1)
  return spread === 0 ? 0 : (max - min) / spread
}

/** Hue angle in degrees. */
function hue(color: RGBA) {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  const spread = max - min
  if (spread === 0) return 0
  const angle =
    max === color.r
      ? ((color.g - color.b) / spread) % 6
      : max === color.g
        ? (color.b - color.r) / spread + 2
        : (color.r - color.g) / spread + 4
  return (angle * 60 + 360) % 360
}

function colorTokens(mode: "dark" | "light") {
  const theme = resolveTheme(DEFAULT_THEMES.graphagent, mode)
  return Object.entries(theme).flatMap(([token, value]) => (value instanceof RGBA ? [[token, value] as const] : []))
}

test("graphagent keeps every token below the saturation limit except the brand and status colors", () => {
  for (const mode of ["dark", "light"] as const) {
    const tokens = colorTokens(mode)
    // The lint has to see the whole palette, not an empty or partial one.
    expect(tokens.length).toBeGreaterThan(60)
    for (const [token, color] of tokens) {
      if (EXEMPT.has(token)) continue
      expect(saturation(color), `${mode} ${token}`).toBeLessThan(SATURATION_LIMIT)
    }
  }
})

test("success is gray, well below the saturation limit", () => {
  for (const mode of ["dark", "light"] as const) {
    const theme = resolveTheme(DEFAULT_THEMES.graphagent, mode)
    expect(EXEMPT.has("success")).toBe(false)
    expect(saturation(theme.success), mode).toBeLessThan(SATURATION_LIMIT)
  }
})

test("the brand tokens carry the brand value and are the saturated ones", () => {
  for (const mode of ["dark", "light"] as const) {
    const theme = resolveTheme(DEFAULT_THEMES.graphagent, mode)
    for (const token of BRAND_TOKENS) {
      expect(theme[token].toInts(), `${mode} ${token}`).toEqual(theme.primary.toInts())
    }
    expect(saturation(theme.primary), mode).toBeGreaterThanOrEqual(SATURATION_LIMIT)
  }
})

test("every status exemption is needed and stays inside its family", () => {
  const exceeds = new Set<string>()
  for (const mode of ["dark", "light"] as const) {
    const theme = resolveTheme(DEFAULT_THEMES.graphagent, mode)
    for (const [token, color] of colorTokens(mode)) if (saturation(color) >= SATURATION_LIMIT) exceeds.add(token)

    // The warning family is one amber: the tokens that reuse it carry exactly its value.
    for (const token of STATUS_TOKENS.warning) {
      expect(theme[token].toInts(), `${mode} ${token}`).toEqual(theme.warning.toInts())
    }
    // The error highlight is a shade of `error`, not another hue.
    for (const token of STATUS_TOKENS.error) {
      const distance = Math.abs(hue(theme[token]) - hue(theme.error))
      expect(Math.min(distance, 360 - distance), `${mode} ${token}`).toBeLessThanOrEqual(6)
    }
    // `error` itself needs no exemption.
    expect(saturation(theme.error), mode).toBeLessThan(SATURATION_LIMIT)
  }

  // Nothing is exempt "just in case": each entry crosses the limit in at least one variant.
  for (const token of EXEMPT) expect(exceeds.has(token), token).toBe(true)
  for (const token of exceeds) expect(EXEMPT.has(token), token).toBe(true)
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
