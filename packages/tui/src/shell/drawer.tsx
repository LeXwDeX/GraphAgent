// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createSignal, type ParentProps, type Signal } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"

/** Fixed width of the drawer overlay in terminal cells. */
export const DRAWER_WIDTH = 40

/** `auto` opens the drawer while the terminal is wider than this. */
export const DRAWER_AUTO_WIDTH = 120

/**
 * Display policy for the drawer. `hidden` never opens on its own, `auto` opens
 * on wide terminals, and `always` keeps it open until the user closes it.
 */
export type DrawerMode = "hidden" | "auto" | "always"

const MODES: readonly DrawerMode[] = ["hidden", "auto", "always"]

/** The stored policy; anything else in the key (a hand-edited or future value) reads as the default. */
export function drawerMode(value: unknown): DrawerMode {
  return MODES.find((mode) => mode === value) ?? "hidden"
}

/** Whether the policy alone opens the drawer at a terminal width. `auto` follows the live width (#1032 D7). */
export function drawerOpensByPolicy(mode: DrawerMode, width: number) {
  return mode === "always" || (mode === "auto" && width > DRAWER_AUTO_WIDTH)
}

/**
 * The user's own open or close, held in memory only (#1032 5.1, D7): it wins over the policy until the process ends
 * or the policy is changed in `/config`, and nothing of it is written to the kv file. Keyed by the kv store so each
 * mounted app has its own, without a new context; `undefined` means the user has not touched the drawer.
 */
const manualByApp = new WeakMap<object, Signal<boolean | undefined>>()

function manualFor(kv: object) {
  const existing = manualByApp.get(kv)
  if (existing) return existing
  const created = createSignal<boolean | undefined>(undefined)
  manualByApp.set(kv, created)
  return created
}

/**
 * Reads the drawer policy and exposes the derived visibility plus the toggle/close actions shared by the frame, the
 * session keybindings and `/config`. The legacy kv `sidebar` is never read (#1032 5.1).
 */
export function useDrawer() {
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const [manual, setManual] = manualFor(kv)
  const mode = createMemo(() => drawerMode(kv.get("drawer_mode")))
  const visible = createMemo(() => manual() ?? drawerOpensByPolicy(mode(), dimensions().width))

  return {
    mode,
    visible,
    toggle() {
      setManual(!visible())
    },
    close() {
      setManual(false)
    },
    /** Stores a new policy and drops the manual choice, so the policy shows at once. */
    setMode(next: DrawerMode) {
      kv.set("drawer_mode", next)
      setManual(undefined)
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
