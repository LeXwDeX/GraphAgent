/**
 * hooks.json layer discovery, concat-merge, and scope-tagged summaries.
 *
 * Pure-move extraction from the former `hook/settings.ts` (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import path from "path"
import os from "os"
import * as Log from "@/util/log"
import { Global } from "@graphagent/core/global"
import { APP_NAME, PROJECT_DIR } from "@graphagent/core/brand"
import { hasProjectLayer } from "@/project/project-root"
import type { HookCommand, HookEvent, HookSummary, Settings } from "../types"
import { commandText, httpUrl, promptText } from "../exec/command"
import { canRewake, inactiveEventWarning, isHookEvent, readJSONFile, warnUnsupportedFields } from "./load"

const log = Log.create({ service: "hook.settings" })

/**
 * Short human-readable description of a hook entry for the Active Hooks block.
 * All types are uniformly truncated to 60 chars: command → command text,
 * http → URL, mcp → tool name, prompt/agent → first line of the prompt/goal.
 */
// Only recognisable script arguments supply the display name; code passed to
// `-e` or a version string must not be mistaken for a file.
const SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".rb",
  ".go",
  ".rs",
  ".php",
  ".pl",
  ".lua",
])

// Values of these flags are inline code, never a script path worth naming.
const INLINE_ARG_FLAGS = new Set(["-c", "-e", "--eval", "-r", "--require", "--import", "--loader"])

function scriptName(entry: HookCommand): string | undefined {
  const args = entry.args ?? []
  const candidates = args.flatMap((arg, index) => {
    // Inline shell code can end in a script-like token (`cat setup.sh`) without being a path.
    if (arg.startsWith("-") || /\s/.test(arg)) return []
    const name = path.basename(arg)
    if (!SCRIPT_EXTENSIONS.has(path.extname(name).toLowerCase())) return []
    const previous = args[index - 1]
    return [
      {
        name,
        optionValue: previous !== undefined && previous.startsWith("-"),
        inline: previous !== undefined && INLINE_ARG_FLAGS.has(previous),
      },
    ]
  })
  // An option value (`--import ./register.ts`) precedes the script that actually runs.
  return (candidates.find((candidate) => !candidate.optionValue) ?? candidates.find((candidate) => !candidate.inline))
    ?.name
}

export function descriptorFor(entry: HookCommand): string {
  switch (entry.type) {
    case "command": {
      // `bun /path/watch.ts` should not read as just `bun` in Active Hooks.
      const name = scriptName(entry)
      return `${commandText(entry)}${name ? ` ${name}` : ""}`.slice(0, 60)
    }
    case "http":
      return httpUrl(entry).slice(0, 60)
    case "mcp":
      return commandText(entry).slice(0, 60)
    case "mcp_tool":
      return `${entry.server}/${entry.tool}`.slice(0, 60)
    case "prompt":
    case "agent":
      return promptText(entry).split("\n")[0].slice(0, 60)
    default:
      return commandText(entry).slice(0, 60)
  }
}
/**
 * Concat-merge hook matchers across layers. Later layers append after earlier
 * ones (matches CC's merge semantics — does NOT replace by matcher key).
 */
// Exported for unit testing only; not part of the public surface.
export function mergeSettings(layers: Settings[]): Settings {
  const out: Settings = { hooks: {} }
  for (const layer of layers) {
    if (!layer.hooks) continue
    for (const [event, matchers] of Object.entries(layer.hooks)) {
      if (!isHookEvent(event)) continue
      const acc = (out.hooks![event] ??= [])
      acc.push(...(matchers ?? []))
    }
  }
  for (const layer of layers) if (layer.disableAllHooks !== undefined) out.disableAllHooks = layer.disableAllHooks
  if (layers.some((l) => l.allowedHttpHookUrls !== undefined))
    out.allowedHttpHookUrls = [...new Set(layers.flatMap((l) => l.allowedHttpHookUrls ?? []))]
  if (layers.some((l) => l.httpHookAllowedEnvVars !== undefined))
    out.httpHookAllowedEnvVars = [...new Set(layers.flatMap((l) => l.httpHookAllowedEnvVars ?? []))]
  return out
}

/**
 * Resolve the GraphAgent global config directory. Uses the explicit override
 * when provided (tests), otherwise falls back to `Global.Path.config` with a
 * `~/.config/graphagent` default. Shared by chainCandidates and loadChain so
 * the fallback logic exists in exactly one place.
 */
function resolveGlobalConfig(globalConfig?: string): string {
  if (globalConfig) return globalConfig
  try {
    return Global.Path.config
  } catch {
    return path.join(os.homedir(), ".config", APP_NAME)
  }
}

