// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Session } from "@graphagent/sdk"
import { createMemo } from "solid-js"
import { Main } from "../../src/routes/session"
import { AppFrame } from "../../src/shell/app-frame"
import { BottomZone, BottomZoneProvider, createBottomZoneState } from "../../src/shell/bottom-zone"
import { useDrawer } from "../../src/shell/drawer"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "./dag-mode-harness"

export const SHELL_SESSION = "ses_shell"

export type SessionShellOptions = {
  /** Session shown first; defaults to `SHELL_SESSION`. */
  sessionID?: string
  /** Sessions the server lists; defaults to just the one above. */
  sessions?: readonly Session[]
} & Pick<MountOptions, "handler" | "keybinds" | "width" | "height">

/**
 * The session screen of the app: a trimmed copy of `app.tsx` with `AppFrame`, `BottomZone` and
 * `Main` wired as in the app, but without `Home`, `Diff` and the footer content, inside the
 * provider stack of `mountRoute`. The drawer shows a stand-in marker: the real drawer content
 * needs the whole sidebar data set, and the shell tests only need the overlay.
 *
 * Waits for the sync bootstrap before returning: seeding store entries earlier lets the
 * bootstrap's reconcile wipe them again.
 */
export async function mountSessionShell(options: SessionShellOptions = {}) {
  let bottomZone!: ReturnType<typeof createBottomZoneState>
  let drawer!: ReturnType<typeof useDrawer>
  const harness = await mountRoute({
    route: { type: "session", sessionID: options.sessionID ?? SHELL_SESSION },
    sessions: options.sessions ?? [sessionFixture(SHELL_SESSION)],
    handler: options.handler,
    keybinds: options.keybinds,
    width: options.width,
    height: options.height,
    view: () => {
      bottomZone = createBottomZoneState()
      drawer = useDrawer()
      const drawerContent = createMemo(() => (drawer.visible() ? <text>抽屉</text> : undefined))
      return (
        <BottomZoneProvider state={bottomZone}>
          <AppFrame
            dimmed={bottomZone.dimmed}
            bottomZone={<BottomZone state={bottomZone} composer={<></>} />}
            drawer={drawerContent()}
          >
            <Main />
          </AppFrame>
        </BottomZoneProvider>
      )
    },
  })

  await waitFor(() => harness.sync().status === "complete")

  return {
    ...harness,
    bottomZone: () => bottomZone,
    drawer: () => drawer,
    frame: () => harness.app.captureCharFrame(),
    /** Opens the drawer with its default key, like a user would. */
    async openDrawer() {
      harness.app.mockInput.pressKey("b", { ctrl: true })
      await waitFor(() => drawer.visible())
      await harness.settle()
    },
  }
}
