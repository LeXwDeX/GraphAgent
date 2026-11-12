import { APP_NAME } from "@graphagent/core/brand"
import { t } from "../i18n"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MINI, LOGO_MIN_COLUMNS } from "../logo"
import { cellWidth } from "../ui/width"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

type Palette = { face: string; shadow: string }

// Same palette as the CLI banner: GRAPH face in gray, AGENT face in the default
// foreground, outlines in two dark grays.
const GRAPH_PALETTE: Palette = { face: dim, shadow: "\x1b[38;5;235m" }
const AGENT_PALETTE: Palette = { face: reset, shadow: "\x1b[38;5;238m" }
const LABEL_WIDTH = 10

function paint(line: string, palette: Palette) {
  let result = ""
  for (const char of line) {
    result += char === " " ? char : `${char === "█" ? palette.face : palette.shadow}${char}${reset}`
  }
  return result
}

/** Wide terminals get the block wordmark; everything else gets the single-line mark. */
function wordmark(pad: string, columns: number | undefined) {
  if (columns === undefined || columns < LOGO_MIN_COLUMNS) return [`${pad}${bold}${LOGO_MINI}${reset}`]
  return LOGO_GRAPH.map((row, index) =>
    `${pad}${paint(row, GRAPH_PALETTE)}${" ".repeat(LOGO_GAP)}${paint(LOGO_AGENT[index] ?? "", AGENT_PALETTE)}`.trimEnd(),
  )
}

export function sessionEpilogue(input: { title: string; sessionID?: string; columns?: number }) {
  const columns = input.columns ?? (process.stdout.isTTY ? process.stdout.columns : undefined)
  const weak = (text: string) => `${dim}${text}${" ".repeat(Math.max(0, LABEL_WIDTH - cellWidth(text)))}${reset}`
  return [
    ...wordmark("  ", columns),
    "",
    `  ${weak(t("exit.session"))}${bold}${input.title}${reset}`,
    `  ${weak(t("exit.continue"))}${bold}${APP_NAME} -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
