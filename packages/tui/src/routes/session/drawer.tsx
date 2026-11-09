// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { AssistantMessage } from "@graphagent/sdk/v2"
import { InstallationChannel } from "@graphagent/core/installation/version"
import { createMemo, createSignal, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { WorkspaceLabel } from "../../component/workspace-label"
import { useTuiConfig } from "../../config"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { t, type MessageKey } from "../../i18n"
import { Locale } from "../../util/locale"
import { getScrollAcceleration } from "../../util/scroll"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const FILE_LABEL_WIDTH = 34

const STATUS_KEY: Record<string, MessageKey> = {
  active: "goal.status.active",
  waiting: "goal.status.waiting",
  done: "goal.status.done",
  paused: "goal.status.paused",
}

function statusLabel(status: string) {
  const key = STATUS_KEY[status]
  return key ? t(key) : status
}

function changeCountWidth(item: { additions: number; deletions: number }) {
  return [item.additions ? `+${item.additions}` : "", item.deletions ? `-${item.deletions}` : ""]
    .filter(Boolean)
    .join(" ").length
}

/**
 * Collapsible section header. Only long lists collapse; short sections always
 * render their content.
 */
function SectionHeader(props: {
  title: string
  collapsible: boolean
  open: Accessor<boolean>
  onToggle: () => void
  summary?: JSX.Element
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} onMouseDown={() => props.collapsible && props.onToggle()}>
      <Show when={props.collapsible}>
        <text fg={theme.text}>{props.open() ? "▼" : "▶"}</text>
      </Show>
      <text fg={theme.text}>
        <b>{props.title}</b>
        {props.summary}
      </text>
    </box>
  )
}

