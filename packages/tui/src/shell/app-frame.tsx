// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { children as resolveChildren, createMemo, Show, type JSX } from "solid-js"
import { MouseButton } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import type { DagIndicatorState } from "./dag-indicator"
import { Drawer } from "./drawer"
import { Footer, type FooterHint, type FooterMeta } from "./footer"
import { StatusBand } from "./status-band"
import { TopBar, type TopBarRight } from "./top-bar"

/** Below either limit the frame renders only the "terminal too small" notice. */
/** The primary button, as the plain number a mouse event carries. */
const LEFT_BUTTON: number = MouseButton.LEFT

export const SHELL_MIN_WIDTH = 60
export const SHELL_MIN_HEIGHT = 12

/**
 * Share of its colors the main and status rows keep while a bottom-zone panel or ask surface is
 * open; the rest fades into the app background.
 */
export const DIMMED_OPACITY = 0.5

export type AppFrameTopBar = {
  path?: string
  right?: TopBarRight
}

export type AppFrameFooter = {
  agent?: string
  agentAction?: string
  hints?: readonly FooterHint[]
  meta?: FooterMeta
  /** DAG mode indicator state; omitted where the session has no mode switch. */
  dag?: DagIndicatorState
  right?: JSX.Element
}

export type AppFrameProps = {
  topBar?: AppFrameTopBar
  footer?: AppFrameFooter
  /** Zero to two status lines above the bottom zone (F4). */
  statusBand?: JSX.Element
  /** The composer, a panel, or the ask queue above the footer (F3); routes install the composer in it. */
  bottomZone?: JSX.Element
  /** Right-edge overlay between the top bar and the bottom zone (F4). */
  drawer?: JSX.Element
  /**
   * A left click that ends on the main or status rows (#1032 5.1); pass it only while the drawer is shown. It does not
   * fire when the press selected text, or for clicks inside the drawer.
   */
  onDrawerBackdrop?: () => void
  /** Dims the main and status rows while a bottom-zone panel or ask surface is open. */
  dimmed?: () => boolean
  children?: JSX.Element
}

/**
 * Mounts one slot prop. A prop that holds JSX builds its element again on every read, and `Show` reads `when` and
 * its children separately, so `<Show when={props.slot}>{props.slot}</Show>` created each slot twice: the second
 * copy was mounted, the first stayed alive and detached, rendering its own panels and prompt and registering its
 * own key layers. The slot is resolved once here and `when` and the content share the result.
 */
function Slot(props: { content?: JSX.Element; wrap?: (content: JSX.Element) => JSX.Element }) {
  const content = resolveChildren(() => props.content)
  return <Show when={content()}>{props.wrap ? props.wrap(content()) : content()}</Show>
}

/**
 * Fixed column shell: one top bar row and one blank row, the main area, the
 * status band, the bottom zone, and a one-row footer. The drawer overlays the
 * right edge of the main/status area without changing layout widths. It ends
 * where the main area ends, so the bottom zone (the composer, a panel or an ask
 * surface) and the footer are never covered.
 *
 * Dimming is an `opacity` on the main and status rows, not a translucent box
 * laid over them: OpenTUI's alpha fill blanks every cell that holds a wide
 * character, so a box would erase the CJK text of the transcript while a panel
 * is open. The drawer is a later sibling of the dimmed rows and is drawn above
 * them at full strength; it has to hide what is under it, which a translucent
 * layer would let through. The order does not depend on when either one appears.
 */
export function AppFrame(props: AppFrameProps) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()

  const renderer = useRenderer()
  const tooSmall = createMemo(() => dimensions().width < SHELL_MIN_WIDTH || dimensions().height < SHELL_MIN_HEIGHT)

  return (
    <Show
      when={!tooSmall()}
      fallback={
        <box width="100%" height="100%" backgroundColor={theme.background} paddingLeft={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("shell.tooSmall")}
          </text>
        </box>
      }
    >
      <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
        <TopBar path={props.topBar?.path} right={props.topBar?.right} />
        <box height={1} flexShrink={0} />
        <box flexGrow={1} minHeight={0} flexDirection="column" position="relative">
          {/* The drawer's backdrop is this column itself, not a hit box laid over it: a box over the transcript would
              take its wheel and its text selection while the drawer is open. A click here bubbles up from whatever it
              landed on; the drawer is a sibling, so its own clicks never get here. */}
          <box
            flexGrow={1}
            minHeight={0}
            flexDirection="column"
            opacity={props.dimmed?.() ? DIMMED_OPACITY : 1}
            onMouseUp={(event) => {
              const backdrop = props.onDrawerBackdrop
              if (!backdrop || event.button !== LEFT_BUTTON) return
              if (renderer.getSelection()?.getSelectedText()) return
              backdrop()
            }}
          >
            <box flexGrow={1} minHeight={0} flexDirection="column">
              {props.children}
            </box>
            <Slot content={props.statusBand} wrap={(content) => <StatusBand>{content}</StatusBand>} />
          </box>
          <Slot content={props.drawer} wrap={(content) => <Drawer>{content}</Drawer>} />
        </box>
        <Slot content={props.bottomZone} />
        <Footer
          agent={props.footer?.agent}
          agentAction={props.footer?.agentAction}
          hints={props.footer?.hints}
          meta={props.footer?.meta}
          dag={props.footer?.dag}
          right={props.footer?.right}
        />
      </box>
    </Show>
  )
}
