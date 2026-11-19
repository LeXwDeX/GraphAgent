import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
  type Accessor,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { hideToolDetails, toolAttention } from "./tool-attention"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { lifecycleKey } from "../../context/lifecycle-mirror"
import { backgroundResultOf, type TaskIndexEntry } from "../../context/session-summary"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { truncateCells, type AmbiguousWidth } from "../../ui/width"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { PatchDiff } from "../../component/patch-diff"
import type {
  AssistantMessage,
  Message,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@graphagent/sdk"
import { createSessionAttention } from "@graphagent/sdk/attention"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import {
  DIAGNOSTIC_LINES,
  numberValue,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
  recordValue,
  stringValue,
  toolDisplay,
  toolRowName,
  webSearchProviderName,
} from "../../util/tool-display"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK, locationHeaders } from "../../context/sdk"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { askConfirm } from "../../ask/local-ask"
import { TodoItem } from "../../component/todo-item"
import type { PromptInfo } from "../../component/prompt/history"
import { dagPanelSpec } from "../../panel/dag"
import { ForkPanel } from "../../panel/fork"
import { HooksPanel } from "../../panel/hooks"
import { MessagePanel } from "../../panel/message"
import { TimelinePanel } from "../../panel/timeline"
import { useHookStatus } from "../../context/hook-status"
import { useCommands } from "../../commands/context"
import { useDrawer } from "../../shell/drawer"
import { returnToParent, useOpenSubAgent } from "../../session/navigate"
import { isRoot, isSubagent } from "../../session/role"
import { nextSibling } from "../../session/siblings"
import {
  backgroundElapsed,
  backgroundRunningAt,
  backgroundStatus,
  type BackgroundStatus,
} from "../../session/background"
import { backgroundCard, type BackgroundCard } from "../../session/background-card"
import {
  handbackLine,
  handbackText,
  promptText,
  sameHandback,
  subagentOutcome,
  UNKNOWN,
  type HandbackLine,
} from "../../session/subagent-record"
import {
  subagentChildren,
  subagentDescription,
  subagentKind,
  subagentMarkerToken,
  subagentSiblings,
  subagentSource,
  subagentTitle,
} from "../../session/subagents"
import { isSyntheticMessage } from "../../session/synthetic-message"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { remoteLine } from "../../util/remote-text"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { createTicker } from "../../context/ticker"
import { useOptionalTicker } from "../../context/ticker-context"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { useAskSurfaceRequests } from "./ask-surface"
import { showExportOptions } from "../../panel/export"
import { useBottomZoneOptional } from "../../shell/bottom-zone"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { alwaysSeparate, setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { t } from "../../i18n"
import { renderUserTextPart } from "../../i18n/receipt"
import { useClipboard } from "../../context/clipboard"
import { nextThinkingMode, reasoningSummary, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { AdaptiveMarkdown } from "../../ui/adaptive-markdown"
import {
  EscapePriority,
  GRAPHAGENT_BASE_MODE,
  modifiedBindings,
  useBindings,
  useCommandShortcut,
  useGraphagentKeymap,
} from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { LocationProvider } from "../../context/location"
import { isQueuedMessage, orderedBefore } from "../../prompt/queued-message"
import {
  createRowMeasurements,
  createSessionViewState,
  DELEGATION_PROMPT_LINES,
  delegationFoldID,
  estimateRowHeight,
  foldRowKey,
  isWindowed,
  PART_OVERSCAN,
  prefixPositions,
  rowRevision,
  settledPartText,
  TAIL_ALWAYS,
  visibleRange,
  type Row,
  type SessionViewState,
} from "./rows"
import { createRowTable, type Delegation } from "./row-table"
import { RESULT_CARD_INDENT, RESULT_CARD_MARK, resultCardPreview, resultCardTitle } from "./result-card"
import { toggleExpand } from "./expand"
import { diffView, sessionContentWidth } from "./diff-view"
import {
  completedOutput,
  delegationFolds,
  editRows,
  errorDenied,
  errorLine,
  firstLine,
  foldFlag,
  foldOutput,
  genericRowOutput,
  lastLine,
  outputCharCap,
  patchFileRows,
  resultCardFolds,
  shellOutput,
  toolError,
  toolFailed,
  toolMetadata,
  writtenLines,
  type FoldEnv,
  type FoldSource,
} from "./fold"
import { DETAIL_SEPARATOR, ToolRow, toolRowState, type ToolRowState } from "./tool-row"

// The tool data readers live in `util/tool-display`, where `./fold` reads them too; the tests import them from here.
export {
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
  toolDisplay,
} from "../../util/tool-display"

addDefaultParsers(parsers.parsers)

export { alwaysSeparate }

const sessionBindingCommands = [
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.undo",
  "session.redo",
  "session.drawer.toggle",
  "session.dagmode.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "view.expand.toggle",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

// Home and End are the prompt's own cursor keys (#886 4.4), so the jump keys
// only apply while no editor has focus. Their modified keys never type text and
// stay active in the base mode either way.
const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  scroll: () => ScrollBoxRenderable | undefined
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
  view: SessionViewState
  rowHeight: (row: Row, index: number) => number
  measureRow: (row: Row, el: BoxRenderable) => void
  /** True while the row hosting `partID` is inside the scroll viewport. Unwindowed transcripts report everything visible. */
  isVisible: (partID: string | undefined) => boolean
  setVisibleParts: (partIDs: ReadonlySet<string> | undefined) => void
  /** The user message a sub-agent view draws as its task block; nothing in a main session (#1033 3.4). */
  delegation: Accessor<Delegation | undefined>
  /** The closing line of a sub-agent that has finished; nothing while it runs, or in a main session (#1033 3.4). */
  handback: Accessor<HandbackLine | undefined>
  shortcuts: {
    childFirst: Accessor<string>
    background: Accessor<string>
    redo: Accessor<string>
    dagmodeToggle: Accessor<string>
    /** The key of `view.expand.toggle`, which the hint on a result card names; empty while it is unbound. */
    expand: Accessor<string>
  }
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Main() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  // The session route schedules a few deferred scrolls on the shared ticker;
  // isolated renders without a provider fall back to a local ticker.
  const ticker = useOptionalTicker() ?? createTicker()
  const promptRef = usePromptRef()
  const commands = useCommands()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const openSubAgent = useOpenSubAgent()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const foregroundTasks = createMemo(() =>
    messages().flatMap((message) =>
      (sync.data.part[message.id] ?? []).filter(
        (part): part is ToolPart =>
          part.type === "tool" &&
          part.tool === "task" &&
          part.state.status === "running" &&
          part.state.metadata?.background !== true,
      ),
    ),
  )
  const askRequests = useAskSurfaceRequests()
  const visible = createMemo(() => !isSubagent(session()))
  // A sub-agent view is read-only (#1033 3.3): the keys that change the session or send it a request do nothing there.
  const readOnly = createMemo(() => isSubagent(session()))
  const disabled = createMemo(() => askRequests().length > 0)

  const pending = createMemo(() => {
    const completed = messages().findLast((x) => x.role === "assistant" && x.time.completed)
    return messages().findLast(
      (x) => x.role === "assistant" && !x.time.completed && (!completed || !orderedBefore(x, completed)),
    )
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)
  const revertBoundary = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return undefined
    return messages().find((m) => m.id === messageID)
  })

  const atOrAfterRevert = (message: Message) => {
    const boundary = revertBoundary()
    return boundary !== undefined && !orderedBefore(message, boundary)
  }

  // What the user wrote, not what the server added after a run (#1408): a background result and the text a command
  // leaves for the model are synthetic messages. One whose parts have not arrived is not known to be the user's.
  // Undo and redo step over user messages and nothing else, so a result is never where either of them stops, and the
  // banner of a revert counts the same messages.
  const userWrote = (message: Message) => {
    if (message.role !== "user") return false
    const parts = sync.data.part[message.id]
    return parts !== undefined && !isSyntheticMessage(parts)
  }

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const boundary = revertBoundary()
    if (!boundary) return []
    return messages().filter((x) => userWrote(x) && !orderedBefore(x, boundary))
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // The row table below is built as soon as this component is created, and a
  // session that is already in the sync store (a return from home or the diff
  // view) has rows by then. What the table reads while it is built, the tool-details
  // setting and the content width, has to be declared before it: a `const` read
  // earlier throws "Cannot access ... before initialization" and the transcript
  // never renders.
  const dimensions = useTerminalDimensions()
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  // The drawer overlays the main area instead of shrinking it.
  const contentWidth = createMemo(() => sessionContentWidth(dimensions().width))

  // The transcript is a flat row table. Windowing, scroll commands and height
  // estimates all read this table instead of mounted render nodes, so an
  // unmounted row can still be located and scrolled to.
  const view = createSessionViewState()
  const measurements = createRowMeasurements()

  // Windowing reports which part rows are actually on screen, so spinners in
  // scrolled-out rows stay static. Undefined means "everything visible" (the
  // unwindowed transcript and the window before the first layout pass).
  const [visibleParts, setVisibleParts] = createSignal<ReadonlySet<string> | undefined>(undefined)
  const updateVisibleParts = (next: ReadonlySet<string> | undefined) => {
    const current = visibleParts()
    if (current === next) return
    if (current && next && current.size === next.size && [...next].every((id) => current.has(id))) return
    setVisibleParts(next)
  }
  const isVisiblePart = (partID: string | undefined) => {
    const ids = visibleParts()
    if (!ids || !partID) return true
    return ids.has(partID)
  }

  // A sub-agent view opens its record with the task its parent delegated (#1033 3.4): the first message of the
  // session, when it is the user message that carries the prompt, is drawn as that block and not as a user message.
  // The window the session keeps (the last 100 messages) can have dropped it; then there is no task block, and the
  // description stays in the top bar.
  const delegation = createMemo(
    (): Delegation | undefined => {
      const current = session()
      if (!current || !isSubagent(current)) return undefined
      const first = messages()[0]
      if (first?.role !== "user" || !promptText(sync.data.part[first.id] ?? [])) return undefined
      return { messageID: first.id, description: subagentDescription(current, sync.data.taskIndex[current.id]) }
    },
    undefined,
    { equals: (left, right) => left?.messageID === right?.messageID && left?.description === right?.description },
  )
  // The Task call of the parent that started the agent: its state tells how it ended when the session's own does not.
  const parentTask = createMemo(() => {
    const entry = sync.data.taskIndex[route.sessionID]
    if (!entry) return undefined
    const part = sync.data.part[entry.parentMessageID]?.find((item) => item.id === entry.partID)
    return { background: entry.background, status: part?.type === "tool" ? part.state.status : undefined }
  })
  const handback = createMemo(
    (): HandbackLine | undefined => {
      if (!isSubagent(session())) return undefined
      const summary = sync.data.summary[route.sessionID]
      const outcome = subagentOutcome(summary, parentTask())
      return outcome ? handbackLine(outcome, summary) : undefined
    },
    undefined,
    { equals: sameHandback },
  )

  const rowData = createRowTable({
    messages,
    parts: (messageID) => sync.data.part[messageID] ?? [],
    readPartText: (part) => sync.readPartText(part),
    view,
    showDetails,
    lastAssistantID: () => lastAssistant()?.id,
    revertMessageID,
    revertRevision: () => rowRevision(revert()?.reverted.length, revertInfo()?.diff),
    reverted: atOrAfterRevert,
    delegation,
    // The line is words, so its revision is the words: a language switch measures it again.
    handback: () => {
      const line = handback()
      if (!line) return undefined
      const text = handbackText(line)
      return rowRevision(text.glyph, text.lead, text.meta)
    },
  })

  const rows = createMemo(() => rowData().rows)

  const rowIndexByMessage = createMemo(() => {
    const index = new Map<string, number>()
    rows().forEach((row, position) => {
      if (!index.has(row.messageID)) index.set(row.messageID, position)
    })
    return index
  })

  const heightFor = (row: Row, index: number) => {
    const width = contentWidth()
    const measured = measurements.get(row.key, row.revision, width)
    if (measured !== undefined) return measured
    const expanded = view.get(row.partID, "expanded") || view.get(row.partID, "errorExpanded")
    return estimateRowHeight(row, width, rowData().chars.get(row.key) ?? 0, expanded) + (row.kind === "tool" ? 1 : 0)
  }

  // Rows the transcript keeps mounted wherever the viewport is: the ones still being written and the
  // ones the reader opened. A set that changes with neither leaves the rows alone.
  const pinnedKeys = createMemo(
    () => {
      const keys = new Set(rowData().streaming)
      for (const [partID, flags] of view.state())
        if (flags.expanded || flags.errorExpanded) keys.add(foldRowKey(partID))
      return keys
    },
    new Set<string>(),
    { equals: (previous, next) => previous.size === next.size && [...next].every((key) => previous.has(key)) },
  )

  const positions = createMemo(() => {
    measurements.version()
    view.state()
    return prefixPositions(rows(), heightFor)
  })

  const measureRow = (row: Row, el: BoxRenderable) => {
    if (el.isDestroyed || el.height <= 0) return
    measurements.report(row.key, row.revision, contentWidth(), el.height)
  }

  const drawer = useDrawer()
  const [conceal, setConceal] = kv.signal("conceal_code", true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const showTimestamps = createMemo(() => timestamps() === "show")
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()
  const hookStatus = useHookStatus()

  onCleanup(
    event.subscribe((evt) => {
      if (
        evt.type !== "session.hook.status" &&
        evt.type !== "session.hook.message" &&
        evt.type !== "session.hook.terminal"
      )
        return
      if (evt.properties.sessionID !== route.sessionID) return
      if (evt.type === "session.hook.message") {
        const message = evt.properties.message
        if (typeof message === "string" && message)
          toast.show({ text: message, level: "info", dedupeKey: "session.hook.message" })
        return
      }
      if (evt.type === "session.hook.terminal") {
        const sequence = evt.properties.sequence
        if (process.stdout.isTTY && typeof sequence === "string") process.stdout.write(sequence)
        return
      }
      hookStatus.update(evt.properties)
    }),
  )

  let lastSwitch: string | undefined = undefined
  onCleanup(
    event.on("message.part.updated", (evt) => {
      const part = evt.properties.part
      if (part.type !== "tool") return
      if (part.sessionID !== route.sessionID) return
      if (part.state.status !== "completed") return
      if (part.id === lastSwitch) return

      if (part.tool === "plan_exit") {
        local.agent.set("build")
        lastSwitch = part.id
      }
    }),
  )

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r, route.sessionID)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }

  // Session switches keep this component mounted, so activation is scoped to
  // the route id instead of the component. Each switch bumps the generation,
  // aborts work from the previous id, resets per-session UI state, and queues
  // one serialized activation so a slow switch cannot overlap the next one.
  let generation = 0
  let activation = Promise.resolve()
  // How many jumps the route has asked for and got: a snap to the end queued before one does not undo it.
  let jumps = 0
  // The session whose activation ended last. By then its messages are loaded and the view is at the end, which is where
  // an activation leaves it, so a jump the route asks for (below) waits for it. A switch clears it: a session visited
  // before does not count as activated while its new activation is still queued.
  const [activated, setActivated] = createSignal<string>()

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        const current = ++generation
        const isCurrent = () => current === generation
        setActivated(undefined)
        seeded = false
        lastSwitch = undefined
        prompt?.set(route.prompt ?? { input: "", parts: [] })
        // A sub-agent session that cannot be shown sends the user back to its parent session; any other goes home.
        // Read now: a deletion can drop the entry from the store before the failure comes back.
        let parentID = sync.session.get(sessionID)?.parentID

        activation = activation
          .then(async () => {
            if (!isCurrent()) return
            const previousWorkspace = untrack(() => project.workspace.current())
            const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
            if (!isCurrent()) return
            if (!result.data) {
              if (parentID) {
                returnToParent(parentID, { kind: "notFound" }, { route: { navigate }, toast })
                return
              }
              toast.show({
                text: `Session not found: ${sessionID}`,
                level: "error",
                duration: 5000,
              })
              navigate({ type: "home" })
              return
            }
            parentID = result.data.parentID

            if (result.data.workspaceID !== previousWorkspace) {
              project.workspace.set(result.data.workspaceID)

              // Sync all the data for this workspace. Note that this
              // workspace may not exist anymore which is why this is not
              // fatal. If it doesn't we still want to show the session
              // (which will be non-interactive)
              try {
                await sync.bootstrap({ fatal: false })
              } catch {}
              if (!isCurrent()) return
            }
            editor.reconnect(result.data.directory)
            // Register the session and its parent chain for full events before
            // the snapshot, so events in between merge instead of being
            // dropped.
            await sync.session.activate(sessionID)
            if (!isCurrent()) {
              sync.session.deactivate()
              return
            }
            if (result.data.parentID && !sync.data.message[result.data.parentID]) {
              await sync.session.sync(result.data.parentID).catch(() => undefined)
              if (!isCurrent()) {
                sync.session.deactivate()
                return
              }
            }
            if (scroll) scroll.scrollBy(100_000)
            setActivated(sessionID)
          })
          .catch((error) => {
            if (!isCurrent()) return
            if (parentID) {
              returnToParent(parentID, { kind: "failed", message: errorMessage(error) }, { route: { navigate }, toast })
              return
            }
            toast.show({
              text: errorMessage(error),
              level: "error",
              duration: 5000,
            })
            navigate({ type: "home" })
          })

        // Leaving this route releases its interest source and lets the LRU
        // shrink. The generation bump aborts any activation still in flight.
        onCleanup(() => {
          if (!isCurrent()) return
          generation += 1
          sync.session.deactivate()
        })
      },
    ),
  )

  const keymap = useGraphagentKeymap()
  const bottomZone = useBottomZoneOptional()
  const renderer = useRenderer()

  // The bottom zone renders the head of the shared root-tree ask queue; local
  // confirm/choice entries are appended separately and survive replacement.
  createEffect(() => {
    bottomZone?.setAsk(askRequests())
  })
  onCleanup(() => bottomZone?.setAsk([]))

  // The input belongs to the bottom zone, below the status band and above the footer, not to this column
  // (#1032 D1). The route keeps its wiring: the closure below runs inside the zone but reads this route's
  // draft binding, submit scroll and ask state. The zone creates it outside this route's provider tree, so the
  // session's location (the directory its `@` file search runs in) is provided again here. A sub-agent view has
  // no input.
  const offComposer = bottomZone?.setComposer({
    render: () => (
      <Show when={session() && visible()}>
        <LocationProvider location={location()}>
          <box width="100%" flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
            <Prompt
              visible={!disabled()}
              ref={bind}
              disabled={disabled()}
              onSubmit={() => {
                toBottom()
              }}
              sessionID={route.sessionID}
            />
          </box>
        </LocationProvider>
      </Show>
    ),
  })
  onCleanup(() => offComposer?.())

  function openBottomPanel(id: string, render: () => JSX.Element) {
    if (!bottomZone) return
    if (bottomZone.host.top()?.id === id) return
    bottomZone.host.push({ id, render })
  }

  onCleanup(commands.setHandler("hooks.list", () => openBottomPanel("hooks", () => <HooksPanel />)))
  // `/dag` is read in a root session and in a sub-agent view alike: the panel shows the root's workflows either way.
  onCleanup(
    commands.setHandler("dag.open", () => {
      if (!bottomZone || bottomZone.host.top()?.id === "dag") return
      bottomZone.host.push(dagPanelSpec())
    }),
  )

  const windowed = () => isWindowed(rows().length)

  // The message the last jump of a windowed session asked to put at the top of the viewport.
  let aligning: string | undefined

  // Small sessions stay fully mounted, so keep using the rendered nodes for
  // exact positions. Windowed sessions locate the target in the row table.
  const scrollToMessageID = (messageID: string) => {
    if (!scroll || scroll.isDestroyed) return false
    if (!windowed()) {
      const child = scroll.getChildren().find((item) => item.id === messageID)
      if (!child) return false
      scroll.scrollBy(child.y - scroll.y - 1)
      return true
    }
    const index = rowIndexByMessage().get(messageID)
    if (index === undefined) return false
    scroll.scrollTo(positions()[index])
    // The offset is only as good as the heights the rows above the target were estimated with. The next frame
    // mounts the rows around the target and lays them out, and this puts the target at the top of the viewport
    // after that layout, before the frame is drawn. A later jump takes the request over.
    aligning = messageID
    scroll.afterLayout(() => {
      if (aligning === messageID && !scroll.isDestroyed)
        scroll.scrollChildIntoView(messageID, { align: "start", inset: 1 })
    })
    return true
  }

  function previewMessage(messageID?: string) {
    if (messageID) scrollToMessageID(messageID)
  }

  // Brings a message into view, at the top of the viewport. The report the server adds when a background run ends is
  // drawn as its result card, which carries the message's id (`BackgroundResultCard`), so the jump lands on the card.
  // A message that draws nothing has no place of its own (other synthetic text has no row): what it brought is at the
  // end of the transcript, so that is where the jump goes.
  function jumpToMessage(messageID: string) {
    if (windowed()) {
      if (scrollToMessageID(messageID)) return
    } else if (scroll.getChildren().some((item) => item.id === messageID)) {
      // Lands again after the next frame's layout, which a jump made right after the messages came in needs.
      scroll.scrollChildIntoView(messageID, { align: "start", inset: 1 })
      return
    }
    scroll.scrollTo(scroll.scrollHeight)
  }

  // A jump the route asks for (#1058 7: the click on the toast of a finished background run). It waits for the
  // session's activation, which ends by scrolling to the end, so that the jump is the last scroll. The request is
  // taken off the route when it is carried out: a later click on the same toast asks again, and scrolls again.
  createEffect(() => {
    const target = route.messageID
    if (!target || activated() !== route.sessionID || !session() || !scroll || scroll.isDestroyed) return
    untrack(() => {
      jumps++
      jumpToMessage(target)
      navigate({ type: "session", sessionID: route.sessionID })
    })
  })

  // A click on a user message opens its actions. A sub-agent view has none to offer (#1033 3.3): its messages are
  // not clickable, and the text is copied by selecting it.
  function openMessagePanel(message: UserMessage) {
    if (renderer.getSelection()?.getSelectedText()) return
    openBottomPanel("message", () => (
      <MessagePanel
        messageID={message.id}
        sessionID={route.sessionID}
        queued={isQueuedMessage(message, pending())}
        setPrompt={(promptInfo) => prompt?.set(promptInfo)}
        editPrompt={(request) => prompt?.edit(request)}
      />
    ))
  }

  const attention = createSessionAttention({
    clientType: "terminal",
    send: (update, signal) => sdk.client.session.attention(update, { signal }),
  })
  const backgroundAttention = createSessionAttention({
    clientType: "terminal",
    send: (update, signal) => sdk.client.session.attention(update, { signal }),
  })
  createEffect(() => attention.select(route.sessionID))
  // The parent whose background view this session holds, set only while it is a background sub-agent. The Task
  // link lives in the summary layer (`taskIndex`, kept by the parent's tool events), so this holds when the
  // parent's own messages are not loaded, or were evicted from the hydrated cache.
  const backgroundParentID = createMemo(() => {
    const current = session()
    const parentID = current?.parentID
    return parentID && sync.data.taskIndex[current.id]?.background === true ? parentID : undefined
  })
  // Every switch of session, siblings included, closes the previous lease before the next one opens, so the old
  // view keeps no heartbeat. A session that is not a background sub-agent holds no lease at all.
  createEffect(
    on([() => route.sessionID, backgroundParentID], ([, parentID]) => {
      backgroundAttention.select(undefined)
      if (parentID) backgroundAttention.select(parentID, true)
    }),
  )
  // An interceptor ahead of all others, not a `keypress` listener: the keymap consumes the keys it binds (left and
  // right between sub-agents, the page keys, esc) before later listeners run, and those are user activity too.
  const offActivity = keymap.intercept("key", () => attention.activity(), { priority: 1_000 })
  onCleanup(() => {
    offActivity()
    void attention.close()
    void backgroundAttention.close()
  })

  // Helper: Find the next user row above or below the viewport. Positions come
  // from the row table, so the target does not need to be mounted.
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    if (!scroll || scroll.isDestroyed) return null
    if (!windowed()) {
      const scrollTop = scroll.y
      const visibleMessages = scroll
        .getChildren()
        .filter((child) => {
          if (!child.id) return false
          const message = messages().find((item) => item.id === child.id)
          if (!message) return false
          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) return false
          return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
        })
        .sort((left, right) => left.y - right.y)
      if (visibleMessages.length === 0) return null
      if (direction === "next") return visibleMessages.find((child) => child.y > scrollTop + 10)?.id ?? null
      return visibleMessages.findLast((child) => child.y < scrollTop - 10)?.id ?? null
    }
    const top = scroll.scrollTop
    // The task block of a sub-agent view is its first user message.
    const userRows = rows().flatMap((row, index) =>
      row.kind === "user" || row.kind === "delegation" ? [{ row, index }] : [],
    )
    if (direction === "next") {
      const target = userRows.find((item) => positions()[item.index] > top + 10)
      return target?.row.messageID ?? null
    }
    const target = userRows.findLast((item) => positions()[item.index] < top - 10)
    return target?.row.messageID ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev") => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      return
    }

    scrollToMessageID(targetID)
  }

  function toBottom() {
    // A jump the route asked for after this was queued (back to a session with a message to show) has the last word.
    const at = jumps
    ticker.at(ticker.now() + 50, () => {
      if (at !== jumps || !scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    })
  }

  const local = useLocal()

  // The first sub-agent of the session in view: the children of a root session, or, from inside a sub-agent, the
  // first of its siblings. First in the order of the `/agents` list is the order `moveChild` walks, so this is where
  // that walk starts.
  function moveFirstChild() {
    const current = session()
    if (!current) return
    const first = subagentChildren(sync.data.session, current.parentID ?? current.id, subagentSource(sync.data))[0]
    if (!first) {
      toast.show({ text: t("subagent.none"), level: "info", dedupeKey: "subagent.none" })
      return
    }
    if (first.id !== current.id) openSubAgent(first.id)
  }

  // The previous or next sibling under the same parent, in the order of the `/agents` list (`subagentSiblings`),
  // wrapping at both ends.
  function moveChild(direction: 1 | -1) {
    const current = session()
    if (!current) return
    const next = nextSibling(
      subagentSiblings(sync.data.session, current.id, subagentSource(sync.data)),
      current.id,
      direction,
    )
    if (next) openSubAgent(next.id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!isSubagent(session()) || (bottomZone?.host.depth() ?? 0) > 0) return
      func()
    }
  }

  // Which flag folds the part of a row, read from the store and not from the blocks on screen: a windowed
  // transcript has unmounted the blocks outside the viewport, and `view.expand.toggle` has to reach them too.
  const foldSource: FoldSource = {
    text: (part) =>
      part.type === "reasoning" && part.time.end !== undefined ? settledPartText(part) : sync.readPartText(part),
    metadata: (part) => toolMetadata(part, (item) => sync.readPartPreview(item)),
  }
  function foldOfRow() {
    const env: FoldEnv = {
      width: contentWidth(),
      thinking: thinkingMode(),
      showGenericToolOutput: showGenericToolOutput(),
    }
    return (row: Row) => {
      // The task block of a sub-agent view is drawn from a user message: its prompt folds under the same flag.
      if (row.kind === "delegation") {
        return delegationFolds(promptText(sync.data.part[row.messageID] ?? []), env.width) ? "expanded" : undefined
      }
      // The card of a background result is drawn from a synthetic text part, and folds when it has more than its line.
      if (row.kind === "result") {
        const part = sync.data.part[row.messageID]?.find((item) => item.id === row.partID)
        const card = part?.type === "text" ? backgroundCard(part) : undefined
        return card && resultCardFolds(card, env.width, ambiguousWidthOf(kv.get("ambiguous_width", 1)))
          ? "expanded"
          : undefined
      }
      if (row.kind !== "reasoning" && row.kind !== "tool") return undefined
      const part = sync.data.part[row.messageID]?.find((item) => item.id === row.partID)
      return part ? foldFlag(part, env, foldSource) : undefined
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      enabled: !readOnly(),
      run: () => {
        void renameSession("")
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      run: () => {
        if (!scroll) return
        const origin = scroll.scrollTop
        openBottomPanel("timeline", () => (
          <TimelinePanel
            sessionID={route.sessionID}
            onPreview={previewMessage}
            onRestore={() => {
              if (!scroll || scroll.isDestroyed) return
              scroll.scrollTo(origin)
            }}
            onSelect={previewMessage}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      enabled: !readOnly(),
      run: () => openBottomPanel("fork", () => <ForkPanel sessionID={route.sessionID} onPreview={previewMessage} />),
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      enabled: !readOnly(),
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            text: "Connect a provider to summarize this session",
            level: "warning",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      enabled: !readOnly(),
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const revertMessage = revert ? messages().find((m) => m.id === revert) : undefined
        const message = messages().findLast((x) => userWrote(x) && (!revertMessage || orderedBefore(x, revertMessage)))
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !readOnly() && !!session()?.revert?.messageID,
      run: () => {
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const revertMessage = messages().find((m) => m.id === messageID)
        const message = revertMessage
          ? messages().find((x) => userWrote(x) && orderedBefore(revertMessage, x))
          : undefined
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: drawer.visible() ? t("drawer.command.hide") : t("drawer.command.show"),
      value: "session.drawer.toggle",
      category: "Session",
      run: () => {
        drawer.toggle()
      },
    },
    {
      title: t("help.dagmode.toggle"),
      value: "session.dagmode.toggle",
      category: "Session",
      // Sub-agent views have no mode switch: the key is inert and unlisted there.
      hidden: isSubagent(session()),
      enabled: !isSubagent(session()),
      run: () => {
        toggleDagMode()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      category: "Session",
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
      },
    },
    {
      title: t("help.expand.toggle"),
      description: t("help.expand.toggle.note"),
      value: "view.expand.toggle",
      category: "Session",
      // Opening a block is view state, not a request, so sub-agent views keep the key (spec 4.4).
      run: () => {
        toggleExpand(rows(), foldOfRow(), view)
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message the user wrote: not a synthetic one, and with text that was not ignored
        // (the echo of a command and a hook's notice are shown, not written)
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart =
            !isSyntheticMessage(parts) && parts.some((part) => part && part.type === "text" && !part.ignored)

          if (hasValidTextPart) {
            scrollToMessageID(message.id)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next"),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev"),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const revertID = session()?.revert?.messageID
        const revertMessage = revertID ? messages().find((m) => m.id === revertID) : undefined
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertMessage || orderedBefore(msg, revertMessage)),
        )
        if (!lastAssistantMessage) {
          toast.show({
            text: "No assistant messages found",
            level: "error",
          })
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({
            text: "No text parts found in last assistant message",
            level: "error",
          })
          return
        }

        const text = textParts
          .map((part) => sync.readPartText(part))
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            text: "No text content found in last assistant message",
            level: "error",
          })
          return
        }

        clipboard
          .write?.(text)
          .then(() =>
            toast.show({
              text: "Message copied to clipboard!",
              level: "success",
            }),
          )
          .catch(() =>
            toast.show({
              text: "Failed to copy to clipboard",
              level: "error",
            }),
          )
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
              readText: (part) => sync.readPartText(part),
              taskKind: (childSessionID) => sync.data.taskIndex[childSessionID]?.kind,
            },
          )
          await clipboard.write?.(transcript)
          toast.show({
            text: "Session transcript copied to clipboard!",
            level: "success",
          })
        } catch {
          toast.show({
            text: "Failed to copy session transcript",
            level: "error",
          })
        }
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = bottomZone
            ? await showExportOptions({
                host: bottomZone.host,
                defaultFilename,
                defaultThinking: showThinking(),
                defaultToolDetails: showDetails(),
                defaultAssistantMetadata: showAssistantMetadata(),
                defaultOpenWithoutSaving: false,
              })
            : null

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
              readText: (part) => sync.readPartText(part),
              taskKind: (childSessionID) => sync.data.taskIndex[childSessionID]?.kind,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
          } else {
            const exportDir = paths.cwd
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await writeExport(filepath, transcript)

            // Open with EDITOR if available
            const result = await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
            if (result !== undefined) {
              await writeExport(filepath, result)
            }

            toast.show({
              text: `Session exported to ${filename}`,
              level: "success",
            })
          }
        } catch {
          toast.show({
            text: "Failed to export session",
            level: "error",
          })
        }
      },
    },
    {
      title: "Background subagents",
      value: "session.background",
      category: "Session",
      hidden: true,
      enabled: !readOnly() && foregroundTasks().length > 0,
      run: () => {
        void sdk.client.experimental.session.background(
          { sessionID: route.sessionID },
          { headers: locationHeaders({ workspace: project.workspace.current() }) },
        )
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        moveFirstChild()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: isSubagent(session()),
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: isSubagent(session()),
      run: childSessionHandler(() => {
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: isSubagent(session()),
      run: childSessionHandler(() => {
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      ...command,
    })),
  )

  async function renameSession(args: string) {
    const title = args.trim()
    if (!title) {
      const current = session()?.title ?? ""
      prompt?.edit({
        label: t("prompt.edit.rename"),
        value: current,
        commit: async (next) => {
          await sdk.client.session.update({
            sessionID: route.sessionID,
            title: next,
          })
        },
      })
      return
    }
    await sdk.client.session.update({
      sessionID: route.sessionID,
      title,
    })
  }

  // The DAG mode lives on the server (#886 3.9). The key asks for the opposite
  // of what `Session.dagMode` says right now and sends nothing else; the
  // result returns through `session.updated`, so no mode is kept or flipped
  // optimistically here.
  function toggleDagMode() {
    const info = session()
    if (!info || !isRoot(info)) return
    const agent = local.agent.current()
    const model = local.model.current()
    void sdk.client.session
      .command(
        {
          sessionID: info.id,
          hookMode: "interactive",
          command: "dag-mode",
          arguments: info.dagMode === "on" ? "off" : "on",
          agent: agent?.name,
          model: model ? `${model.providerID}/${model.modelID}` : undefined,
        },
        { throwOnError: true },
      )
      .catch((error) => {
        // A failing command also raises `session.error`, whose toast is keyed by
        // its text: reuse the text as the key so the two merge into one. The
        // text comes from the server, so strip escapes and control characters.
        const text = remoteLine(errorMessage(error))
        toast.show({ text, level: "error", dedupeKey: text })
      })
  }

  const registryCommandIds = new Set([
    "session.rename",
    "session.timeline",
    "session.fork",
    "session.compact",
    "session.undo",
    "session.redo",
    "session.drawer.toggle",
    "session.copy",
    "session.export",
  ])

  createEffect(() => {
    for (const command of sessionCommandList()) {
      if (!registryCommandIds.has(command.value)) continue
      onCleanup(
        commands.setHandler(command.value, (ctx) => {
          if (command.value === "session.rename") return renameSession(ctx.args)
          return command.run()
        }),
      )
    }
  })

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    bindings: modifiedBindings(
      keymap,
      tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
    ),
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: () => isSubagent(session()),
    priority: EscapePriority.subagent,
    bindings: [
      { key: "escape", desc: "Go to parent session", group: "Session", cmd: "session.parent" },
      { key: "left", desc: "Previous child session", group: "Session", cmd: "session.child.previous" },
      { key: "right", desc: "Next child session", group: "Session", cmd: "session.child.next" },
    ],
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: () => drawer.visible(),
    priority: EscapePriority.drawer,
    bindings: [{ key: "escape", desc: t("drawer.command.hide"), group: "Session", cmd: () => drawer.close() }],
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))

  // snap to bottom when session changes, unless the route comes with a jump of its own
  createEffect(
    on(
      () => route.sessionID,
      () => {
        if (!route.messageID) toBottom()
      },
    ),
  )

  // Keymap selectors re-run on every keymap state change. Creating one per
  // message makes their cost grow with the transcript, so the session owns a
  // single set and passes it down through context.
  const shortcuts = {
    childFirst: useCommandShortcut("session.child.first"),
    background: useCommandShortcut("session.background"),
    redo: useCommandShortcut("session.redo"),
    dagmodeToggle: useCommandShortcut("session.dagmode.toggle"),
    expand: useCommandShortcut("view.expand.toggle"),
  }

  return (
    <LocationProvider location={location()}>
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          diffWrapMode,
          scroll: () => scroll,
          providers,
          sync,
          tui: tuiConfig,
          view,
          rowHeight: heightFor,
          measureRow,
          isVisible: isVisiblePart,
          setVisibleParts: updateVisibleParts,
          delegation,
          handback,
          shortcuts,
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
            <Show when={session()}>
              <scrollbox
                ref={(r) => (scroll = r)}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.border,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <box height={1} />
                <Show
                  when={isWindowed(rows().length)}
                  fallback={
                    <>
                      <For each={messages()}>
                        {(message, index) => (
                          <Switch>
                            <Match when={message.id === revert()?.messageID}>
                              {(function () {
                                const [hover, setHover] = createSignal(false)

                                const handleUnrevert = async () => {
                                  if (!bottomZone) return
                                  const confirmed = await askConfirm(bottomZone, {
                                    title: "Confirm Redo",
                                    body: "Are you sure you want to restore the reverted messages?",
                                    confirmLabel: t("ask.confirm.confirm"),
                                    cancelLabel: t("ask.confirm.cancel"),
                                  })
                                  if (confirmed) {
                                    keymap.dispatchCommand("session.redo")
                                  }
                                }

                                return (
                                  <box
                                    onMouseOver={() => setHover(true)}
                                    onMouseOut={() => setHover(false)}
                                    onMouseUp={handleUnrevert}
                                    marginTop={1}
                                    flexShrink={0}
                                    border={["left"]}
                                    customBorderChars={SplitBorder.customBorderChars}
                                    borderColor={theme.backgroundPanel}
                                  >
                                    <box
                                      paddingTop={1}
                                      paddingBottom={1}
                                      paddingLeft={2}
                                      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                                    >
                                      <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                      <text fg={theme.textMuted}>
                                        <span style={{ fg: theme.text }}>{shortcuts.redo()}</span> or /redo to restore
                                      </text>
                                      <Show when={revert()!.diffFiles?.length}>
                                        <box marginTop={1}>
                                          <For each={revert()!.diffFiles}>
                                            {(file) => (
                                              <text fg={theme.text}>
                                                {file.filename}
                                                <Show when={file.additions > 0}>
                                                  <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                                </Show>
                                                <Show when={file.deletions > 0}>
                                                  <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                                </Show>
                                              </text>
                                            )}
                                          </For>
                                        </box>
                                      </Show>
                                    </box>
                                  </box>
                                )
                              })()}
                            </Match>
                            <Match when={atOrAfterRevert(message)}>
                              <></>
                            </Match>
                            <Match when={message.role === "user" && message.id === delegation()?.messageID}>
                              <DelegationBlock messageID={message.id} parts={sync.data.part[message.id] ?? []} />
                            </Match>
                            <Match when={message.role === "user"}>
                              <UserMessage
                                index={index()}
                                onMouseUp={
                                  isSubagent(session()) ? undefined : () => openMessagePanel(message as UserMessage)
                                }
                                message={message as UserMessage}
                                parts={sync.data.part[message.id] ?? []}
                                pending={pending()}
                              />
                              <BackgroundResults parts={sync.data.part[message.id] ?? []} />
                            </Match>
                            <Match when={message.role === "assistant"}>
                              <AssistantMessage
                                last={lastAssistant()?.id === message.id}
                                message={message as AssistantMessage}
                                parts={sync.data.part[message.id] ?? []}
                              />
                            </Match>
                          </Switch>
                        )}
                      </For>
                      <Show when={handback() && messages().length > 0}>
                        <SubagentHandback />
                      </Show>
                    </>
                  }
                >
                  <SessionTranscript
                    rows={rows()}
                    positions={positions()}
                    pinned={pinnedKeys()}
                    revert={revert()}
                    onUserMouseUp={isSubagent(session()) ? undefined : openMessagePanel}
                  />
                </Show>
              </scrollbox>
            </Show>
          </box>
        </box>
      </context.Provider>
    </LocationProvider>
  )
}

