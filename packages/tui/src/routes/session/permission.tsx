import { createStore } from "solid-js/store"
import { dirname } from "node:path"
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import { Renderable, type BoxRenderable, type DiffRenderable, type TextareaRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import type { PermissionRequest } from "@graphagent/sdk"
import { useSDK, locationHeaders } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useProject } from "../../context/project"
import { filetype } from "../../util/filetype"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../config"
import { EscapePriority, GRAPHAGENT_BASE_MODE, useBindings } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { PanelShell, panelMaxRows, type PanelHint } from "../../panel/shell"
import { t, type MessageKey } from "../../i18n"
import { askSourceLabel } from "../../ask/ask-queue"
import { diffView } from "./diff-view"
import { diffChanges } from "./fold"
import { ChangeSummary } from "./tool-row"

type PermissionStage = "options" | "reject"
type PermissionChoice = "once" | "always" | "reject" | "relay"

/** The rows of a diff an ask keeps at the least; with fewer to give it, the diff folds to the count of its changes. */
const MIN_DIFF_ROWS = 3
/** The blank rows that set the diff apart from the lines above it and the options under it. */
const DIFF_GAPS = 2
/**
 * The blank rows above the fullscreen panel. The content budget, the terminal height less 6, and the four rows of the
 * panel's own border, title and hint leave two rows of the terminal over: one goes here, one stays under a panel that
 * has used its whole budget.
 */
const FULLSCREEN_MARGIN = 1

/**
 * Makes the container a `Portal` creates a layer over the whole terminal (#1662). The container is a plain box added to
 * the end of the root, and in the flow of the root: laid out after the app, which is as tall as the terminal, it sat
 * under the last row, and the ask in it was drawn off screen (or, where the app is shorter, in a strip one row high,
 * with a panel that had no side borders). Out of the flow and spread over the screen, it is where the ask is meant to be.
 */
function coverTerminal(layer: object) {
  if (!(layer instanceof Renderable)) return
  layer.position = "absolute"
  layer.top = 0
  layer.right = 0
  layer.bottom = 0
  layer.left = 0
}

/** What an ask that has a diff draws of it, and whether blank rows set it apart from the parts around it. */
export interface DiffFit {
  show: "diff" | "count" | "none"
  gap: 0 | 1
}

/**
 * How the rows of an ask that has a diff are divided (#1651). `budget` is the rows the panel gives its content and `fixed`
 * the rows that always stand: the lines above the diff and the options. The diff takes what they leave after the blank
 * rows around it and scrolls inside it. With under `MIN_DIFF_ROWS` left it folds to one line of counts; with less room
 * still the blank rows go first, then the counts: the options and the hint row stay in view at any terminal height.
 */
export function fitDiff(budget: number, fixed: number): DiffFit {
  const spare = budget - fixed - DIFF_GAPS
  if (spare >= MIN_DIFF_ROWS) return { show: "diff", gap: 1 }
  if (spare >= 1) return { show: "count", gap: 1 }
  return { show: budget - fixed >= 1 ? "count" : "none", gap: 0 }
}

function EditBody(props: { request: PermissionRequest; show: DiffFit["show"] }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()
  // The rows the diff takes at this width. A scroll area does not hug what it holds: left alone it fills the room it is
  // given and leaves blank rows under a short diff. They are its flex basis, which the panel shrinks to the rows left
  // when the diff is longer (`optionsContent`); a fixed `height` would not shrink.
  const [natural, setNatural] = createSignal<number>()

  const filepath = createMemo(() => {
    const value = props.request.metadata?.filepath
    return typeof value === "string" ? value : ""
  })
  const diff = createMemo(() => {
    const value = props.request.metadata?.diff
    return typeof value === "string" ? value : ""
  })
  // The request carries the diff but not the `filediff` the completed edit has, so the counts come from the diff.
  const changes = createMemo(() => diffChanges(diff()))

  // The permission diff sits in the bottom zone, which spans the terminal; it keeps the shared threshold.
  const view = createMemo(() => diffView(config.diff_style, dimensions().width))

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff() && props.show === "diff"}>
        <scrollbox
          flexBasis={natural()}
          flexGrow={0}
          flexShrink={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
            onSizeChange={function (this: DiffRenderable) {
              if (this.height > 0) setNatural(this.height)
            }}
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
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
        </scrollbox>
      </Show>
      <Show when={diff() && props.show === "count"}>
        <box paddingLeft={1}>
          <ChangeSummary additions={changes().additions} deletions={changes().deletions} errors={0} />
        </box>
      </Show>
      <Show when={!diff()}>
        <text fg={theme.textMuted}>{t("ask.permission.noDiff")}</text>
      </Show>
    </box>
  )
}

