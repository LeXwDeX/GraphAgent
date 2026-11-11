// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { ProjectTrustDecision, ProjectTrustEntry, ProjectTrustRisk } from "@graphagent/sdk"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useKV } from "../context/kv"
import { useTuiPaths } from "../context/runtime"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { t, type MessageKey } from "../i18n"
import { useBindings } from "../keymap"
import { errorMessage } from "../util/error"
import { TuiLog } from "../util/log"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { useToast } from "../ui/toast"
import { DetailPanel, type DetailRow } from "./detail"
import { usePanelHost } from "./host"
import type { PanelHint } from "./shell"

export type TrustPanelMode = "first" | "changed" | "manage" | "imported"

const CATEGORY_KEYS: Record<ProjectTrustEntry["category"], MessageKey> = {
  hook: "trust.category.hook",
  mcp: "trust.category.mcp",
  "skill-hook": "trust.category.skillHook",
  "agent-hook": "trust.category.agentHook",
  "command-shell": "trust.category.commandShell",
  formatter: "trust.category.formatter",
  lsp: "trust.category.lsp",
}

const RISK_KEYS: Record<ProjectTrustRisk["code"], MessageKey> = {
  "download-and-execute": "trust.risk.download",
  "send-local-file": "trust.risk.sendFile",
  "delete-outside-project": "trust.risk.deleteOutside",
  "startup-persistence": "trust.risk.startup",
  "package-runner": "trust.risk.packageRunner",
  "reads-environment": "trust.risk.readsEnvironment",
  "external-url": "trust.risk.externalUrl",
  "remote-mcp": "trust.risk.remoteMcp",
  sudo: "trust.risk.sudo",
}

/** Common hook events get a sentence; the rest fall back to the event name. */
const HOOK_WHEN_KEYS: Record<string, MessageKey> = {
  PreToolUse: "trust.when.preToolUse",
  PostToolUse: "trust.when.postToolUse",
  UserPromptSubmit: "trust.when.userPromptSubmit",
  SessionStart: "trust.when.sessionStart",
  SessionEnd: "trust.when.sessionEnd",
  Stop: "trust.when.stop",
  Notification: "trust.when.notification",
  SubagentStart: "trust.when.subagentStart",
  SubagentStop: "trust.when.subagentStop",
  PreCompact: "trust.when.preCompact",
  PostCompact: "trust.when.postCompact",
  PermissionRequest: "trust.when.permissionRequest",
  Setup: "trust.when.setup",
}

function whenLabel(when: string): string {
  if (when === "mcp.start") return t("trust.when.mcp")
  if (when === "command.shell") return t("trust.when.commandShell")
  if (when === "formatter.run") return t("trust.when.formatter")
  if (when === "lsp.start") return t("trust.when.lsp")
  const key = HOOK_WHEN_KEYS[when]
  return key ? t(key) : t("trust.when.hook", { event: when })
}

function highRisk(entry: ProjectTrustEntry): boolean {
  return entry.risks.some((risk) => risk.level === "high")
}

function sourceFile(entry: ProjectTrustEntry): string {
  return `.agents/${entry.source.file}`
}

function stateLabel(state: ProjectTrustEntry["state"]): string {
  if (state === "trusted") return t("trust.state.trusted")
  if (state === "declined") return t("trust.state.declined")
  return t("trust.state.pending")
}

function changeLabel(change: NonNullable<ProjectTrustEntry["change"]>): string {
  return change === "new" ? t("trust.change.new") : t("trust.change.modified")
}

function riskLabel(risk: ProjectTrustRisk): string {
  const label = t(RISK_KEYS[risk.code])
  const detail = risk.detail === undefined ? "" : ` · ${risk.detail}`
  if (risk.level === "high") return `⚠ ${label}${detail}`
  return `${t("trust.risk.caution")} · ${label}${detail}`
}

/**
 * Project trust review (#1040): the first-open and changed prompts list only
 * pending entries; `/trust` lists every entry with its current state. Checkbox
 * state belongs to this panel until a decision is submitted, except in manage
 * mode where a toggle writes immediately.
 */
