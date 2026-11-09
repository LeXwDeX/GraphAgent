// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, Show } from "solid-js"
import { useHookStatus } from "../context/hook-status"
import { useTicker } from "../context/ticker-context"
import { useTheme } from "../context/theme"
import { t } from "../i18n"

/** Footer indicator for the oldest running hook of the current session. */
export function HookProgress(props: { sessionID?: string }) {
  const hooks = useHookStatus()
  const ticker = useTicker()
  const { theme } = useTheme()

  const run = createMemo(() => (props.sessionID ? hooks.list(props.sessionID)[0] : undefined))
  const elapsed = createMemo(() => {
    ticker.second()
    const current = run()
    if (!current) return 0
    return Math.max(0, Math.floor((ticker.now() - current.startedAt) / 1000))
  })

  return (
    <Show when={run()}>
      {(current) => (
        <text fg={theme.textMuted} wrapMode="none">
          {t("shell.footer.hookRunning", { name: current().descriptor, seconds: elapsed() })}
        </text>
      )}
    </Show>
  )
}
