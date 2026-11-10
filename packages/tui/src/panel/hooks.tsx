// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createSignal } from "solid-js"
import { useHookStatus, type HookRun } from "../context/hook-status"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useTicker } from "../context/ticker-context"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { errorMessage } from "../util/error"
import { useToast } from "../ui/toast"
import { ListPanel, type ListItem } from "./list"

function elapsedSeconds(run: HookRun, now: number): number {
  return Math.max(0, Math.floor((now - run.startedAt) / 1000))
}

/** `/hooks`: lists running foreground hook handlers and cancels one on confirm. */
export function HooksPanel() {
  const hookStatus = useHookStatus()
  const route = useRoute()
  const sdk = useSDK()
  const ticker = useTicker()
  const toast = useToast()
  const { theme } = useTheme()
  const [confirming, setConfirming] = createSignal<string>()
  const [cancelling, setCancelling] = createSignal<string>()

  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const cancellable = () => typeof sdk.client.session.hook?.cancel === "function"

  const items = createMemo<ListItem<HookRun>[]>(() => {
    ticker.second()
    const now = ticker.now()
    return hookStatus.list(sessionID()).map((run) => {
      const canCancel = run.cancellable && cancellable()
      const title =
        cancelling() === run.hookID
          ? t("panel.hooks.cancelling", { name: run.descriptor })
          : confirming() === run.hookID && canCancel
            ? t("panel.hooks.confirm", { name: run.descriptor })
            : run.descriptor
      const trail = [
        t("panel.hooks.elapsed", { seconds: elapsedSeconds(run, now) }),
        t("panel.hooks.timeout", { seconds: Math.round(run.timeoutMs / 1000) }),
      ].join(" · ")
      return {
        id: run.hookID,
        value: run,
        title,
        description: run.statusMessage,
        trail,
      }
    })
  })

  async function cancel(run: HookRun) {
    if (cancelling()) return
    if (!run.cancellable || !cancellable()) {
      toast.show({ text: t("panel.hooks.notCancellable"), level: "info", dedupeKey: "panel.hooks.not-cancellable" })
      return
    }
    if (confirming() !== run.hookID) {
      setConfirming(run.hookID)
      return
    }

    setConfirming(undefined)
    setCancelling(run.hookID)
    const result = await sdk.client.session.hook
      .cancel({ sessionID: run.sessionID, hookID: run.hookID })
      .catch((error) => ({ error }))
    setCancelling(undefined)
    if (result?.error) {
      toast.show({
        text: t("panel.hooks.cancelFailed", { message: errorMessage(result.error) }),
        level: "error",
        dedupeKey: "panel.hooks.cancel-failed",
      })
      return
    }
    if ("data" in result && result.data?.cancelled) {
      hookStatus.remove(run.sessionID, run.hookID)
      toast.show({
        text: t("panel.hooks.cancelled", { name: run.descriptor }),
        level: "success",
        dedupeKey: "panel.hooks.cancelled",
      })
      return
    }
    toast.show({
      text: t("panel.hooks.missed", { name: run.descriptor }),
      level: "info",
      dedupeKey: "panel.hooks.missed",
    })
  }

  return (
    <ListPanel
      title={t("panel.hooks.title")}
      command="/hooks"
      items={items()}
      onMove={() => setConfirming(undefined)}
      onSelect={(item) => void cancel(item.value)}
      empty={
        <text fg={theme.textMuted} wrapMode="none">
          {t("panel.hooks.empty")}
        </text>
      }
    />
  )
}