export function TrustPanel(props: { mode: TrustPanelMode; imported?: readonly string[] }) {
  const sync = useSync()
  const host = usePanelHost()
  const toast = useToast()
  const kv = useKV()
  const paths = useTuiPaths()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()

  const [localChecked, setLocalChecked] = createSignal<Record<string, boolean>>({})
  const [selected, setSelected] = createSignal<ProjectTrustEntry>()
  const [submitting, setSubmitting] = createSignal(false)

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const noProjectLayer = () => sync.path.worktree === paths.home

  const importedIds = createMemo(() => new Set(props.imported ?? []))

  const listed = createMemo(() => {
    const entries = sync.data.trust
    if (props.mode === "manage") return entries
    const pending = entries.filter((entry) => entry.state === "pending")
    if (props.mode === "imported") return pending.filter((entry) => importedIds().has(entry.id))
    return props.mode === "changed" ? pending.filter((entry) => entry.change !== undefined) : pending
  })

  const unchangedCount = createMemo(
    () => sync.data.trust.filter((entry) => entry.state === "trusted" && entry.change === undefined).length,
  )

  function checkedFor(entry: ProjectTrustEntry): boolean {
    if (props.mode === "manage") return entry.state === "trusted"
    return localChecked()[entry.id] ?? !highRisk(entry)
  }

  function triggerLabel(entry: ProjectTrustEntry): string {
    const when = whenLabel(entry.when)
    if (props.mode === "imported") {
      return importedIds().has(entry.id) ? `${t("trust.change.imported")} · ${when}` : when
    }
    if (props.mode === "manage" || entry.change === undefined) return when
    return `${changeLabel(entry.change)} · ${when}`
  }

  const triggerWidth = createMemo(
    () => listed().reduce((max, entry) => Math.max(max, cellWidth(triggerLabel(entry), ambiguousWidth())), 0),
  )

  const commandBudget = createMemo(() => {
    // Selection marker (2) + checkbox lead (4) + state column in manage mode.
    const stateWidth =
      props.mode === "manage"
        ? listed().reduce((max, entry) => Math.max(max, cellWidth(stateLabel(entry.state), ambiguousWidth())), 0) + 2
        : 0
    return Math.max(16, dimensions().width - 6 - 6 - stateWidth - triggerWidth() - 2)
  })

  function commandCell(entry: ProjectTrustEntry): JSX.Element {
    const text = truncateCells(entry.command, commandBudget(), ambiguousWidth())
    return (
      <text fg={highRisk(entry) ? theme.error : undefined} wrapMode="none">
        {text}
      </text>
    )
  }

  function detailBody(entry: ProjectTrustEntry): string {
    const lines: string[] = []
    if (highRisk(entry)) lines.push(t("trust.risk.highBadge"))
    if (entry.change === "modified" && entry.previous !== undefined) {
      lines.push(t("trust.previousLine", { command: entry.previous }))
      lines.push(t("trust.currentLine", { command: entry.command }))
    }
    lines.push(
      t("trust.source", {
        file: `${sourceFile(entry)}${entry.source.line === undefined ? "" : `:${entry.source.line}`}`,
      }),
    )
    lines.push(t("trust.when", { when: whenLabel(entry.when) }))
    if (entry.risks.length === 0) {
      lines.push(t("trust.risk.none"))
    } else {
      lines.push(t("trust.risk.header"))
      for (const risk of entry.risks) lines.push(`  ${riskLabel(risk)}`)
    }
    return lines.join("\n")
  }

  const groups = createMemo(() => {
    const result = new Map<string, ProjectTrustEntry[]>()
    for (const entry of listed()) {
      const items = result.get(entry.source.file)
      if (items) items.push(entry)
      else result.set(entry.source.file, [entry])
    }
    return [...result.entries()].sort(([left], [right]) => left.localeCompare(right))
  })

  function groupTitle(file: string, entries: ProjectTrustEntry[]): string {
    const categories = new Set(entries.map((entry) => entry.category))
    const name = `.agents/${file}`
    if (categories.size !== 1) return t("trust.group.plain", { file: name, count: entries.length })
    return t("trust.group.named", {
      file: name,
      count: entries.length,
      kind: t(CATEGORY_KEYS[entries[0]!.category]),
    })
  }

  const rows = createMemo<DetailRow<ProjectTrustEntry>[]>(() => {
    const result: DetailRow<ProjectTrustEntry>[] = []
    for (const [file, entries] of groups()) {
      result.push({
        id: `group:${file}`,
        cells: [
          <text fg={theme.textDim} attributes={TextAttributes.BOLD} wrapMode="none">
            {groupTitle(file, entries)}
          </text>,
        ],
        selectable: false,
      })
      for (const entry of entries) {
        const cells: (string | JSX.Element)[] = []
        if (props.mode === "manage") cells.push(stateLabel(entry.state))
        cells.push(triggerLabel(entry))
        cells.push(commandCell(entry))
        result.push({
          id: entry.id,
          value: entry,
          lead: { kind: "check", checked: checkedFor(entry), disabled: submitting() },
          cells,
          body: detailBody(entry),
        })
      }
    }
    return result
  })

  const activeEntry = createMemo(() => selected() ?? rows().find((row) => row.selectable !== false)?.value)

  async function apply(decisions: ProjectTrustDecision[], close: boolean): Promise<boolean> {
    if (submitting()) return false
    setSubmitting(true)
    try {
      await sync.trust.decide(decisions)
      // #1223: the imported review is resolved once its entries were decided.
      if (props.mode === "imported") sync.trust.clearImportedReview()
      if (close) host.close()
      return true
    } catch (error) {
      TuiLog.write("error", "project trust decision failed", { error: String(error) })
      toast.show({
        text: t("trust.failed", { message: errorMessage(error) }),
        level: "error",
        dedupeKey: "trust.failed",
      })
      return false
    } finally {
      setSubmitting(false)
    }
  }

  function toggle(row: DetailRow<ProjectTrustEntry>) {
    const entry = row.value
    if (!entry) return
    if (props.mode === "manage") {
      void apply([{ id: entry.id, state: entry.state === "trusted" ? "declined" : "trusted" }], false)
      return
    }
    setLocalChecked((current) => ({ ...current, [entry.id]: !(current[entry.id] ?? !highRisk(entry)) }))
  }

  function selectAll() {
    setLocalChecked(Object.fromEntries(listed().map((entry) => [entry.id, true])))
  }

  function trustChecked() {
    void apply(
      listed().map((entry) => ({ id: entry.id, state: checkedFor(entry) ? "trusted" : "declined" })),
      true,
    )
  }

  function declineAll() {
    void apply(
      listed().map((entry) => ({ id: entry.id, state: "declined" })),
      true,
    )
  }

  function revoke() {
    const entry = activeEntry()
    if (!entry || entry.state === "pending") return
    void apply([{ id: entry.id, state: "revoked" }], false)
  }

  useBindings(() => ({
    enabled: () => props.mode !== "manage" && !submitting(),
    commands: [
      { name: "trust.select_all", title: t("trust.hint.selectAll"), category: "Panel", run: selectAll },
      { name: "trust.decline_all", title: t("trust.hint.decline"), category: "Panel", run: declineAll },
    ],
    bindings: [
      { key: "a", cmd: "trust.select_all", desc: t("trust.hint.selectAll"), group: "Panel" },
      { key: "n", cmd: "trust.decline_all", desc: t("trust.hint.decline"), group: "Panel" },
    ],
  }))

  useBindings(() => ({
    enabled: () => props.mode === "manage" && !submitting(),
    commands: [{ name: "trust.revoke", title: t("trust.hint.revoke"), category: "Panel", run: revoke }],
    bindings: [{ key: "r", cmd: "trust.revoke", desc: t("trust.hint.revoke"), group: "Panel" }],
  }))

  const hints = createMemo<PanelHint[]>(() => {
    if (props.mode === "manage") {
      return [{ key: "trust.revoke", label: t("trust.hint.revoke"), when: () => activeEntry()?.state !== "pending" }]
    }
    return [
      { key: "trust.select_all", label: t("trust.hint.selectAll") },
      { key: "trust.decline_all", label: t("trust.hint.decline") },
    ]
  })

  function title(): string {
    if (props.mode === "manage") return t("trust.title.manage")
    if (props.mode === "changed") return t("trust.title.changed")
    if (props.mode === "imported") return t("trust.title.imported")
    return t("trust.title.first")
  }

  function summaryText(): string {
    if (props.mode === "manage") {
      return noProjectLayer() ? t("trust.noProject") : t("trust.summary.manage", { count: listed().length })
    }
    if (props.mode === "changed") return t("trust.summary.changed", { count: listed().length })
    if (props.mode === "imported") return t("trust.summary.imported", { count: listed().length })
    return t("trust.summary.first", { count: listed().length })
  }

  const empty = () => props.mode === "manage" && listed().length === 0

  return (
    <DetailPanel
      title={
        <box flexDirection="row" gap={1}>
          <text
            attributes={TextAttributes.BOLD}
            fg={props.mode === "manage" ? theme.primary : theme.warning}
            wrapMode="none"
          >
            {title()}
          </text>
          <Show when={!noProjectLayer()}>
            <text fg={theme.textDim} wrapMode="none">
              {sync.path.worktree}
            </text>
          </Show>
        </box>
      }
      command="/trust"
      tone={props.mode === "manage" ? "default" : "warning"}
      summary={
        <box flexDirection="column">
          <text fg={empty() ? theme.textMuted : theme.text} wrapMode="word">
            {summaryText()}
          </text>
          <Show when={props.mode === "changed" && unchangedCount() > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {t("trust.unchanged", { count: unchangedCount() })}
            </text>
          </Show>
        </box>
      }
      rows={rows()}
      onSelect={(row) => setSelected(row.value)}
      onActivate={props.mode === "manage" ? undefined : trustChecked}
      activateLabel={t("trust.hint.trust")}
      onToggle={toggle}
      hints={hints()}
      body={
        <Show
          when={!empty()}
          fallback={
            <text fg={theme.textMuted} wrapMode="word">
              {noProjectLayer() ? t("trust.noProject") : t("trust.empty")}
            </text>
          }
        >
          <Show when={props.mode !== "manage"}>
            <text fg={theme.textMuted} wrapMode="word">
              {t("trust.footnote")}
            </text>
          </Show>
        </Show>
      }
    />
  )
}