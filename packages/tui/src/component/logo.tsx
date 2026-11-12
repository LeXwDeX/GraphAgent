import { APP_TITLE } from "@graphagent/core/brand"
import { StyledText, TextAttributes, type RGBA, type TextChunk, type TextRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createRenderEffect, For, Show } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MIN_COLUMNS, LOGO_MIN_ROWS } from "../logo"
import { cellWidth, type AmbiguousWidth } from "../ui/width"

/** Colour class of one wordmark cell: GRAPH face, AGENT face, outline, or nothing drawn. */
export type LogoTone = "face" | "accent" | "shadow" | "blank"

/** Neighbouring cells of one tone; `start` is the 0-based column of the first cell. */
export type LogoRun = { tone: LogoTone; text: string; start: number }

function toneOf(char: string, accent: boolean): LogoTone {
  if (char === " ") return "blank"
  if (char === "█") return accent ? "accent" : "face"
  return "shadow"
}

/**
 * One wordmark row (GRAPH, gap, AGENT) merged into runs of the same tone. The gap is
 * its own blank run, so the GRAPH / AGENT boundary sits at column `LOGO_GRAPH[row].length`.
 */
export function logoRuns(row: number): LogoRun[] {
  const runs: LogoRun[] = []
  let column = 0
  const push = (char: string, tone: LogoTone) => {
    const last = runs.at(-1)
    if (last && last.tone === tone) last.text += char
    else runs.push({ tone, text: char, start: column })
    column += 1
  }

  for (const char of LOGO_GRAPH[row] ?? "") push(char, toneOf(char, false))
  for (let gap = 0; gap < LOGO_GAP; gap++) push(" ", "blank")
  for (const char of LOGO_AGENT[row] ?? "") push(char, toneOf(char, true))
  return runs
}

/** Display width of the widest wordmark row; box and block glyphs are East Asian Ambiguous. */
function wordmarkWidth(ambiguousWidth: AmbiguousWidth) {
  const rows = LOGO_GRAPH.map((graph, row) => (graph + " ".repeat(LOGO_GAP) + (LOGO_AGENT[row] ?? "")).trimEnd())
  return Math.max(...rows.map((text) => cellWidth(text, ambiguousWidth)))
}

/**
 * The wordmark needs a wide and tall terminal; anything smaller gets the one-line mark.
 * With `ambiguous_width = 2` the glyphs take two cells each, so the terminal must also be
 * wide enough for that.
 */
export function logoFits(size: { width: number; height: number }, ambiguousWidth: AmbiguousWidth = 1) {
  return size.width >= LOGO_MIN_COLUMNS && size.height >= LOGO_MIN_ROWS && wordmarkWidth(ambiguousWidth) <= size.width
}

/** `◇─◆ GraphAgent`: the one-line mark, drawn like the one in the top bar. */
export function LogoMark() {
  const { theme } = useTheme()
  return (
    <text fg={theme.text} wrapMode="none" selectable={false}>
      <span style={{ fg: theme.textMuted }}>◇─</span>
      <span style={{ fg: theme.primary }}>◆</span>
      <span> </span>
      <b>{APP_TITLE}</b>
    </text>
  )
}

/**
 * One wordmark row as a single text node. The colours live in the chunks of its styled
 * content, so a row costs one node however many glyph runs it has.
 */
function WordmarkRow(props: { row: number }) {
  const { theme } = useTheme()
  const color = (tone: LogoTone): RGBA | undefined => {
    if (tone === "face") return theme.logoFace
    if (tone === "accent") return theme.logoAccent
    if (tone === "shadow") return theme.logoShadow
    return undefined
  }
  const content = () =>
    new StyledText(
      logoRuns(props.row).map((run): TextChunk => ({
        __isChunk: true,
        text: run.text,
        fg: color(run.tone),
        attributes: TextAttributes.BOLD,
      })),
    )

  return (
    <text
      wrapMode="none"
      selectable={false}
      ref={(node: TextRenderable) => {
        // The Solid renderer stringifies a `content` prop, so the styled content is assigned
        // directly; the effect only re-runs when the theme changes.
        createRenderEffect(() => {
          node.content = content()
        })
      }}
    />
  )
}

function Wordmark() {
  return (
    <box flexShrink={0}>
      <For each={LOGO_GRAPH}>{(_, row) => <WordmarkRow row={row()} />}</For>
    </box>
  )
}

/** Home screen logo: the wordmark on a wide, tall terminal, the one-line mark otherwise. */
export function Logo() {
  const dimensions = useTerminalDimensions()
  const kv = useKV()
  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  return (
    <Show when={logoFits(dimensions(), ambiguousWidth())} fallback={<LogoMark />}>
      <Wordmark />
    </Show>
  )
}
