import type { ParentProps } from "solid-js"
import { useTheme } from "../context/theme"

/** Fixed width of the drawer overlay in terminal cells. */
export const DRAWER_WIDTH = 40

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