type RevertState = {
  messageID: string
  reverted: readonly unknown[]
  diffFiles: ReturnType<typeof getRevertDiffFiles>
}

function RevertRow(props: { revert: RevertState | undefined }) {
  const { theme } = useTheme()
  const bottomZone = useBottomZoneOptional()
  const keymap = useGraphagentKeymap()
  const ctx = use()
  const [hover, setHover] = createSignal(false)

  const handleUnrevert = async () => {
    if (!bottomZone) return
    const confirmed = await askConfirm(bottomZone, {
      title: "Confirm Redo",
      body: "Are you sure you want to restore the reverted messages?",
      confirmLabel: t("ask.confirm.confirm"),
      cancelLabel: t("ask.confirm.cancel"),
    })
    if (confirmed) keymap.dispatchCommand("session.redo")
  }

  return (
    <Show when={props.revert}>
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={handleUnrevert}
        marginTop={1}
        flexShrink={0}
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundPanel}
      >
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
        >
          <text fg={theme.textMuted}>{props.revert!.reverted.length} message reverted</text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.text }}>{ctx.shortcuts.redo()}</span> or /redo to restore
          </text>
          <Show when={props.revert!.diffFiles.length}>
            <box marginTop={1}>
              <For each={props.revert!.diffFiles}>
                {(file) => (
                  <text fg={theme.text}>
                    {file.filename}
                    <Show when={file.additions > 0}>
                      <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                    </Show>
                    <Show when={file.deletions > 0}>
                      <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                    </Show>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

function SessionTranscript(props: {
  rows: Row[]
  positions: number[]
  /** Keys of the rows that stay mounted wherever the viewport is. */
  pinned: ReadonlySet<string>
  revert: RevertState | undefined
  /** Opens the actions of a user message; absent where the messages are not clickable (a sub-agent view). */
  onUserMouseUp?: (message: UserMessage) => void
}) {
  const ctx = use()
  const renderer = useRenderer()
  // The rows the viewport shows, as `visibleRange` last reported them.
  const [shown, setShown] = createSignal({ first: 0, last: 0 })
  let controller: BoxRenderable | undefined
  // The rows that are mounted now, by key: the element each one is laid out in and its measuring function.
  const mountedRows = new Map<string, { el: BoxRenderable; measure: () => void }>()
  const track = (key: string, el: BoxRenderable, measure: () => void) => {
    const entry = { el, measure }
    mountedRows.set(key, entry)
    return () => {
      if (mountedRows.get(key) === entry) mountedRows.delete(key)
    }
  }

  // The scroll box keeps one row where it is: the one the top of the viewport is in. A row above it that is
  // measured for the first time, mounted, opened or closed moves everything under it in the layout, and the
  // box takes the offset along in that same layout; left alone, the content under the reader jumps by the
  // difference between what the row was estimated at and what it measures (#1277).
  let held: { key: string; el: BoxRenderable; index: number; top: number } | undefined
  let release: (() => void) | undefined

  // Where the positions put the held row now, against where they put it when the last pass ended. They differ
  // by a change made since to the rows or to a row the reader opened or closed above it: one this frame's
  // layout applies, and the box holds the offset through. Measurements are not in it. They come after, from a
  // layout that was held already.
  const shifted = () => {
    if (!held) return 0
    const { key } = held
    const index = props.rows[held.index]?.key === key ? held.index : props.rows.findIndex((row) => row.key === key)
    return index === -1 ? 0 : props.positions[index] - held.top
  }

  const hold = (scroll: ScrollBoxRenderable, first: number) => {
    // At the end the box follows the content that comes: there is nothing to keep still, and a held row would
    // stop it from following.
    const atEnd = scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height
    const row = atEnd ? undefined : props.rows[first]
    const entry = row ? mountedRows.get(row.key) : undefined
    // Only a row an earlier layout has placed can be held. One this very pass mounted has no place yet.
    if (!row || !entry || entry.el.isDestroyed || entry.el.height <= 0) {
      release?.()
      release = undefined
      held = undefined
      return
    }
    if (held?.el === entry.el) {
      held.index = first
      held.top = props.positions[first]
      return
    }
    release = scroll.anchor(entry.el)
    held = { key: row.key, el: entry.el, index: first, top: props.positions[first] }
  }

  onCleanup(() => {
    if (controller) renderer.unregisterLifecyclePass(controller)
    release?.()
    ctx.setVisibleParts(undefined)
  })

  const tailStart = createMemo(() => props.rows.length - TAIL_ALWAYS)
  const inWindow = (index: number, range: { first: number; last: number }) =>
    index >= range.first - PART_OVERSCAN && index <= range.last + PART_OVERSCAN

  // Each row asks whether it is mounted through a selector and hears only the answers that change for it:
  // the viewport moving by a line, or a row being written at the tail, flips a handful of rows, where a
  // signal every row read would re-run every row of a long transcript.
  const isPinned = createSelector(
    () => props.pinned,
    (key: string, pinned) => pinned.has(key),
  )
  const isTail = createSelector(tailStart, (index: number, start) => index >= start)
  const isShown = createSelector(shown, inWindow)
  const mounted = (row: Row, index: number) => isPinned(row.key) || isTail(index) || isShown(index)

  // The same question, asked plainly: it visits every row once, and reading the selectors here would
  // subscribe this memo to every row on each run. Equal maps are kept apart, so a changed `positions`
  // (the row being written at the tail grows) that moves no gap does not wake the placeholder rows.
  const gaps = createMemo(
    () => {
      const range = shown()
      const start = tailStart()
      const mountedAt = (index: number) =>
        props.pinned.has(props.rows[index].key) || index >= start || inWindow(index, range)
      const result = new Map<number, number>()
      let index = 0
      while (index < props.rows.length) {
        if (mountedAt(index)) {
          index++
          continue
        }
        const first = index
        while (index < props.rows.length && !mountedAt(index)) index++
        result.set(first, props.positions[index] - props.positions[first])
      }
      return result
    },
    undefined,
    {
      equals: (previous, next) =>
        previous !== undefined &&
        previous.size === next.size &&
        [...next].every(([first, height]) => previous.get(first) === height),
    },
  )
  const hasGap = createSelector(gaps, (index: number, map) => map.has(index))

  return (
    <>
      <box
        height={0}
        ref={(el) => {
          controller = el
          el.onLifecyclePass = () => {
            const scroll = ctx.scroll()
            if (!scroll || scroll.isDestroyed) return
            // What the positions already know of the held row's place that the layout of this frame has not
            // applied yet, taken before anything is measured.
            const shift = shifted()
            // Measure what the last layout produced before the window moves. A row
            // that was mounted for one layout and is unmounted by this very pass
            // would otherwise leave unmeasured, its estimate would stay in the
            // positions, and the window computed from them would flip between two
            // ranges on every frame once the viewport follows the end.
            batch(() => {
              for (const { measure } of mountedRows.values()) measure()
            })
            // The window is the one the viewport will need after this frame's layout, at the offset the held
            // row leaves it at. What only the layout will learn of is far smaller than the rows the window
            // carries on either side.
            const range = visibleRange(props.positions, scroll.scrollTop + shift, scroll.viewport.height)
            hold(scroll, range.first)
            const current = shown()
            if (range.first === current.first && range.last === current.last) return
            const ids = new Set<string>()
            const end = Math.min(range.last, props.rows.length - 1)
            for (let index = range.first; index <= end; index++) {
              const partID = props.rows[index]?.partID
              if (partID) ids.add(partID)
            }
            batch(() => {
              setShown(range)
              ctx.setVisibleParts(ids)
            })
          }
          renderer.registerLifecyclePass(el)
        }}
      />
      <For each={props.rows}>
        {(row, index) => (
          <Switch>
            <Match when={mounted(row, index())}>
              <SessionRow row={row} revert={props.revert} onUserMouseUp={props.onUserMouseUp} track={track} />
            </Match>
            <Match when={hasGap(index())}>
              <box height={gaps().get(index())!} />
            </Match>
          </Switch>
        )}
      </For>
    </>
  )
}

function SessionRow(props: {
  row: Row
  revert: RevertState | undefined
  onUserMouseUp?: (message: UserMessage) => void
  /** Registers the row's element and measuring function with the transcript; the returned function removes them. */
  track: (key: string, el: BoxRenderable, measure: () => void) => () => void
}) {
  const ctx = use()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[ctx.sessionID] ?? [])
  const message = createMemo(() => messages().find((item) => item.id === props.row.messageID))
  const parts = createMemo(() => sync.data.part[props.row.messageID] ?? [])
  const part = createMemo(() => {
    if (!props.row.partID) return undefined
    return parts().find((item) => item.id === props.row.partID)
  })
  const index = createMemo(() => messages().findIndex((item) => item.id === props.row.messageID))
  const pending = createMemo(() => {
    const completed = messages().findLast((item) => item.role === "assistant" && item.time.completed)
    return messages().findLast(
      (item) => item.role === "assistant" && !item.time.completed && (!completed || !orderedBefore(item, completed)),
    )
  })
  const last = createMemo(() => {
    const current = message()
    return current?.role === "assistant" && messages().findLast((item) => item.role === "assistant")?.id === current.id
  })
  let untrack: (() => void) | undefined
  onCleanup(() => untrack?.())

  return (
    <box
      flexShrink={0}
      paddingTop={props.row.kind === "tool" ? 1 : 0}
      ref={(el) => {
        untrack = props.track(props.row.key, el, () => ctx.measureRow(props.row, el))
      }}
    >
      <Switch>
        <Match when={props.row.kind === "revert"}>
          <RevertRow revert={props.revert} />
        </Match>
        <Match when={props.row.kind === "user" && message()?.role === "user"}>
          <UserMessage
            index={index()}
            message={message() as UserMessage}
            parts={parts()}
            pending={pending()}
            onMouseUp={props.onUserMouseUp ? () => props.onUserMouseUp?.(message() as UserMessage) : undefined}
          />
        </Match>
        <Match when={props.row.kind === "delegation" && message()?.role === "user"}>
          <DelegationBlock messageID={props.row.messageID} parts={parts()} />
        </Match>
        <Match when={props.row.kind === "handback"}>
          <SubagentHandback />
        </Match>
        <Match when={props.row.kind === "result"}>
          <Show when={part()}>
            {(value) => {
              const current = value()
              return current.type === "text" ? <BackgroundResultCard part={current} /> : undefined
            }}
          </Show>
        </Match>
        <Match when={props.row.kind === "text" && part()?.type === "text"}>
          <TextPart last={false} part={part() as TextPart} message={message() as AssistantMessage} />
        </Match>
        <Match when={props.row.kind === "reasoning" && part()?.type === "reasoning"}>
          <ReasoningPart last={false} part={part() as ReasoningPart} message={message() as AssistantMessage} />
        </Match>
        <Match when={props.row.kind === "tool" && part()?.type === "tool"}>
          <ToolPart last={false} part={part() as ToolPart} message={message() as AssistantMessage} />
        </Match>
        <Match when={props.row.kind === "notice" && props.row.key.startsWith("task:")}>
          <AssistantTaskHint parts={parts()} />
        </Match>
        <Match when={props.row.kind === "notice" && props.row.key.startsWith("error:")}>
          <AssistantError message={message() as AssistantMessage} />
        </Match>
        <Match when={props.row.kind === "meta"}>
          <AssistantSummary message={message() as AssistantMessage} last={last()} />
        </Match>
      </Switch>
    </box>
  )
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  /** Opens the message's actions. Absent in a sub-agent view, where the block is not clickable and does not hover. */
  onMouseUp?: () => void
  index: number
  pending?: Message
}) {
  const ctx = use()
  const local = useLocal()
  const receiptShortcut = ctx.shortcuts.dagmodeToggle
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return renderUserTextPart(x, { key: receiptShortcut() })
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => isQueuedMessage(props.message, props.pending))
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              if (props.onMouseUp) setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {` ${directory ? t("message.directory") : t("message.file")} `}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> {t("message.queued")} </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title={` ${t("message.compaction")} `}
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

