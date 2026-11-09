import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { queuedMessageExpected } from "../../prompt/queued-message"
import type { DialogContext } from "../../ui/dialog"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  queued?: boolean
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()
  const parts = createMemo(() => sync.data.part[props.messageID] ?? [])

  const copy = async (dialog: DialogContext) => {
    const text = parts().reduce((result, part) => {
      if (part.type === "text" && !part.synthetic) return result + part.text
      return result
    }, "")
    await clipboard.write?.(text)
    dialog.clear()
  }

  const editQueued = async (dialog: DialogContext) => {
    const expected = queuedMessageExpected(parts())
    if (!expected) return
    const text = await DialogPrompt.show(dialog, "Edit queued message", {
      value: expected.expectedText,
      description: () => <text>Attachments and message order will be preserved.</text>,
    })
    if (text === null) return
    dialog.replace(() => <DialogPrompt title="Edit queued message" value={text} busy busyText="Saving..." />)
    try {
      await sdk.client.session.editQueuedMessage(
        {
          sessionID: props.sessionID,
          messageID: props.messageID,
          ...expected,
          text,
        },
        { throwOnError: true },
      )
      dialog.clear()
    } catch (error) {
      dialog.clear()
      toast.show({ title: "Queued message was not changed", message: errorMessage(error), variant: "warning" })
    }
  }

  const deleteQueued = async (dialog: DialogContext) => {
    const expected = queuedMessageExpected(parts())
    if (!expected) return
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete queued message",
      "Delete only this pending prompt? The current run and files are not affected.",
    )
    if (!confirmed) return
    try {
      await sdk.client.session.deleteQueuedMessage(
        {
          sessionID: props.sessionID,
          messageID: props.messageID,
          ...expected,
        },
        { throwOnError: true },
      )
      dialog.clear()
    } catch (error) {
      toast.show({ title: "Queued message was not deleted", message: errorMessage(error), variant: "warning" })
    }
  }

  const queuedOptions = createMemo(() => [
    {
      title: "Edit",
      value: "message.queued.edit",
      description: "change this prompt before it runs",
      onSelect: editQueued,
    },
    {
      title: "Delete",
      value: "message.queued.delete",
      description: "remove only this pending prompt",
      onSelect: deleteQueued,
    },
    {
      title: "Copy",
      value: "message.copy",
      description: "message text to clipboard",
      onSelect: copy,
    },
  ])

  return (
    <DialogSelect
      title="Message Actions"
      options={
        props.queued
          ? queuedOptions()
          : [
              {
                title: "Revert",
                value: "session.revert",
                description: "undo messages and file changes",
                onSelect: (dialog) => {
                  const msg = message()
                  if (!msg) return

                  void sdk.client.session.revert({
                    sessionID: props.sessionID,
                    messageID: msg.id,
                  })

                  if (props.setPrompt) {
                    const parts = sync.data.part[msg.id]
                    const promptInfo = parts.reduce(
                      (agg, part) => {
                        if (part.type === "text") {
                          if (!part.synthetic) agg.input += part.text
                        }
                        if (part.type === "file") agg.parts.push(strip(part))
                        return agg
                      },
                      { input: "", parts: [] as PromptInfo["parts"] },
                    )
                    props.setPrompt(promptInfo)
                  }

                  dialog.clear()
                },
              },
              {
                title: "Copy",
                value: "message.copy",
                description: "message text to clipboard",
                onSelect: copy,
              },
              {
                title: "Fork",
                value: "session.fork",
                description: "create a new session",
                onSelect: async (dialog) => {
                  const result = await sdk.client.session.fork({
                    sessionID: props.sessionID,
                    messageID: props.messageID,
                  })
                  const msg = message()
                  const prompt = msg
                    ? sync.data.part[msg.id].reduce(
                        (agg, part) => {
                          if (part.type === "text") {
                            if (!part.synthetic) agg.input += part.text
                          }
                          if (part.type === "file") agg.parts.push(part)
                          return agg
                        },
                        { input: "", parts: [] as PromptInfo["parts"] },
                      )
                    : undefined
                  route.navigate({
                    sessionID: result.data!.id,
                    type: "session",
                    prompt,
                  })
                  dialog.clear()
                },
              },
            ]
      }
    />
  )
}
