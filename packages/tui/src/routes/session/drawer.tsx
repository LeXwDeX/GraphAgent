// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { resolveRootSessionID } from "../../ask/ask-queue"
import { WorkspaceLabel } from "../../component/workspace-label"
import { useTuiConfig } from "../../config"
import { useKV } from "../../context/kv"
import { lifecycleKey } from "../../context/lifecycle-mirror"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useOptionalTicker } from "../../context/ticker-context"
import { t } from "../../i18n"
import { useCommandShortcut } from "../../keymap"
import { backgroundItems } from "../../session/background"
import { isRoot, isSubagent } from "../../session/role"
import { isGoalShown } from "../../shell/status-band"
import type { AmbiguousWidth } from "../../ui/width"
import { estimateMark } from "../../util/context-window"
import { remoteLine } from "../../util/remote-text"
import { getScrollAcceleration } from "../../util/scroll"
import {
  CONTEXT_BAR_CELLS,
  DRAWER_TEXT_CELLS,
  backgroundRunLine,
  backgroundSection,
  contextBarCells,
  contextTone,
  contextUsage,
  goalLine,
  sameBackgroundSection,
  services,
  todoCount,
  todoMark,
  usageLines,
  type BackgroundRunRow,
} from "./drawer-model"

/**
 * The drawer's sections (#1032 5.2), in their fixed order: session, context, cost, the DAG mode line, goal,
 * background runs, todo, services. Each is a plain display component over `useSync()`; nothing in the drawer is
 * clickable. The context and todo follow the session on screen, a sub-agent's included; the cost is the whole task
 * tree's, with a line of the session's own on a sub-agent's screen (#1475); the goal and the background runs are
 * always the root session's; LSP and MCP are global. The modified-files section is left out for now (#1032 D8): since
 * H5 its data source is mostly empty.
 */