/**
 * Build the hooks.json candidate file list with scope tags. The project layer
 * is a single directory (`<root>/.agents/`) holding a committed `hooks.json`
 * and a local `hooks.local.json`; there is no worktree layer because a linked
 * worktree is itself a project root. Shared by loadChain (merge) and
 * summarizeChain (scope-tagged summaries) so adding or removing a path layer
 * updates both consumers without a second edit.
 */
export function chainCandidates(
  root: string,
  globalConfig?: string,
): Array<{ scope: "global" | "project" | "local"; file: string }> {
  const globalConfigDir = resolveGlobalConfig(globalConfig)
  // When the resolved root is $HOME there is no project layer: `~/.agents` is
  // the user-level shared directory, so its hooks files must not load as
  // project hooks. Only the global hooks.json applies.
  if (!hasProjectLayer(root, Global.Path.home))
    return [{ scope: "global", file: path.join(globalConfigDir, "hooks.json") }]
  return [
    { scope: "global", file: path.join(globalConfigDir, "hooks.json") },
    { scope: "project", file: path.join(root, PROJECT_DIR, "hooks.json") },
    { scope: "local", file: path.join(root, PROJECT_DIR, "hooks.local.json") },
  ]
}

/**
 * Single-pass chain load: reads each hooks.json file EXACTLY ONCE and produces
 * both the merged Settings and the scope-tagged HookSummary[] from the same
 * parse. Eliminates the transient-inconsistency window where `loadChain` and
 * `summarizeChain` re-read the same file independently (a file changing between
 * the two reads could yield settings and summary that disagree). `loadChain`
 * and `summarizeChain` are now thin shells over this.
 *
 * `warnUnsupportedFields` runs per-file inside this pass (same as the old
 * `loadChain`), so both shells surface the same warnings.
 */
function readChain(
  root: string,
  globalConfig?: string,
): { settings: Settings; summaries: HookSummary[]; invalid: string[] } {
  const layers: Settings[] = []
  const summaries: HookSummary[] = []
  const invalid: string[] = []
  for (const { scope, file } of chainCandidates(root, globalConfig)) {
    const read = readJSONFile(file)
    if (read.invalid) invalid.push(file)
    const data = read.settings
    if (!data) continue
    warnUnsupportedFields(data.hooks, path.dirname(file))
    layers.push(data)
    if (!data.hooks) continue
    for (const [event, matchers] of Object.entries(data.hooks)) {
      if (!isHookEvent(event)) continue
      for (const m of matchers ?? []) {
        for (const h of m.hooks ?? []) {
          summaries.push({
            event,
            scope,
            type: h.type,
            descriptor: inactiveEventWarning(event)
              ? `${descriptorFor(h)} [${inactiveEventWarning(event)}]`
              : descriptorFor(h),
            ...(m.matcher && m.matcher !== "*" ? { matcher: m.matcher } : {}),
            ...(h.type === "command" && h.asyncRewake === true && canRewake(event) ? { asyncRewake: true } : {}),
          })
        }
      }
    }
  }
  return { settings: mergeSettings(layers), summaries, invalid }
}

/**
 * Produce scope-tagged summaries of the merged hooks chain — one entry per
 * individual hook command, tagged with the layer (global/project/local) it
 * came from. Ordering matches loadChain: global first, then project, then
 * local. Used by `SettingsHook.list()` so the Active Hooks block reflects
 * live, hot-reloaded state without re-reading files on every call.
 *
 * Exported for unit testing only; not part of the public surface.
 */
export function summarizeChain(root: string, globalConfig?: string): HookSummary[] {
  return readChain(root, globalConfig).summaries
}

// Exported for unit testing only; not part of the public surface.
// `globalConfig` overrides the resolved GraphAgent global config dir so tests can
// point it at an isolated temp dir instead of the real ~/.config/graphagent.
export function loadChain(root: string, globalConfig?: string): Settings {
  return loadChainWithSummaries(root, globalConfig).settings
}

/**
 * Single-call variant returning both the merged settings and the scope-tagged
 * summaries from ONE pass over the chain files. The SettingsHook layer (initial
 * state + hot-reload callback) uses this instead of calling `loadChain` and
 * `summarizeChain` back-to-back, which would read every hooks.json twice and
 * reopen the transient-inconsistency window `readChain` exists to close.
 */
export function loadChainWithSummaries(
  root: string,
  globalConfig?: string,
): { settings: Settings; summaries: HookSummary[]; invalid: string[] } {
  return readChain(root, globalConfig)
}

/**
 * @internal Test-only: the hooks.json layer candidates for a project, so tests
 * can assert which files the chain would read without writing to them.
 */
export { chainCandidates as __chainCandidates }
