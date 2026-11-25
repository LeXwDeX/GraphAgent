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
  subagentCountText,
  subagentDetail,
  subagentGroupTitle,
  subagentInitiatorText,
  subagentMarkerToken,
  subagentRelayText,
  subagentRows,
  subagentSource,
  subagentStateWord,
  subagentStatsText,
  subagentTitle,
  subagentTrail,
  type SubagentRow,
} from "../session/subagents"
import { MARK_CELLS } from "../ui/layout"
import { textFg, textStyle } from "../ui/text"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"
import { PANEL_NARROW_WIDTH, usePanelInnerWidth } from "./shell"

/** The gap between the columns of a row. */
const NAME_GAP = 2
const MIN_NAME_WIDTH = 8
/** The command at the right of the title row (hidden from `PANEL_NARROW_WIDTH` down), and the gap before the counts. */
const COMMAND = "/agents"
const TITLE_GAP = 2

function sameStrings(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function padCells(text: string, width: number, ambiguousWidth: AmbiguousWidth) {
  return text + " ".repeat(Math.max(0, width - cellWidth(text, ambiguousWidth)))
}

/**
 * The detail lines of a row on the one note line of the panel. What a run that is over reported, and whether it came
 * back, are short and come first; the delegated prompt, which can be of any length, follows and is what the line cuts.
 */
function detailText(lines: readonly string[]) {
  return [...lines.slice(1), ...lines.slice(0, 1)].join(" · ")
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

/** The heading of the panel: its name, and the count of what is listed, muted, cut to what the title row has left. */
function PanelTitle(props: { counts: string }) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const innerWidth = usePanelInnerWidth({ dimensions })
  const shown = createMemo(() => {
    const aw: AmbiguousWidth = kv.get("ambiguous_width", 1) === 2 ? 2 : 1
    const title = t("subagent.panel.title")
    const command = dimensions().width >= PANEL_NARROW_WIDTH ? cellWidth(COMMAND, aw) + NAME_GAP : 0
    const room = innerWidth() - command - cellWidth(title, aw) - TITLE_GAP
    return { title, counts: props.counts && room > 0 ? truncateCells(props.counts, room, aw) : "" }
  })
  return (
    <text fg={textFg(theme, "title")} wrapMode="none">
      <span style={textStyle(theme, "title")}>{shown().title}</span>
      <Show when={shown().counts}>
        <span style={textStyle(theme, "secondary")}>{" ".repeat(TITLE_GAP) + shown().counts}</span>
      </Show>
    </text>
  )
}

/**
 * `/agents`: the sub-agents of the session tree the user is in, read-only. A row says what a sub-agent is doing and
 * for how long; `⏎` goes into it, and the one action asks the main agent to deal with it, which only fills the main
 * session's input. There is no way to stop or steer a sub-agent from here.
 *
 * Everything shown is already in the data layer (the session list, the Task links, the job states and the summaries),
 * so opening the panel asks the server for nothing and loads no session. The list is the direct children of the root
 * session in three groups (#1058 6): the background runs, the foreground runs that still run, then everything else.
 * The order inside is `session/subagents.ts`'s, the one the sibling keys walk.
 */
export function AgentsPanel() {
  const route = useRoute()
  const sync = useSync()
  const kv = useKV()
  const ticker = useTicker()
  const { theme } = useTheme()
  const host = usePanelHost()
  const innerWidth = usePanelInnerWidth()
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
    return subagentRows(sync.data.session, root, subagentSource(sync.data))
  })
  const byID = createMemo(() => new Map(rows().map((row) => [row.id, row])))
  const rowOf = (id: string) => byID().get(id)
  const counts = createMemo(() => subagentCountText(rows()))

  /** What a row says of its sub-agent: the state word, then the tool count and the time. */
  const stateText = (row: SubagentRow) => subagentTrail(row, row.marker === "running" ? now() : 0)

  // A row is one line: the name (the kind in bold, the description muted), who asked for it, then the state word in
  // its status color with the tool count and the time muted after it. The text is the one string the columns were
  // laid out with before; only the colors and the weight of the kind differ, so the columns still line up.
  const titleNode = (row: SubagentRow) => {
    const aw = ambiguousWidth()
    const full = subagentTitle(row)
    const name = padCells(truncateCells(full, nameWidth(), aw), nameWidth(), aw)
    const initText = padCells(subagentInitiatorText(row), initiatorWidth(), aw)
    const state = subagentStateWord(row)
    const stats = subagentStatsText(row, row.marker === "running" ? now() : 0)
    const stateFg = row.marker ? theme[subagentMarkerToken(row.marker)] : textFg(theme, "secondary")
    // The kind is bold and the rest muted only while the whole name fits the column; a cut name is drawn plain.
    const canSplit = cellWidth(full, aw) <= nameWidth()
    return (
      <>
        {canSplit ? (
          <>
            <span style={textStyle(theme, "body")}>{row.kind}</span>
            <span style={textStyle(theme, "body")}>{" · "}</span>
            <span style={textStyle(theme, "secondary")}>{row.description}</span>
            <span style={textStyle(theme, "secondary")}>{name.slice(full.length)}</span>
          </>
        ) : (
          <span style={textStyle(theme, "body")}>{name}</span>
        )}
        <span style={textStyle(theme, "secondary")}>{`${" ".repeat(NAME_GAP)}${initText}${" ".repeat(NAME_GAP)}`}</span>
        <span style={{ fg: stateFg }}>{state}</span>
        <span style={textStyle(theme, "secondary")}>{` · ${stats}`}</span>
      </>
    )
  }

  /** The text of the message that carries a finished background run's report, when that message is loaded. */
  const resultText = (row: SubagentRow) => {
    const result = row.result
    if (!result) return undefined
    const part = sync.data.part[result.messageID]?.find((item) => item.id === result.partID)
    return part?.type === "text" ? part.text : undefined
  }

  // The user's filter narrows the rows by their names. The list template would match it against each row's whole text,
  // the state and the time included, which follow the data, so a row would come and go as its time ticks; the template
  // is left to draw the input only, and the rows are narrowed here, by the name as it is when the filter is typed.
  const [needle, setNeedle] = createSignal("")

  // The list keeps its items while only their state changes: building them again would mount every row anew on each tool
  // a running sub-agent calls. Each item reads its row where it is drawn, so the glyph, the text and the time still
  // follow the data. When a state change does move rows (the order of the ids changes), the list keeps the selection on
  // its sub-agent: it follows the id, and starts over at the first row only when the filter text changes.
  const ids = createMemo<string[]>(() => rows().map((row) => row.id), [], { equals: sameStrings })
  const shownIDs = createMemo<string[]>(
    () => {
      const text = needle().trim()
      return ids().filter((id) => {
        if (!text) return true
        const row = untrack(() => rowOf(id))
        return row !== undefined && fuzzysort.single(text, subagentTitle(row)) !== null
      })
    },
    [],
    { equals: sameStrings },
  )
  // The rows on screen. The clock and the widths of the columns follow these only: a running sub-agent the filter
  // hides keeps no subscription alive and does not move the columns of the rows that are shown.
  const shownRows = createMemo(() => shownIDs().flatMap((id) => rowOf(id) ?? []))
  const ticking = createMemo(() => shownRows().some((row) => row.marker === "running"))
  const stateWidth = createMemo(() =>
    Math.max(0, ...shownRows().map((row) => cellWidth(stateText(row), ambiguousWidth()))),
  )
  const initiatorWidth = createMemo(() =>
    Math.max(0, ...shownRows().map((row) => cellWidth(subagentInitiatorText(row), ambiguousWidth()))),
  )
  const nameWidth = createMemo(() => {
    const marker = cellWidth(`${SUBAGENT_MARKER_GLYPH.running} `, ambiguousWidth())
    const room = innerWidth() - MARK_CELLS - marker - NAME_GAP - initiatorWidth() - NAME_GAP - stateWidth()
    return Math.max(MIN_NAME_WIDTH, room)
  })
  const items = createMemo<ListItem<string>[]>(() =>
    shownIDs().map((id) => ({
      id,
      value: id,
      get title() {
        const row = rowOf(id)
        return row ? titleNode(row) : id
      },
      // The heading follows the row, which moves between groups as its state does.
      get group() {
        const row = rowOf(id)
        return row ? subagentGroupTitle(row.group) : undefined
      },
      lead: <StateGlyph row={() => rowOf(id)} />,
      // Read for the selected row, and for the first one, where the list looks for a detail at all. The delegated prompt
      // is the first user message of the session when it is loaded; otherwise the Task description stands in, and
      // nothing is requested to get the message. A background run that is over adds what it reported, which is read
      // from the main session's messages when they are loaded.
      get detail() {
        const row = rowOf(id)
        if (!row) return undefined
        return detailText(
          subagentDetail(row, {
            prompt: delegatedPrompt(sync.data.message[id], (messageID) => sync.data.part[messageID]),
            resultText: resultText(row),
          }),
        )
      },
    })),
  )

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
        title={<PanelTitle counts={counts()} />}
        command={COMMAND}
        items={items()}
        filter={{ client: false }}
        onFilter={(value) => setNeedle(value)}
        selectionKey={needle()}
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
  return <text fg={textFg(theme, "secondary")}>{props.filtered ? t("panel.list.empty") : t("subagent.none")}</text>
}
