import {
  BoxRenderable,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, untrack, Show, Switch, Match } from "solid-js"
import path from "path"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { Flag } from "@graphagent/core/flag/flag"
import { Identifier } from "@graphagent/core/id/id"
import { useTheme } from "../../context/theme"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { useSDK, locationHeaders } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { promptOffsetWidth } from "../../prompt/display"
import { createStore, produce, unwrap } from "solid-js/store"
import { useCommands, useCommandScope } from "../../commands/context"
import { resolveSlashInput, serverCommandSpec, type CommandRunContext } from "../../commands/registry"
import { parseBtwArgs, useBtwOptional } from "../../context/btw"
import { usePromptHistory, type PromptInfo } from "../../prompt/history"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { useBottomZoneOptional } from "../../shell/bottom-zone"
import { SkillsPanel } from "../../panel/skills"
import { StashPanel } from "../../panel/stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { AssistantMessage, FilePart, UserMessage } from "@graphagent/sdk"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { formatDuration } from "../../util/format"
import { t } from "../../i18n"
import { openProviderPanel } from "../../panel/provider"
import { askChoice } from "../../ask/local-ask"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useTicker } from "../../context/ticker-context"
import { useArgs } from "../../context/args"
import {
  EscapePriority,
  GRAPHAGENT_BASE_MODE,
  useBindings,
  useCommandShortcut,
  useLeaderActive,
  useGraphagentKeymap,
} from "../../keymap"
import { useTuiConfig } from "../../config"
import { usePromptWorkspace } from "./workspace"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import { TuiLog } from "../../util/log"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  /** Append text to the draft, preserving existing content and parts, then focus. */
  append(text: string): void
  /** Replace the draft with prefill text that can be committed or rolled back. */
  edit(request: PromptEditRequest): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

/**
 * A transient edit of the composer text, used by `/rename` and queued-message
 * editing. Enter commits the value (and restores the previous draft when
 * `commit` is set); Esc always restores the previous draft.
 */