/**
 * The task a sub-agent view opens with (#1033 3.4): what the main agent asked of it, read-only. It stands where the
 * first user message of the session would, so the prompt is drawn once, here and not again as a user message. A long
 * prompt is cut after `DELEGATION_PROMPT_LINES` lines the way a long tool output is, and opens the way one does: by a
 * click on the block or by `view.expand.toggle`, which flip the same flag (`delegationFolds` decides when there is
 * anything to open). `/copy` and `/export` keep the prompt whole either way.
 */
function DelegationBlock(props: { messageID: string; parts: Part[] }) {
  const ctx = use()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const description = createMemo(() => ctx.delegation()?.description)
  const text = createMemo(() => promptText(props.parts))
  const folds = createMemo(() => delegationFolds(text(), ctx.width))
  const foldID = () => delegationFoldID(props.messageID)
  const expanded = () => ctx.view.get(foldID(), "expanded")
  // The cut prompt keeps the `…` line of its own: the hint under a tool output opens with one, this block's does not.
  const prompt = createMemo(() =>
    expanded() || !folds()
      ? text()
      : collapseToolOutput(text(), DELEGATION_PROMPT_LINES, outputCharCap(DELEGATION_PROMPT_LINES, ctx.width), {
          ellipsisRow: true,
        }).output,
  )

  return (
    <box
      id={props.messageID}
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      borderColor={theme.border}
      customBorderChars={SplitBorder.customBorderChars}
      flexShrink={0}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        backgroundColor={folds() && hover() ? theme.backgroundMenu : theme.backgroundPanel}
        flexShrink={0}
        onMouseOver={() => folds() && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          // Only a prompt that folds is clickable, and a drag that selected text is not a click.
          if (!folds() || renderer.getSelection()?.getSelectedText()) return
          ctx.view.set(foldID(), "expanded", !expanded())
        }}
      >
        <text fg={theme.textMuted}>{t("subagent.task.title")}</text>
        <Show when={description()}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {description()}
          </text>
        </Show>
        <Show when={prompt()}>
          <box paddingTop={1} gap={1}>
            <text fg={theme.text}>{prompt()}</text>
            <Show when={folds()}>
              <text fg={theme.textMuted}>{expanded() ? t("subagent.task.collapse") : t("subagent.task.expand")}</text>
            </Show>
          </box>
        </Show>
      </box>
    </box>
  )
}

