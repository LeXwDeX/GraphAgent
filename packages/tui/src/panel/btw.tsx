// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { Spinner } from "../component/spinner"
import { useBtw, type BtwEntry } from "../context/btw"
import { useClipboard } from "../context/clipboard"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../keymap"
import { AdaptiveMarkdown } from "../ui/adaptive-markdown"
import { useToast } from "../ui/toast"
import { truncateCells, type AmbiguousWidth } from "../ui/width"
import { DetailPanel } from "./detail"
import type { PanelHint } from "./shell"

const QUESTION_CELLS = 48

function elapsed(entry: BtwEntry): string {
  const end = entry.finishedAt ?? entry.startedAt
  const value = Math.max(0, end - entry.startedAt) / 1000
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function statusLine(entry: BtwEntry): string {
  if (entry.status !== "done") {
    if (entry.status === "error") return t("btw.status.error")
    if (entry.status === "cancelled") return t("btw.status.cancelled")
    return t("btw.status.pending")
  }
  const model = entry.model ? `${entry.model.providerID}/${entry.model.modelID}` : ""
  const base = entry.usage
    ? t("btw.status.done", {
        model,
        seconds: elapsed(entry),
        input: entry.usage.inputTokens,
        output: entry.usage.outputTokens,
      })
    : t("btw.status.doneNoUsage", { model, seconds: elapsed(entry) })
  const notes: string[] = []
  if (entry.context?.truncated) notes.push(t("btw.context.truncated"))
  if (entry.context?.inFlightDropped) notes.push(t("btw.context.inFlight"))
  return notes.length === 0 ? base : `${base} · ${notes.join(" · ")}`
}

/**
 * `/btw` answer panel (#1023). The panel is non-modal and never takes focus:
 * Escape only closes it (a running request keeps going and stays in the
 * in-memory history), while `x` is the explicit cancel. History lives in the
 * Btw controller, so switching between the latest entries keeps working after
 * the panel is closed and reopened with an empty `/btw`.
 */
export function BtwPanel(props: { sessionID: string }) {
  const btw = useBtw()
  const kv = useKV()
  const toast = useToast()
  const clipboard = useClipboard()
  const { theme, syntax } = useTheme()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const entries = createMemo(() => btw.entries(props.sessionID))
  // Offset from the newest entry; a new question does not move the cursor.
  const [offset, setOffset] = createSignal(0)
  const entry = createMemo(() => {
    const list = entries()
    if (list.length === 0) return undefined
    return list[Math.max(0, list.length - 1 - offset())]
  })

  const question = createMemo(() => {
    const current = entry()
    if (!current) return ""
    const line = current.question.split("\n")[0]?.trim() ?? ""
    return truncateCells(line, QUESTION_CELLS, ambiguousWidth())
  })

  const position = createMemo(() => {
    const list = entries()
    const index = list.length - offset()
    return t("btw.history", { index: Math.max(1, Math.min(index, list.length)), total: list.length })
  })

  function older() {
    setOffset((value) => Math.min(value + 1, Math.max(0, entries().length - 1)))
  }

  function newer() {
    setOffset((value) => Math.max(0, value - 1))
  }

  function cancel() {
    if (entry()?.status !== "pending") return
    void btw.cancel(props.sessionID)
  }

  async function copy() {
    const answer = entry()?.answer
    if (!answer) return
    try {
      await clipboard.write?.(answer)
      toast.show({ text: t("btw.copied"), level: "info", dedupeKey: "btw.copied" })
    } catch (error) {
      toast.error(error)
    }
  }

  useBindings(() => ({
    commands: [
      { name: "btw.previous", title: t("btw.hint.previous"), category: "Panel", run: older },
      { name: "btw.next", title: t("btw.hint.next"), category: "Panel", run: newer },
      { name: "btw.copy", title: t("btw.hint.copy"), category: "Panel", run: copy },
      { name: "btw.cancel", title: t("btw.hint.cancel"), category: "Panel", run: cancel },
    ],
    bindings: [
      { key: "[", cmd: "btw.previous", desc: t("btw.hint.previous"), group: "Panel" },
      { key: "]", cmd: "btw.next", desc: t("btw.hint.next"), group: "Panel" },
      { key: "c", cmd: "btw.copy", desc: t("btw.hint.copy"), group: "Panel" },
      { key: "x", cmd: "btw.cancel", desc: t("btw.hint.cancel"), group: "Panel" },
    ],
  }))

  const hints = createMemo<PanelHint[]>(() => {
    const result: PanelHint[] = []
    if (entries().length > 1) {
      result.push({ key: "btw.previous", label: t("btw.hint.previous") })
      result.push({ key: "btw.next", label: t("btw.hint.next") })
    }
    if (entry()?.answer !== undefined) result.push({ key: "btw.copy", label: t("btw.hint.copy") })
    if (entry()?.status === "pending") result.push({ key: "btw.cancel", label: t("btw.hint.cancel") })
    return result
  })

  const body = () => {
    const current = entry()
    if (!current) {
      return (
        <text fg={theme.textMuted} wrapMode="word">
          {t("btw.empty")}
        </text>
      )
    }
    if (current.status === "pending") {
      return <Spinner color={theme.textMuted}>{t("btw.waiting")}</Spinner>
    }
    if (current.status === "error") {
      return (
        <text fg={theme.error} wrapMode="word">
          {current.error ?? t("btw.status.error")}
        </text>
      )
    }
    if (current.status === "cancelled") {
      return (
        <text fg={theme.textMuted} wrapMode="word">
          {t("btw.cancelled.body")}
        </text>
      )
    }
    return (
      <AdaptiveMarkdown
        content={current.answer ?? ""}
        streaming={false}
        syntaxStyle={syntax()}
        conceal={false}
        fg={theme.markdownText}
        tableOptions={{ style: "grid" }}
      />
    )
  }

  return (
    <DetailPanel
      title={
        <box flexDirection="row" gap={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.primary} wrapMode="none">
            {t("btw.title")}
          </text>
          <Show when={question()}>
            <text fg={theme.text} wrapMode="none">
              · {question()}
            </text>
          </Show>
        </box>
      }
      command="/btw"
      summary={
        <box flexDirection="row" gap={2}>
          <Show
            when={entry()}
            fallback={
              <text fg={theme.textMuted} wrapMode="none">
                {t("btw.empty")}
              </text>
            }
          >
            {(current) => (
              <text
                fg={current().status === "error" ? theme.error : theme.textMuted}
                wrapMode="word"
              >
                {statusLine(current())}
              </text>
            )}
          </Show>
          <Show when={entries().length > 1}>
            <text fg={theme.textDim} wrapMode="none">
              {position()}
            </text>
          </Show>
        </box>
      }
      hints={hints()}
      body={body()}
    />
  )
}
