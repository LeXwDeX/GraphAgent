// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createStore } from "solid-js/store"
import { dirname } from "node:path"
import { createEffect, createMemo, For, Show } from "solid-js"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
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
import { PanelShell, type PanelHint } from "../../panel/shell"
import { t } from "../../i18n"
import { askSourceLabel } from "../../ask/ask-queue"

type PermissionStage = "options" | "reject"
type PermissionChoice = "once" | "always" | "reject" | "relay"

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => {
    const value = props.request.metadata?.filepath
    return typeof value === "string" ? value : ""
  })
  const diff = createMemo(() => {
    const value = props.request.metadata?.diff
    return typeof value === "string" ? value : ""
  })

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
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
      <Show when={!diff()}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No diff provided</text>
        </box>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
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
  const title = createMemo(() => {
    const label = source() ? t("ask.title.permissionSource", { source: source()! }) : t("ask.title.permission")
    return `${props.position}/${props.total} · ${label}`
  })

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
      result.push({ key: "ask.permission.previous", label: t("ask.hint.previous") })
      result.push({ key: "ask.permission.next", label: t("ask.hint.next") })
    }
    result.push({ key: "ask.permission.select", label: t("ask.hint.select") })
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

  const info = createMemo(() => {
    const permission = props.request.permission
    const data = inputData()

    // A hook-forced ask carries no tool metadata (diff, path); show the effective input itself for tools
    // without a view built on that input.
    if (hookAsk() && !INPUT_VIEWS.has(permission)) {
      const path = [data.filePath, data.path].find((value): value is string => typeof value === "string")
      return {
        icon: "⚙",
        title: path ? `Call tool ${permission} · ${pathFormatter.format(path)}` : `Call tool ${permission}`,
        body: (
          <box paddingLeft={1}>
            <text fg={theme.text}>{inputPreview(data)}</text>
          </box>
        ),
      }
    }

    if (permission === "edit") {
      const raw = props.request.metadata?.filepath
      const filepath = typeof raw === "string" ? raw : ""
      return {
        icon: "→",
        title: `Edit ${pathFormatter.format(filepath)}`,
        body: <EditBody request={props.request} />,
      }
    }

    if (permission === "read") {
      const raw = data.filePath
      const filePath = typeof raw === "string" ? raw : ""
      return {
        icon: "→",
        title: `Read ${pathFormatter.format(filePath)}`,
        body: (
          <Show when={filePath}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{"Path: " + pathFormatter.format(filePath)}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "glob") {
      const pattern = typeof data.pattern === "string" ? data.pattern : ""
      return {
        icon: "✱",
        title: `Glob "${pattern}"`,
        body: (
          <Show when={pattern}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "grep") {
      const pattern = typeof data.pattern === "string" ? data.pattern : ""
      return {
        icon: "✱",
        title: `Grep "${pattern}"`,
        body: (
          <Show when={pattern}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "list") {
      const raw = data.path
      const dir = typeof raw === "string" ? raw : ""
      return {
        icon: "→",
        title: `List ${pathFormatter.format(dir)}`,
        body: (
          <Show when={dir}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{"Path: " + pathFormatter.format(dir)}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "bash") {
      const command = typeof data.command === "string" ? data.command : ""
      return {
        icon: "#",
        title: "Shell command",
        body: (
          <Show when={command}>
            <box paddingLeft={1}>
              <text fg={theme.text}>{"$ " + command}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "task") {
      const type = typeof data.subagent_type === "string" ? data.subagent_type : "Unknown"
      const desc = typeof data.description === "string" ? data.description : ""
      return {
        icon: "#",
        title: `${Locale.titlecase(type)} Task`,
        body: (
          <Show when={desc}>
            <box paddingLeft={1}>
              <text fg={theme.text}>{"◉ " + desc}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "webfetch") {
      const url = typeof data.url === "string" ? data.url : ""
      return {
        icon: "%",
        title: `WebFetch ${url}`,
        body: (
          <Show when={url}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{"URL: " + url}</text>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "websearch") {
      const query = typeof data.query === "string" ? data.query : ""
      return {
        icon: "◈",
        title: `${webSearchProviderLabel(data.provider)} "${query}"`,
        body: (
          <Show when={query}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>{"Query: " + query}</text>
            </box>
          </Show>
        ),
      }
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
        icon: "←",
        title: `Access external directory ${dir}`,
        body: (
          <Show when={patterns.length > 0}>
            <box paddingLeft={1} gap={1}>
              <text fg={theme.textMuted}>Patterns</text>
              <box>
                <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
              </box>
            </box>
          </Show>
        ),
      }
    }

    if (permission === "doom_loop") {
      return {
        icon: "⟳",
        title: "Continue after repeated failures",
        body: (
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>This keeps the session running despite repeated failures.</text>
          </box>
        ),
      }
    }

    return {
      icon: "⚙",
      title: `Call tool ${permission}`,
      body: <TextBody title={"Tool: " + permission} />,
    }
  })

  function choiceLabel(choice: PermissionChoice) {
    if (choice === "once") return t("ask.permission.once")
    if (choice === "reject") return t("ask.permission.reject")
    if (choice === "relay") return t("ask.permission.relay")
    const patterns = props.request.always
    return patterns.length > 0
      ? t("ask.permission.alwaysPatterns", { patterns: patterns.join(", ") })
      : t("ask.permission.always")
  }

  const optionsContent = () => {
    const current = info()
    return (
      <box flexDirection="column" gap={1}>
        <Show when={hookReason()}>
          <box paddingLeft={1}>
            <text fg={theme.warning}>{t("ask.permission.hook", { reason: hookReason() })}</text>
          </box>
        </Show>
        <box flexDirection="column" paddingLeft={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} flexShrink={0}>
              {current.icon}
            </text>
            <text fg={theme.text}>{current.title}</text>
          </box>
        </box>
        {current.body}
        <box flexDirection="column" paddingTop={1}>
          <For each={choices()}>
            {(choice, index) => {
              const selected = () => index() === store.selected
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  backgroundColor={selected() ? theme.backgroundSelected : undefined}
                  onMouseOver={() => setStore("selected", index())}
                  onMouseUp={() => {
                    setStore("selected", index())
                    choose(choice)
                  }}
                >
                  <text fg={selected() ? theme.warning : theme.textMuted} flexShrink={0}>
                    {`${index() + 1}.`}
                  </text>
                  <text fg={selected() ? theme.warning : theme.text}>{choiceLabel(choice)}</text>
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

  const surface = (expanded: boolean) => (
    <PanelShell
      title={title()}
      tone="warning"
      hints={hints()}
      maxRows={expanded ? Math.max(1, dimensions().height - 6) : undefined}
    >
      {content()}
    </PanelShell>
  )

  return (
    <Show
      when={!store.expanded}
      fallback={
        <Portal>
          <box position="absolute" top={0} left={0} right={0} bottom={0} backgroundColor={theme.background}>
            {surface(true)}
          </box>
        </Portal>
      }
    >
      {surface(false)}
    </Show>
  )
}
