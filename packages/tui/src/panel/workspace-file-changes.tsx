// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { VcsFileStatus } from "@graphagent/sdk"
import { createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { askConfirm } from "../ask/local-ask"
import type { BottomZoneStateApi } from "../shell/bottom-zone"
import { DetailPanel, type DetailRow } from "./detail"
import type { PanelHostApi } from "./host"

export type WorkspaceFileChangesChoice = "no" | "yes"

export interface WorkspaceFileChangesOptions {
  title?: string
  message?: string
}

function statusLabel(status: VcsFileStatus["status"]) {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

function changeCount(file: VcsFileStatus) {
  return `${file.additions ? `+${file.additions}` : ""}${file.deletions ? ` -${file.deletions}` : ""}`
}

export function WorkspaceFileChangesPanel(
  props: WorkspaceFileChangesOptions & {
    files: VcsFileStatus[]
    onConfirm(): void | Promise<void>
  },
) {
  const { theme } = useTheme()

  const rows = createMemo<DetailRow<VcsFileStatus>[]>(() =>
    props.files.map((file) => ({
      id: file.file,
      cells: [statusLabel(file.status), file.file, changeCount(file)],
      value: file,
    })),
  )

  return (
    <DetailPanel
      title={props.title ?? t("panel.workspace.changes.title")}
      summary={
        <text fg={theme.textMuted} wrapMode="word">
          {props.message ?? t("panel.workspace.changes.message")}
        </text>
      }
      rows={rows()}
      onActivate={() => void props.onConfirm()}
      activateLabel={t("panel.workspace.changes.confirm")}
      hints={[]}
    />
  )
}

/**
 * Shows the file-change list in the bottom zone and asks for confirmation in
 * the ask area when the user activates a row.
 */
export function showWorkspaceFileChanges(
  input: WorkspaceFileChangesOptions & {
    host: PanelHostApi
    zone?: BottomZoneStateApi
    files: VcsFileStatus[]
  },
): Promise<WorkspaceFileChangesChoice | undefined> {
  const title = input.title ?? t("panel.workspace.changes.title")
  const message = input.message ?? t("panel.workspace.changes.message")
  return new Promise((resolve) => {
    let choice: WorkspaceFileChangesChoice | undefined
    let confirming = false
    input.host.push({
      id: "workspace-file-changes",
      render: () => (
        <WorkspaceFileChangesPanel
          files={input.files}
          title={title}
          message={message}
          onConfirm={async () => {
            if (confirming || choice || !input.zone) return
            confirming = true
            try {
              const confirmed = await askConfirm(input.zone, {
                title,
                body: message,
                confirmLabel: t("ask.confirm.confirm"),
                cancelLabel: t("ask.confirm.cancel"),
              })
              choice = confirmed ? "yes" : "no"
              input.host.close()
            } finally {
              confirming = false
            }
          }}
        />
      ),
      onClose: () => resolve(choice),
    })
  })
}
