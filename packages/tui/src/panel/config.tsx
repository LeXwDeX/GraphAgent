// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { UiLanguage } from "@graphagent/core/config/language"
import { createMemo, createSignal, onMount } from "solid-js"
import { useCommands } from "../commands/context"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useThinkingMode } from "../context/thinking"
import { getLanguage, setLanguage, t } from "../i18n"
import { isSubagent } from "../session/role"
import { drawerMode, useDrawer } from "../shell/drawer"
import { dagBandMode } from "../shell/status-band"
import { useToast } from "../ui/toast"
import { TuiLog } from "../util/log"
import * as Model from "../util/model"
import { useShortcutEntries } from "./help"
import { usePanelHost } from "./host"
import { SettingsPanel, type SettingRow, type SettingsTab } from "./settings"
import { ThemePanel } from "./theme"
import { VariantPanel } from "./variant"

// AGENTS.md 6.6: a choice row cycles through at most six options; one with more opens a list instead.
const MAX_INLINE_CHOICES = 6
const PERMISSION_TOOLS = ["edit", "bash", "webfetch", "external_directory"] as const
type PermissionTool = (typeof PERMISSION_TOOLS)[number]
type DagMode = "on" | "off"

type Overrides = {
  dagMode?: DagMode
  concurrency?: number
  budget?: number | null
  language?: UiLanguage
  autoCompact?: boolean
  smallModel?: string
  permission?: Partial<Record<PermissionTool, string>>
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

/**
 * `/config`: every row reads and writes a real TUI store. Rows backed by the
 * global configuration file are disabled when the SDK write endpoint is not
 * available, so the panel never pretends a change was persisted.
 */
export function ConfigPanel(props: { activeTab: string; onTab?(id: string): void }) {
  const sdk = useSDK()
  const sync = useSync()
  const kv = useKV()
  const theme = useTheme()
  const thinking = useThinkingMode()
  const drawer = useDrawer()
  const route = useRoute()
  const toast = useToast()
  const host = usePanelHost()
  const local = useLocal()
  const commands = useCommands()
  const shortcuts = useShortcutEntries()
  const [overrides, setOverrides] = createSignal<Overrides>({})

  const writable = () => typeof sdk.client.global.config?.update === "function"

  async function writeConfig(patch: Record<string, unknown>, done?: () => void) {
    const client = sdk.client.global.config
    if (typeof client?.update !== "function") return
    let failure: unknown
    try {
      const result = (await client.update({ config: patch as never })) as { error?: unknown } | undefined
      failure = result?.error
    } catch (error) {
      failure = error
    }
    if (failure) {
      toast.show({
        text: t("panel.config.writeFailed", { message: describeError(failure) }),
        level: "error",
        dedupeKey: "config.write",
      })
      return
    }
    done?.()
  }

  const session = createMemo(() => (route.data.type === "session" ? sync.session.get(route.data.sessionID) : undefined))

  // The limits in force are the server's to say (#1290): they come from the DAG mode snapshot of this tree, which a
  // tree with DAG mode off and no workflow does not read by itself, so it is asked for once as the panel opens. Outside
  // a session there is no snapshot and the rows show what is configured.
  onMount(() => {
    if (route.data.type === "session") sync.dag.readMode(route.data.sessionID)
  })
  const dagLimits = createMemo(() => {
    if (route.data.type !== "session") return undefined
    return sync.data.dagMode[sync.session.root(route.data.sessionID)]?.limits
  })

  const dagMode = (): DagMode => overrides().dagMode ?? (sync.data.config.dag?.mode === "on" ? "on" : "off")
  /** `dag.concurrency` as set: the write made here, else the file's value; undefined while unset. */
  const configuredConcurrency = (): number | undefined => overrides().concurrency ?? sync.data.config.dag?.concurrency
  /**
   * The concurrency the scheduler enforces. The snapshot counts only while it was read for the configuration the panel
   * shows: after a write, until the read-back lands, it says nothing instead of describing the old value.
   */
  const concurrencyInForce = (): number | undefined => {
    const limits = dagLimits()
    if (limits === undefined) return undefined
    const configured = typeof limits.configuredConcurrency === "number" ? limits.configuredConcurrency : undefined
    return configured === configuredConcurrency() ? limits.concurrency : undefined
  }
  /** The value shown and edited: the configured one, else the one in force while the panel does not know it is unset. */
  const concurrencyText = () => {
    const value = configuredConcurrency() ?? concurrencyInForce()
    return value === undefined ? "" : String(value)
  }
  const concurrencyNote = () => {
    const inForce = concurrencyInForce()
    if (inForce === undefined) return undefined
    const configured = configuredConcurrency()
    if (configured === undefined) return t("panel.config.dag.concurrency.default")
    return configured > inForce ? t("panel.config.dag.concurrency.capped", { effective: inForce }) : undefined
  }
  const budget = (): number | null =>
    overrides().budget !== undefined ? overrides().budget! : (sync.data.config.dag?.budget?.tokens ?? null)
  const budgetText = () => {
    const value = budget()
    return value === null ? "" : String(value)
  }
  const sessionState = () => (session()?.dagMode === "on" ? t("panel.setting.on") : t("panel.setting.off"))
  const configuredLanguage = () => overrides().language ?? sync.data.config.language
  const autoCompact = (): boolean => overrides().autoCompact ?? sync.data.config.compaction?.auto ?? true
  /** `compaction.trigger_ratio` as a percentage of the context; undefined while it is not set. */
  const triggerPercent = (): number | undefined => {
    const ratio = sync.data.config.compaction?.trigger_ratio
    return typeof ratio === "number" && Number.isFinite(ratio) ? Math.round(ratio * 100) : undefined
  }
  /** `small_model` as set: the write made here, else the file's value; undefined while unset. */
  const smallModel = (): string | undefined => (overrides().smallModel ?? sync.data.config.small_model) || undefined
  /** Whether `value` is the `provider/model` of a model of a connected provider, as the server reads `small_model`. */
  const connectedModel = (value: string): boolean => {
    const { providerID, modelID } = Model.parse(value)
    return providerID !== "" && modelID !== "" && Model.get(sync.data.provider, providerID, modelID) !== undefined
  }
  /** The model name as the top bar writes it; undefined while no model is chosen. */
  const currentModelName = (): string | undefined => {
    const current = local.model.current()
    return current ? Model.name(sync.data.provider, current.providerID, current.modelID) : undefined
  }
  /** A sub-agent view is read-only: choosing a model or a reasoning effort there would write to the sub-agent. */
  const delegated = () => isSubagent(session())

  function permissionValue(tool: PermissionTool): string {
    const permissions = sync.data.config.permission as Record<string, unknown> | undefined
    const entry = overrides().permission?.[tool] ?? permissions?.[tool]
    if (typeof entry === "string") return entry
    if (entry && typeof entry === "object") {
      const star = (entry as Record<string, string>)["*"]
      if (typeof star === "string") return star
      return "custom"
    }
    return "ask"
  }

  const permissionOptions = () => [
    { value: "ask", label: t("panel.config.permission.ask") },
    { value: "allow", label: t("panel.config.permission.allow") },
    { value: "deny", label: t("panel.config.permission.deny") },
  ]

  function permissionRow(tool: PermissionTool, label: string): SettingRow {
    const value = permissionValue(tool)
    return {
      id: `permission-${tool}`,
      label,
      kind: "choice",
      value,
      valueLabel: value === "custom" ? t("panel.config.permission.custom") : undefined,
      options: permissionOptions(),
      description: t("panel.config.permission.description"),
      disabled: !writable(),
      onChange(next) {
        void writeConfig({ permission: { [tool]: next } }, () => {
          setOverrides((current) => ({
            ...current,
            permission: { ...current.permission, [tool]: next },
          }))
        })
      },
    }
  }

  const generalRows = createMemo<SettingRow[]>(() => [
    {
      id: "language",
      label: t("config.language.label"),
      kind: "choice",
      value: getLanguage(),
      options: [
        { value: "zh-CN", label: t("language.option.zh-CN") },
        { value: "en", label: t("language.option.en") },
      ],
      suffix: () => (configuredLanguage() === undefined ? t("panel.config.language.auto") : undefined),
      description: t("panel.config.language.description"),
      disabled: !writable(),
      onChange(next) {
        const language = next as UiLanguage
        setLanguage(language)
        setOverrides((current) => ({ ...current, language }))
        void writeConfig({ language })
      },
    },
    {
      id: "auto-compact",
      label: t("panel.config.autoCompact"),
      kind: "toggle",
      value: autoCompact(),
      suffix: () => {
        const percent = triggerPercent()
        return percent === undefined ? undefined : t("panel.config.autoCompact.at", { percent })
      },
      description: t("panel.config.autoCompact.description"),
      disabled: !writable(),
      onChange(next) {
        void writeConfig({ compaction: { auto: next } }, () =>
          setOverrides((current) => ({ ...current, autoCompact: next })),
        )
      },
    },
    {
      id: "file-context",
      label: t("panel.config.fileContext"),
      kind: "toggle",
      value: kv.get("file_context_enabled", true),
      onChange: (next) => kv.set("file_context_enabled", next),
    },
    {
      id: "paste-summary",
      label: t("panel.config.pasteSummary"),
      kind: "toggle",
      value: kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
      onChange: (next) => kv.set("paste_summary_enabled", next),
    },
    {
      id: "session-directory-filter",
      label: t("panel.config.sessionDirectoryFilter"),
      kind: "toggle",
      value: kv.get("session_directory_filter_enabled", true),
      onChange(next) {
        kv.set("session_directory_filter_enabled", next)
        void sync.session.refresh()
      },
    },
    {
      id: "terminal-title",
      label: t("panel.config.terminalTitle"),
      kind: "toggle",
      value: kv.get("terminal_title_enabled", true),
      onChange: (next) => kv.set("terminal_title_enabled", next),
    },
  ])

  const interfaceRows = createMemo<SettingRow[]>(() => [
    {
      id: "theme",
      label: t("panel.config.theme"),
      kind: "action",
      valueLabel: theme.selected,
      run: () => host.push({ id: "theme", render: () => <ThemePanel /> }),
    },
    {
      id: "theme-mode",
      label: t("panel.config.themeMode"),
      kind: "choice",
      value: theme.locked() ? theme.mode() : "system",
      options: [
        { value: "system", label: t("panel.config.theme.system") },
        { value: "dark", label: t("panel.config.theme.dark") },
        { value: "light", label: t("panel.config.theme.light") },
      ],
      onChange(next) {
        if (next === "system") theme.unlock()
        else if (next === "dark" || next === "light") theme.setMode(next)
      },
    },
    {
      id: "animations",
      label: t("panel.config.animations"),
      kind: "toggle",
      value: kv.get("animations_enabled", true),
      onChange: (next) => kv.set("animations_enabled", next),
    },
    {
      id: "thinking",
      label: t("panel.config.thinking"),
      kind: "toggle",
      value: thinking.mode() === "show",
      onChange: (next) => thinking.set(next ? "show" : "hide"),
    },
    {
      id: "timestamps",
      label: t("panel.config.timestamps"),
      kind: "toggle",
      value: kv.get("timestamps", "hide") === "show",
      onChange: (next) => kv.set("timestamps", next ? "show" : "hide"),
    },
    {
      id: "tool-details",
      label: t("panel.config.toolDetails"),
      kind: "toggle",
      value: kv.get("tool_details_visibility", true),
      onChange: (next) => kv.set("tool_details_visibility", next),
    },
    {
      id: "generic-tool-output",
      label: t("panel.config.genericToolOutput"),
      kind: "toggle",
      value: kv.get("generic_tool_output_visibility", false),
      onChange: (next) => kv.set("generic_tool_output_visibility", next),
    },
    {
      id: "scrollbar",
      label: t("panel.config.scrollbar"),
      kind: "toggle",
      value: kv.get("scrollbar_visible", false),
      onChange: (next) => kv.set("scrollbar_visible", next),
    },
    {
      id: "diff-wrap",
      label: t("panel.config.diffWrap"),
      kind: "toggle",
      value: kv.get("diff_wrap_mode", "word") === "word",
      onChange: (next) => kv.set("diff_wrap_mode", next ? "word" : "none"),
    },
    {
      id: "drawer",
      label: t("panel.config.drawer"),
      kind: "choice",
      value: drawer.mode(),
      options: [
        { value: "hidden", label: t("panel.config.drawer.hidden") },
        { value: "auto", label: t("panel.config.drawer.auto") },
        { value: "always", label: t("panel.config.drawer.always") },
      ],
      onChange: (next) => drawer.setMode(drawerMode(next)),
    },
    {
      id: "conceal-code",
      label: t("panel.config.conceal"),
      kind: "toggle",
      value: kv.get("conceal_code", true),
      onChange: (next) => kv.set("conceal_code", next),
    },
    {
      id: "dag-band",
      label: t("panel.config.dagBand"),
      kind: "choice",
      value: dagBandMode(kv.get("dag_band", "auto")),
      options: [
        { value: "auto", label: t("panel.config.dagBand.auto") },
        { value: "always", label: t("panel.config.dagBand.always") },
        { value: "hidden", label: t("panel.config.dagBand.hidden") },
      ],
      onChange: (next) => kv.set("dag_band", next),
    },
    {
      id: "ambiguous-width",
      label: t("panel.config.ambiguousWidth"),
      kind: "choice",
      value: kv.get("ambiguous_width", 1) === 2 ? "2" : "1",
      options: [
        { value: "1", label: t("panel.config.width.narrow") },
        { value: "2", label: t("panel.config.width.wide") },
      ],
      onChange: (next) => kv.set("ambiguous_width", Number(next)),
    },
  ])

  const modelRows = createMemo<SettingRow[]>(() => {
    const variants = local.model.variant.list()
    return [
      {
        id: "model-current",
        label: t("panel.config.model.current"),
        kind: "action",
        valueLabel: currentModelName() ?? t("panel.setting.empty"),
        suffix: () => (delegated() ? t("subagent.readonlyTag") : undefined),
        description: t("panel.config.model.current.description"),
        disabled: delegated(),
        run() {
          // The model list is the panel `/model` opens, run by the command as the palette runs it.
          void commands.run("model.list", { args: "", origin: "palette" }).catch((error) => {
            TuiLog.write("error", "Command failed", error)
          })
        },
      },
      // Six options or fewer cycle in place; past that the row opens the variant list, as section 6.6 requires.
      variants.length + 1 > MAX_INLINE_CHOICES
        ? {
            id: "variant",
            label: t("panel.config.variant"),
            kind: "action",
            valueLabel: local.model.variant.current() ?? t("panel.variant.default"),
            suffix: () => (delegated() ? t("subagent.readonlyTag") : undefined),
            description: t("panel.config.variant.description"),
            disabled: delegated(),
            // The same list the `variant.list` key opens, on this panel's stack as the theme list is.
            run: () => host.push({ id: "variant", render: () => <VariantPanel /> }),
          }
        : {
            id: "variant",
            label: t("panel.config.variant"),
            kind: "choice",
            value: local.model.variant.current() ?? "default",
            valueLabel: variants.length === 0 ? t("panel.config.variant.none") : undefined,
            options: [
              { value: "default", label: t("panel.variant.default") },
              ...variants.map((variant) => ({ value: variant, label: variant })),
            ],
            suffix: () => (delegated() ? t("subagent.readonlyTag") : undefined),
            description: t("panel.config.variant.description"),
            disabled: variants.length === 0 || delegated(),
            onChange: (next) => local.model.variant.set(next === "default" ? undefined : next),
          },
      {
        id: "small-model",
        label: t("panel.config.smallModel"),
        kind: "text",
        value: smallModel() ?? "",
        suffix: () => (smallModel() === undefined ? t("panel.config.smallModel.auto") : undefined),
        description: t("panel.config.smallModel.description"),
        disabled: !writable(),
        // The global configuration has no way to clear a key, so an empty value is no value to write.
        validate: (value) => (connectedModel(value.trim()) ? undefined : "panel.config.smallModel.invalid"),
        onChange(value) {
          const model = value.trim()
          void writeConfig({ small_model: model }, () => setOverrides((current) => ({ ...current, smallModel: model })))
        },
      },
    ]
  })

  const dagRows = createMemo<SettingRow[]>(() => [
    {
      id: "dag-default",
      label: t("panel.config.dag.defaultOn"),
      kind: "toggle",
      value: dagMode() === "on",
      suffix: () => (session() ? t("panel.config.dag.session", { state: sessionState() }) : undefined),
      description: t("panel.config.dag.default.description"),
      disabled: !writable(),
      onChange(next) {
        const mode: DagMode = next ? "on" : "off"
        void writeConfig({ dag: { mode } }, () => setOverrides((current) => ({ ...current, dagMode: mode })))
      },
    },
    {
      id: "dag-concurrency",
      label: t("panel.config.dag.concurrency"),
      kind: "text",
      value: concurrencyText(),
      suffix: concurrencyNote,
      description: t("panel.config.dag.concurrency.description"),
      disabled: !writable(),
      validate(value) {
        if (!/^\d+$/.test(value.trim())) return "panel.config.dag.concurrency.invalid"
        const parsed = Number(value)
        return parsed >= 1 && parsed <= 64 ? undefined : "panel.config.dag.concurrency.invalid"
      },
      onChange(value) {
        const parsed = Number(value)
        void writeConfig({ dag: { concurrency: parsed } }, () =>
          setOverrides((current) => ({ ...current, concurrency: parsed })),
        )
      },
    },
    {
      id: "dag-budget",
      label: t("panel.config.dag.budget"),
      kind: "text",
      value: budgetText(),
      suffix: () => (budgetText() === "" ? t("panel.config.dag.budget.empty") : undefined),
      description: t("panel.config.dag.budget.description"),
      disabled: !writable(),
      validate(value) {
        const trimmed = value.trim()
        if (trimmed === "") return undefined
        if (!/^\d+$/.test(trimmed)) return "panel.config.dag.budget.invalid"
        return Number(trimmed) > 0 ? undefined : "panel.config.dag.budget.invalid"
      },
      onChange(value) {
        const trimmed = value.trim()
        const tokens = trimmed === "" ? null : Number(trimmed)
        void writeConfig({ dag: { budget: { tokens } } }, () =>
          setOverrides((current) => ({ ...current, budget: tokens })),
        )
      },
    },
  ])

  const permissionRows = createMemo<SettingRow[]>(() => [
    permissionRow("edit", t("panel.config.permission.edit")),
    permissionRow("bash", t("panel.config.permission.bash")),
    permissionRow("webfetch", t("panel.config.permission.webfetch")),
    permissionRow("external_directory", t("panel.config.permission.externalDirectory")),
  ])

  /** The shortcuts the keymap holds, as `/help` lists them; the panel reports them and holds none of them. */
  const shortcutRows = createMemo<SettingRow[]>(() =>
    shortcuts().map((entry) => ({
      id: `shortcut:${entry.id}`,
      label: entry.title,
      kind: "action",
      valueLabel: entry.keys,
      readonly: true,
      description: entry.note,
      // Never run: a read-only row does nothing when it is activated.
      run() {},
    })),
  )

  const tabs = createMemo<SettingsTab[]>(() => [
    { id: "general", label: t("panel.config.tab.general"), rows: generalRows() },
    { id: "interface", label: t("panel.config.tab.interface"), rows: interfaceRows() },
    { id: "model", label: t("panel.config.tab.model"), rows: modelRows() },
    { id: "dag", label: t("panel.config.tab.dag"), rows: dagRows() },
    { id: "permissions", label: t("panel.config.tab.permission"), rows: permissionRows() },
    { id: "shortcuts", label: t("panel.config.tab.shortcuts"), rows: shortcutRows() },
  ])

  return (
    <SettingsPanel
      title={t("panel.config.title")}
      command="/config"
      tabs={tabs()}
      activeTab={props.activeTab}
      onTab={props.onTab}
    />
  )
}
