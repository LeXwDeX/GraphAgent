import { createMemo, Show, type Accessor, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useTheme } from "../context/theme"
import { formatKeySequence, useKeymapSelector, useLeaderActive } from "../keymap"
import { useToast, type ToastOptions } from "../ui/toast"

/**
 * Lists the keys that can follow the leader key while it is pending. The
 * keymap clears the sequence on timeout, which unmounts this hint.
 */
function LeaderPendingKeys() {
  const config = useTuiConfig()
  const { theme } = useTheme()
  const leader = useLeaderActive()
  const active = useKeymapSelector((keymap) => keymap.getActiveKeys({ includeMetadata: true }))
  const keys = createMemo(() => {
    if (!leader()) return []
    const seen = new Set<string>()
    return active().flatMap((item) => {
      const key = formatKeySequence(
        [{ stroke: item.stroke, display: item.display, tokenName: item.tokenName }],
        config,
      )
      if (!key || seen.has(key)) return []
      seen.add(key)
      return [key]
    })
  })

  return (
    <Show when={keys().length > 0}>
      <text fg={theme.textMuted} wrapMode="none">
        {keys().join("  ")}
      </text>
    </Show>
  )
}

function ToastLine(props: { toast: ToastOptions }) {
  const { theme } = useTheme()
  const color = () => {
    if (props.toast.variant === "success") return theme.success
    if (props.toast.variant === "warning") return theme.warning
    if (props.toast.variant === "error") return theme.error
    return theme.textMuted
  }

  return (
    <text fg={color()} wrapMode="none">
      {props.toast.title ? `${props.toast.title}: ` : ""}
      {props.toast.message}
    </text>
  )
}

/**
 * Transient footer content. The right-hand footer position is shared, with the
 * leader hint taking precedence over a toast and, once F3 lands, hook progress.
 */
export function useFooterStatus(progress?: Accessor<JSX.Element | undefined>): Accessor<JSX.Element | undefined> {
  const toast = useToast()
  const leader = useLeaderActive()

  return createMemo(() => {
    if (leader()) return <LeaderPendingKeys />
    const current = toast.currentToast
    if (current) return <ToastLine toast={current} />
    return progress?.()
  })
}
