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
import { cellWidth, truncateCells, type AmbiguousWidth } from "../../ui/width"
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
  numberValue,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
  recordValue,
  stringValue,
  toolDisplay,
  webSearchProviderLabel,
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
import { nextSibling } from "../../session/siblings"
import { backgroundElapsed, backgroundStatus, type BackgroundStatus } from "../../session/background"
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
  subagentMarkerToken,
  subagentSiblings,
  subagentSource,
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
import { setPreLayoutSiblingMargin } from "../../util/layout"
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
  editShowsBlock,
  errorDenied,
  foldFlag,
  GENERIC_OUTPUT_LINES,
  genericOutput,
  genericShowsBlock,
  outputCharCap,
  resultCardFolds,
  SHELL_OUTPUT_LINES,
  shellOutput,
  shellShowsBlock,
  toolError,
  toolFailed,
  toolMetadata,
  writeShowsBlock,
  type FoldEnv,
  type FoldSource,
} from "./fold"

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

export const alwaysSeparate = new WeakSet<BoxRenderable>()

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
  const visible = createMemo(() => !session()?.parentID)
  // A sub-agent view is read-only (#1033 3.3): the keys that change the session or send it a request do nothing there.
  const readOnly = createMemo(() => !!session()?.parentID)
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

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const boundary = revertBoundary()
    if (!boundary) return []
    return messages().filter((x) => x.role === "user" && !orderedBefore(x, boundary))
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
      if (!current?.parentID) return undefined
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
      if (!session()?.parentID) return undefined
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
      if (!session()?.parentID || (bottomZone?.host.depth() ?? 0) > 0) return
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
        // What the user wrote, not what the server added after a run (#1408): a background result and the text a command
        // leaves for the model are synthetic messages. One whose parts have not arrived is not known to be the user's.
        const message = messages().findLast((x) => {
          if (x.role !== "user" || (revertMessage && !orderedBefore(x, revertMessage))) return false
          const parts = sync.data.part[x.id]
          return parts !== undefined && !isSyntheticMessage(parts)
        })
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
          ? messages().find((x) => x.role === "user" && orderedBefore(revertMessage, x))
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
      hidden: !!session()?.parentID,
      enabled: !session()?.parentID,
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
      enabled: !!session()?.parentID,
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
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
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
    if (!info || info.parentID) return
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
    enabled: () => !!session()?.parentID,
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
                                  session()?.parentID ? undefined : () => openMessagePanel(message as UserMessage)
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
                    onUserMouseUp={session()?.parentID ? undefined : openMessagePanel}
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
                          {directory ? " Directory " : " File "}
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
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
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
  const prompt = createMemo(() =>
    expanded() || !folds()
      ? text()
      : collapseToolOutput(text(), DELEGATION_PROMPT_LINES, outputCharCap(DELEGATION_PROMPT_LINES, ctx.width)).output,
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
          <Show
            when={props.parts.some(
              (x) =>
                x.type === "tool" &&
                x.tool === "task" &&
                x.state.status === "running" &&
                x.state.metadata?.background !== true,
            )}
          >
            <span style={{ fg: theme.textMuted }}> · </span>
            {ctx.shortcuts.background()}
            <span style={{ fg: theme.textMuted }}> {t("background.hint.move")}</span>
          </Show>
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
          <text fg={theme.textMuted}>
            Tools started in this turn, so it was not replayed automatically. Retry manually.
          </text>
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
              <span style={{ fg: theme.textMuted }}> · interrupted</span>
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
function GenericTool(props: ToolProps) {
  const attention = createMemo(() => toolAttention(props.tool, props.part.state))
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => genericOutput(props.output))
  const expanded = () => ctx.view.get(props.part.id, "expanded")
  const maxLines = GENERIC_OUTPUT_LINES
  const maxChars = createMemo(() => outputCharCap(maxLines, ctx.width))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })
  // Only the block folds; the one-line fallback below has nothing to open, and `fold.ts` skips a call that draws it.
  const showBlock = () => genericShowsBlock(attention(), props.output, ctx.showGenericToolOutput())

  return (
    <Show
      when={showBlock()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={attention() ? `# ${props.tool}: blocked` : `# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={collapsed().overflow ? () => ctx.view.set(props.part.id, "expanded", !expanded()) : undefined}
      >
        <box gap={1}>
          <Show when={attention()}>{(reason) => <text fg={theme.error}>{reason()}</text>}</Show>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
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
      iconColor={props.iconColor}
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
  iconColor?: RGBA
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
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
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

function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
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
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {title()}
              </text>
            }
          >
            <Spinner color={theme.textMuted} visible={() => ctx.isVisible(props.part?.id)}>
              {title().replace(/^# /, "")}
            </Spinner>
          </Show>
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
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => shellOutput(props.metadata))
  const expanded = () => ctx.view.get(props.part.id, "expanded")
  const maxLines = SHELL_OUTPUT_LINES
  const maxChars = createMemo(() => outputCharCap(maxLines, ctx.width))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    const formatted = pathFormatter.format(workdir)
    if (formatted === ".") return undefined
    return formatted
  })

  const title = createMemo(() => {
    const wd = workdirDisplay()
    if (!wd) return
    return `# Running in ${wd}`
  })

  return (
    <Switch>
      <Match when={shellShowsBlock(props.metadata)}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={collapsed().overflow ? () => ctx.view.set(props.part.id, "expanded", !expanded()) : undefined}
        >
          <box gap={1}>
            <Show when={isRunning()} fallback={<text fg={theme.text}>$ {stringValue(props.input.command)}</text>}>
              <Spinner color={theme.text} visible={() => ctx.isVisible(props.part.id)}>
                {stringValue(props.input.command)}
              </Spinner>
            </Show>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={stringValue(props.input.command)} part={props.part}>
          {stringValue(props.input.command)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })

  return (
    <Switch>
      <Match when={writeShowsBlock(props.metadata)}>
        <BlockTool title={"# Wrote " + pathFormatter.format(stringValue(props.input.filePath))} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(stringValue(props.input.filePath))}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending="Preparing write..."
          complete={stringValue(props.input.filePath)}
          part={props.part}
        >
          Write {pathFormatter.format(stringValue(props.input.filePath))}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        ({numberValue(props.metadata.matches)} {numberValue(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

/** A run's `initiator` as the server records it; anything else is unknown. */
function initiatorValue(value: unknown): "user" | "agent" | undefined {
  return value === "user" || value === "agent" ? value : undefined
}

/** Columns the status line of a Task row starts at: the row's padding, the icon cell and the `↳ `. */
const TASK_DETAIL_INDENT = 3 + INLINE_TOOL_ICON_WIDTH + 2
/** The most cells of an error the status line of a background run shows. */
const TASK_REASON_CELLS = 80

/** The theme token a background run is drawn in, by how it stands; the icon tells the finished ones apart as well. */
const BACKGROUND_COLOR = {
  queued: "statusQueued",
  running: "statusRunning",
  completed: "success",
  error: "error",
  interrupted: "warning",
  cancelled: "textMuted",
} as const satisfies Record<Exclude<BackgroundStatus, "unknown">, string>

/** A call that cancels a background task (`action: "cancel"`) names the task it stops; it starts no run. */
function TaskCancel(props: ToolProps) {
  const sync = useSync()
  const openSubAgent = useOpenSubAgent()
  const target = createMemo(() => stringValue(props.input.task_id))
  const name = createMemo(() => {
    const id = target()
    if (!id) return undefined
    return t("background.row.cancelCall", { description: sync.data.taskIndex[id]?.description ?? id })
  })
  return (
    <InlineTool
      icon="│"
      complete={name()}
      pending={t("subagent.row.pending")}
      part={props.part}
      onClick={() => {
        const id = target()
        if (id) openSubAgent(id)
      }}
    >
      {name()}
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  // A streamed call mounts before its arguments arrive (`input: {}`): which row it is must follow them.
  return (
    <Show when={props.input.action === "cancel"} fallback={<TaskRun {...props} />}>
      <TaskCancel {...props} />
    </Show>
  )
}

function TaskRun(props: ToolProps) {
  const { theme } = useTheme()
  const sync = useSync()
  const ctx = use()
  const kv = useKV()
  const ticker = useOptionalTicker()
  const openSubAgent = useOpenSubAgent()

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
  const backgroundState = createMemo((): Exclude<BackgroundStatus, "unknown"> | undefined => {
    const id = sessionID()
    if (!id || !background()) return undefined
    const state = backgroundStatus({
      entry: entry(),
      job: sync.data.lifecycle[lifecycleKey({ domain: "job", id })],
      summary: summary(),
    })
    return state === "unknown" ? undefined : state
  })

  // Only a running line shows a time that moves, so only a running row that is on screen listens to the one-second
  // clock; a row that is queued, finished or scrolled away keeps what it shows and costs no timer.
  const ticking = createMemo(() => backgroundState() === "running" && ctx.isVisible(props.part.id))
  createEffect(() => {
    if (!ticking() || !ticker) return
    onCleanup(ticker.subscribeSecond())
  })
  const elapsed = createMemo(() => {
    const state = backgroundState()
    if (state === undefined) return undefined
    if (ticking()) ticker?.second()
    return backgroundElapsed(
      { sessionID: sessionID() ?? "", entry: entry(), status: state },
      ticker?.now() ?? Date.now(),
    )
  })

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  // The error is cut so that its line stays one row at the content width the transcript has.
  const reason = () => {
    const prefix = cellWidth(t("background.row.error", { reason: "" }), ambiguousWidth())
    const room = Math.min(TASK_REASON_CELLS, ctx.width - TASK_DETAIL_INDENT - prefix)
    return backgroundReason(summary()?.error, Math.max(10, room), ambiguousWidth())
  }

  // The line under the title. A foreground run, or one nothing is known of, has its retry, what it is doing, or how
  // the call ended; a background run says how it stands.
  const detail = createMemo(() => {
    const state = backgroundState()
    const retrying = retry()
    const retryLine = retrying && formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))
    if (state === undefined) {
      if (isRunning()) {
        if (retryLine) return retryLine
        const current = summary()?.current
        if (current) return `${Locale.titlecase(current.tool)} ${current.title ?? ""}`.trimEnd()
        return formatSubagentToolcalls(summary()?.toolCalls)
      }
      if (props.part.state.status === "completed") {
        return formatCompletedSubagentDetail(summary()?.toolCalls, Locale.duration(duration()))
      }
      return undefined
    }
    if (state === "running" && retryLine) return retryLine
    const time = elapsed()
    return formatBackgroundStatus({
      status: state,
      reported: link()?.result !== undefined,
      calls: formatSubagentToolcalls(summary()?.toolCalls),
      elapsed: time === undefined ? UNKNOWN : Locale.duration(time),
      reason: state === "error" ? reason() : undefined,
    })
  })

  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    const lines = [
      formatSubagentTitle(Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"), description, {
        initiator: initiator(),
        background: background(),
        promoted: promoted(),
      }),
    ]
    const line = detail()
    if (line) lines.push(`↳ ${line}`)
    return lines.join("\n")
  })

  const color = createMemo(() => {
    const state = backgroundState()
    if (state === undefined) return retry() ? theme.error : undefined
    // A run that is retrying says so in the color of an error, as a foreground one does.
    if (state === "running" && retry()) return theme.error
    return theme[BACKGROUND_COLOR[state]]
  })
  const icon = createMemo(() => {
    switch (backgroundState()) {
      case "completed":
        return "✓"
      case "error":
        return "✗"
      case undefined:
        return props.part.state.status === "completed" ? "✓" : "│"
      default:
        return "│"
    }
  })
  const spinning = createMemo(() => {
    const state = backgroundState()
    return state === undefined ? isRunning() : state === "running"
  })

  return (
    <InlineTool
      icon={icon()}
      separate={true}
      color={color()}
      spinner={spinning()}
      complete={stringValue(props.input.description)}
      pending={t("subagent.row.pending")}
      part={props.part}
      onClick={() => {
        const id = sessionID()
        if (id) openSubAgent(id)
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number | undefined) {
  // A cold start cannot reconstruct historical tool counts (#886 5.4); `—`
  // distinguishes "unknown" from a real zero.
  if (count === undefined) return UNKNOWN
  return t(count === 1 ? "subagent.end.tools.one" : "subagent.end.tools.other", { count })
}

/** `Explore Task — description`, then who asked for the run and whether it runs in the background (#1058). */
export function formatSubagentTitle(
  agent: string,
  description: string,
  labels: { initiator: "user" | "agent" | undefined; background: boolean; promoted: boolean },
) {
  const initiator = t(labels.initiator === "user" ? "background.row.byUser" : "background.row.byAgent")
  const execution = t(
    labels.promoted
      ? "background.row.promoted"
      : labels.background
        ? "background.row.background"
        : "background.row.foreground",
  )
  return [t("subagent.row.title", { agent, description }), initiator, execution].join(" · ")
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

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const view = createMemo(() => diffView(ctx.tui.diff_style, ctx.width))

  const ft = createMemo(() => filetype(stringValue(props.input.filePath)))

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")

  return (
    <Switch>
      <Match when={editShowsBlock(props.metadata)}>
        <BlockTool title={"← Edit " + pathFormatter.format(stringValue(props.input.filePath))} part={props.part}>
          <box paddingLeft={1}>
            <PatchDiff
              scroll={ctx.scroll}
              diff={diffContent()}
              view={view()}
              filetype={ft()}
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
          </box>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={stringValue(props.input.filePath)} part={props.part}>
          Edit {pathFormatter.format(stringValue(props.input.filePath))} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  const view = createMemo(() => diffView(ctx.tui.diff_style, ctx.width))

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <PatchDiff
          scroll={ctx.scroll}
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
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
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.patch} filePath={file.filePath} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." failure="Patch failed" complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
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
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
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
