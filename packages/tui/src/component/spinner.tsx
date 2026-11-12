import { ScrollBoxRenderable, type BoxRenderable, type RGBA, type Renderable } from "@opentui/core"
import { useRenderer, type JSX } from "@opentui/solid"
import { Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { createTicker } from "../context/ticker"
import { useOptionalTicker } from "../context/ticker-context"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function nearestScrollBox(node: Renderable) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent instanceof ScrollBoxRenderable) return parent
  }
  return undefined
}

/**
 * Braille spinner driven by the shared ticker. It subscribes only while it is
 * visible: mounted-but-scrolled-out rows keep a static frame and cause no
 * renders. "Visible" is the caller's `visible` (the windowed transcript knows
 * its viewport rows) and the spinner's own position in the nearest scroll box,
 * so a fully mounted transcript is held to the same rule. Run mode renders this
 * component outside `TickerProvider`, so it falls back to a local ticker (one
 * timer per instance in that mode only).
 */
export function Spinner(props: { children?: JSX.Element; color?: RGBA; visible?: Accessor<boolean> }) {
  const { theme } = useTheme()
  const kv = useKV()
  const renderer = useRenderer()
  const ticker = useOptionalTicker()
  const animations = () => kv.get("animations_enabled", true)
  const local = ticker ? undefined : createTicker({ animationsEnabled: animations })
  const color = () => props.color ?? theme.textMuted
  // On screen until a laid-out position says otherwise, so a spinner that is
  // visible when it mounts never starts static.
  const [onScreen, setOnScreen] = createSignal(true)
  const visible = () => animations() && onScreen() && (props.visible?.() ?? true)

  const watchPosition = (node: BoxRenderable) => {
    let scroll: ScrollBoxRenderable | undefined
    let offset = 0
    let passes = 0
    node.onLifecyclePass = () => {
      if (node.isDestroyed || !node.parent) return
      scroll ??= nearestScrollBox(node)
      if (!scroll) {
        // A footer or the run mode: nothing scrolls it away.
        renderer.unregisterLifecyclePass(node)
        return
      }
      // A pass runs before the layout of its frame, so the first one precedes
      // the node's first layout and its position is a placeholder.
      if (++passes < 2) {
        offset = scroll.scrollTop
        return
      }
      // A node outside the viewport is culled: it keeps a position but reports
      // no size, so a missing size is read as one line.
      const top = node.y
      const bottom = top + Math.max(1, node.height)
      const { y, height } = scroll.viewport
      setOnScreen(bottom > y && top < y + height)
      // The position above is the one the last layout produced. When the box has
      // scrolled since, that layout is stale, so ask for the frame that
      // re-measures it; otherwise a spinner scrolled into view would stay static
      // until something else drew.
      if (scroll.scrollTop !== offset) {
        offset = scroll.scrollTop
        renderer.requestRender()
      }
    }
    renderer.registerLifecyclePass(node)
    onCleanup(() => renderer.unregisterLifecyclePass(node))
  }

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
      <box flexDirection="row" gap={1} ref={watchPosition}>
        <text fg={color()}>{SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]}</text>
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
