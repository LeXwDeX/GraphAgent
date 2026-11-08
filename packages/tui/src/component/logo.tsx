import { RGBA, TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { tint, useTheme } from "../context/theme"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH } from "../logo"

type Segment = { text: string; shadow: boolean }

function segments(line: string): Segment[] {
  const parts: Segment[] = []
  for (const char of line) {
    const shadow = char !== "█" && char !== " "
    const last = parts.at(-1)
    if (last && last.shadow === shadow) {
      last.text += char
      continue
    }
    parts.push({ text: char, shadow })
  }
  return parts
}

export function Logo() {
  const { theme } = useTheme()

  const line = (text: string, fg: RGBA) => {
    const shadow = tint(theme.background, fg, 0.25)
    return (
      <For each={segments(text)}>
        {(part) => (
          <text fg={part.shadow ? shadow : fg} attributes={TextAttributes.BOLD} selectable={false}>
            {part.text}
          </text>
        )}
      </For>
    )
  }

  return (
    <box>
      <For each={LOGO_GRAPH}>
        {(graph, index) => (
          <box flexDirection="row">
            {line(graph, theme.textMuted)}
            <text selectable={false}>{" ".repeat(LOGO_GAP)}</text>
            {line(LOGO_AGENT[index()] ?? "", theme.text)}
          </box>
        )}
      </For>
    </box>
  )
}