export type PromptEditRequest = {
  /** Shown in the status line above the composer. */
  label: string
  value: string
  parts?: PromptInfo["parts"]
  /** When set, Enter commits the value here instead of sending a prompt. */
  commit?(value: string): void | Promise<void>
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const DRAFT_RETENTION_MIN_CHARS = 20

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

/** Same first-token rule as `resolveSlashInput`, used before scope filtering. */
function isBtwCommandInput(input: string) {
  if (!input.startsWith("/")) return false
  const firstLine = input.split("\n", 1)[0] ?? ""
  return firstLine.split(" ")[0] === "/btw"
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const leader = useLeaderActive()
  const local = useLocal()
  const args = useArgs()
  const paths = useTuiPaths()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const commands = useCommands()
  const commandScope = useCommandScope()
  const bottomZone = useBottomZoneOptional()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const [sending, setSending] = createSignal(false)
  const [failedSubmission, setFailedSubmission] = createSignal<PromptInfo>()
  createEffect(() => {
    const failed = sync.data.failed_submission[props.sessionID ?? ""]
    if (failed) setFailedSubmission(failed)
  })
  let submissionAttempt = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    submissionAttempt++
  })
  const [stopping, setStopping] = createSignal<{ sessionID: string; token: number; messageID?: string }>()
  let cancelAttempt = 0
  createEffect(() => {
    const pending = stopping()
    if (
      pending &&
      (pending.sessionID !== props.sessionID ||
        status().type === "idle" ||
        sync.data.message[pending.sessionID]?.findLast((message) => message.role === "user")?.id !== pending.messageID)
    ) {
      cancelAttempt++
      setStopping(undefined)
    }
  })
  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID || status().type !== "idle") return
    // An ordinary prompt interrupted after send must not leave a permanent
    // stopping banner. Command uncertainty is explicitly preserved here.
    local.model.acknowledgePromptInterrupt(sessionID)
  })
  const preparation = createMemo(() => {
    const current = status()
    return current.type === "busy" && current.preparation?.stage !== "memory" ? current.preparation : undefined
  })
  const history = usePromptHistory()
  const btw = useBtwOptional()
  const stash = usePromptStash()
  const keymap = useGraphagentKeymap()
  const agentShortcut = useCommandShortcut("agent.cycle")
  const paletteShortcut = useCommandShortcut("command.palette.show")
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const ticker = useTicker()
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const workspace = usePromptWorkspace(props.sessionID)
  const move = usePromptMove({ projectID: project.project, sessionID: () => props.sessionID })
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      text: t("panel.provider.promptWarning"),
      level: "warning",
      duration: 3000,
    })
    if (sync.data.provider.length === 0 && bottomZone) {
      openProviderPanel({ host: bottomZone.host })
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const session = sync.session.get(props.sessionID)
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = session?.cost ?? 0
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
        setStore("interrupt", 0)
        interruptCancel?.()
        interruptCancel = undefined
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  let interruptCancel: (() => void) | undefined
  onCleanup(() => interruptCancel?.())
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID) {
        syncedSessionID = undefined
        return
      }
      const saved = sync.session.get(sessionID)?.model
      if (!msg && !sync.data.message[sessionID]) return
      if (!saved && !msg) return

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg?.agent)
      if (msg?.agent && isPrimaryAgent) {
        // Keep command line --agent if specified.
        if (!args.agent) local.agent.set(msg.agent)
        // The session's persisted model is authoritative; the last user message is only a fallback.
        // Restoring is local-only so it neither runs model-switch hooks nor overwrites the saved model.
      }
      const restored = saved ? { providerID: saved.providerID, modelID: saved.id, variant: saved.variant } : msg?.model
      if (restored && local.model.restore(restored)) syncedSessionID = sessionID
    }
  })

  async function openPromptEditor() {
    // replace summarized text parts with the actual text
    const text = store.prompt.parts
      .filter((p) => p.type === "text")
      .reduce((acc, p) => {
        if (!p.source) return acc
        return acc.replace(p.source.text.value, p.text)
      }, store.prompt.input)

    const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

    const value = text
    const content = await openEditor({
      renderer,
      value,
      cwd:
        (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
        project.instance.directory() ||
        paths.cwd,
    })
    if (!content) return
    const normalized = normalizePromptContent(content)

    input.setText(normalized)

    // Update positions for nonTextParts based on their location in new content
    // Filter out parts whose virtual text was deleted
    // this handles a case where the user edits the text in the editor
    // such that the virtual text moves around or is deleted
    const updatedNonTextParts = nonTextParts
      .map((part) => {
        let virtualText = ""
        if (part.type === "file" && part.source?.text) {
          virtualText = part.source.text.value
        } else if (part.type === "agent" && part.source) {
          virtualText = part.source.value
        }

        if (!virtualText) return part

        const newStart = normalized.indexOf(virtualText)
        // if the virtual text is deleted, remove the part
        if (newStart === -1) return null

        const newEnd = newStart + virtualText.length

        if (part.type === "file" && part.source?.text) {
          return {
            ...part,
            source: {
              ...part.source,
              text: {
                ...part.source.text,
                start: newStart,
                end: newEnd,
              },
            },
          }
        }

        if (part.type === "agent" && part.source) {
          return {
            ...part,
            source: {
              ...part.source,
              start: newStart,
              end: newEnd,
            },
          }
        }

        return part
      })
      .filter((part) => part !== null)

    setStore("prompt", {
      input: normalized,
      // keep only the non-text parts because the text parts were
      // already expanded inline
      parts: updatedNonTextParts,
    })
    restoreExtmarksFromParts(updatedNonTextParts)
    input.cursorOffset = Bun.stringWidth(normalized)
  }

  function openSkillsDialog() {
    if (!bottomZone) return
    bottomZone.host.push({
      id: "skills",
      render: () => (
        <SkillsPanel
          onSelect={(skill) => {
            input.setText(`/${skill} `)
            setStore("prompt", {
              input: `/${skill} `,
              parts: [],
            })
            input.gotoBufferEnd()
          }}
        />
      ),
    })
  }

  const promptCommands = [
    {
      title: "Restore failed prompt",
      name: "prompt.restore_failed",
      category: "Prompt",
      enabled: () => untrack(() => Boolean(failedSubmission())),
      run: () => {
        const failed = failedSubmission()
        if (!failed) return
        if (store.prompt.input || store.prompt.parts.length) stash.push(unwrap(store.prompt))
        input.setText(failed.input)
        setStore("prompt", structuredClone(unwrap(failed)))
        setStore("mode", failed.mode ?? "normal")
        restoreExtmarksFromParts(failed.parts)
        setFailedSubmission(undefined)
        if (props.sessionID) sync.set("failed_submission", props.sessionID, undefined)
      },
    },
    {
      title: "Clear prompt",
      name: "prompt.clear",
      category: "Prompt",
      hidden: true,
      run: () => {
        clearPrompt()
      },
    },
    {
      title: "Submit prompt",
      name: "prompt.submit",
      category: "Prompt",
      hidden: true,
      run: async () => {
        if (!input.focused) return
        const handled = await submit()
        if (!handled) return
      },
    },
    {
      title: "Remove editor context",
      name: "prompt.editor_context.clear",
      category: "Prompt",
      enabled: () => untrack(() => Boolean(editorContext())),
      run: () => {
        dismissEditorContext()
      },
    },
    {
      title: "Paste",
      name: "prompt.paste",
      category: "Prompt",
      hidden: true,
      run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
        ctx.event.preventDefault()
        ctx.event.stopPropagation()
        const content = await clipboard.read?.()
        if (content?.mime.startsWith("image/")) {
          await pasteAttachment({
            filename: "clipboard",
            mime: content.mime,
            content: content.data,
          })
          return
        }
        if (content?.mime === "text/plain") {
          await pasteInputText(content.data)
        }
      },
    },
    {
      title: "Interrupt session",
      name: "session.interrupt",
      category: "Session",
      hidden: true,
      enabled: () =>
        untrack(() => status().type !== "idle" || Boolean(props.sessionID && local.model.queued(props.sessionID))),
      run: (ctx: CommandContext<Renderable, KeyEvent>) => {
        if (auto()?.visible) return
        if (!input.focused) return
        // TODO: this should be its own command
        if (store.mode === "shell") {
          setStore("mode", "normal")
          return
        }
        if (!props.sessionID) return

        // Terminals can deliver a fast ESC double-press as a single
        // meta-modified escape event; count it as the confirmed second
        // press instead of losing it.
        setStore("interrupt", store.interrupt + (ctx.event.meta ? 2 : 1))

        if (interruptCancel) interruptCancel()
        interruptCancel = ticker.at(ticker.now() + 5000, () => {
          interruptCancel = undefined
          setStore("interrupt", 0)
        })

        if (store.interrupt >= 2) {
          if (interruptCancel) interruptCancel()
          interruptCancel = undefined
          if (stopping()?.sessionID === props.sessionID) return
          const sessionID = props.sessionID
          if (status().type === "idle") {
            local.model.interruptQueued(sessionID)
            setStore("interrupt", 0)
            return
          }
          const token = ++cancelAttempt
          setStopping({
            sessionID,
            token,
            messageID: sync.data.message[sessionID]?.findLast((message) => message.role === "user")?.id,
          })
          local.model.interrupt(sessionID)
          void sdk.client.session.abort({ sessionID }, { throwOnError: true }).catch((error) => {
            if (disposed || token !== cancelAttempt || props.sessionID !== sessionID) return
            setStopping(undefined)
            toast.show({
              text: "Failed to stop session: " + (errorMessage(error) + " · Press esc twice to retry"),
              level: "error",
            })
          })
          setStore("interrupt", 0)
        }
      },
    },
    {
      title: "Open editor",
      category: "Session",
      name: "prompt.editor",
      run: openPromptEditor,
    },
    {
      title: "Skills",
      name: "prompt.skills",
      category: "Prompt",
      run: openSkillsDialog,
    },
    {
      title: "Warp",
      desc: "Change the workspace for the session",
      name: "workspace.set",
      category: "Session",
      enabled: Flag.GRAPHAGENT_WORKSPACES,
      run: () => {
        workspace.open()
      },
    },
    {
      title: "Move session",
      desc: "Move to another project dir",
      name: "session.move",
      category: "Session",
      run: () => {
        move.open()
      },
    },
  ]

  useBindings(() => ({
    commands: promptCommands,
  }))

  onCleanup(commands.setHandler("prompt.editor", openPromptEditor))
  onCleanup(commands.setHandler("prompt.skills", openSkillsDialog))
  onCleanup(commands.setHandler("workspace.set", () => workspace.open()))
  onCleanup(commands.setHandler("session.move", () => move.open()))
  onCleanup(commands.setHandler("session.btw", submitBtw))

  function submitServerCommand(name: string, args: string) {
    if (!input || input.isDestroyed) return
    const text = `/${name}${args ? " " + args : ""}`
    input.setText(text)
    setStore("prompt", { input: text, parts: [] })
    input.gotoBufferEnd()
    void submit()
  }

  function prefillBtw() {
    ref.set({ input: "/btw ", parts: [] })
    ref.focus()
  }

  function submitBtw(ctx: CommandRunContext) {
    const sessionID = props.sessionID
    if (ctx.origin !== "slash" || !ctx.args.trim()) {
      // An empty `/btw` reopens the answer panel when this session already has
      // history; otherwise it starts a fresh question in the input box.
      if (ctx.origin === "slash" && sessionID && btw?.latest(sessionID)) {
        btw.show(sessionID)
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        input.focus()
      } else {
        prefillBtw()
      }
      return
    }
    if (!sessionID) {
      toast.show({ text: t("prompt.btw.no_session"), level: "warning", dedupeKey: "prompt.btw.no_session" })
      return
    }
    const parsed = parseBtwArgs(ctx.args)
    if (!parsed) {
      toast.show({ text: t("prompt.btw.invalid_model"), level: "warning", dedupeKey: "prompt.btw.invalid_model" })
      return
    }
    if (!parsed.question || !btw) return
    // History is memory-only: side questions can carry sensitive text and
    // must not be written to prompt-history.jsonl.
    const recalled = unwrap(store.prompt).input
    void btw
      .ask(sessionID, parsed.question, { model: parsed.model })
      .then((result) => {
        if (result.type !== "busy") return
        toast.show({ text: t("prompt.btw.busy"), level: "warning", dedupeKey: "prompt.btw.busy" })
      })
      .catch((error) => TuiLog.write("error", "Side question failed", error))
    if (recalled) history.appendEphemeral({ input: recalled, parts: [] })
    input.extmarks.clear()
    input.clear()
    setStore("prompt", { input: "", parts: [] })
    setStore("extmarkToPartIndex", new Map())
    input.focus()
  }

  createEffect(() => {
    const disposers: Array<() => void> = []
    for (const command of sync.data.command) {
      const spec = serverCommandSpec(command, (ctx) => submitServerCommand(command.name, ctx.args))
      if (spec) disposers.push(commands.register(spec))
    }
    onCleanup(() => {
      for (const dispose of disposers) dispose()
    })
  })

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("prompt.palette", [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "workspace.set",
      "session.move",
    ]),
  }))

  // Escape-only interrupt layer. It sits below ask/modal but above the generic
  // base layers, so a busy session's double-escape is handled here instead of
  // being gathered as one more prompt palette command.
  useBindings(() => ({
    target: inputTarget,
    priority: EscapePriority.interrupt,
    enabled: () =>
      untrack(() => {
        if (inputTarget() === undefined || input === undefined || props.disabled || auto()?.visible) return false
        if (store.mode === "shell" || !input.focused) return false
        return status().type !== "idle" || Boolean(props.sessionID && local.model.queued(props.sessionID))
      }),
    bindings: tuiConfig.keybinds.get("session.interrupt"),
  }))

  const [editing, setEditing] = createSignal<{ request: PromptEditRequest; original: PromptInfo } | undefined>()

  function cancelEdit() {
    const current = editing()
    if (!current) return
    setEditing(undefined)
    ref.set(current.original)
    input.focus()
  }

  useBindings(() => ({
    target: inputTarget,
    // Above the interrupt layer: Esc cancels the edit instead of stopping the
    // running session, and below ask/panel layers so an incoming request wins.
    priority: EscapePriority.edit,
    enabled: () => untrack(() => editing() !== undefined),
    commands: [
      {
        name: "prompt.edit.cancel",
        title: "Cancel edit",
        category: "Prompt",
        run: cancelEdit,
      },
    ],
    bindings: [{ key: "escape", desc: "Cancel edit", group: "Prompt", cmd: "prompt.edit.cancel" }],
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      draftRevision++
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    append(text) {
      const current = unwrap(store.prompt)
      const next = current.input ? `${current.input}\n${text}` : text
      ref.set({ ...current, input: next })
      input.focus()
    },
    edit(request) {
      const original = structuredClone(unwrap(store.prompt))
      setEditing({ request, original })
      ref.set({ input: request.value, parts: request.parts ? [...request.parts] : [] })
      input.focus()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || bottomZone?.composerVisible() === false) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a panel is open.
    // Keep focus with the panel and let the prompt reclaim it after it closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  const stashCommands = [
    {
      title: "Stash prompt",
      name: "prompt.stash",
      category: "Prompt",
      enabled: () => untrack(() => !!store.prompt.input),
      run: () => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
      },
    },
    {
      title: "Stash pop",
      name: "prompt.stash.pop",
      category: "Prompt",
      enabled: () => untrack(() => stash.list().length > 0),
      run: () => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
      },
    },
    {
      title: "Stash list",
      name: "prompt.stash.list",
      category: "Prompt",
      enabled: () => untrack(() => stash.list().length > 0),
      run: () => {
        if (!bottomZone) return
        bottomZone.host.push({
          id: "stash",
          render: () => (
            <StashPanel
              onSelect={(entry) => {
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ),
        })
      },
    },
  ]

  useBindings(() => ({
    commands: stashCommands,
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: () => untrack(() => inputTarget() !== undefined && !props.disabled),
      bindings: tuiConfig.keybinds.get("prompt.paste"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: () => untrack(() => inputTarget() !== undefined && !props.disabled && store.prompt.input !== ""),
      bindings: tuiConfig.keybinds.get("prompt.clear"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: () =>
        untrack(
          () =>
            inputTarget() !== undefined &&
            !props.disabled &&
            store.mode === "normal" &&
            !auto()?.visible &&
            input?.visualCursor.offset === 0,
        ),
      bindings: [
        {
          key: "!",
          desc: "Shell mode",
          group: "Prompt",
          cmd: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      priority: EscapePriority.shell,
      enabled: () => untrack(() => inputTarget() !== undefined && store.mode === "shell"),
      bindings: [{ key: "escape", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: () =>
        untrack(() => inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0),
      bindings: [{ key: "backspace", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: () =>
        untrack(() => inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) input.cursorOffset = 0
              return false
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.previous"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: () =>
        untrack(() => inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              )
                input.cursorOffset = input.plainText.length
              return false
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.next"),
    }
  })

  let draftRevision = 0
  let workspaceAskOpen = false
  let submitting = false
  async function submit() {
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.input`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner()
    } catch (error) {
      setSending(false)
      toast.show({
        text: "Failed to send prompt: " + errorMessage(error),
        level: "error",
      })
      return false
    } finally {
      submitting = false
    }
  }

  async function submitInner() {
    workspace.clearNotice()

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (workspace.creating() || move.creating()) return false
    if (auto()?.visible) return false
    // `/rename` and provider inputs commit through a callback; the previous
    // draft comes back so the edit never replaces the user's work.
    const edit = editing()
    if (edit?.request.commit) {
      const value = store.prompt.input
      setEditing(undefined)
      ref.set(edit.original)
      await edit.request.commit(value)
      return true
    }
    if (!store.prompt.input) return false
    const editSend = edit !== undefined
    if (editSend) setEditing(undefined)
    // `/btw` is session-scoped, so `resolveSlashInput` treats it as a message on
    // the home view. Intercept it there to avoid creating a session, and keep
    // the draft: the user only gets a hint.
    if (store.mode !== "shell" && !props.sessionID && isBtwCommandInput(store.prompt.input)) {
      toast.show({ text: t("prompt.btw.no_session"), level: "warning", dedupeKey: "prompt.btw.no_session" })
      return false
    }
    if (store.mode === "shell" && props.sessionID && local.model.commandActive(props.sessionID)) {
      toast.show({
        text: t("prompt.submit.unconfirmed.toast"),
        level: "warning",
        duration: 5000,
      })
      return false
    }
    const agent = local.agent.current()
    if (!agent) return false
    const builtin = editSend
      ? ({ kind: "message" } as const)
      : resolveSlashInput(commands, commandScope(), store.prompt.input)
    if (builtin.kind === "builtin") {
      // `/btw` owns clearing and focus so empty, invalid or session-less input
      // stays in the composer. Shell mode never intercepts it.
      if (builtin.spec.id === "session.btw") {
        if (store.mode !== "shell") {
          void commands.run(builtin.spec.id, { args: builtin.args, origin: "slash" }).catch((error) => {
            toast.show({
              text: errorMessage(error),
              level: "error",
            })
          })
          return true
        }
      } else {
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        void commands.run(builtin.spec.id, { args: builtin.args, origin: "slash" }).catch((error) => {
          toast.show({
            text: errorMessage(error),
            level: "error",
          })
        })
        props.onSubmit?.()
        return true
      }
    }
    const selectedModel = structuredClone(unwrap(local.model.current()))
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      if (!bottomZone) {
        toast.show({
          text: t("prompt.workspace.unavailable.body"),
          level: "warning",
        })
        return false
      }
      if (!workspaceAskOpen) {
        workspaceAskOpen = true
        void askChoice(bottomZone, {
          title: t("prompt.workspace.unavailable.title"),
          body: t("prompt.workspace.unavailable.body"),
          options: [
            { id: "restore", label: t("prompt.workspace.unavailable.restore") },
            { id: "cancel", label: t("prompt.workspace.unavailable.cancel") },
          ],
        }).then((choice) => {
          workspaceAskOpen = false
          if (choice === "restore") workspace.open()
        })
      }
      return false
    }

    const submittedRevision = draftRevision
    const submitted = structuredClone(unwrap(store.prompt))
    const inputText = expandTrackedPastedText(
      submitted.input,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const partIndex = store.extmarkToPartIndex.get(extmark.id)
        const part = partIndex === undefined ? undefined : submitted.parts[partIndex]
        if (part?.type !== "text") return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = submitted.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const editorSelection = structuredClone(unwrap(editorContext()))
    const selectionKey = editorSelectionKey(editorSelection)
    const editorParts =
      editorSelection && editor.labelState() === "pending"
        ? [
            {
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []

    const originalSessionID = props.sessionID
    const draftUnchanged = () =>
      draftRevision === submittedRevision &&
      store.prompt.input === submitted.input &&
      JSON.stringify(unwrap(store.prompt.parts)) === JSON.stringify(submitted.parts)
    const messageID = Identifier.ascending("message")
    let accepted = false
    const attempt = ++submissionAttempt
    cancelAttempt++
    setStopping(undefined)
    const previousFailure = failedSubmission()
    if (previousFailure) stash.push(unwrap(previousFailure))
    setFailedSubmission(undefined)
    if (originalSessionID) sync.set("failed_submission", originalSessionID, undefined)
    setSending(true)
    const markEditorAccepted = () => {
      if (editorParts.length > 0 && editorSelectionKey(editorContext()) === selectionKey) editor.markSelectionSent()
    }
    const clearPending = () => {
      if (sessionID && sync.data.pending_submission[sessionID] === messageID)
        sync.set("pending_submission", sessionID, undefined)
      if (attempt === submissionAttempt) setSending(false)
    }
    const restoreDraft = () => {
      if (!store.prompt.input && store.prompt.parts.length === 0 && props.sessionID === originalSessionID) {
        input.setText(submitted.input)
        setStore("prompt", structuredClone(submitted))
        restoreExtmarksFromParts(submitted.parts)
        setStore("mode", currentMode)
        setFailedSubmission(undefined)
        return true
      }
      return false
    }
    const failed = (error: unknown) => {
      const acknowledged =
        accepted ||
        sync.data.message[sessionID ?? ""]?.some((message) => message.id === messageID) ||
        (sessionID &&
          sync.data.submission_attempt[sessionID] === messageID &&
          sync.data.pending_submission[sessionID] === undefined)
      clearPending()
      if (acknowledged) return
      if (attempt !== submissionAttempt || disposed) {
        stash.push(submitted)
        if (sessionID && sync.data.submission_attempt[sessionID] === messageID)
          sync.set("failed_submission", sessionID, { ...submitted, mode: currentMode })
        toast.show({
          text: "Failed to send prompt: " + (errorMessage(error) + " · Failed input saved in prompt stash"),
          level: "error",
        })
        return
      }
      setSending(false)
      setFailedSubmission({ ...submitted, mode: currentMode })
      restoreDraft()
      toast.show({
        text: "Failed to send prompt: " + errorMessage(error),
        level: "error",
      })
    }
    // An interrupted request stays unconfirmed: restore the draft for a retry
    // without claiming the request failed or was accepted.
    const interrupted = () => {
      if (attempt !== submissionAttempt || disposed) {
        stash.push(submitted)
        return
      }
      clearPending()
      setSending(false)
      restoreDraft()
    }
    const variant =
      props.sessionID && local.model.variant.selected() === "default" ? "default" : local.model.variant.current()
    let sessionID = props.sessionID
    let finishMoveProgress = false
    if (sessionID == null) {
      const selectedWorkspace = workspace.selection()
      const workspaceID = selectedWorkspace?.type === "existing" ? selectedWorkspace.workspaceID : undefined

      const directory = await move.getDirectory(submitted.input)
      if (move.pending() && !directory) {
        setSending(false)
        return false
      }
      finishMoveProgress = Boolean(move.progress())

      const res = await sdk.client.session.create(
        {
          workspaceID,
          agent: agent.name,
          model: {
            providerID: selectedModel.providerID,
            id: selectedModel.modelID,
            variant,
          },
        },
        { headers: locationHeaders({ directory }) },
      )

      if (res.error) {
        failed(res.error)
        if (finishMoveProgress) move.finishSubmit()
        TuiLog.write("error", "Creating a session failed", res.error)

        toast.show({
          text: "Creating a session failed: " + errorMessage(res.error),
          level: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    const submission = resolveSlashInput(commands, commandScope(), inputText)

    if (currentMode === "shell") {
      move.startSubmit()
      void sdk.client.session
        .shell(
          {
            sessionID,
            hookMode: "interactive",
            agent: agent.name,
            model: {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
            },
            command: inputText,
          },
          { throwOnError: true },
        )
        .then(() => {
          if (attempt === submissionAttempt) setSending(false)
        })
        .catch(failed)
      if (draftUnchanged()) setStore("mode", "normal")
    } else if (submission.kind === "server") {
      move.startSubmit()
      const args = submission.args

      sync.set("submission_attempt", sessionID, messageID)
      sync.set("pending_submission", sessionID, messageID)
      local.model.submit({
        sessionID,
        model: selectedModel,
        variant,
        messageID,
        command: true,
        send: () =>
          sdk.client.session.command(
            {
              sessionID,
              messageID,
              hookMode: "interactive",
              command: submission.name,
              arguments: args,
              agent: agent.name,
              model: `${selectedModel.providerID}/${selectedModel.modelID}`,
              variant,
              parts: nonTextParts.filter((x) => x.type === "file"),
            },
            { throwOnError: true },
          ),
        accepted: () => {
          accepted = true
          clearPending()
          // #1223: mark an import run so the idle transition can present the
          // entries it wrote for confirmation.
          if (submission.name === "import-claude") void sync.trust.beginImport(sessionID)
        },
        failed,
        interrupted,
      })
    } else {
      move.startSubmit()
      sync.set("submission_attempt", sessionID, messageID)
      sync.set("pending_submission", sessionID, messageID)
      local.model.submit({
        sessionID,
        model: selectedModel,
        variant,
        messageID,
        command: false,
        send: () =>
          sdk.client.session.prompt(
            {
              sessionID,
              hookMode: "interactive",
              ...selectedModel,
              messageID,
              agent: agent.name,
              model: selectedModel,
              variant,
              parts: [
                ...editorParts,
                {
                  type: "text",
                  text: inputText,
                },
                ...nonTextParts,
              ],
            },
            { throwOnError: true },
          ),
        accepted: () => {
          accepted = true
          markEditorAccepted()
          clearPending()
        },
        failed,
        interrupted,
      })
    }
    if (disposed || props.sessionID !== originalSessionID) return true
    history.append({
      ...submitted,
      mode: currentMode,
    })
    if (draftUnchanged()) {
      input.extmarks.clear()
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
    }
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!originalSessionID && props.sessionID === originalSessionID && !disposed) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      ticker.at(ticker.now() + 50, () => {
        if (!disposed && props.sessionID === originalSessionID)
          route.navigate({
            type: "session",
            sessionID,
            prompt: structuredClone(unwrap(store.prompt)),
          })
      })
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      const attachment = await readLocalAttachment(filepath)
      const filename = path.basename(filepath)
      if (attachment?.type === "text") {
        pasteText(attachment.content, `[SVG: ${filename ?? "image"}]`)
        return
      }
      if (attachment?.type === "binary") {
        await pasteAttachment({
          filename,
          filepath,
          mime: attachment.mime,
          content: Buffer.from(attachment.content).toString("base64"),
        })
        return
      }
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if (
      (lineCount >= 3 || pastedContent.length > 150) &&
      kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
    ) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    ticker.at(ticker.now(), () => {
      if (!input || input.isDestroyed) return
      input.invalidateIntrinsicSize()
      renderer.requestRender()
    })
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  function clearPrompt() {
    if (store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS || store.prompt.parts.length > 0) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const borderHighlight = highlight

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command... "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything... "${list()[store.placeholder % list().length]}"`
  })

  const spinnerColor = createMemo(() => {
    const agent =
      status().type !== "idle"
        ? (local.agent.list().find((a) => a.name === lastUserMessage()?.agent) ?? local.agent.current())
        : local.agent.current()
    return agent ? local.agent.color(agent.name) : theme.border
  })
  const maxHeight = createMemo(() => tuiConfig.prompt?.max_height ?? Math.max(6, Math.floor(dimensions().height / 3)))
  // A panel or ask surface replaces the composer. The Prompt stays mounted so
  // its draft survives, but its spinners must stop driving frames (#1025 P17b).
  const composerShown = () => props.visible !== false && (bottomZone?.composerVisible() ?? true)

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={composerShown()} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
            width="100%"
          >
            <Show when={editing()}>
              {(current) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {t("prompt.edit.status", { label: current().request.label })}
                </text>
              )}
            </Show>
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={leader() ? theme.textMuted : theme.text}
              focusedTextColor={leader() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={maxHeight()}
              onContentChange={() => {
                draftRevision++
                const value = input.plainText
                setStore("prompt", "input", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
              }}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                ticker.at(ticker.now(), () => ticker.at(ticker.now(), () => submit()))
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatchCommand("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.parts),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                ticker.at(ticker.now(), () => {
                  // deferred so the textarea is initialized before the cursor color applies
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                })
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={props.disabled ? theme.backgroundElement : theme.text}
              cursorStyle={{ style: "block", blinking: false }}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={local.agent.current()} fallback={<box height={1} />}>
                  {(agent) => (
                    <>
                      <text fg={highlight()}>{store.mode === "shell" ? "Shell" : Locale.titlecase(agent().name)}</text>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.textMuted}>·</text>
                          <text flexShrink={0} fg={leader() ? theme.textMuted : theme.text}>
                            {local.model.parsed().model}
                          </text>
                          <text fg={theme.textMuted}>{currentProviderLabel()}</text>
                          <Show when={showVariant()}>
                            <text fg={theme.textMuted}>·</text>
                            <text>
                              <span style={{ fg: theme.warning, bold: true }}>{local.model.variant.current()}</span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <Switch>
            <Match when={props.sessionID && local.model.uncertain(props.sessionID) === "stopping"}>
              <box flexDirection="column">
                <text paddingLeft={1} fg={theme.warning}>
                  {t("prompt.stop.requested")}
                </text>
                <text paddingLeft={1} fg={theme.warning}>
                  {t("prompt.submit.paused")}
                </text>
              </box>
            </Match>
            <Match when={props.sessionID && local.model.uncertain(props.sessionID) === "unknown"}>
              <box flexDirection="column">
                <text paddingLeft={1} fg={theme.warning}>
                  {t("prompt.submit.unconfirmed")}
                </text>
                <text paddingLeft={1} fg={theme.warning}>
                  {t("prompt.submit.restart")}
                </text>
              </box>
            </Match>
            <Match when={stopping()}>
              <text paddingLeft={1} fg={theme.textMuted}>
                Stopping…
              </text>
            </Match>
            <Match when={sending() || sync.data.pending_submission[props.sessionID ?? ""]}>
              <text paddingLeft={1} fg={theme.textMuted}>
                Sending prompt…
              </text>
            </Match>
            <Match when={failedSubmission()}>
              <text paddingLeft={1} fg={theme.error}>
                Prompt not sent · restore failed prompt from commands to retry
              </text>
            </Match>
            <Match when={status().type !== "idle"}>
              <box
                flexDirection="row"
                gap={1}
                flexGrow={1}
                justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
              >
                <box flexShrink={0} flexDirection="row" gap={1}>
                  <box marginLeft={1}>
                    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                      <Spinner color={spinnerColor()} visible={composerShown} />
                    </Show>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <Show when={preparation()}>
                      {(phase) => (
                        <text fg={theme.textMuted}>
                          {
                            {
                              memory: "Preparing memory…",
                              reasoning: "Preparing reasoning…",
                              tools: "Preparing tools…",
                            }[phase().stage]
                          }
                        </text>
                      )}
                    </Show>
                    {(() => {
                      const retry = createMemo(() => {
                        const s = status()
                        if (s.type !== "retry") return
                        return s
                      })
                      const message = createMemo(() => {
                        const r = retry()
                        if (!r) return
                        if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                          return "gemini is way too hot right now"
                        if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                        return r.message
                      })
                      const isTruncated = createMemo(() => {
                        const r = retry()
                        if (!r) return false
                        return r.message.length > 120
                      })
                      const seconds = createMemo(() => {
                        ticker.second()
                        const next = retry()?.next
                        if (!next) return 0
                        return Math.max(0, Math.round((next - ticker.now()) / 1000))
                      })
                      onMount(() => onCleanup(ticker.subscribeSecond()))
                      const handleMessageClick = () => {
                        const r = retry()
                        if (!r) return
                        if (isTruncated()) {
                          toast.show({
                            text: "Retry Error: " + r.message,
                            level: "warning",
                          })
                        }
                      }

                      const retryText = () => {
                        const r = retry()
                        if (!r) return ""
                        const baseMessage = message()
                        const truncatedHint = isTruncated() ? " (click to expand)" : ""
                        const duration = formatDuration(seconds())
                        const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                        return baseMessage + truncatedHint + retryInfo
                      }

                      return (
                        <Show when={retry()}>
                          <box onMouseUp={handleMessageClick}>
                            <text fg={theme.error}>{retryText()}</text>
                          </box>
                        </Show>
                      )
                    })()}
                  </box>
                </box>
                <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                  esc{" "}
                  <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                    {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                  </span>
                </text>
              </box>
            </Match>
            <Match when={sync.data.session_load_errors[props.sessionID ?? ""]?.length}>
              <text paddingLeft={1} fg={theme.textMuted}>
                Some session details could not load (
                {sync.data.session_load_errors[props.sessionID ?? ""]
                  ?.map((kind) => (kind === "session_diff" ? "diff" : kind === "todo" ? "tasks" : kind))
                  .join(", ")}
                )
              </text>
            </Match>
            <Match when={workspace.notice()}>
              {(notice) => (
                <box paddingLeft={3}>
                  <text fg={theme.accent}>{notice()}</text>
                </box>
              )}
            </Match>
            <Match when={workspace.label()}>
              {(label) => (
                <box paddingLeft={3} flexDirection="row" gap={1}>
                  <Show when={workspace.creating()}>
                    <Spinner color={theme.accent} visible={composerShown} />
                  </Show>
                  <text fg={workspace.creating() ? theme.accent : theme.text}>
                    {(() => {
                      const item = label()
                      if (item.type === "new") {
                        if (workspace.creating())
                          return `Creating ${item.workspaceType}${".".repeat(workspace.creatingDots())}`
                        return (
                          <>
                            Workspace <span style={{ fg: theme.textMuted }}>(new {item.workspaceType})</span>
                          </>
                        )
                      }
                      return (
                        <>
                          Workspace <span style={{ fg: theme.textMuted }}>{item.workspaceName}</span>
                        </>
                      )
                    })()}
                  </text>
                </box>
              )}
            </Match>
            <Match when={move.progress()}>
              {(progress) => (
                <box paddingLeft={3}>
                  <Spinner color={theme.accent} visible={composerShown}>
                    {progress()}
                    <span style={{ fg: theme.textMuted }}>{".".repeat(move.creatingDots())}</span>
                  </Spinner>
                </box>
              )}
            </Match>
            <Match when={move.pendingNew()}>
              <box paddingLeft={3}>
                <text fg={theme.accent}>(new working copy)</text>
              </box>
            </Match>
            <Match when={true}>{props.hint ?? <text />}</Match>
          </Switch>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row">
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text fg={editorContextLabelState() === "pending" ? theme.secondary : theme.textMuted}>{file()}</text>
                )}
              </Show>
              <Switch>
                <Match when={store.mode === "normal"}>
                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[item().context, item().cost].filter(Boolean).join(" · ")}
                        </text>
                      )}
                    </Match>
                    <Match when={true}>
                      <text fg={theme.text}>
                        {agentShortcut()} <span style={{ fg: theme.textMuted }}>agents</span>
                      </text>
                    </Match>
                  </Switch>
                  <text fg={theme.text}>
                    {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