/** What the request is about, in one line: a command, a path, a pattern, a URL or a query. */
interface PermissionObject {
  /** The prompt of a command, or the label of the field with its colon. */
  lead: string
  text: string
}

/** What the ask draws of one request; the parts it has nothing for are left out, never made up. */
interface PermissionView {
  /** The tool as the title names it. */
  tool: string
  /** The object of the request, in the dark block under the title. */
  object?: PermissionObject
  /** A readable explanation the request already carries. */
  note?: string
  /** What sits under the block: a diff, the patterns of a directory, the input of a call a hook asked about. */
  body?: JSX.Element
  /** The body is the diff of an edit: it takes the rows the panel has left and scrolls inside them (#1651). */
  diff?: boolean
}

/** The name the title leads with, by permission: the tool's own name, the same in every language. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit: "Edit",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  list: "List",
  task: "Task",
  webfetch: "WebFetch",
}

function toolName(permission: string, data: Record<string, unknown>) {
  if (permission === "websearch") return webSearchProviderLabel(data.provider)
  if (permission === "external_directory") return t("ask.tool.externalDirectory")
  if (permission === "doom_loop") return t("ask.tool.doomLoop")
  return TOOL_NAMES[permission] ?? permission
}

/** The dark block of the ask: the lead in the muted color, the text after it, a cell of padding on each side. */
function ObjectBlock(props: PermissionObject) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.background}>
      <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
        {props.lead}
      </text>
      <text fg={theme.text} flexShrink={1}>
        {props.text}
      </text>
    </box>
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Permissions whose dialog view renders the tool input directly (rather than tool-provided metadata). */
const INPUT_VIEWS = new Set(["read", "glob", "grep", "list", "bash", "task", "webfetch", "websearch"])

/** Bounded, readable preview of a hook-forced ask's effective input. */
export const inputPreview = (input: Record<string, unknown>, maxLines = 24, maxChars = 2_000) => {
  const lines = JSON.stringify(input, null, 2).split("\n")
  const shown = lines.slice(0, maxLines).join("\n")
  const clipped = shown.length > maxChars ? shown.slice(0, maxChars) : shown
  return clipped.length < JSON.stringify(input, null, 2).length ? `${clipped}\n… (truncated)` : clipped
}

export interface PermissionPromptProps {
  request: PermissionRequest
  /** Session being viewed; decides whether a source label is shown. */
  currentSessionID: string
  /** Root of the queue's session tree; own-request reject accepts a reason. */
  rootSessionID: string
  /** 1-based position in the shared ask queue. */
  position: number
  total: number
  /** Directory of the requesting session, not the session being viewed. */
  directory?: string
  /** Appends the relay request to the root draft without submitting it. */
  prefill?: (text: string) => void
}

