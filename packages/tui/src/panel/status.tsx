// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { InstallationVersion } from "@graphagent/core/installation/version"
import type { FormatterStatus, LspStatus, McpStatus } from "@graphagent/sdk"
import { createMemo } from "solid-js"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import { useToast, type ToastRecord } from "../ui/toast"
import { DetailPanel, type DetailRow } from "./detail"

function mcpStatusLabel(item: McpStatus): string {
  if (item.status === "connected") return t("drawer.mcp.connected")
  if (item.status === "failed") return item.error
  if (item.status === "disabled") return t("drawer.mcp.disabled")
  if (item.status === "needs_auth") return t("drawer.mcp.needsAuth")
  return item.error
}

function lspStatusLabel(item: LspStatus): string {
  return item.status === "connected" ? t("drawer.mcp.connected") : t("panel.status.lsp.error")
}

function errorText(record: ToastRecord): string {
  return record.text
}

/** `/status`: MCP, LSP and formatter sections plus the version and recent error toasts. */
export function StatusPanel() {
  const sync = useSync()
  const toast = useToast()

  const mcp = createMemo(() => Object.entries(sync.data.mcp ?? {}))
  const lsp = createMemo(() => sync.data.lsp ?? [])
  const formatters = createMemo<FormatterStatus[]>(() => sync.data.formatter.filter((item) => item.enabled))

  const rows = createMemo<DetailRow[]>(() => {
    const result: DetailRow[] = []

    result.push({
      id: "section:mcp",
      cells: [t("panel.status.section.mcp", { count: mcp().length })],
      selectable: false,
    })
    if (mcp().length === 0) {
      result.push({ id: "empty:mcp", cells: [t("panel.status.empty.mcp")], selectable: false })
    } else {
      for (const [name, item] of mcp()) {
        result.push({
          id: `mcp:${name}`,
          cells: [name, mcpStatusLabel(item)],
          value: item,
          note: item.status === "failed" ? item.error : undefined,
        })
      }
    }

    if (lsp().length > 0) {
      result.push({
        id: "section:lsp",
        cells: [t("panel.status.section.lsp", { count: lsp().length })],
        selectable: false,
      })
      for (const item of lsp()) {
        result.push({
          id: `lsp:${item.id}`,
          cells: [item.id, item.root, lspStatusLabel(item)],
          value: item,
        })
      }
    }

    result.push({
      id: "section:formatters",
      cells: [t("panel.status.section.formatters", { count: formatters().length })],
      selectable: false,
    })
    if (formatters().length === 0) {
      result.push({ id: "empty:formatters", cells: [t("panel.status.empty.formatters")], selectable: false })
    } else {
      for (const item of formatters()) {
        result.push({ id: `formatter:${item.name}`, cells: [item.name], value: item })
      }
    }

    result.push({ id: "version", cells: [t("panel.status.version"), InstallationVersion], selectable: false })

    result.push({
      id: "section:errors",
      cells: [t("panel.status.section.errors", { count: toast.recentMessages.length })],
      selectable: false,
    })
    if (toast.recentMessages.length === 0) {
      result.push({ id: "empty:errors", cells: [t("panel.status.errors.empty")], selectable: false })
    } else {
      for (const record of toast.recentMessages) {
        result.push({
          id: `error:${record.id}`,
          cells: [errorText(record)],
          selectable: false,
        })
      }
    }

    return result
  })

  return <DetailPanel title={t("panel.status.title")} command="/status" rows={rows()} hints={[]} />
}
