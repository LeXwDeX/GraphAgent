// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import type { DialogContext } from "../ui/dialog"
import type { PanelHostApi } from "./host"
import { SettingsPanel, type SettingRow } from "./settings"

export interface ExportOptions {
  filename: string
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  openWithoutSaving: boolean
}

export interface ExportOptionsPanelProps {
  defaultFilename: string
  defaultThinking: boolean
  defaultToolDetails: boolean
  defaultAssistantMetadata: boolean
  defaultOpenWithoutSaving: boolean
  onSubmit(options: ExportOptions): void
}

/** `/export`: filename plus transcript content toggles, with a bottom export action. */
export function ExportOptionsPanel(props: ExportOptionsPanelProps) {
  const [store, setStore] = createStore({
    filename: props.defaultFilename,
    thinking: props.defaultThinking,
    toolDetails: props.defaultToolDetails,
    assistantMetadata: props.defaultAssistantMetadata,
    openWithoutSaving: props.defaultOpenWithoutSaving,
  })

  const rows = createMemo<readonly SettingRow[]>(() => [
    {
      id: "filename",
      label: t("panel.export.filename"),
      kind: "text",
      value: store.filename,
      onChange: (value) => setStore("filename", value),
    },
    {
      id: "thinking",
      label: t("panel.export.thinking"),
      kind: "toggle",
      value: store.thinking,
      onChange: (value) => setStore("thinking", value),
    },
    {
      id: "toolDetails",
      label: t("panel.export.toolDetails"),
      kind: "toggle",
      value: store.toolDetails,
      onChange: (value) => setStore("toolDetails", value),
    },
    {
      id: "assistantMetadata",
      label: t("panel.export.assistantMetadata"),
      kind: "toggle",
      value: store.assistantMetadata,
      onChange: (value) => setStore("assistantMetadata", value),
    },
    {
      id: "openWithoutSaving",
      label: t("panel.export.openWithoutSaving"),
      kind: "toggle",
      value: store.openWithoutSaving,
      onChange: (value) => setStore("openWithoutSaving", value),
    },
    {
      id: "export",
      label: t("panel.export.submit"),
      kind: "action",
      run: () =>
        props.onSubmit({
          filename: store.filename,
          thinking: store.thinking,
          toolDetails: store.toolDetails,
          assistantMetadata: store.assistantMetadata,
          openWithoutSaving: store.openWithoutSaving,
        }),
    },
  ])

  return (
    <SettingsPanel
      title={t("panel.export.title")}
      command="/export"
      tabs={[{ id: "options", label: t("panel.export.tab"), rows: rows() }]}
      activeTab="options"
    />
  )
}

/**
 * Opens the export panel and resolves with the chosen options, or null when the
 * panel is closed without exporting.
 */
export function showExportOptions(input: {
  host: PanelHostApi
  dialog: Pick<DialogContext, "clear">
  defaultFilename: string
  defaultThinking: boolean
  defaultToolDetails: boolean
  defaultAssistantMetadata: boolean
  defaultOpenWithoutSaving: boolean
}): Promise<ExportOptions | null> {
  input.dialog.clear()
  return new Promise((resolve) => {
    let result: ExportOptions | null = null
    input.host.push({
      id: "export-options",
      render: () => (
        <ExportOptionsPanel
          defaultFilename={input.defaultFilename}
          defaultThinking={input.defaultThinking}
          defaultToolDetails={input.defaultToolDetails}
          defaultAssistantMetadata={input.defaultAssistantMetadata}
          defaultOpenWithoutSaving={input.defaultOpenWithoutSaving}
          onSubmit={(options) => {
            result = options
            input.host.close()
          }}
        />
      ),
      onClose: () => resolve(result),
    })
  })
}