function Heading(props: { title: string; detail?: string }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.text} wrapMode="none">
      <b>{props.title}</b>
      <Show when={props.detail}>{(detail) => <span style={{ fg: theme.textMuted }}> {detail()}</span>}</Show>
    </text>
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
  const branch = createMemo(() => sync.data.vcs?.branch)

  return (
    <Show when={session()}>
      {(current) => (
        <box>
          <text fg={theme.text}>
            <b>{remoteLine(current().title)}</b>
          </text>
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
          <Show when={branch()}>
            {(name) => (
              <text fg={theme.textMuted} wrapMode="none">
                {t("drawer.session.branch", { branch: remoteLine(name()) })}
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

function DrawerContext(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const usage = createMemo(() => contextUsage(sync.data.message[props.sessionID] ?? [], sync.data.provider))
  const tone = (percent: number) => theme[contextTone(percent)]

  return (
    <box>
      <Heading title={t("drawer.context")} />
      <Show when={usage()} fallback={<text fg={theme.textMuted}>—</text>}>
        {(current) => (
          <>
            <text fg={theme.textMuted} wrapMode="none">
              {t("drawer.context.usage", {
                used: current().used.toLocaleString("en-US"),
                limit: `${estimateMark(current())}${current().limit?.toLocaleString("en-US") ?? "—"}`,
              })}
            </text>
            <Show when={current().percent !== undefined}>
              <text fg={theme.textMuted} wrapMode="none">
                <span style={{ fg: tone(current().percent!) }}>{"█".repeat(contextBarCells(current().percent!))}</span>
                <span style={{ fg: theme.textDim }}>
                  {"█".repeat(CONTEXT_BAR_CELLS - contextBarCells(current().percent!))}
                </span>{" "}
                <span style={{ fg: tone(current().percent!) }}>
                  {estimateMark(current())}
                  {current().percent}%
                </span>
              </text>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

/**
 * What the whole task tree on screen has used (#1475): the cost and the tokens of the root, its sub-agents and its DAG
 * nodes, read from the server (`GET /session/:id/usage`) for the root of the tree, whichever session of it is shown.
 * A sub-agent's screen adds a last line with what that session has used by itself. Display only, nothing to click.
 * The usage is read only while this section is mounted, that is while the drawer is open: the effect below counts the
 * root as watched and lets go of it when the drawer closes or another tree comes on screen.
 */
function DrawerCost(props: { sessionID: string; rootID: string }) {
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  createEffect(() => {
    onCleanup(sync.usage.watch(props.rootID))
  })
  const session = createMemo(() => sync.session.get(props.sessionID))
  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const lines = createMemo(() =>
    usageLines(sync.data.usage[props.rootID], session(), isSubagent(session()), ambiguousWidth()),
  )

  return (
    <box>
      <Heading title={t("drawer.cost")} />
      <For each={lines()}>
        {(line) => (
          <text fg={theme.textMuted} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

/**
 * The DAG mode line (F4 5.1, 7.1), above the goal: on, with the key that switches it, or off. Read-only, nothing
 * to click. The mode belongs to the root session, so a sub-agent session has no line.
 */
function DrawerDagMode(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const key = useCommandShortcut("session.dagmode.toggle")
  const session = createMemo(() => sync.session.get(props.sessionID))
  const text = createMemo(() =>
    session()?.dagMode === "on" ? t("dagmode.drawer.on", { key: key() }).trimEnd() : t("dagmode.drawer.off"),
  )

  return (
    <Show when={isRoot(session())}>
      <text fg={theme.textMuted} wrapMode="none">
        {text()}
      </text>
    </Show>
  )
}

/** The root session's goal, whichever session of the tree is on screen. Hidden without a goal. */
function DrawerGoal(props: { rootID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  // A partial goal body (no text or status) is no goal: reading `.goal` on it would throw.
  const goal = createMemo(() => {
    const value = sync.data.goal[props.rootID]
    return isGoalShown(value) ? value : undefined
  })
  const line = createMemo(() => {
    const current = goal()
    return current ? goalLine(current) : undefined
  })
  const subgoals = createMemo(() => {
    const list = goal()?.subgoals
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
  })

  return (
    <Show when={goal()}>
      {(current) => (
        <box>
          <Heading title={t("goal.title")} />
          <text fg={theme.text}>{remoteLine(current().goal)}</text>
          <Show when={line()}>
            {(state) => (
              <text fg={theme.textMuted} wrapMode="none">
                {state().turns ? `${state().turns} · ` : ""}
                <span style={{ fg: state().warning ? theme.warning : theme.textMuted }}>{state().state}</span>
              </text>
            )}
          </Show>
          <For each={subgoals()}>{(item) => <text fg={theme.textMuted}>{`· ${remoteLine(item)}`}</text>}</For>
        </box>
      )}
    </Show>
  )
}

function DrawerRun(props: { row: BackgroundRunRow; now: () => number; ambiguousWidth: () => AmbiguousWidth }) {
  const { theme } = useTheme()
  const line = createMemo(() => backgroundRunLine(props.row, props.now(), DRAWER_TEXT_CELLS, props.ambiguousWidth()))
  return (
    <text fg={theme.text} wrapMode="none">
      <span style={{ fg: theme[line().token] }}>{line().marker}</span>
      {line().text}
      <Show when={line().time !== ""}>
        <span style={{ fg: theme.textMuted }}>{line().pad + line().time}</span>
      </Show>
    </text>
  )
}

/**
 * The root session's background runs that are still going, whichever session of the tree is on screen (#1058 5): at
 * most three lines, each a marker, `kind · description` and, for a running one, how long it has run; the rest are
 * counted on a last line that points at `/agents`. Hidden while none is going. The times follow the one-second
 * clock, which this section asks for only while a listed run is running; the drawer mounts its sections only while it
 * is open, so a closed drawer asks for nothing.
 */
function DrawerBackground(props: { rootID: string }) {
  const sync = useSync()
  const kv = useKV()
  const ticker = useOptionalTicker()
  const { theme } = useTheme()
  const section = createMemo(
    () =>
      backgroundSection(
        backgroundItems({
          taskIndex: sync.data.taskIndex,
          rootID: props.rootID,
          job: (id) => sync.data.lifecycle[lifecycleKey({ domain: "job", id })],
          summary: (id) => sync.data.summary[id],
        }),
        (id) => sync.session.get(id),
      ),
    undefined,
    { equals: sameBackgroundSection },
  )
  const ticking = createMemo(() => section()?.running === true)
  createEffect(() => {
    if (!ticking() || !ticker) return
    onCleanup(ticker.subscribeSecond())
  })
  const now = () => {
    // Reading the second signal is what makes a time follow the clock.
    if (ticking()) ticker?.second()
    return ticker?.now() ?? Date.now()
  }
  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)

  return (
    <Show when={section()}>
      {(current) => (
        <box>
          <Heading title={t("background.drawer.title", { n: current().total })} />
          <For each={current().rows}>{(row) => <DrawerRun row={row} now={now} ambiguousWidth={ambiguousWidth} />}</For>
          <Show when={current().more > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {t("background.drawer.more", { k: current().more })}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

function DrawerTodo(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const list = createMemo(() => sync.data.todo[props.sessionID] ?? [])

  return (
    <Show when={list().length > 0}>
      <box>
        <Heading title={t("drawer.todo")} detail={todoCount(list())} />
        <For each={list()}>
          {(item) => (
            <box flexDirection="row">
              <text flexShrink={0} fg={theme[todoMark(item.status).tone]}>
                {`${todoMark(item.status).symbol} `}
              </text>
              <text flexGrow={1} wrapMode="word" fg={item.status === "completed" ? theme.textMuted : theme.text}>
                {remoteLine(item.content)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function DrawerServices() {
  const sync = useSync()
  const { theme } = useTheme()
  const state = createMemo(() => services(sync.data.lsp, sync.data.mcp))

  return (
    <Show when={state()}>
      {(current) => (
        <box>
          <Heading title={t("drawer.services")} />
          <For each={current().lsp}>
            {(item) => (
              <text fg={theme.textMuted} wrapMode="none">
                <span style={{ fg: item.ok ? theme.success : theme.error }}>●</span>
                {` ${t("drawer.lsp", { id: remoteLine(item.id) })}`}
              </text>
            )}
          </For>
          <Show when={current().mcpConnected !== undefined}>
            <text fg={theme.textMuted} wrapMode="none">
              <span style={{ fg: (current().mcpConnected ?? 0) > 0 ? theme.success : theme.textDim }}>●</span>{" "}
              {t("drawer.mcp.connectedCount", { count: current().mcpConnected ?? 0 })}
            </text>
          </Show>
          <Show when={current().mcpFailed.length > 0}>
            <text fg={theme.error}>
              {`● ${t("drawer.mcp.failed", { names: current().mcpFailed.map(remoteLine).join(", ") })}`}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

/**
 * Session drawer content. Mounted only while the drawer is visible, so its sections create no subscriptions when the
 * drawer is closed. The last row names the key that closes it, from the keymap.
 */
export function SessionDrawer(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toggle = useCommandShortcut("session.drawer.toggle")
  const rootID = createMemo(() => resolveRootSessionID(sync.data.session, props.sessionID))

  return (
    <Show when={sync.session.get(props.sessionID)}>
      <box height="100%" paddingTop={1} paddingLeft={2} paddingRight={2}>
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
            <DrawerCost sessionID={props.sessionID} rootID={rootID()} />
            <DrawerDagMode sessionID={props.sessionID} />
            <DrawerGoal rootID={rootID()} />
            <DrawerBackground rootID={rootID()} />
            <DrawerTodo sessionID={props.sessionID} />
            <DrawerServices />
          </box>
        </scrollbox>
        <box height={1} flexShrink={0}>
          <Show when={toggle()}>
            {(key) => (
              <text fg={theme.textDim} wrapMode="none">
                {t("drawer.closeHint", { key: key() })}
              </text>
            )}
          </Show>
        </box>
      </box>
    </Show>
  )
}
