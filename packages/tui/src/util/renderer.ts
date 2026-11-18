import type { CliRenderer } from "@opentui/core"

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  if (renderer.isDestroyed) return
  renderer.setTerminalTitle("")
  renderer.destroy()
}

/**
 * Ceiling for the listeners on one renderer event. Every mounted `useTerminalDimensions()` caller holds one `resize`
 * listener on the renderer, so the count follows the screen: 10 with the app idle, 13 with the `/dag` panel open
 * (#1425). Node warns past 10 (`MaxListenersExceededWarning`), and did so on every mount. The count is bounded: it
 * does not grow when panels open and close or the terminal is resized, so the limit is a fixed value above that peak.
 * Anything past it is a leak and the warning is the signal. Do not raise it to 0 (unlimited): that mutes the signal.
 */
export const RENDERER_LISTENER_LIMIT = 32

/**
 * Applies `RENDERER_LISTENER_LIMIT`. The app root calls it before any panel mounts, and so do the test harnesses that
 * mirror the root (`mountRoute`): a harness without it would warn on every mount of a full screen.
 */
export function limitRendererListeners(renderer: { setMaxListeners(max: number): unknown }) {
  renderer.setMaxListeners(RENDERER_LISTENER_LIMIT)
}
