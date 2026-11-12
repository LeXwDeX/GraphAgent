// Character data for the GraphAgent wordmark. Rendering (colors, shadow
// shading, breakpoints, theme tokens) belongs to F1; this module only owns
// the glyphs.
//
// Classification for renderers: `█` is drawn with the foreground color
// (GRAPH light gray, AGENT brand blue), box-drawing characters `╗╔╝╚║═`
// with the shadow color, spaces are transparent.

export const LOGO_GRAPH: readonly string[] = [
  " ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗",
  "██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║",
  "██║  ███╗██████╔╝███████║██████╔╝███████║",
  "██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔══██║",
  "╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║",
  " ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝",
]

export const LOGO_AGENT: readonly string[] = [
  " █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
]

export const LOGO_GAP = 2

export const LOGO_WIDTH = 87

export const LOGO_MIN_COLUMNS = 90

/** The home screen also needs this many rows for the wordmark; shorter terminals get the mini mark. */
export const LOGO_MIN_ROWS = 22

export const LOGO_MINI = "◇─◆ GraphAgent"