/**
 * The line that closes the record of a finished sub-agent (#1033 3.4): `✓ <it is done and the result went back>
 * · <tool calls> · <time>`. Static, drawn once the agent is idle and not at all while it runs.
 */
function SubagentHandback() {
  const ctx = use()
  const { theme } = useTheme()
  const shown = createMemo(() => {
    const line = ctx.handback()
    return line ? { outcome: line.outcome, ...handbackText(line) } : undefined
  })

  return (
    <Show when={shown()}>
      {(line) => (
        <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
          <text>
            <span style={{ fg: theme[subagentMarkerToken(line().outcome)] }}>{line().glyph}</span>
            <span style={{ fg: line().outcome === "failed" ? theme.error : theme.textMuted }}>{line().lead}</span>
            <span style={{ fg: theme.textMuted }}>{line().meta}</span>
          </text>
        </box>
      )}
    </Show>
  )
}

/** The `ambiguous_width` setting as the width functions take it. */
const ambiguousWidthOf = (value: unknown): AmbiguousWidth => (value === 2 ? 2 : 1)

/** The theme token the mark of a result card is drawn in, by how the run ended. */
const RESULT_CARD_COLOR = {
  completed: "success",
  error: "error",
  interrupted: "warning",
} as const satisfies Record<BackgroundCard["status"], string>

