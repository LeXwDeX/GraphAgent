// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { TuiLog } from "../util/log"
import { ListPanel, type ListItem } from "./list"

function statusLabel(status: string) {
  switch (status) {
    case "connected":
      return t("drawer.mcp.connected")
    case "disabled":
      return t("drawer.mcp.disabled")
    case "needs_auth":
      return t("drawer.mcp.needsAuth")
    case "needs_client_registration":
      return t("drawer.mcp.needsClientId")
    case "failed":
      return t("panel.mcp.status.failed")
    default:
      return status
  }
}

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  return (
    <Show
      when={!props.loading}
      fallback={
        <text fg={theme.textMuted} wrapMode="none">
          {t("panel.mcp.loading")}
        </text>
      }
    >
      <text
        fg={props.enabled ? theme.success : theme.textMuted}
        attributes={props.enabled ? TextAttributes.BOLD : undefined}
        wrapMode="none"
      >
        {props.enabled ? `✓ ${t("panel.mcp.enabled")}` : `○ ${t("panel.mcp.disabled")}`}
      </text>
    </Show>
  )
}

/** `/mcp`: toggles MCP servers with space; selecting a row intentionally keeps the panel open. */
export function McpPanel() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const [loading, setLoading] = createSignal<string | null>(null)

  const items = createMemo<ListItem<string>[]>(() => {
    const data = sync.data.mcp ?? {}
    const active = loading()
    return Object.entries(data)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, status]) => ({
        id: name,
        value: name,
        title: name,
        description: statusLabel(status.status),
        trail: <Status enabled={local.mcp.isEnabled(name)} loading={active === name} />,
      }))
  })

  async function toggle(name: string) {
    if (loading() !== null) return
    setLoading(name)
    try {
      await local.mcp.toggle(name)
      const status = await sdk.client.mcp.status()
      if (status.data) {
        sync.set("mcp", status.data)
      } else {
        TuiLog.write("error", "Failed to refresh MCP status: no data returned")
      }
    } catch (error) {
      TuiLog.write("error", "Failed to toggle MCP", error)
    } finally {
      setLoading(null)
    }
  }

  return (
    <ListPanel
      title={t("panel.mcp.title")}
      command="/mcp"
      items={items()}
      onSelect={() => {
        // MCP rows only expose the toggle action, matching the dialog behavior.
      }}
      actions={[
        {
          key: "dialog.mcp.toggle",
          label: t("panel.mcp.toggle"),
          when: () => loading() === null,
          run: (item) => toggle(item.value),
        },
      ]}
    />
  )
}
