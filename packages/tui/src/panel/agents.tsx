// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import { resolveRootSessionID } from "../ask/ask-queue"
import { useKV } from "../context/kv"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTicker } from "../context/ticker-context"
import { t } from "../i18n"
import { useOpenSubAgent } from "../session/navigate"
import { usePrefillRootPrompt } from "../session/prefill"
import {
  delegatedPrompt,
  SUBAGENT_MARKER_GLYPH,
  subagentMarkerToken,
  subagentRelayText,
  subagentRows,
  subagentTitle,
  subagentTrail,
  type SubagentRow,
} from "../session/subagents"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

/** Border and padding of the panel shell, the row's pointer, and the gap between a row's name and its state. */
const SHELL_WIDTH = 4
const POINTER_WIDTH = 2
const NAME_GAP = 2
const MIN_NAME_WIDTH = 8

function sameStrings(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function padCells(text: string, width: number, ambiguousWidth: AmbiguousWidth) {
  return text + " ".repeat(Math.max(0, width - cellWidth(text, ambiguousWidth)))
}

/**
 * Listens to the one-second clock while it is mounted. Only a sub-agent that runs has a time that moves, so the panel
 * mounts this only while there is one.
 */
function SecondTick() {
  const ticker = useTicker()
  onCleanup(ticker.subscribeSecond())
  return null
}

/**
 * The state of a row as one static glyph, in the color the top bar gives the same state. A row whose state is not
 * known (every session after a restart, until it reports one) has a blank where the glyph would be.
 */
function StateGlyph(props: { row: () => SubagentRow | undefined }) {
  const { theme } = useTheme()
  const marker = () => props.row()?.marker
  return (
    <Show when={marker()} fallback={<text wrapMode="none">{"  "}</text>}>
      {(shown) => (
        <text fg={theme[subagentMarkerToken(shown())]} wrapMode="none">
          {`${SUBAGENT_MARKER_GLYPH[shown()]} `}
        </text>
      )}
    </Show>
  )
}

/**
 * `/agents`: the sub-agents of the session tree the user is in, read-only. A row says what a sub-agent is doing and
 * for how long; `⏎` goes into it, and the one action asks the main agent to deal with it, which only fills the main
 * session's input. There is no way to stop or steer a sub-agent from here.
 *
 * Everything shown is already in the data layer (the session list, the Task links and the summaries), so opening the
 * panel asks the server for nothing and loads no session. The list is the direct children of the root session, in the
 * order `←→` walks them.
 */
export function AgentsPanel() {
  const route = useRoute()
  const sync = useSync()
  const kv = useKV()
  const ticker = useTicker()
  const host = usePanelHost()
  const dimensions = useTerminalDimensions()
  const openSubAgent = useOpenSubAgent()
  const prefill = usePrefillRootPrompt()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)

  /** The clock's now. Reading it in a computation makes that computation follow the one-second signal. */
  const now = () => {
    ticker.second()
    return ticker.now()
  }

  const rootID = createMemo(() =>
    route.data.type === "session" ? resolveRootSessionID(sync.data.session, route.data.sessionID) : undefined,
  )
  const rows = createMemo<SubagentRow[]>(() => {
    const root = rootID()
    if (root === undefined) return []
    return subagentRows(sync.data.session, root, {
      task: (id) => sync.data.taskIndex[id],
      summary: (id) => sync.data.summary[id],
    })
  })
  const byID = createMemo(() => new Map(rows().map((row) => [row.id, row])))
  const rowOf = (id: string) => byID().get(id)
  const ticking = createMemo(() => rows().some((row) => row.marker === "running"))

  /** What a row says of its sub-agent: the state, the tool count and the time. A clock is read only for a running one. */
  const stateText = (row: SubagentRow) => subagentTrail(row, row.marker === "running" ? now() : 0)

  // A row is one string, name then state, laid out by `cellWidth` so that it fits the panel whichever width the
  // terminal gives East Asian ambiguous glyphs. The states line up in a column as wide as the widest of them, and the
  // name is cut to what is left of the row.
  const stateWidth = createMemo(() => Math.max(0, ...rows().map((row) => cellWidth(stateText(row), ambiguousWidth()))))
  const nameWidth = createMemo(() => {
    const marker = cellWidth(`${SUBAGENT_MARKER_GLYPH.running} `, ambiguousWidth())
    const room = dimensions().width - SHELL_WIDTH - POINTER_WIDTH - marker - NAME_GAP - stateWidth()
    return Math.max(MIN_NAME_WIDTH, room)
  })
  const rowText = (row: SubagentRow) => {
    const aw = ambiguousWidth()
    const name = padCells(truncateCells(subagentTitle(row), nameWidth(), aw), nameWidth(), aw)
    return `${name}${" ".repeat(NAME_GAP)}${stateText(row)}`
  }

  // The user's filter narrows the rows by their names. The list template would match it against each row's text,
  // which follows the data, and move the selection back to the first row whenever that text changes; so the template
  // is left to draw the input only, and the rows are narrowed here, by the name as it is when the filter is typed.
  const [needle, setNeedle] = createSignal("")

  // The list keeps its items while only their state changes: it moves the selection back to the first row whenever
  // its items change, which a running sub-agent would do on every tool it calls. Each item reads its row where it is
  // drawn, so the glyph, the text and the time still follow the data.
  const ids = createMemo<string[]>(() => rows().map((row) => row.id), [], { equals: sameStrings })
  const items = createMemo<ListItem<string>[]>(() => {
    const text = needle().trim()
    return ids()
      .filter((id) => {
        if (!text) return true
        const row = untrack(() => rowOf(id))
        return row !== undefined && fuzzysort.single(text, subagentTitle(row)) !== null
      })
      .map((id) => ({
        id,
        value: id,
        get title() {
          const row = rowOf(id)
          return row ? rowText(row) : id
        },
        lead: <StateGlyph row={() => rowOf(id)} />,
        // Read only for the selected row. The delegated prompt is the first user message of the session when it is
        // loaded; otherwise the Task description stands in, and nothing is requested to get the message.
        get description() {
          const row = rowOf(id)
          if (!row) return undefined
          const text =
            delegatedPrompt(sync.data.message[id], (messageID) => sync.data.part[messageID]) ?? row.description
          return t("subagent.panel.prompt", { text })
        },
      }))
  })

  function relay(item: ListItem<string>) {
    const row = rowOf(item.value)
    if (!row) return
    host.closeAll()
    prefill(subagentRelayText(row))
  }

  return (
    <>
      <Show when={ticking()}>
        <SecondTick />
      </Show>
      <ListPanel
        title={t("subagent.panel.title")}
        command="/agents"
        items={items()}
        filter={{ client: false }}
        onFilter={(value) => setNeedle(value)}
        empty={<EmptyNote filtered={needle().trim() !== ""} />}
        onSelect={(item) => {
          host.closeAll()
          openSubAgent(item.value)
        }}
        actions={[{ key: "subagent.relay", label: t("subagent.panel.relay"), run: relay }]}
      />
    </>
  )
}

/** No sub-agent at all, or none that the filter lets through. */
function EmptyNote(props: { filtered: boolean }) {
  const { theme } = useTheme()
  return <text fg={theme.textMuted}>{props.filtered ? t("panel.list.empty") : t("subagent.none")}</text>
}