/** The cards of a user message: one for each of its parts that reports a finished background run. */
function BackgroundResults(props: { parts: Part[] }) {
  const results = createMemo(() =>
    props.parts.filter((part): part is TextPart => part.type === "text" && backgroundResultOf(part) !== undefined),
  )
  return <For each={results()}>{(part) => <BackgroundResultCard part={part} />}</For>
}

/**
 * The card of a finished background run (#1058): the result the server added to this session when the run ended, drawn
 * where that message sits and not hidden with the rest of the synthetic text. Closed it is two lines, the title with its
 * status and time, and the first line of what the run left with a hint at its end. `view.expand.toggle` opens the whole
 * result under the title, drawn as the markdown assistant text is (`resultCardFolds` says when there is more to open;
 * the key and the hint read it). A click opens the sub-agent that ran it, and asks the server for nothing. Only the
 * metadata of the part says that it is a result (`backgroundCard`).
 */
function BackgroundResultCard(props: { part: TextPart }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const renderer = useRenderer()
  const openSubAgent = useOpenSubAgent()
  const [hover, setHover] = createSignal(false)
  const link = createMemo(() => ctx.sync.data.taskIndex[backgroundResultOf(props.part)?.childSessionID ?? ""])
  const card = createMemo(() => backgroundCard(props.part, link()?.kind))
  const ambiguousWidth = () => ambiguousWidthOf(kv.get("ambiguous_width", 1))
  const folds = createMemo(() => {
    const value = card()
    return value ? resultCardFolds(value, ctx.width, ambiguousWidth()) : false
  })
  // A card that cannot fold is closed, whatever flag an earlier width left: the key could not close it.
  const expanded = createMemo(() => folds() && ctx.view.get(props.part.id, "expanded"))
  const hint = createMemo(() => {
    const key = ctx.shortcuts.expand()
    if (!key || !folds()) return t("background.card.hintOpen")
    return t(expanded() ? "background.card.hintCollapse" : "background.card.hint", { key })
  })
  const layout = (firstLine: string) =>
    resultCardPreview({
      firstLine,
      hint: hint(),
      folds: folds(),
      width: ctx.width,
      ambiguousWidth: ambiguousWidth(),
    })

  return (
    <Show when={card()}>
      {(value) => {
        const title = createMemo(() => resultCardTitle(value(), ctx.width, ambiguousWidth()))
        const preview = createMemo(() => layout(value().firstLine))
        // The hint of an open card stands alone under the body, at the same end of the line.
        const closing = createMemo(() => layout(""))
        return (
          <box
            // The jump to the report (the toast of a finished run) finds the card by its message: that message draws
            // no user block of its own, its text being synthetic.
            id={props.part.messageID}
            ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
            marginTop={1}
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.border}
            flexShrink={0}
          >
            <box
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={1}
              backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
              flexShrink={0}
              onMouseOver={() => setHover(true)}
              onMouseOut={() => setHover(false)}
              onMouseUp={() => {
                // A drag that selected text is not a click.
                if (renderer.getSelection()?.getSelectedText()) return
                openSubAgent(value().childSessionID)
              }}
            >
              <text wrapMode="none" fg={theme.text}>
                <span style={{ fg: theme[RESULT_CARD_COLOR[value().status]] }}>{RESULT_CARD_MARK} </span>
                {title()}
              </text>
              <Show
                when={expanded()}
                fallback={
                  <text wrapMode="none">
                    <span style={{ fg: value().status === "error" ? theme.error : theme.textMuted }}>
                      {" ".repeat(RESULT_CARD_INDENT)}
                      {preview().text}
                    </span>
                    <span>{" ".repeat(preview().pad)}</span>
                    <span style={{ fg: theme.textDim }}>{preview().hint}</span>
                  </text>
                }
              >
                <box paddingTop={1}>
                  <AdaptiveMarkdown
                    content={value().body}
                    streaming={false}
                    syntaxStyle={syntax()}
                    tableOptions={{ style: "grid" }}
                    conceal={ctx.conceal()}
                    fg={theme.markdownText}
                    bg={theme.backgroundPanel}
                  />
                </box>
                <box paddingTop={1}>
                  <text wrapMode="none">
                    <span>{" ".repeat(RESULT_CARD_INDENT + closing().pad)}</span>
                    <span style={{ fg: theme.textDim }}>{closing().hint}</span>
                  </text>
                </box>
              </Show>
            </box>
          </box>
        )
      }}
    </Show>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <AssistantTaskHint parts={props.parts} />
      <AssistantError message={props.message} />
      <AssistantSummary message={props.message} last={props.last} />
    </>
  )
}

function AssistantTaskHint(props: { parts: Part[] }) {
  const ctx = use()
  const { theme } = useTheme()
  return (
    <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
      <box paddingTop={1} paddingLeft={3}>
        <text fg={theme.text}>
          {ctx.shortcuts.childFirst()}
          <span style={{ fg: theme.textMuted }}> {t("background.hint.view")}</span>
        </text>
      </box>
    </Show>
  )
}

function AssistantError(props: { message: AssistantMessage }) {
  const { theme } = useTheme()
  const retryBlocked = createMemo(() => {
    const error = recordValue(props.message.error)
    if (error?.name !== "APIError") return false
    const metadata = recordValue(recordValue(error.data)?.metadata)
    return typeof metadata?.retryBlockedBy === "string"
  })
  return (
    <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        marginTop={1}
        backgroundColor={theme.backgroundPanel}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.error}
      >
        <text fg={theme.textMuted}>{errorMessage(props.message.error)}</text>
        <Show when={retryBlocked()}>
          <text fg={theme.textMuted}>{t("message.retryBlocked")}</text>
        </Show>
      </box>
    </Show>
  )
}

