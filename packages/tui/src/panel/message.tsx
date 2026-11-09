// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Part } from "@graphagent/sdk"
import { createMemo, createSignal } from "solid-js"
import { useClipboard } from "../context/clipboard"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import type { PromptEditRequest } from "../component/prompt"
import type { PromptInfo } from "../prompt/history"
import { stripPromptPartIDs as strip } from "../prompt/part"
import { queuedMessageExpected } from "../prompt/queued-message"
import { errorMessage } from "../util/error"
import { useToast } from "../ui/toast"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

type MessageAction = "edit" | "delete" | "copy" | "revert" | "fork"

export interface MessagePanelProps {
  messageID: string
  sessionID: string
  queued?: boolean
  setPrompt?: (prompt: PromptInfo) => void
  /** Prefills the composer in edit mode (Esc restores the previous draft). */
  editPrompt?: (request: PromptEditRequest) => void
}

/**
 * Actions for one user message. Subagent views only expose Copy; queued
 * messages expose Edit/Delete, which prefill the composer or remove the
 * pending prompt after a second confirmation.
 */
export function MessagePanel(props: MessagePanelProps) {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()
  const host = usePanelHost()
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)

  const message = createMemo(() => sync.data.message[props.sessionID]?.find((item) => item.id === props.messageID))
  const parts = createMemo(() => sync.data.part[props.messageID] ?? [])
  const isSubagent = createMemo(() => Boolean(sync.session.get(props.sessionID)?.parentID))

  function promptFrom(input: readonly Part[], stripIDs: boolean): PromptInfo {
    return input.reduce<PromptInfo>(
      (agg, part) => {
        if (part.type === "text") {
          if (!part.synthetic) agg.input += part.text
        }
        if (part.type === "file") agg.parts.push(stripIDs ? strip(part) : part)
        return agg
      },
      { input: "", parts: [] },
    )
  }

  // Editing takes the pending prompt back into the composer in edit mode.
  // Remove it from the queue first so re-submitting the edited text cannot run
  // it twice; Esc restores the composer draft, not the deleted queue entry.
  async function editQueued() {
    const expected = queuedMessageExpected(parts())
    if (!expected || !props.editPrompt) return
    const prompt = promptFrom(parts(), true)
    try {
      await sdk.client.session.deleteQueuedMessage(
        {
          sessionID: props.sessionID,
          messageID: props.messageID,
          ...expected,
        },
        { throwOnError: true },
      )
    } catch (error) {
      toast.show({ title: t("panel.message.edit.failed"), message: errorMessage(error), variant: "warning" })
      return
    }
    props.editPrompt({ label: t("prompt.edit.queued"), value: expected.expectedText, parts: prompt.parts })
    host.close()
  }

  async function deleteQueued() {
    const expected = queuedMessageExpected(parts())
    if (!expected) return
    if (!confirmingDelete()) {
      setConfirmingDelete(true)
      toast.show({ variant: "warning", message: t("panel.message.delete.confirm") })
      return
    }
    try {
      await sdk.client.session.deleteQueuedMessage(
        {
          sessionID: props.sessionID,
          messageID: props.messageID,
          ...expected,
        },
        { throwOnError: true },
      )
    } catch (error) {
      toast.show({ title: t("panel.message.delete.failed"), message: errorMessage(error), variant: "warning" })
    }
    host.close()
  }

  async function copy() {
    const text = parts().reduce((result, part) => {
      if (part.type === "text" && !part.synthetic) return result + part.text
      return result
    }, "")
    await clipboard.write?.(text)
    host.close()
  }

  function revert() {
    const msg = message()
    if (!msg) return
    void sdk.client.session.revert({ sessionID: props.sessionID, messageID: msg.id })
    props.setPrompt?.(promptFrom(parts(), true))
    host.close()
  }

  async function fork() {
    const result = await sdk.client.session.fork({ sessionID: props.sessionID, messageID: props.messageID })
    route.navigate({ sessionID: result.data!.id, type: "session", prompt: promptFrom(parts(), false) })
    host.close()
  }

  const items = createMemo<ListItem<MessageAction>[]>(() => {
    const copyItem: ListItem<MessageAction> = {
      id: "copy",
      value: "copy",
      title: t("panel.message.copy"),
      description: t("panel.message.copy.description"),
    }
    if (isSubagent()) return [copyItem]
    if (props.queued) {
      return [
        {
          id: "edit",
          value: "edit",
          title: t("panel.message.edit"),
          description: t("panel.message.edit.description"),
        },
        {
          id: "delete",
          value: "delete",
          title: t("panel.message.delete"),
          description: t("panel.message.delete.description"),
        },
        copyItem,
      ]
    }
    return [
      {
        id: "revert",
        value: "revert",
        title: t("panel.message.revert"),
        description: t("panel.message.revert.description"),
      },
      copyItem,
      {
        id: "fork",
        value: "fork",
        title: t("panel.message.fork"),
        description: t("panel.message.fork.description"),
      },
    ]
  })

  function run(action: MessageAction) {
    switch (action) {
      case "edit":
        editQueued()
        return
      case "delete":
        void deleteQueued()
        return
      case "copy":
        void copy()
        return
      case "revert":
        revert()
        return
      case "fork":
        void fork()
        return
    }
  }

  return (
    <ListPanel
      title={t("panel.message.title")}
      items={items()}
      onMove={() => setConfirmingDelete(false)}
      onSelect={(item) => run(item.value)}
    />
  )
}
