import {
  batch,
  createContext,
  createEffect,
  createMemo,
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
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
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
import { webSearchProviderLabel } from "../../util/tool-display"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK, locationHeaders } from "../../context/sdk"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { askConfirm } from "../../ask/local-ask"
import { TodoItem } from "../../component/todo-item"
import type { PromptInfo } from "../../component/prompt/history"
import { ForkPanel } from "../../panel/fork"
import { HooksPanel } from "../../panel/hooks"
import { MessagePanel } from "../../panel/message"
import { TimelinePanel } from "../../panel/timeline"
import { useHookStatus } from "../../context/hook-status"
import { useCommands } from "../../commands/context"
import { useDrawer } from "../../shell/drawer"
import { SubagentFooter } from "./subagent-footer.tsx"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { remoteLine } from "../../util/remote-text"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { createTicker } from "../../context/ticker"
import { useOptionalTicker } from "../../context/ticker-context"
import stripAnsi from "strip-ansi"
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
  estimateRowHeight,
  isWindowed,
  PART_OVERSCAN,
  prefixPositions,
  rowRevision,
  stableRows,
  TAIL_ALWAYS,
  visibleRange,
  type Row,
  type SessionViewState,
} from "./rows"

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
  shortcuts: {
    childFirst: Accessor<string>
    background: Accessor<string>
    redo: Accessor<string>
    dagmodeToggle: Accessor<string>
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
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => b.time.created - a.time.created)
  })
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

  // The transcript is a flat row table. Windowing, scroll commands and height
  // estimates all read this table instead of mounted render nodes, so an
  // unmounted row can still be located and scrolled to.
  const view = createSessionViewState()
  const measurements = createRowMeasurements()
  let previousRows: ReadonlyMap<string, Row> = new Map()

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

  const rowData = createMemo(() => {
    const list: Row[] = []
    const chars = new Map<string, number>()
    const streaming = new Set<string>()
    const textLines = (text: string) => Math.max(1, ...text.split("\n").map((line) => line.length))

    for (const message of messages()) {
      if (message.id === revertMessageID()) {
        list.push({
          key: `revert:${message.id}`,
          messageID: message.id,
          kind: "revert",
          revision: rowRevision(revert()?.reverted.length, revertInfo()?.diff),
        })
      }
      if (atOrAfterRevert(message)) continue
      const parts = sync.data.part[message.id] ?? []

      if (message.role === "user") {
        const texts: string[] = []
        for (const part of parts) {
          if (part.type === "text" && !part.synthetic) texts.push(renderUserTextPart(part, { key: "" }))
        }
        const text = texts.join("\n\n")
        const compaction = parts.some((part) => part.type === "compaction")
        if (text || compaction) {
          const key = `user:${message.id}`
          list.push({
            key,
            messageID: message.id,
            kind: "user",
            revision: rowRevision(text, compaction),
          })
          chars.set(key, textLines(text))
        }
        continue
      }

      for (const part of parts) {
        if (part.type === "text") {
          const text = sync.readPartText(part).trim()
          if (!text) continue
          const key = `part:${part.id}`
          const done = part.time?.end !== undefined
          list.push({
            key,
            messageID: message.id,
            partID: part.id,
            kind: "text",
            revision: rowRevision(text, done),
          })
          chars.set(key, textLines(text))
          if (!done) streaming.add(key)
        } else if (part.type === "reasoning") {
          const text = sync.readPartText(part).replace("[REDACTED]", "").trim()
          if (!text) continue
          const key = `part:${part.id}`
          const done = part.time.end !== undefined
          list.push({
            key,
            messageID: message.id,
            partID: part.id,
            kind: "reasoning",
            revision: rowRevision(text, done, view.get(part.id, "expanded")),
          })
          chars.set(key, textLines(text))
          if (!done) streaming.add(key)
        } else if (part.type === "tool") {
          if (hideToolDetails(part.tool, part.state, showDetails())) continue
          const key = `part:${part.id}`
          const output = part.state.status === "completed" ? part.state.output : ""
          list.push({
            key,
            messageID: message.id,
            partID: part.id,
            kind: "tool",
            revision: rowRevision(
              part.state.status,
              output.length,
              part.state.status === "pending" ? false : Boolean(part.state.metadata?.background),
              view.get(part.id, "expanded"),
              view.get(part.id, "errorExpanded"),
            ),
          })
          if (part.state.status === "pending" || part.state.status === "running") streaming.add(key)
        }
      }

      if (parts.some((part) => part.type === "tool" && part.tool === "task")) {
        const key = `task:${message.id}`
        list.push({
          key,
          messageID: message.id,
          kind: "notice",
          revision: rowRevision(
            parts.some(
              (part) =>
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                part.state.metadata?.background !== true,
            ),
          ),
        })
      }

      if (message.error && message.error.name !== "MessageAbortedError") {
        list.push({
          key: `error:${message.id}`,
          messageID: message.id,
          kind: "notice",
          revision: rowRevision(errorMessage(message.error), message.error.name),
        })
      }

      const final = message.finish && !["tool-calls", "unknown"].includes(message.finish)
      if (lastAssistant()?.id === message.id || final || message.error?.name === "MessageAbortedError") {
        list.push({
          key: `summary:${message.id}`,
          messageID: message.id,
          kind: "meta",
          revision: rowRevision(
            message.finish,
            message.time.completed,
            message.error?.name,
            message.agent,
            message.mode,
          ),
        })
      }
    }

    const stable = stableRows(previousRows, list)
    previousRows = stable.byKey
    return { rows: stable.rows, chars, streaming }
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

  const positions = createMemo(() => {
    measurements.version()
    view.state()
    return prefixPositions(rows(), heightFor)
  })

  const measureRow = (row: Row, el: BoxRenderable) => {
    if (el.isDestroyed || el.height <= 0) return
    measurements.report(row.key, row.revision, contentWidth(), el.height)
  }

  const dimensions = useTerminalDimensions()
  const drawer = useDrawer()
  const [conceal, setConceal] = kv.signal("conceal_code", true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const showTimestamps = createMemo(() => timestamps() === "show")
  // The drawer overlays the main area instead of shrinking it.
  const contentWidth = createMemo(() => dimensions().width - 4)
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

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        const current = ++generation
        const isCurrent = () => current === generation
        seeded = false
        lastSwitch = undefined
        prompt?.set(route.prompt ?? { input: "", parts: [] })

        activation = activation
          .then(async () => {
            if (!isCurrent()) return
            const previousWorkspace = untrack(() => project.workspace.current())
            const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
            if (!isCurrent()) return
            if (!result.data) {
              toast.show({
                text: `Session not found: ${sessionID}`,
                level: "error",
                duration: 5000,
              })
              navigate({ type: "home" })
              return
            }

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
          })
          .catch((error) => {
            if (!isCurrent()) return
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

  function openBottomPanel(id: string, render: () => JSX.Element) {
    if (!bottomZone) return
    if (bottomZone.host.top()?.id === id) return
    bottomZone.host.push({ id, render })
  }

  onCleanup(commands.setHandler("hooks.list", () => openBottomPanel("hooks", () => <HooksPanel />)))

  const windowed = () => isWindowed(rows().length)

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
    return true
  }

  function previewMessage(messageID?: string) {
    if (messageID) scrollToMessageID(messageID)
  }

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
  createEffect(() => {
    const current = session()
    const parentID = current?.parentID
    const viewing =
      parentID &&
      (sync.data.message[parentID] ?? []).some((message) =>
        (sync.data.part[message.id] ?? []).some(
          (part) =>
            part.type === "tool" &&
            part.tool === "task" &&
            part.state.status !== "pending" &&
            part.state.metadata?.background === true &&
            (part.state.metadata?.sessionID ?? part.state.metadata?.sessionId) === current.id,
        ),
      )
    backgroundAttention.select(viewing ? parentID : undefined, !!viewing)
  })
  const reportActivity = () => attention.activity()
  renderer.keyInput.on("keypress", reportActivity)
  onCleanup(() => {
    renderer.keyInput.off("keypress", reportActivity)
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
    const userRows = rows().flatMap((row, index) => (row.kind === "user" ? [{ row, index }] : []))
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
    ticker.at(ticker.now() + 50, () => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    })
  }

  const local = useLocal()

  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry")
      toast.show({
        text: "Retry Error: " + status.message,
        level: "warning",
      })
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || (bottomZone?.host.depth() ?? 0) > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
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
      run: () => openBottomPanel("fork", () => <ForkPanel sessionID={route.sessionID} onPreview={previewMessage} />),
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
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
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const revertMessage = revert ? messages().find((m) => m.id === revert) : undefined
        const message = messages().findLast(
          (x) => x.role === "user" && (!revertMessage || orderedBefore(x, revertMessage)),
        )
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
      enabled: !!session()?.revert?.messageID,
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
      enabled: !session()?.parentID,
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

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

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
      enabled: foregroundTasks().length > 0,
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
    enabled: () => drawer.visible() && !session()?.parentID,
    priority: EscapePriority.drawer,
    bindings: [{ key: "escape", desc: t("drawer.command.hide"), group: "Session", cmd: () => drawer.close() }],
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  // Keymap selectors re-run on every keymap state change. Creating one per
  // message makes their cost grow with the transcript, so the session owns a
  // single set and passes it down through context.
  const shortcuts = {
    childFirst: useCommandShortcut("session.child.first"),
    background: useCommandShortcut("session.background"),
    redo: useCommandShortcut("session.redo"),
    dagmodeToggle: useCommandShortcut("session.dagmode.toggle"),
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
                          <Match when={message.role === "user"}>
                            <UserMessage
                              index={index()}
                              onMouseUp={() => {
                                if (renderer.getSelection()?.getSelectedText()) return
                                openBottomPanel("message", () => (
                                  <MessagePanel
                                    messageID={message.id}
                                    sessionID={route.sessionID}
                                    queued={isQueuedMessage(message as UserMessage, pending())}
                                    setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                                    editPrompt={(request) => prompt?.edit(request)}
                                  />
                                ))
                              }}
                              message={message as UserMessage}
                              parts={sync.data.part[message.id] ?? []}
                              pending={pending()}
                            />
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
                  }
                >
                  <SessionTranscript
                    rows={rows()}
                    positions={positions()}
                    pinned={(row) =>
                      rowData().streaming.has(row.key) ||
                      view.get(row.partID, "expanded") ||
                      view.get(row.partID, "errorExpanded")
                    }
                    revert={revert()}
                    onUserMouseUp={openMessagePanel}
                  />
                </Show>
              </scrollbox>
              <box flexShrink={0}>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <Prompt
                    visible={visible() && !disabled()}
                    ref={bind}
                    disabled={disabled()}
                    onSubmit={() => {
                      toBottom()
                    }}
                    sessionID={route.sessionID}
                  />
                </Show>
              </box>
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
  pinned: (row: Row) => boolean
  revert: RevertState | undefined
  onUserMouseUp: (message: UserMessage) => void
}) {
  const ctx = use()
  const renderer = useRenderer()
  const [first, setFirst] = createSignal(0)
  const [last, setLast] = createSignal(0)
  let controller: BoxRenderable | undefined
  // Measuring functions of the rows that are mounted now, in mount order.
  const mountedRows = new Set<() => void>()
  const track = (measure: () => void) => {
    mountedRows.add(measure)
    return () => {
      mountedRows.delete(measure)
    }
  }

  onCleanup(() => {
    if (controller) renderer.unregisterLifecyclePass(controller)
    ctx.setVisibleParts(undefined)
  })

  const mounted = (row: Row, index: number) =>
    props.pinned(row) ||
    index >= props.rows.length - TAIL_ALWAYS ||
    (index >= first() - PART_OVERSCAN && index <= last() + PART_OVERSCAN)

  const gaps = createMemo(() => {
    const result = new Map<number, number>()
    let index = 0
    while (index < props.rows.length) {
      if (mounted(props.rows[index], index)) {
        index++
        continue
      }
      const start = index
      while (index < props.rows.length && !mounted(props.rows[index], index)) index++
      result.set(start, props.positions[index] - props.positions[start])
    }
    return result
  })

  return (
    <>
      <box
        height={0}
        ref={(el) => {
          controller = el
          el.onLifecyclePass = () => {
            const scroll = ctx.scroll()
            if (!scroll || scroll.isDestroyed) return
            // Measure what the last layout produced before the window moves. A row
            // that was mounted for one layout and is unmounted by this very pass
            // would otherwise leave unmeasured, its estimate would stay in the
            // positions, and the window computed from them would flip between two
            // ranges on every frame once the viewport follows the end.
            batch(() => {
              for (const measure of mountedRows) measure()
            })
            const range = visibleRange(props.positions, scroll.scrollTop, scroll.viewport.height)
            if (range.first === first() && range.last === last()) return
            const ids = new Set<string>()
            const end = Math.min(range.last, props.rows.length - 1)
            for (let index = range.first; index <= end; index++) {
              const partID = props.rows[index]?.partID
              if (partID) ids.add(partID)
            }
            batch(() => {
              setFirst(range.first)
              setLast(range.last)
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
            <Match when={gaps().has(index())}>
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
  onUserMouseUp: (message: UserMessage) => void
  /** Registers the row's measuring function with the transcript; the returned function removes it. */
  track: (measure: () => void) => () => void
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
        untrack = props.track(() => ctx.measureRow(props.row, el))
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
            onMouseUp={() => props.onUserMouseUp(message() as UserMessage)}
          />
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
  onMouseUp: () => void
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
              setHover(true)
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
          <span style={{ fg: theme.textMuted }}> view subagents</span>
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
            <span style={{ fg: theme.textMuted }}> background</span>
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
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return ctx.sync.readPartText(props.part).replace("[REDACTED]", "")
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
  const raw = createMemo(() => ctx.sync.readPartText(props.part))
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
      if (props.part.state.status === "pending") return {}
      const metadata = props.part.state.metadata ?? {}
      // The running output window lives in the stream buffer, not the store
      // (#886 5.3); it overlays the snapshot until the durable part settles.
      const preview = ctx.sync.readPartPreview(props.part)
      return preview ? { ...metadata, output: preview.tail, previewTotalLength: preview.totalLength } : metadata
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
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
  const output = createMemo(() => props.output?.trim() ?? "")
  const expanded = () => ctx.view.get(props.part.id, "expanded")
  const maxLines = 3
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  return (
    <Show
      when={attention() || (props.output && ctx.showGenericToolOutput())}
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

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
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
      denied={Boolean(denied())}
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
  const output = createMemo(() => stripAnsi(stringValue(props.metadata.output)?.trim() ?? ""))
  const expanded = () => ctx.view.get(props.part.id, "expanded")
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
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
      <Match when={stringValue(props.metadata.output) !== undefined}>
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
      <Match when={props.metadata.diagnostics !== undefined}>
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

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const sync = useSync()
  const toast = useToast()

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

  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    let content = [
      formatSubagentTitle(
        Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"),
        description,
        props.metadata.background === true,
      ),
    ]

    const retrying = retry()
    if (isRunning() && retrying) {
      content.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning()) {
      const current = summary()?.current
      if (current) content.push(`↳ ${Locale.titlecase(current.tool)} ${current.title ?? ""}`.trimEnd())
      else content.push(`↳ ${formatSubagentToolcalls(summary()?.toolCalls)}`)
    }

    if (!isRunning() && props.part.state.status === "completed") {
      content.push(`↳ ${formatCompletedSubagentDetail(summary()?.toolCalls, Locale.duration(duration()))}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      separate={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={stringValue(props.input.description)}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (sessionID()) {
          navigate({ type: "session", sessionID: sessionID()! })
        }
        const status = retry()
        if (status)
          toast.show({
            text: "Retry Error: " + status.message,
            level: "warning",
          })
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number | undefined) {
  // A cold start cannot reconstruct historical tool counts (#886 5.4); `—`
  // distinguishes "unknown" from a real zero.
  if (count === undefined) return "—"
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number | undefined, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(stringValue(props.input.filePath)))

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
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

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
])

export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || patch === undefined || deletions === undefined) return []
    return [{ type, relativePath, filePath, patch, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
