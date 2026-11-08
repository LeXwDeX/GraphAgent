import { expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TerminalColors } from "@opentui/core"
import { Schema } from "effect"
import { DEFAULT_THEMES, addTheme, allThemes, hasTheme, resolveTheme, terminalMode, tint } from "../src/theme"
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

test("derives new token fallbacks for themes that do not define them", () => {
  const theme = resolveTheme(DEFAULT_THEMES.aura, "dark")
  const ints = (color: { toInts(): number[] }) => color.toInts()
  expect(ints(theme.textDim)).toEqual(ints(tint(theme.textMuted, theme.background, 0.5)))
  expect(ints(theme.backgroundSelected)).toEqual(ints(tint(theme.backgroundPanel, theme.primary, 0.12)))
  expect(ints(theme.backgroundUser)).toEqual(ints(theme.backgroundElement))
  expect(ints(theme.borderWarning)).toEqual(ints(tint(theme.border, theme.warning, 0.4)))
  expect(ints(theme.logoFace)).toEqual(ints(theme.textMuted))
  expect(ints(theme.logoAccent)).toEqual(ints(theme.primary))
  expect(ints(theme.logoShadow)).toEqual(ints(tint(theme.background, theme.textMuted, 0.25)))
  expect(ints(theme.statusRunning)).toEqual(ints(theme.primary))
  expect(ints(theme.statusQueued)).toEqual(ints(theme.textDim))
  expect(ints(theme.statusPaused)).toEqual(ints(theme.warning))
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