function AssistantSummary(props: { message: AssistantMessage; last: boolean }) {
  const local = useLocal()
  const ctx = use()
  const sync = useSync()
  const { theme } = useTheme()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  return (
    <Switch>
      <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
        <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
          <text marginTop={1}>
            <span
              style={{
                fg:
                  props.message.error?.name === "MessageAbortedError"
                    ? theme.textMuted
                    : local.agent.color(props.message.agent),
              }}
            >
              ▣{" "}
            </span>{" "}
            <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
            <span style={{ fg: theme.textMuted }}> · {model()}</span>
            <Show when={duration()}>
              <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
            </Show>
            <Show when={props.message.error?.name === "MessageAbortedError"}>
              <span style={{ fg: theme.textMuted }}> · {t("message.interrupted")}</span>
            </Show>
          </text>
        </box>
      </Match>
    </Switch>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

const INLINE_TOOL_ICON_WIDTH = 2

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  // Expansion lives in the session view state so unmounting a windowed row
  // does not lose it.
  const expanded = () => ctx.view.get(props.part.id, "expanded")

  // Reasoning is finalized when the server sets `time.end` (see processor.ts).
  // Flips independently of the parent message completing.
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const raw = createMemo(() => {
    // A finished part reads its snapshot: following the stream version would re-run this on every frame.
    const text = isDone() ? settledPartText(props.part) : ctx.sync.readPartText(props.part)
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return text.replace("[REDACTED]", "")
  })
  // While streaming only leading blank lines are dropped; the full body is
  // trimmed once, when it stops changing.
  const content = createMemo(() => (isDone() ? raw().trim() : raw().trimStart()))
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const syntax = createSyntaxStyleMemo((owner) => generateSubtleSyntax(theme, owner))

  const toggle = () => {
    if (!inMinimal()) return
    ctx.view.set(props.part.id, "expanded", !expanded())
  }

  return (
    <Show when={content()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box onMouseUp={toggle}>
          <ReasoningHeader
            toggleable={inMinimal()}
            open={!inMinimal() || expanded()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
            visible={() => ctx.isVisible(props.part.id)}
          />
        </box>
        <Show when={(!inMinimal() || expanded()) && summary().body}>
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <AdaptiveMarkdown
              content={summary().body}
              streaming={!isDone()}
              syntaxStyle={syntax()}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
  visible?: Accessor<boolean>
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()} visible={props.visible}>
            {props.title ? "Thinking: " + props.title : "Thinking"}
          </Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          <Show when={props.toggleable}>
            <span>{props.open ? "- " : "+ "}</span>
          </Show>
          <span>Thought</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  // `time.end` marks the final text part. Until then the trailing block stays
  // in streaming mode, and only leading blank lines are dropped; the full body
  // is trimmed once when it stops changing.
  const isDone = createMemo(() => props.part.time?.end !== undefined)
  // A finished part reads its snapshot: following the stream version would re-run this on every frame.
  const raw = createMemo(() => (isDone() ? settledPartText(props.part) : ctx.sync.readPartText(props.part)))
  const content = createMemo(() => (isDone() ? raw().trim() : raw().trimStart()))
  return (
    <Show when={content()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
        <AdaptiveMarkdown
          content={content()}
          streaming={!isDone()}
          syntaxStyle={syntax()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => hideToolDetails(props.part.tool, props.part.state, ctx.showDetails()))

  const toolprops = {
    get metadata() {
      // The running output window lives in the stream buffer, not the store
      // (#886 5.3); it overlays the snapshot until the durable part settles.
      return toolMetadata(props.part, (part) => ctx.sync.readPartPreview(part))
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return completedOutput(props.part.state)
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={display() === "bash"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={display() === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={display() === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={display() === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={display() === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={display() === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={display() === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={display() === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={display() === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={display() === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={display() === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={display() === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}
/** The parts of an arg that are there, set off with a space. */
const words = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ")

/** `text` as one line of a row: no escapes or control characters, and a tab is a space. */
const oneLine = (text: string) => remoteLine(text.replaceAll("\t", " "))

/**
 * The row of a tool call that draws no block of its own (#1614): the state the call is in and what each state says
 * under it, and what a click on the row opens. A call that completed says what its tool has to say as `done`, and
 * "done" when it has nothing. A call whose output folds gives the lines the row leaves out of it as `folds` and the
 * whole of it as `body`, which the open row draws.
 */
function ToolCall(props: {
  part: ToolPart
  name: string
  arg?: string
  /** The line under a call that completed. */
  done?: string | JSX.Element
  /** The color of `done`, when it is a string that is not in the one the state gives. */
  doneColor?: RGBA
  /** What a call that runs has printed last. */
  progress?: string
  /** The lines the row leaves out of the output of a call that completed, when that output folds. */
  folds?: number
  /**
   * A call that completed has a `body` to open under its summary, and its row says nothing of it: no hint under the
   * summary, open or closed. The click and `view.expand.toggle` open it all the same (an edit, a write, a patch).
   */
  opens?: boolean
  /** The whole output of a call that folds, or what the open row of a call that `opens` draws. */
  body?: JSX.Element
  /** A call that completed without doing what it was asked: its dot is that of a call that failed. */
  blocked?: boolean
  /** What the open row of a call that failed draws after its error: the output a command printed before it did. */
  trace?: string
}) {
  const { theme } = useTheme()
  const ctx = use()

  const waiting = useWaiting(() => props.part)
  const error = createMemo(() => toolError(props.part.state))
  // A call the user or the rules turned down is not a failure: it has no error to open.
  const failed = createMemo(() => toolFailed(props.part.state))
  const completed = () => props.part.state.status === "completed"
  const state = createMemo((): ToolRowState => {
    const current = toolRowState(props.part.state, waiting())
    return current === "done" && props.blocked ? "failed" : current
  })
  const folded = () => completed() && (props.folds !== undefined || Boolean(props.opens))
  const expanded = () => ctx.view.get(props.part.id, "expanded")
  const errorExpanded = () => ctx.view.get(props.part.id, "errorExpanded")

  const result = (): string | JSX.Element | undefined => {
    switch (state()) {
      case "waiting":
        return t("tool.row.waiting")
      case "pending":
        return t("tool.row.pending")
      case "running":
        return t("tool.row.running")
      case "denied":
        return t("tool.row.denied")
      case "failed": {
        // A call that completed and is drawn as failed was blocked: what it says is why.
        if (completed()) return props.done
        const line = errorLine(error())
        return line ? t("tool.row.failedWith", { error: line }) : t("tool.row.failed")
      }
      default:
        return props.done ?? t("tool.row.done")
    }
  }

  return (
    <ToolRow
      state={state()}
      name={props.name}
      arg={props.arg}
      width={ctx.width}
      result={result()}
      resultColor={completed() ? props.doneColor : undefined}
      detail={state() === "running" ? props.progress : undefined}
      hidden={folded() ? props.folds : undefined}
      expanded={folded() ? expanded() : failed() ? errorExpanded() : false}
      expandKey={ctx.shortcuts.expand()}
      visible={() => ctx.isVisible(props.part.id)}
      onClick={
        folded()
          ? () => ctx.view.set(props.part.id, "expanded", !expanded())
          : failed()
            ? () => ctx.view.set(props.part.id, "errorExpanded", !errorExpanded())
            : undefined
      }
    >
      {folded() ? (
        props.body
      ) : (
        <box>
          <text fg={theme.error}>{error()}</text>
          <Show when={props.trace}>
            <box marginTop={1}>
              <text fg={theme.textMuted}>{props.trace}</text>
            </box>
          </Show>
        </box>
      )}
    </ToolRow>
  )
}

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const attention = createMemo(() => toolAttention(props.tool, props.part.state))
  // The output the reader asked to see; a call that was blocked says why instead.
  const output = createMemo(() => genericRowOutput(attention(), props.output, ctx.showGenericToolOutput()))
  const fold = createMemo(() => foldOutput(output(), ctx.width))

  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={input(props.input)}
      blocked={Boolean(attention())}
      folds={fold().folds ? fold().hidden : undefined}
      done={
        attention() ? (
          <text fg={theme.error}>{attention()}</text>
        ) : fold().folds ? (
          oneLine(firstLine(output()))
        ) : output() ? (
          <text fg={theme.text}>{output()}</text>
        ) : undefined
      }
      body={<text fg={theme.text}>{output()}</text>}
    />
  )
}

function InlineTool(props: {
  icon: string
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const errorExpanded = () => ctx.view.get(props.part.id, "errorExpanded")

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const error = createMemo(() => toolError(props.part.state))

  const denied = createMemo(() => errorDenied(error()))

  // A failed call folds its error text under the row, and a click on the row opens it (see `onMouseUp` below).
  const failed = createMemo(() => toolFailed(props.part.state))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.icon}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={denied()}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      visible={() => ctx.isVisible(props.part.id)}
      separate={props.separate}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          ctx.view.set(props.part.id, "errorExpanded", !errorExpanded())
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  visible?: Accessor<boolean>
  separate?: boolean
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return props.separate ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} visible={props.visible} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: { title?: string; children: JSX.Element; part?: ToolPart }) {
  const { theme } = useTheme()
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
    >
      <Show when={props.title}>
        {(title) => (
          <text paddingLeft={3} fg={theme.textMuted}>
            {title()}
          </text>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  // Only the tail of the output is known here (the server keeps `SHELL_TAIL_LINES` of it), and while the call runs it
  // is the preview the stream buffer holds, so what the row keeps of a folded output is its last line.
  const output = createMemo(() => shellOutput(props.metadata))
  const fold = createMemo(() => foldOutput(output(), ctx.width))
  // The code a command that failed exited with; a signal ends a command with none.
  const exit = createMemo(() => {
    const code = numberValue(props.metadata.exit)
    return code === undefined || code === 0 ? undefined : code
  })
  const withExit = (text: string) => (exit() === undefined ? text : t("tool.row.exitWith", { code: exit()!, text }))

  const workdir = createMemo(() => {
    const dir = stringValue(props.input.workdir)
    if (!dir || dir === ".") return undefined
    const formatted = pathFormatter.format(dir)
    return formatted === "." ? undefined : formatted
  })
  // The first line of the command, and a `…` when there are more; the directory it runs in, when it is not this one.
  const arg = createMemo(() => {
    const lines = (stringValue(props.input.command) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length === 0) return undefined
    return words(lines[0] + (lines.length > 1 ? "…" : ""), workdir() && "· " + workdir())
  })

  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={arg()}
      progress={oneLine(lastLine(output()))}
      folds={fold().folds ? fold().hidden : undefined}
      doneColor={exit() === undefined ? undefined : theme.error}
      done={
        !output() ? (
          exit() === undefined ? (
            t("tool.row.noOutput")
          ) : (
            t("tool.row.exit", { code: exit()! })
          )
        ) : fold().folds ? (
          withExit(oneLine(lastLine(output())))
        ) : (
          <text fg={exit() === undefined ? theme.text : theme.error}>{withExit(output())}</text>
        )
      }
      body={<text fg={theme.text}>{output()}</text>}
      trace={output()}
    />
  )
}

/** The errors a call's diagnostics hold for one file, in words. */
const diagnosticCount = (errors: number) =>
  t(errors === 1 ? "tool.row.diagnostics.one" : "tool.row.diagnostics.other", { n: errors })

/**
 * What a change did to a file, the line under the call of an edit or of a file of a patch: the lines it added and the
 * lines it removed, in the colors of success and of error, and how many errors the language server found in the file.
 * A count the server did not give is left out, and the others stand as they are.
 */
function ChangeSummary(props: { additions?: number; deletions?: number; errors: number }) {
  const { theme } = useTheme()
  const counts = createMemo(() => {
    const list: Array<{ text: string; fg: RGBA }> = []
    if (props.additions !== undefined) list.push({ text: "+" + props.additions, fg: theme.success })
    // U+2212, the minus sign, and not the hyphen of a flag.
    if (props.deletions !== undefined) list.push({ text: "\u2212" + props.deletions, fg: theme.error })
    return list
  })
  return (
    <text fg={theme.text} wrapMode="none">
      <For each={counts()}>
        {(count, index) => <span style={{ fg: count.fg }}>{(index() ? " " : "") + count.text}</span>}
      </For>
      <Show when={props.errors > 0}>
        <span style={{ fg: theme.error }}>{DETAIL_SEPARATOR + diagnosticCount(props.errors)}</span>
      </Show>
    </text>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const filePath = createMemo(() => stringValue(props.input.filePath))
  const code = createMemo(() => stringValue(props.input.content) ?? "")
  // The code block numbers the lines the file has, which the line break that ends the last one does not start.
  const shown = createMemo(() => code().replace(/\n$/, ""))
  const lines = createMemo(() => writtenLines(code()))
  const errors = useDiagnosticErrors(() => props.metadata.diagnostics, filePath)

  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={pathFormatter.format(filePath())}
      // What a write has under its summary is the file it wrote, which is always folded and opened with no hint.
      opens={lines() > 0}
      done={
        <text fg={theme.text} wrapMode="none">
          {t(lines() === 1 ? "tool.row.written.one" : "tool.row.written.other", { n: lines() })}
          <Show when={errors().length > 0}>
            <span style={{ fg: theme.error }}>{DETAIL_SEPARATOR + diagnosticCount(errors().length)}</span>
          </Show>
        </text>
      }
      body={
        <box flexDirection="column">
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(filePath())}
              syntaxStyle={syntax()}
              content={shown()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath() ?? ""} />
        </box>
      }
    />
  )
}

/** What a search tool acts on: its pattern, and where it looks when it is not the working directory. */
function searchArg(pattern: string | undefined, path: string) {
  if (pattern === undefined) return undefined
  return words(`"${pattern}"`, path ? t("tool.row.inPath", { path }) : undefined)
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  const count = createMemo(() => numberValue(props.metadata.count))
  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={searchArg(stringValue(props.input.pattern), pathFormatter.format(stringValue(props.input.path)))}
      done={
        count() === undefined
          ? undefined
          : t(count() === 1 ? "tool.row.files.one" : "tool.row.files.other", { n: count()! })
      }
    />
  )
}

/** How much a call that read a file or a directory got of it, in words; nothing when the server did not say. */
function readSummary(display: unknown) {
  const info = recordValue(display)
  if (info?.type === "directory") {
    const entries = numberValue(info.totalEntries)
    return entries === undefined
      ? undefined
      : t(entries === 1 ? "tool.row.entries.one" : "tool.row.entries.other", { n: entries })
  }
  const start = numberValue(info?.lineStart)
  const end = numberValue(info?.lineEnd)
  if (start === undefined || end === undefined) return undefined
  const lines = Math.max(0, end - start + 1)
  return t(lines === 1 ? "tool.row.lines.one" : "tool.row.lines.other", { n: lines })
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  const summary = createMemo(() => readSummary(props.metadata.display))
  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={words(pathFormatter.format(stringValue(props.input.filePath)), input(props.input, ["filePath"]))}
      done={
        loaded().length > 0 ? (
          <box>
            <text fg={theme.text} wrapMode="none">
              {summary() ?? t("tool.row.done")}
            </text>
            <For each={loaded()}>
              {(filepath) => (
                <text fg={theme.textMuted}>
                  {"↳ " + t("tool.row.loaded", { path: pathFormatter.format(filepath) })}
                </text>
              )}
            </For>
          </box>
        ) : (
          summary()
        )
      }
    />
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  const matches = createMemo(() => numberValue(props.metadata.matches))
  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={searchArg(stringValue(props.input.pattern), pathFormatter.format(stringValue(props.input.path)))}
      done={
        matches() === undefined
          ? undefined
          : matches() === 0
            ? t("tool.row.noMatches")
            : t(matches() === 1 ? "tool.row.matches.one" : "tool.row.matches.other", { n: matches()! })
      }
    />
  )
}

function WebFetch(props: ToolProps) {
  return <ToolCall part={props.part} name={toolRowName(props.tool)} arg={stringValue(props.input.url)} />
}

function WebSearch(props: ToolProps) {
  const results = createMemo(() => numberValue(props.metadata.numResults))
  const query = createMemo(() => stringValue(props.input.query))
  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      // The row leads with the tool's name: the provider goes after it by its own name, with no second "Web Search".
      arg={query() === undefined ? undefined : words(webSearchProviderName(props.metadata.provider), `"${query()}"`)}
      done={
        results() === undefined
          ? undefined
          : t(results() === 1 ? "tool.row.results.one" : "tool.row.results.other", { n: results()! })
      }
    />
  )
}

/** A run's `initiator` as the server records it; anything else is unknown. */
function initiatorValue(value: unknown): "user" | "agent" | undefined {
  return value === "user" || value === "agent" ? value : undefined
}

/** The most cells of an error the status line of a background run shows. */
const TASK_REASON_CELLS = 80

/** The theme token a background run is drawn in, by how it stands; the dot tells the finished ones apart as well. */
const BACKGROUND_COLOR = {
  queued: "statusQueued",
  running: "statusRunning",
  completed: "success",
  error: "error",
  interrupted: "warning",
  cancelled: "textMuted",
} as const satisfies Record<Exclude<BackgroundStatus, "unknown">, string>

/**
 * Whether the permission the session asks for now is the one of this call: the row then says it waits, since what the
 * reader has to do is answer.
 */
function useWaiting(part: () => ToolPart) {
  const ctx = use()
  const sync = useSync()
  return createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    return Boolean(callID) && callID === part().callID
  })
}

/**
 * The row of a call that acts on a task that exists already (cancels it, reads its log, #1453): one line, `Task` and
 * what the call does to which task. It starts no run, so while it goes well it has no result line; a call that waits for
 * a permission, was turned down or failed says so under itself. A click on a call that failed opens its error, on one
 * that did not it opens the task's sub-agent, which asks the server for nothing.
 */
function TaskCall(props: { part: ToolPart; text: string | undefined; target: string | undefined }) {
  const { theme } = useTheme()
  const ctx = use()
  const openSubAgent = useOpenSubAgent()
  const waiting = useWaiting(() => props.part)
  const state = createMemo(() => toolRowState(props.part.state, waiting()))
  const error = createMemo(() => toolError(props.part.state))
  const failed = createMemo(() => toolFailed(props.part.state))
  const errorExpanded = () => ctx.view.get(props.part.id, "errorExpanded")
  const result = (): string | undefined => {
    switch (state()) {
      case "waiting":
        return t("tool.row.waiting")
      case "denied":
        return t("tool.row.denied")
      case "failed": {
        const line = errorLine(error())
        return line ? t("tool.row.failedWith", { error: line }) : t("tool.row.failed")
      }
      default:
        return undefined
    }
  }
  const open = () => {
    const id = props.target
    if (id) openSubAgent(id)
  }

  return (
    <ToolRow
      state={state()}
      name={toolRowName(props.part.tool)}
      // A call whose arguments have not arrived names nothing yet.
      arg={props.text ?? t("subagent.row.pending")}
      width={ctx.width}
      result={result()}
      expanded={failed() ? errorExpanded() : false}
      visible={() => ctx.isVisible(props.part.id)}
      onClick={
        failed()
          ? () => ctx.view.set(props.part.id, "errorExpanded", !errorExpanded())
          : props.target
            ? open
            : undefined
      }
    >
      <text fg={theme.error}>{error()}</text>
    </ToolRow>
  )
}

/** A call that cancels a background task (`action: "cancel"`) names the task it stops; it starts no run. */
function TaskCancel(props: ToolProps) {
  const sync = useSync()
  const target = createMemo(() => stringValue(props.input.task_id))
  const name = createMemo(() => {
    const id = target()
    if (!id) return undefined
    // The description and the id are remote text: one line, no escapes or control characters.
    return t("background.row.cancelCall", { description: remoteLine(sync.data.taskIndex[id]?.description ?? id) })
  })
  return <TaskCall part={props.part} text={name()} target={target()} />
}

/**
 * A call that reads a task's log (`action: "read"`, #1453) names the task it reads, in one line; it starts no run. It
 * has no description of its own, which a run's row waits for, so it must not be drawn as one.
 */
function TaskRead(props: ToolProps) {
  const sync = useSync()
  const target = createMemo(() => stringValue(props.input.task_id))
  const name = createMemo(() => {
    const id = target()
    if (!id) return undefined
    // The description and the id are remote text: one line, no escapes or control characters.
    return t("background.row.readCall", { description: remoteLine(sync.data.taskIndex[id]?.description ?? id) })
  })
  return <TaskCall part={props.part} text={name()} target={target()} />
}

function Task(props: ToolProps) {
  // A streamed call mounts before its arguments arrive (`input: {}`): which row it is must follow them.
  return (
    <Switch fallback={<TaskRun {...props} />}>
      <Match when={props.input.action === "cancel"}>
        <TaskCancel {...props} />
      </Match>
      <Match when={props.input.action === "read"}>
        <TaskRead {...props} />
      </Match>
    </Switch>
  )
}

/**
 * The row of a Task call that starts a run (#1614, #1058): `Task` and the run's kind and description on the first line,
 * with who asked for it and where it runs at the end; what the run is doing under it, `status · tool calls · time`,
 * and at the end of that line the word that opens the sub-agent. A foreground run that goes on says how to move it to
 * the background before that word. How a run stands comes from `backgroundStatus` when it runs in the background, and
 * from the call and the child's summary otherwise; the dot and the line are drawn in the color of that state.
 */
function TaskRun(props: ToolProps) {
  const { theme } = useTheme()
  const sync = useSync()
  const ctx = use()
  const kv = useKV()
  const ticker = useOptionalTicker()
  const openSubAgent = useOpenSubAgent()
  const waiting = useWaiting(() => props.part)

  // `sessionID` is the current key; `sessionId` keeps tabs for messages
  // persisted before the rename (#1069 P9).
  const sessionID = createMemo(() => stringValue(props.metadata.sessionID) ?? stringValue(props.metadata.sessionId))
  // #886 5.5: the row never loads the child session; it reads the summary that
  // the event gate keeps up to date (and that a cold start rebuilds from the
  // session list). Entering the child view is what hydrates it.
  const summary = createMemo(() => sync.data.summary[sessionID() ?? ""])
  const status = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const isRunning = createMemo(() => {
    if (props.part.state.status === "running") return true
    const value = summary()
    return value?.status === "busy" || value?.status === "retry"
  })
  const retry = createMemo(() => {
    const value = status()
    if (value?.type !== "retry") return
    return value
  })

  const duration = createMemo(() => {
    const value = summary()
    if (value?.startedAt === undefined) return 0
    return Math.max(0, value.lastActivityAt - value.startedAt)
  })

  // #1058: the link the data layer keeps for the child says who asked for the run, where it runs and what the server
  // reported when it ended. The part's own metadata stands in until the link is there.
  const link = createMemo(() => sync.data.taskIndex[sessionID() ?? ""])
  const initiator = createMemo(() => link()?.initiator ?? initiatorValue(props.metadata.initiator))
  const background = createMemo(() => link()?.background ?? props.metadata.background === true)
  const promoted = createMemo(() => link()?.promoted ?? props.metadata.promoted === true)
  const entry = createMemo(
    (): TaskIndexEntry =>
      link() ?? {
        parentSessionID: props.part.sessionID,
        parentMessageID: props.part.messageID,
        partID: props.part.id,
        background: background(),
        startedAt: props.part.state.status === "pending" ? undefined : props.part.state.time.start,
      },
  )
  // What a background run is doing. When nothing says, the row reads like a foreground one.
  const job = createMemo(() => {
    const id = sessionID()
    return id ? sync.data.lifecycle[lifecycleKey({ domain: "job", id })] : undefined
  })
  const backgroundState = createMemo((): Exclude<BackgroundStatus, "unknown"> | undefined => {
    const id = sessionID()
    if (!id || !background()) return undefined
    const state = backgroundStatus({ entry: entry(), job: job(), summary: summary() })
    return state === "unknown" ? undefined : state
  })

  const error = createMemo(() => toolError(props.part.state))
  // A call that failed on its own account keeps its error folded under the row; a click opens it, as `ctrl+o` does.
  const failed = createMemo(() => toolFailed(props.part.state))
  const errorExpanded = () => ctx.view.get(props.part.id, "errorExpanded")
  // How the run stands, in the words of a tool row: a background run by its own status, the others by their call.
  const state = createMemo((): ToolRowState => {
    switch (backgroundState()) {
      case "running":
        return "running"
      case "completed":
        return "done"
      case "error":
        return "failed"
      // Waiting for a slot, interrupted, cancelled: a dot that does not move, which the color tells apart.
      case "queued":
      case "interrupted":
      case "cancelled":
        return "pending"
    }
    const current = toolRowState(props.part.state, waiting())
    // A call that has not returned, or whose child still works after it did, is running as long as the child works.
    return (current === "done" || current === "pending") && isRunning() ? "running" : current
  })
  const running = createMemo(() => state() === "running")

  // Only a run that goes on shows a time that moves, so only a running row that is on screen listens to the one-second
  // clock; a row that is queued, finished or scrolled away keeps what it shows and costs no timer.
  const ticking = createMemo(() => running() && ctx.isVisible(props.part.id))
  createEffect(() => {
    if (!ticking() || !ticker) return
    onCleanup(ticker.subscribeSecond())
  })
  const elapsed = createMemo(() => {
    const run = backgroundState() ?? (running() ? "running" : undefined)
    if (run === undefined) return undefined
    if (ticking()) ticker?.second()
    // The time of a run that began is counted from then, not from the Task call that queued it (#1407).
    const runningAt = run === "running" ? backgroundRunningAt(job()) : undefined
    return backgroundElapsed(
      {
        sessionID: sessionID() ?? "",
        entry: entry(),
        status: run,
        ...(runningAt === undefined ? {} : { runningAt }),
      },
      ticker?.now() ?? Date.now(),
    )
  })

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  // The row cuts the line to the room it has, so the error is cut only to the most a line shows of it.
  const reason = () => backgroundReason(summary()?.error, TASK_REASON_CELLS, ambiguousWidth())
  const calls = () => formatSubagentToolcalls(summary()?.toolCalls)
  const time = () => {
    const value = elapsed()
    return value === undefined ? UNKNOWN : Locale.duration(value)
  }

  // The line under the first one: how the run stands, in words.
  const line = createMemo((): string => {
    const run = backgroundState()
    const retrying = retry()
    const retryLine = retrying && formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))
    if (run !== undefined) {
      if (run === "running" && retryLine) return retryLine
      return formatBackgroundStatus({
        status: run,
        reported: link()?.result !== undefined,
        calls: calls(),
        elapsed: time(),
        reason: run === "error" ? reason() : undefined,
      })
    }
    switch (state()) {
      case "waiting":
        return t("tool.row.waiting")
      case "denied":
        return t("tool.row.denied")
      case "failed": {
        const text = errorLine(error())
        return text ? t("tool.row.failedWith", { error: text }) : t("tool.row.failed")
      }
      case "running":
        return (
          retryLine || formatBackgroundStatus({ status: "running", reported: false, calls: calls(), elapsed: time() })
        )
      case "done":
        return t("subagent.row.done", {
          detail: formatCompletedSubagentDetail(summary()?.toolCalls, Locale.duration(duration())),
        })
      default:
        return t("subagent.row.pending")
    }
  })

  // The kind and what it was asked to do read as they do in the top bar and in `/agents`.
  const title = createMemo(() => {
    const child = sync.session.get(sessionID() ?? "")
    const session = { title: child?.title ?? "", agent: child?.agent }
    const task = {
      kind: link()?.kind ?? stringValue(props.input.subagent_type),
      description: link()?.description ?? stringValue(props.input.description),
    }
    const description = subagentDescription(session, task)
    return description ? subagentTitle({ kind: subagentKind(session, task), description }) : ""
  })
  const tags = createMemo(() =>
    title()
      ? formatSubagentTags({ initiator: initiator(), background: background(), promoted: promoted() })
      : undefined,
  )

  const tone = createMemo((): RGBA => {
    const run = backgroundState()
    // A run that is retrying says so in the color of an error, as a foreground one does.
    if (run !== undefined) return run === "running" && retry() ? theme.error : theme[BACKGROUND_COLOR[run]]
    switch (state()) {
      case "running":
        return retry() ? theme.error : theme.primary
      case "done":
        return theme.success
      case "failed":
      case "denied":
        return theme.error
      case "waiting":
        return theme.warning
      default:
        return theme.textMuted
    }
  })

  // A foreground run that goes on can be moved to the background: the row says which key does it, unless none does.
  const move = createMemo(() => {
    if (state() !== "running" || background() || props.part.state.status !== "running") return undefined
    const key = ctx.shortcuts.background()
    return key ? t("background.hint.move", { key }) : undefined
  })
  // The word at the end of the line: what a click does, which a call that failed does not (it opens its error).
  const enter = createMemo(() => !failed() && Boolean(sessionID()))
  const open = () => {
    const id = sessionID()
    if (id) openSubAgent(id)
  }

  return (
    <ToolRow
      state={state()}
      name={toolRowName(props.tool)}
      arg={title()}
      tag={tags()}
      width={ctx.width}
      result={line()}
      resultColor={tone()}
      dotColor={tone()}
      note={move()}
      action={enter() ? t("background.row.enter") : undefined}
      expanded={failed() ? errorExpanded() : false}
      visible={() => ctx.isVisible(props.part.id)}
      onClick={
        failed() ? () => ctx.view.set(props.part.id, "errorExpanded", !errorExpanded()) : enter() ? open : undefined
      }
    >
      <text fg={theme.error}>{error()}</text>
    </ToolRow>
  )
}

export function formatSubagentToolcalls(count: number | undefined) {
  // A cold start cannot reconstruct historical tool counts (#886 5.4); `—`
  // distinguishes "unknown" from a real zero.
  if (count === undefined) return UNKNOWN
  return t(count === 1 ? "subagent.end.tools.one" : "subagent.end.tools.other", { count })
}

/** Who asked for the run and whether it runs in the background, which the first line of a Task row ends with (#1058). */
export function formatSubagentTags(labels: {
  initiator: "user" | "agent" | undefined
  background: boolean
  promoted: boolean
}) {
  const initiator = t(labels.initiator === "user" ? "background.row.byUser" : "background.row.byAgent")
  const execution = t(
    labels.promoted
      ? "background.row.promoted"
      : labels.background
        ? "background.row.background"
        : "background.row.foreground",
  )
  return `${initiator} · ${execution}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return t("subagent.row.retry", { attempt, message })
}

export function formatCompletedSubagentDetail(toolcalls: number | undefined, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

/**
 * The status line of a background run, without its arrow: what `backgroundStatus` decided, in words (#1058).
 * `reported` is whether the server has told how the run ended, in a message of its own below the row; `calls` and
 * `elapsed` come ready, with `—` for what is unknown.
 */
export function formatBackgroundStatus(input: {
  status: Exclude<BackgroundStatus, "unknown">
  reported: boolean
  calls: string
  elapsed: string
  reason?: string
}) {
  const { status, calls, elapsed, reason } = input
  if (status === "queued") return t("background.row.queued")
  if (status === "running") return t("background.row.running", { calls, elapsed })
  if (status === "completed") {
    return t(input.reported ? "background.row.completedResult" : "background.row.completed", { elapsed })
  }
  if (status === "error") return reason ? t("background.row.error", { reason }) : t("background.row.errorBare")
  if (status === "interrupted") return t("background.row.interrupted")
  if (status === "cancelled") return t("background.row.cancelled")
  // A status added to `BackgroundStatus` without a line here does not typecheck.
  return status satisfies never
}

/** The first line of an error that has any text, as one displayable line cut to `width` cells; none without one. */
export function backgroundReason(error: string | undefined, width: number, ambiguousWidth: AmbiguousWidth) {
  for (const line of (error ?? "").split(/\r?\n/)) {
    const text = remoteLine(line)
    if (text) return truncateCells(text, width, ambiguousWidth) || undefined
  }
  return undefined
}

/** The diff of one file, as an open row draws it under its summary; the colors of the diff are its own. */
function DiffBlock(props: { diff: string; filePath: string | undefined }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const view = createMemo(() => diffView(ctx.tui.diff_style, ctx.width))
  return (
    <PatchDiff
      scroll={ctx.scroll}
      diff={props.diff}
      view={view()}
      filetype={filetype(props.filePath)}
      syntaxStyle={syntax()}
      showLineNumbers={true}
      width="100%"
      wrapMode={ctx.diffWrapMode()}
      fg={theme.text}
      addedBg={theme.diffAddedBg}
      removedBg={theme.diffRemovedBg}
      contextBg={theme.diffContextBg}
      addedSignColor={theme.diffHighlightAdded}
      removedSignColor={theme.diffHighlightRemoved}
      lineNumberFg={theme.diffLineNumber}
      lineNumberBg={theme.diffContextBg}
      addedLineNumberBg={theme.diffAddedLineNumberBg}
      removedLineNumberBg={theme.diffRemovedLineNumberBg}
    />
  )
}

function Edit(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  const filePath = createMemo(() => stringValue(props.input.filePath))
  const rows = createMemo(() => editRows(props.metadata))
  // What the edit added and removed is counted by the server (`filediff`); a call that has no count says it is done.
  const filediff = createMemo(() => recordValue(props.metadata.filediff))
  const additions = createMemo(() => numberValue(filediff()?.additions))
  const deletions = createMemo(() => numberValue(filediff()?.deletions))
  const errors = useDiagnosticErrors(() => props.metadata.diagnostics, filePath)

  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={words(pathFormatter.format(filePath()), input({ replaceAll: props.input.replaceAll }))}
      // What an edit has under its summary is its diff, which is always folded and opened with no hint.
      opens={rows() > 0}
      done={
        additions() === undefined && deletions() === undefined ? undefined : (
          <ChangeSummary additions={additions()} deletions={deletions()} errors={errors().length} />
        )
      }
      body={
        <box flexDirection="column">
          <DiffBlock diff={stringValue(props.metadata.diff) ?? ""} filePath={filePath()} />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath() ?? ""} />
        </box>
      }
    />
  )
}

type PatchFileInfo = ReturnType<typeof parseApplyPatchFiles>[number]

/** One file of a patch: a row of its own, which opens to the diff of the file. */
function PatchFile(props: ToolProps & { file: PatchFileInfo }) {
  const pathFormatter = usePathFormatter()
  const rows = createMemo(() => patchFileRows(props.file))
  const errors = useDiagnosticErrors(
    () => props.metadata.diagnostics,
    () => props.file.movePath ?? props.file.filePath,
  )
  // What the patch did to the file, said as the tool does: a file it deleted, created or moved is named so.
  const arg = createMemo(() => {
    const file = props.file
    if (file.type === "delete") return t("tool.row.patch.deleted", { path: file.relativePath })
    if (file.type === "add") return t("tool.row.patch.created", { path: file.relativePath })
    if (file.type === "move") {
      return t("tool.row.patch.moved", { from: pathFormatter.format(file.filePath), to: file.relativePath })
    }
    return file.relativePath
  })

  return (
    <ToolCall
      part={props.part}
      name={toolRowName(props.tool)}
      arg={arg()}
      opens={rows() > 0}
      done={
        <ChangeSummary additions={props.file.additions} deletions={props.file.deletions} errors={errors().length} />
      }
      body={
        <box flexDirection="column">
          <DiffBlock diff={props.file.patch} filePath={props.file.filePath} />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.file.movePath ?? props.file.filePath} />
        </box>
      }
    />
  )
}

function ApplyPatch(props: ToolProps) {
  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  return (
    <Show
      when={props.part.state.status === "completed" && files().length > 0}
      fallback={<ToolCall part={props.part} name={toolRowName(props.tool)} />}
    >
      <For each={files()}>{(file) => <PatchFile {...props} file={file} />}</For>
    </Show>
  )
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={parseTodos(props.metadata.todos).length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending="Updating todos..."
          failure="Todo update failed"
          complete={false}
          part={props.part}
        >
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  const name = createMemo(() => stringValue(props.input.name))
  return (
    <ToolCall part={props.part} name={toolRowName(props.tool)} arg={name() === undefined ? undefined : `"${name()}"`} />
  )
}

/** The errors the language server found in `filePath`, all of them, from the diagnostics a call recorded. */
function useDiagnosticErrors(diagnostics: () => unknown, filePath: () => string | undefined) {
  const terminalEnvironment = useTuiTerminalEnvironment()
  return createMemo(() =>
    parseDiagnostics(diagnostics(), normalizePath(filePath() ?? "", terminalEnvironment.platform), Infinity),
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const errors = useDiagnosticErrors(
    () => props.diagnostics,
    () => props.filePath,
  )

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors().slice(0, DIAGNOSTIC_LINES)}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}
