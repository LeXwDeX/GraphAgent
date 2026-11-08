import { createMemo, type ParentProps } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"

/** Fixed width of the drawer overlay in terminal cells. */
export const DRAWER_WIDTH = 40

/** Below this width the drawer stops opening automatically in `auto` mode. */
const AUTO_WIDTH = 120

/**
 * Display policy for the drawer. `hidden` never opens on its own, `auto` opens
 * on wide terminals, and `always` keeps it open until the user closes it.
 */
export type DrawerMode = "hidden" | "auto" | "always"

/**
 * Reads the persisted drawer policy and exposes the derived visibility plus
 * the toggle/close actions shared by the frame and the session keybindings.
 */
export function useDrawer() {
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const [mode, setMode] = kv.signal<DrawerMode>("drawer_mode", "hidden")
  const wide = createMemo(() => dimensions().width > AUTO_WIDTH)
  const visible = createMemo(() => mode() === "always" || (mode() === "auto" && wide()))

  return {
    mode,
    visible,
    toggle() {
      setMode(() => (visible() ? "hidden" : "always"))
    },
    close() {
      setMode(() => "hidden")
    },
  }
}

/**
 * Drawer slot: an absolute overlay on the right edge of the main/status area,
 * from the top bar down to the bottom zone (F4). It never squeezes the main
 * area and never covers the bottom zone or footer.
 */
export function Drawer(props: ParentProps) {
  const { theme } = useTheme()
  return (
    <box
      position="absolute"
      right={0}
      top={0}
      bottom={0}
      width={DRAWER_WIDTH}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
    >
      {props.children}
    </box>
  )
}
