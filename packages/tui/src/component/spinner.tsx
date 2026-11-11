import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { createTicker } from "../context/ticker"
import { useOptionalTicker } from "../context/ticker-context"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * Braille spinner driven by the shared ticker. It subscribes only while it is
 * visible: mounted-but-scrolled-out rows keep a static frame and cause no
 * renders. Run mode renders this component outside `TickerProvider`, so it
 * falls back to a local ticker (one timer per instance in that mode only).
 */
export function Spinner(props: { children?: JSX.Element; color?: RGBA; visible?: Accessor<boolean> }) {
  const { theme } = useTheme()
  const kv = useKV()
  const ticker = useOptionalTicker()
  const animations = () => kv.get("animations_enabled", true)
  const local = ticker ? undefined : createTicker({ animationsEnabled: animations })
  const color = () => props.color ?? theme.textMuted
  const visible = () => animations() && (props.visible?.() ?? true)

  const frame = createMemo(() => {
    const source = ticker ?? local
    return source ? source.frame() : 0
  })

  createEffect(() => {
    const source = ticker ?? local
    if (!source || !visible()) return
    onCleanup(source.subscribe())
  })

  return (
    <Show when={animations()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <text fg={color()}>{SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]}</text>
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