function DrawerSession(props: { sessionID: string }) {
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }

  return (
    <Show when={session()}>
      {(current) => (
        <box paddingRight={1}>
          <text fg={theme.text}>
            <b>{current().title}</b>
          </text>
          <Show when={InstallationChannel !== "latest"}>
            <text fg={theme.textMuted}>{props.sessionID}</text>
          </Show>
          <Show when={current().workspaceID}>
            <text fg={theme.textMuted}>
              <Show
                when={workspace()}
                fallback={<WorkspaceLabel type="unknown" name={current().workspaceID!} status="error" icon />}
              >
                {(item) => (
                  <WorkspaceLabel
                    type={item().type}
                    name={item().name}
                    status={project.workspace.status(item().id) ?? "error"}
                    icon
                  />
                )}
              </Show>
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

function DrawerContext(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const state = createMemo(() => {
    const last = messages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!last) return { tokens: 0, percent: null }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme.text}>
        <b>{t("drawer.context")}</b>
      </text>
      <text fg={theme.textMuted}>{t("drawer.context.tokens", { tokens: state().tokens.toLocaleString() })}</text>
      <text fg={theme.textMuted}>{t("drawer.context.used", { percent: state().percent ?? 0 })}</text>
    </box>
  )
}

function DrawerCost(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const cost = createMemo(() => sync.session.get(props.sessionID)?.cost ?? 0)

  return (
    <box>
      <text fg={theme.text}>
        <b>{t("drawer.cost")}</b>
      </text>
      <text fg={theme.textMuted}>{t("drawer.cost.spent", { amount: money.format(cost()) })}</text>
    </box>
  )
}

function DrawerGoal(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const goal = createMemo(() => sync.data.goal[props.sessionID])

  return (
    <Show when={goal()}>
      {(current) => (
        <box>
          <text fg={theme.text}>
            <b>{t("goal.title")}</b> [{statusLabel(current().status)}]
          </text>
          <text fg={theme.textMuted}>
            {current().goal.length > 60 ? current().goal.slice(0, 57) + "..." : current().goal}
          </text>
          <text fg={theme.textMuted}>
            {t("goal.turns", { used: Number(current().turnsUsed), max: Number(current().maxTurns) })}
          </text>
        </box>
      )}
    </Show>
  )
}

function DrawerTodo(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const [open, setOpen] = createSignal(true)
  const list = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const visible = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))
  const collapsible = createMemo(() => list().length > 2)

  return (
    <Show when={visible()}>
      <box>
        <SectionHeader
          title={t("drawer.todo")}
          collapsible={collapsible()}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />
        <Show when={!collapsible() || open()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

function DrawerFiles(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const [open, setOpen] = createSignal(true)
  const list = createMemo(() =>
    (sync.data.session_diff[props.sessionID] ?? []).flatMap((item) =>
      item.file === undefined ? [] : [{ ...item, file: item.file }],
    ),
  )
  const collapsible = createMemo(() => list().length > 2)

  return (
    <Show when={list().length > 0}>
      <box>
        <SectionHeader
          title={t("drawer.files")}
          collapsible={collapsible()}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />
        <Show when={!collapsible() || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme.textMuted} wrapMode="none">
                  {Locale.truncateLeft(item.file, Math.max(2, FILE_LABEL_WIDTH - changeCountWidth(item)))}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme.diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme.diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

function DrawerLsp() {
  const sync = useSync()
  const { theme } = useTheme()
  const [open, setOpen] = createSignal(true)
  const list = createMemo(() => sync.data.lsp)
  const off = createMemo(() => !sync.data.config.lsp)
  const collapsible = createMemo(() => list().length > 2)

  return (
    <box>
      <SectionHeader
        title="LSP"
        collapsible={collapsible()}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      <Show when={!collapsible() || open()}>
        <Show when={list().length === 0}>
          <text fg={theme.textMuted}>{off() ? t("drawer.lsp.disabled") : t("drawer.lsp.waiting")}</text>
        </Show>
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: item.status === "connected" ? theme.success : theme.error,
                }}
              >
                •
              </text>
              <text fg={theme.textMuted}>
                {item.id} {item.root}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

function DrawerMcp() {
  const sync = useSync()
  const { theme } = useTheme()
  const [open, setOpen] = createSignal(true)
  const list = createMemo(() =>
    Object.entries(sync.data.mcp)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => ({
        name,
        status: item.status,
        error: item.status === "failed" ? item.error : undefined,
      })),
  )
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )
  const collapsible = createMemo(() => list().length > 2)

  const dot = (status: string) => {
    if (status === "connected") return theme.success
    if (status === "failed") return theme.error
    if (status === "disabled") return theme.textMuted
    if (status === "needs_auth") return theme.warning
    if (status === "needs_client_registration") return theme.error
    return theme.textMuted
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <SectionHeader
          title="MCP"
          collapsible={collapsible()}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          summary={
            <Show when={!open()}>
              <span style={{ fg: theme.textMuted }}>
                {" "}
                {t("drawer.mcp.summary", {
                  active: on(),
                  errors: bad() > 0 ? t("drawer.mcp.errors", { count: bad() }) : "",
                })}
              </span>
            </Show>
          }
        />
        <Show when={!collapsible() || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: dot(item.status),
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  {item.name}{" "}
                  <span style={{ fg: theme.textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>{t("drawer.mcp.connected")}</Match>
                      <Match when={item.status === "failed"}>
                        <i>{item.error}</i>
                      </Match>
                      <Match when={item.status === "disabled"}>{t("drawer.mcp.disabled")}</Match>
                      <Match when={item.status === "needs_auth"}>{t("drawer.mcp.needsAuth")}</Match>
                      <Match when={item.status === "needs_client_registration"}>{t("drawer.mcp.needsClientId")}</Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

/**
 * Session drawer content. Mounted only while the drawer is visible, so its
 * sections create no subscriptions when the drawer is closed.
 */
export function SessionDrawer(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={sync.session.get(props.sessionID)}>
      <box height="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <DrawerSession sessionID={props.sessionID} />
            <DrawerContext sessionID={props.sessionID} />
            <DrawerCost sessionID={props.sessionID} />
            <DrawerGoal sessionID={props.sessionID} />
            <DrawerTodo sessionID={props.sessionID} />
            <DrawerFiles sessionID={props.sessionID} />
            <DrawerLsp />
            <DrawerMcp />
          </box>
        </scrollbox>
      </box>
    </Show>
  )
}
