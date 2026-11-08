import { createMemo, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { BottomZone } from "./bottom-zone"
import { Drawer } from "./drawer"
import { Footer, type FooterHint, type FooterMeta } from "./footer"
import { StatusBand } from "./status-band"
import { TopBar, type TopBarRight } from "./top-bar"

/** Below either limit the frame renders only the "terminal too small" notice. */
export const SHELL_MIN_WIDTH = 60
export const SHELL_MIN_HEIGHT = 12

export type AppFrameTopBar = {
  path?: string
  right?: TopBarRight
}

export type AppFrameFooter = {
  agent?: string
  agentAction?: string
  hints?: readonly FooterHint[]
  meta?: FooterMeta
  dag?: JSX.Element
  right?: JSX.Element
}

export type AppFrameProps = {
  topBar?: AppFrameTopBar
  footer?: AppFrameFooter
  /** Zero to two status lines above the bottom zone (F4). */
  statusBand?: JSX.Element
  /** Input, panel, or ask queue above the footer (F3). */
  bottomZone?: JSX.Element
  /** Right-edge overlay between the top bar and the bottom zone (F4). */
  drawer?: JSX.Element
  children?: JSX.Element
}

/**
 * Fixed column shell: one top bar row and one blank row, the main area, the
 * status band, the bottom zone, and a one-row footer. The drawer overlays the
 * right edge of the main/status area without changing layout widths.
 */
export function AppFrame(props: AppFrameProps) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()

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
          <box flexGrow={1} minHeight={0} flexDirection="column">
            {props.children}
          </box>
          <Show when={props.statusBand}>
            <StatusBand>{props.statusBand}</StatusBand>
          </Show>
          <Show when={props.drawer}>
            <Drawer>{props.drawer}</Drawer>
          </Show>
        </box>
        <Show when={props.bottomZone}>
          <BottomZone>{props.bottomZone}</BottomZone>
        </Show>
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