export function PermissionPrompt(props: PermissionPromptProps) {
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const pathFormatter = usePathFormatter()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const [store, setStore] = createStore({
    stage: "options" as PermissionStage,
    selected: 0,
    expanded: false,
  })
  let input: TextareaRenderable | undefined
  let requestID = props.request.id

  // Session routes no longer remount per session; reset the confirmation stage
  // when a different request replaces the current one.
  createEffect(() => {
    const id = props.request.id
    if (requestID === id) return
    requestID = id
    setStore({ stage: "options", selected: 0, expanded: false })
  })

  const own = createMemo(() => props.request.sessionID === props.rootSessionID)
  const choices = createMemo<PermissionChoice[]>(() =>
    own() ? ["once", "always", "reject"] : ["once", "always", "reject", "relay"],
  )
  const hasDiff = createMemo(() => {
    const diff = props.request.metadata?.diff
    return typeof diff === "string" && diff.length > 0
  })
  // The rows of content the panel has: the diff of an edit is cut to what the lines above it and the options leave.
  const budget = createMemo(() =>
    Math.max(1, store.expanded ? dimensions().height - 6 : panelMaxRows(dimensions().height)),
  )
  // The rows of the lines above the diff, as the layout gave them: the path of an edit takes one unless it wraps.
  const [above, setAbove] = createSignal(1)
  const fit = createMemo(() => fitDiff(budget(), above() + choices().length))

  const session = createMemo(() => sync.data.session.find((item) => item.id === props.request.sessionID))
  const directory = () => props.directory ?? session()?.directory

  const source = createMemo(() =>
    askSourceLabel(
      { session: sync.data.session, taskIndex: sync.data.taskIndex },
      props.request.sessionID,
      props.currentSessionID,
    ),
  )
  const relaySource = createMemo(
    () =>
      askSourceLabel(
        { session: sync.data.session, taskIndex: sync.data.taskIndex },
        props.request.sessionID,
        props.rootSessionID,
      ) ?? props.request.permission,
  )
  const hookAsk = () => props.request.metadata?.hookAsk === true
  const hookReason = () => {
    const reason = props.request.metadata?.reason
    return hookAsk() && typeof reason === "string" ? reason : ""
  }
  const inputData = createMemo(() => {
    const effective = props.request.metadata?.input
    if (hookAsk() && isRecord(effective)) return effective
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  function reply(replyKind: "once" | "always" | "reject", message?: string) {
    void sdk.client.permission.reply(
      { reply: replyKind, requestID: props.request.id, ...(message ? { message } : {}) },
      {
        headers: locationHeaders({
          directory: directory(),
          workspace: project.workspace.current(),
        }),
      },
    )
  }

  function rejectPlain() {
    reply("reject")
  }

  function choose(choice: PermissionChoice) {
    if (!choices().includes(choice)) return
    if (choice === "reject") {
      if (!own()) {
        rejectPlain()
        return
      }
      setStore({ stage: "reject", expanded: false })
      return
    }
    if (choice === "relay") {
      // Reply first, then hand the user to the root draft: the subagent only
      // receives the rejection; the main agent relays the explanation.
      rejectPlain()
      props.prefill?.(t("ask.permission.relayPrompt", { source: relaySource() }))
      return
    }
    reply(choice)
  }

  function move(delta: number) {
    const total = choices().length
    setStore("selected", (selected) => (((selected + delta + total) % total) + total) % total)
  }

  function confirmChoice() {
    const choice = choices()[store.selected]
    if (choice) choose(choice)
  }

  createEffect(() => {
    if (store.stage !== "reject") return
    queueMicrotask(() => {
      if (!input || input.isDestroyed) return
      input.focus()
    })
  })

  const hints = createMemo<PanelHint[]>(() => {
    if (store.stage === "reject") {
      return [
        { key: "ask.permission.rejectSend", label: t("ask.hint.submit") },
        { key: "ask.permission.rejectPlain", label: t("ask.hint.reject") },
      ]
    }
    const result: PanelHint[] = []
    if (choices().length > 1) {
      result.push({ key: "ask.permission.previous", also: "ask.permission.next", label: t("ask.hint.pick") })
    }
    result.push({ key: "ask.permission.select", label: t("ask.hint.confirm") })
    result.push({ key: "ask.permission.reject", label: t("ask.hint.reject") })
    if (hasDiff()) result.push({ key: "ask.permission.fullscreen", label: t("ask.hint.fullscreen") })
    return result
  })

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    priority: EscapePriority.modal,
    enabled: () => store.stage === "options",
    commands: [
      { name: "app.exit", title: "Reject permission", category: "Ask", run: rejectPlain },
      { name: "ask.permission.previous", title: "Previous option", category: "Ask", run: () => move(-1) },
      { name: "ask.permission.next", title: "Next option", category: "Ask", run: () => move(1) },
      { name: "ask.permission.select", title: "Select option", category: "Ask", run: confirmChoice },
      { name: "ask.permission.once", title: "Allow once", category: "Ask", run: () => choose("once") },
      { name: "ask.permission.always", title: "Allow for this session", category: "Ask", run: () => choose("always") },
      { name: "ask.permission.reject", title: "Reject permission", category: "Ask", run: rejectPlain },
      {
        name: "ask.permission.rejectOption",
        title: "Reject permission",
        category: "Ask",
        run: () => choose("reject"),
      },
      {
        name: "ask.permission.relay",
        title: "Reject and relay through the main agent",
        category: "Ask",
        run: () => choose("relay"),
      },
      {
        name: "ask.permission.fullscreen",
        title: "Toggle permission fullscreen",
        category: "Ask",
        run: () => {
          if (hasDiff()) setStore("expanded", (value) => !value)
        },
      },
    ],
    bindings: [
      { key: "up", desc: "Previous permission option", group: "Ask", cmd: "ask.permission.previous" },
      { key: "down", desc: "Next permission option", group: "Ask", cmd: "ask.permission.next" },
      { key: "return", desc: "Select permission option", group: "Ask", cmd: "ask.permission.select" },
      { key: "1", desc: "Allow once", group: "Ask", cmd: "ask.permission.once" },
      { key: "2", desc: "Allow for this session", group: "Ask", cmd: "ask.permission.always" },
      { key: "3", desc: "Reject", group: "Ask", cmd: "ask.permission.rejectOption" },
      ...(own() ? [] : [{ key: "4", desc: "Reject and relay", group: "Ask", cmd: "ask.permission.relay" }]),
      ...tuiConfig.keybinds.get("app.exit"),
      ...(hasDiff()
        ? [{ key: "ctrl+f", desc: "Toggle permission fullscreen", group: "Ask", cmd: "ask.permission.fullscreen" }]
        : []),
    ],
  }))

  useBindings(() => ({
    enabled: () => store.stage === "options",
    priority: EscapePriority.ask,
    bindings: [{ key: "escape", desc: "Reject permission", group: "Ask", cmd: "ask.permission.reject" }],
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    priority: EscapePriority.askSub,
    enabled: () => store.stage === "reject",
    commands: [
      {
        name: "ask.permission.rejectSend",
        title: "Send rejection reason",
        category: "Ask",
        run: () => reply("reject", input?.plainText ?? ""),
      },
      { name: "ask.permission.rejectPlain", title: "Reject without a reason", category: "Ask", run: rejectPlain },
    ],
    bindings: [{ key: "return", desc: "Send rejection reason", group: "Ask", cmd: "ask.permission.rejectSend" }],
  }))

  useBindings(() => ({
    enabled: () => store.stage === "reject",
    priority: EscapePriority.askSub,
    bindings: [{ key: "escape", desc: "Reject without a reason", group: "Ask", cmd: "ask.permission.rejectPlain" }],
  }))

  const info = createMemo<PermissionView>(() => {
    const permission = props.request.permission
    const data = inputData()
    const tool = toolName(permission, data)
    const field = (key: MessageKey, value: string): PermissionObject | undefined =>
      value ? { lead: `${t(key)}:`, text: value } : undefined
    const str = (value: unknown) => (typeof value === "string" ? value : "")

    // A hook-forced ask carries no tool metadata (diff, path); show the effective input itself for tools
    // without a view built on that input.
    if (hookAsk() && !INPUT_VIEWS.has(permission)) {
      const path = [data.filePath, data.path].find((value): value is string => typeof value === "string")
      return {
        tool,
        object: path ? field("ask.permission.path", pathFormatter.format(path)) : undefined,
        body: <text fg={theme.text}>{inputPreview(data)}</text>,
      }
    }

    if (permission === "edit") {
      return {
        tool,
        object: field("ask.permission.path", pathFormatter.format(str(props.request.metadata?.filepath))),
        body: <EditBody request={props.request} show={fit().show} />,
        diff: hasDiff(),
      }
    }

    if (permission === "read") {
      return { tool, object: field("ask.permission.path", pathFormatter.format(str(data.filePath))) }
    }

    if (permission === "glob" || permission === "grep") {
      return { tool, object: field("ask.permission.pattern", str(data.pattern)) }
    }

    if (permission === "list") {
      return { tool, object: field("ask.permission.path", pathFormatter.format(str(data.path))) }
    }

    if (permission === "bash") {
      const command = str(data.command)
      return { tool, object: command ? { lead: "$", text: command } : undefined }
    }

    if (permission === "task") {
      const type = str(data.subagent_type)
      return {
        tool,
        object: field("ask.permission.agent", type ? Locale.titlecase(type) : ""),
        note: str(data.description) || undefined,
      }
    }

    if (permission === "webfetch") {
      return { tool, object: field("ask.permission.url", str(data.url)) }
    }

    if (permission === "websearch") {
      return { tool, object: field("ask.permission.query", str(data.query)) }
    }

    if (permission === "external_directory") {
      const meta = props.request.metadata ?? {}
      const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
      const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
      const pattern = props.request.patterns?.[0]
      const derived = typeof pattern === "string" ? (pattern.includes("*") ? dirname(pattern) : pattern) : undefined

      const raw = parent ?? filepath ?? derived
      const dir = pathFormatter.format(raw)
      const patterns = (props.request.patterns ?? []).filter((p): p is string => typeof p === "string")

      return {
        tool,
        object: field("ask.permission.path", dir),
        body:
          patterns.length > 0 ? (
            <box flexDirection="column">
              <text fg={theme.textMuted}>{t("ask.permission.patterns")}</text>
              <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
            </box>
          ) : undefined,
      }
    }

    if (permission === "doom_loop") {
      return { tool, body: <text fg={theme.textMuted}>{t("ask.permission.doomLoop")}</text> }
    }

    return { tool }
  })

  const title = createMemo(() => {
    const tool = info().tool
    return source()
      ? t("ask.title.permissionToolSource", { source: source()!, tool })
      : t("ask.title.permissionTool", { tool })
  })

  function choiceLabel(choice: PermissionChoice) {
    if (choice === "once") return t("ask.permission.once")
    // The root can say why it rejects (the reason editor opens); a sub-agent's request is rejected as it is.
    if (choice === "reject") return own() ? t("ask.permission.rejectTell") : t("ask.permission.reject")
    if (choice === "relay") return t("ask.permission.relay")
    const patterns = props.request.always
    return patterns.length > 0
      ? t("ask.permission.alwaysPatterns", { patterns: patterns.join(", ") })
      : t("ask.permission.always")
  }

  const optionsContent = () => {
    const current = info()
    // The diff of an edit is the one part that gives way (#1651). The content is held to the rows the panel has, the
    // lines above the diff and the options keep theirs, and the flex layout shrinks the diff's scroll area to the rest;
    // any other body keeps the height it asks for, as it did before.
    const gap = () => (current.diff ? fit().gap : 1)
    return (
      <box flexDirection="column" maxHeight={current.diff ? budget() : undefined}>
        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function (this: BoxRenderable) {
            setAbove(this.height)
          }}
        >
          <Show when={hookReason()}>
            <text fg={theme.warning}>{t("ask.permission.hook", { reason: hookReason() })}</text>
          </Show>
          <Show when={current.object}>{(object) => <ObjectBlock lead={object().lead} text={object().text} />}</Show>
          <Show when={current.note}>
            <text fg={theme.textMuted}>{current.note}</text>
          </Show>
        </box>
        <Show when={current.body}>
          <box flexDirection="column" paddingTop={gap()}>
            {current.body}
          </box>
        </Show>
        <box flexDirection="column" flexShrink={0} paddingTop={gap()}>
          <For each={choices()}>
            {(choice, index) => {
              const selected = () => index() === store.selected
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={selected() ? theme.backgroundSelected : undefined}
                  onMouseOver={() => setStore("selected", index())}
                  onMouseUp={() => {
                    setStore("selected", index())
                    choose(choice)
                  }}
                >
                  <text fg={selected() ? theme.primary : theme.textMuted} flexShrink={0} wrapMode="none">
                    {selected() ? "›" : " "}
                  </text>
                  <text fg={selected() ? theme.primary : theme.textMuted} flexShrink={0} wrapMode="none">
                    {`${index() + 1}.`}
                  </text>
                  <text fg={selected() ? theme.primary : theme.text}>{choiceLabel(choice)}</text>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    )
  }

  const rejectContent = () => (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={theme.warning}>{"△"}</text>
        <text fg={theme.text}>{t("ask.permission.rejectTitle")}</text>
      </box>
      <box paddingLeft={1}>
        <text fg={theme.textMuted}>{t("ask.permission.rejectHint")}</text>
      </box>
      <box paddingLeft={1}>
        <textarea
          ref={(value: TextareaRenderable) => {
            input = value
            value.traits = { status: "REJECT" }
          }}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
        />
      </box>
    </box>
  )

  const content = () => (store.stage === "reject" ? rejectContent() : optionsContent())

  const surface = () => (
    <PanelShell
      title={title()}
      command={props.total > 1 ? `${props.position}/${props.total}` : undefined}
      tone="warning"
      hints={hints()}
      maxRows={budget()}
    >
      {content()}
    </PanelShell>
  )

  return (
    <Show
      when={!store.expanded}
      fallback={
        <Portal ref={coverTerminal}>
          <box
            position="absolute"
            top={0}
            left={0}
            right={0}
            bottom={0}
            paddingTop={FULLSCREEN_MARGIN}
            backgroundColor={theme.background}
          >
            {surface()}
          </box>
        </Portal>
      }
    >
      {surface()}
    </Show>
  )
}
