/**
 * Settings-based hooks with Claude Code-compatible envelopes and explicit runtime support.
 *
 * Reads hooks from a dedicated hooks.json chain (later layers concat-append on
 * top of earlier ones, mirroring Claude Code's merge semantics — hooks
 * accumulate, they do not replace):
 *
 *   1. ~/.config/graphagent/hooks.json         (global, hot-reloaded)
 *   2. <root>/.agents/hooks.json               (project, hot-reloaded)
 *   3. <root>/.agents/hooks.local.json         (local, hot-reloaded)
 *
 * A linked worktree is itself a project root, so there is no separate worktree
 * layer. `.claude/` directories are never read for hooks (complete cut).
 *
 * Supports the Claude Code hook event surface at the protocol/schema layer.
 *
 * Hook entry types:
 *   - { type: "command", command: "<shell>", timeout?: <seconds> }
 *   - { type: "mcp",     command: "mcp__<server>__<tool>", timeout?: <seconds> }
 *   - { type: "http",    url: "<url>", command?: "<legacy-url>", timeout?: <seconds> }
 *   - { type: "prompt",  prompt: "<llm-system-prompt>", command?: "<legacy-prompt>", timeout?: <seconds> }
 *   - { type: "agent",   prompt: "<llm-task-prompt>", command?: "<legacy-prompt>", timeout?: <seconds> }
 *
 * stdin JSON envelope per Claude Code spec:
 *   { hook_event_name, session_id, prompt_id, transcript_path, cwd,
 *     scratchpad_dir, permission_mode, agent_id?, agent_type?, effort?,
 *     ...event-specific }
 *
 * stdout control JSON (any subset):
 *   { continue, stopReason, suppressOutput, systemMessage,
 *     decision: "approve"|"block", reason,
 *     hookSpecificOutput: { hookEventName, permissionDecision,
 *                            permissionDecisionReason, additionalContext,
 *                            updatedInput } }
 *
 * Exit code semantics (CC spec):
 *   0  → allow, parse stdout
 *   2  → block, stderr → reason
 *   *  → log warning, do NOT abort main flow (mirrors fork commit 0f3017f33a)
 */
import path from "path"
import os from "os"
import { existsSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { Effect, Layer, Context, Option, Scope, Exit, Fiber } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { HookSpecificOutputSchema } from "./schema"
import { FSUtil } from "@graphagent/core/fs-util"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import * as Log from "@/util/log"
import { Global } from "@graphagent/core/global"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { SessionHooks, type ScopedHooksInput } from "./session-hooks"
import type { SessionHookEntry } from "./session-hooks"
import { patchFilePaths } from "./file-changes"
import { HookNotification } from "./notifications"
import { SessionID } from "@/session/schema"
import { SessionCancellation } from "@/session/cancellation"
import { HookRewake } from "./rewake"
import { HookConfigChange } from "./config-change"
import { HookFileWatch } from "./file-watch"
import { EffectBridge } from "@/effect/bridge"
import { buildForkHooks, watchSettings } from "./extensions"
import { HookTranscript } from "./transcript"
import { claudeToolResponse } from "./tool-output"
import type {
  ForkHooks,
  HookCommand,
  HookEnvelope,
  HookEvent,
  HookEffort,
  HookJSONOutput,
  HookMatcher,
  HookPayload,
  HookSummary,
  Settings,
  TriggerContext,
} from "./types"
import { isAsync, isRecord, VALID_HOOK_EVENTS } from "./types"
import { commandText, execShell, expandCommand, httpUrl, promptText, resolveHookCwd } from "./exec/command"
import { validTerminalSequence } from "./exec/output"
import { commandHandler } from "./handlers/command"
import { httpHandler, httpHookUrlAllowed } from "./handlers/http"
import { mcpHandler, mcpToolHandler } from "./handlers/mcp-tool"
import { promptHandler } from "./handlers/prompt"
import { agentHandler } from "./handlers/agent"
import type { HookExecution, HookHandler } from "./handlers/shared"
import { chainCandidates, descriptorFor, loadChainWithSummaries } from "./config/chain"
import { canonicalToolName, claudeTools, matches, matcherTargets, translateClaudeInput } from "./match"
import { buildStdinEnvelope, resolveWorktreeHookPath } from "./envelope"

const log = Log.create({ service: "hook.settings" })

// Re-export the extracted modules so `@/hook/settings` keeps its full surface
// until the barrel switch (D1 PR1 step 4).
export type {
  ForkHooks,
  HookCommand,
  HookEffort,
  HookEvent,
  HookJSONOutput,
  HookPayload,
  HookSpecificOutput,
  HookSummary,
  Settings,
  TriggerContext,
} from "./types"
export { VALID_HOOK_EVENTS } from "./types"
export { expandHookCommand, resolveHookShell } from "./exec/command"
export type { ResolvedShell, ShellProbe } from "./exec/command"
export { classifyStdout } from "./exec/output"
export type { StdoutClass } from "./exec/output"
export { agentToPermissionMode } from "./match"
export { detectUnsupportedFields, readJSON, warnUnsupportedFields } from "./config/load"
export { loadChain, loadChainWithSummaries, mergeSettings, summarizeChain } from "./config/chain"
export { chainCandidates as __chainCandidates } from "./config/chain"

// ── Async rewake (hook-async-rewake) ───────────────────────────
// Sentinel prefix for rewake prompts. UserPromptSubmit hook processing skips
// prompts whose text starts with this prefix, preventing hook → rewake → hook
// loops. The prefix must match the opening of buildRewakePrompt exactly.
export const HOOK_REWAKE_SENTINEL = "<system-reminder>\nAsync hook completed"

const CONTEXT_LIMIT = 10_000
const CONTEXT_PREVIEW_LIMIT = 2_000
/**
 * Claude bounds hook-provided context at 10,000 characters and escapes reminder
 * tags so hook output cannot close the host envelope. Over-limit text is kept
 * whole in `spillDir` when available; what reaches the model is its path plus a
 * 2,000-character preview. Without a writable directory the value is truncated
 * in place so the cap still holds.
 */
export function sanitizeHookContext(text: string, spillDir?: string): string {
  const escaped = text
    .replaceAll("<system-reminder>", "&lt;system-reminder>")
    .replaceAll("</system-reminder>", "&lt;/system-reminder>")
  if (escaped.length <= CONTEXT_LIMIT) return escaped
  if (spillDir) {
    const file = path.join(spillDir, `context-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`)
    try {
      writeFileSync(file, text, { mode: 0o600 })
      return `Full context saved to ${file}\n\n${escaped.slice(0, CONTEXT_PREVIEW_LIMIT)}`
    } catch {
      // An unwritable scratchpad must not fail the hook; fall back to truncation.
    }
  }
  return `${escaped.slice(0, CONTEXT_LIMIT)}\n[truncated at ${CONTEXT_LIMIT} characters]`
}

const SHOW_STDERR_EVENTS = new Set<HookEvent>([
  "SessionStart",
  "SessionEnd",
  "CwdChanged",
  "FileChanged",
  "PostCompact",
  "SubagentStart",
  "PostModelSwitch",
])

function buildRewakePrompt(entry: HookCommand, event: HookEvent, content: string, spillDir?: string): string {
  const cmd = descriptorFor(entry)
  return `${HOOK_REWAKE_SENTINEL} (command: ${cmd}, event: ${event}):\n${sanitizeHookContext(content, spillDir)}\n</system-reminder>`
}

// `TriggerResult` and `landSystemMessages` live in `./trigger-result` (a
// cycle-free leaf). Re-exported here so existing `SettingsHook.*` /
// `import { type TriggerResult } from "@/hook/settings"` call sites keep
// working. See trigger-result.ts for the cycle rationale.
import { landSystemMessages, type TriggerResult } from "./trigger-result"
export type { TriggerResult } from "./trigger-result"
export { landSystemMessages } from "./trigger-result"

/**
 * Hard cap on how many times a blocked Stop / SubagentStop hook may drive another
 * model turn. Guards against a misbehaving hook that ignores `stop_hook_active`
 * (which would otherwise loop forever burning tokens). Shared by the main agent
 * Stop path (prompt.ts) and the SubagentStop path (task.ts).
 */
export const MAX_STOP_CONTINUATIONS = 8

/**
 * Claude Code's `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` override for the cap above.
 * Only a positive integer is accepted; anything else (including unset) keeps
 * the documented default of 8.
 */
export function stopHookBlockCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  if (raw === undefined) return MAX_STOP_CONTINUATIONS
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : MAX_STOP_CONTINUATIONS
}

/**
 * Tool events report fresh feedback per call (e.g. a PostToolUse validator
 * repeating the same lint error), so their additionalContext is deduplicated
 * only within one trigger. SubagentStart is keyed by the PARENT sessionID but its
 * context lands in a fresh child session each time, so a second subagent (or a
 * resumed task_id) must receive the same text again. Every other event keeps
 * per-session dedup: its context (SessionStart, Stop, …) stays in history after
 * the first injection.
 *
 * Exception to per-session dedup: a SessionStart with source "compact" clears the
 * session's bucket first (see trigger). Compaction removes earlier injected context
 * from model history, so identical text must be injectable again. `resume` keeps
 * per-session dedup: it fires at most once per session per instance, on a fresh
 * instance state whose bucket is empty, so nothing can be wrongly dropped.
 */
const PER_TRIGGER_DEDUP_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  // Each prompt is a new turn: identical text must reach the model again.
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "SubagentStop",
])

/**
 * Identity of a handler for per-trigger dedup: only fully equivalent handlers
 * run once (CC behavior). Every configured field except loader metadata takes
 * part (headers, env allowlists, options, timeout), plus the expanded command
 * or URL. Scoped skill/agent registrations add their origin separately.
 */
function handlerKey(entry: HookCommand, origin?: string): string {
  const target =
    entry.type === "command"
      ? expandCommand(entry)
      : entry.type === "http"
        ? httpUrl(entry)
        : entry.type === "mcp_tool"
          ? `${entry.server}/${entry.tool}`
          : commandText(entry)
  const { __sourceDir: _sourceDir, ...identity } = entry
  return JSON.stringify([origin ?? "settings", target, identity], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

/** Per-event handler availability from the 2026-10-16 Claude Code hooks reference. */
const ALL_HANDLER_TYPES = new Set<HookCommand["type"]>(["command", "http", "mcp_tool", "mcp", "prompt", "agent"])
const OBSERVATIONAL_HANDLER_TYPES = new Set<HookCommand["type"]>(["command", "http", "mcp_tool", "mcp"])
function supportsHandler(event: HookEvent, type: HookCommand["type"]): boolean {
  if (event === "Setup") return type === "command"
  if (event === "SessionStart") return type === "command" || type === "mcp_tool" || type === "mcp"
  if (event === "PermissionRequest") return type !== "agent"
  if (
    [
      "UserPromptSubmit",
      "UserPromptExpansion",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "PermissionDenied",
      "Stop",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "TeammateIdle",
    ].includes(event)
  )
    return ALL_HANDLER_TYPES.has(type)
  return OBSERVATIONAL_HANDLER_TYPES.has(type)
}

// ── Effect service ──────────────────────────────────────────────

interface StopRewakeChain {
  count: number
  unregister?: () => void
}

function removeStopChain(state: State, key: string, expected?: StopRewakeChain): boolean {
  const chain = state.stopRewakeChains.get(key)
  if (!chain || (expected && chain !== expected)) return false
  state.stopRewakeChains.delete(key)
  chain.unregister?.()
  return true
}

interface State {
  settings: Settings
  cwd: string
  /** Stable project root; survives deletion of `cwd`, so hooks can fall back to it. */
  root: string
  /**
   * Deduplicated additionalContext strings, bucketed per sessionID. Each
   * session sees every distinct context once; a second session is NOT
   * starved by what the first already saw. The bucket for a session is
   * evicted on SessionEnd (see trigger) so the map does not grow unboundedly
   * across the process lifetime. Headless / no-session triggers collapse to
   * the "" bucket, preserving the prior global-dedup behavior for those.
   */
  seen: Map<string, Set<string>>
  once: Map<string, WeakSet<HookCommand>>
  onceRunning: Map<string, WeakMap<HookCommand, string>>
  stopRewakeChains: Map<string, StopRewakeChain>
  asyncResults: Map<string, TriggerResult>
  asyncFibers: Map<string, Set<Fiber.Fiber<unknown, unknown>>>
  /**
   * Async SessionEnd commands. Their session is gone by design, so ending it must not
   * interrupt them; they run for their side effects and stop only with the instance.
   */
  endFibers: Set<Fiber.Fiber<unknown, unknown>>
  /**
   * Scope-tagged summaries of the currently-effective hooks, computed by
   * `summarizeChain` alongside `settings` (same closure, same hot-reload
   * watcher). `list()` reads this without touching files.
   */
  hooksList: HookSummary[]
}

export interface Interface {
  readonly trigger: (payload: HookPayload, ctx: TriggerContext) => Effect.Effect<TriggerResult>
  /** Deliver completed background command output on the next turn only. */
  readonly drainAsync?: (sessionID: SessionID | string) => Effect.Effect<TriggerResult>
  /** Drop pending output and interrupt background commands owned by this session. */
  readonly clearSession?: (sessionID: SessionID | string) => Effect.Effect<void>
  readonly fileWatchPaths?: () => Effect.Effect<readonly string[]>
  /** Cheap event probe including currently registered session hooks. */
  readonly hasEvent?: (event: HookEvent, sessionID?: SessionID | string) => Effect.Effect<boolean>
  /** Overall SessionEnd budget, accounting for configured hooks and env override. */
  readonly sessionEndTimeout?: () => Effect.Effect<number>
  /** Wait for async SessionEnd commands within the caller's budget; interruption cancels them. */
  readonly settleSessionEnd?: () => Effect.Effect<void>
  /** Register validated skill/agent frontmatter hooks for their actual lifetime. */
  readonly registerScoped?: (sessionID: SessionID | string, input: ScopedHooksInput) => Effect.Effect<void>
  readonly unregisterScoped?: (sessionID: SessionID | string, origin: string) => Effect.Effect<void>
  /**
   * Read-only view of the currently-effective hooks (merged global + project +
   * local chain), one entry per hook command tagged with its source layer.
   * Backed by the same hot-reloaded state `trigger` consults — never re-reads
   * files. Empty when no hooks.json layer defines any hook or when
   * disableAllHooks is on, because no trigger can run them.
   */
  readonly list: () => Effect.Effect<ReadonlyArray<HookSummary>>
  /**
   * Invalidate the pending Stop/SubagentStop/StopFailure rewake chain for a
   * session. SessionPrompt.cancel calls this so a user abort is not overridden
   * by a callback that completes afterwards and rewakes a fresh turn. Optional
   * so partial test mocks stay valid; the real layer always provides it.
   */
  readonly invalidateStopRewakeChain?: (sessionID: SessionID | string) => Effect.Effect<void>
  /**
   * Re-validate a stop-chain token captured at Stop-trigger time. Returns
   * false when the chain has since been invalidated or replaced (session
   * cancel, newer user prompt, SessionEnd, instance dispose). Admission and
   * the run path re-check with this, because invalidation can land after the
   * callback's own completion check. Optional so partial test mocks stay
   * valid; the real layer always provides it.
   */
  readonly validateStopRewakeChain?: (sessionID: SessionID | string, token: unknown) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SettingsHook") {}

// Per-session additionalContext dedup bucket cap. A normal session never
// approaches this; the bound exists for the headless "" bucket (sessionID=""),
// which is shared across every prompt of a long-lived headless process and
// would otherwise accumulate without limit. Eviction is insertion-order-oldest
// (Set iterates in insertion order), so the least-recently-injected context is
// dropped first — acceptable since re-injection only matters within a session.
const MAX_SEEN_PER_BUCKET = 1000

/**
 * Add `text` to the per-session dedup bucket; returns true when newly added
 * (the caller then injects it into additionalContexts). Caps the bucket at
 * MAX_SEEN_PER_BUCKET by evicting the oldest entry — see the constant comment
 * for why the headless "" bucket needs this.
 */
const addSeen = (seen: Map<string, Set<string>>, sessionID: string, text: string): boolean => {
  const bucket = seen.get(sessionID) ?? new Set<string>()
  if (bucket.has(text)) return false
  bucket.add(text)
  if (bucket.size > MAX_SEEN_PER_BUCKET) {
    const oldest = bucket.values().next().value
    if (oldest !== undefined) bucket.delete(oldest)
  }
  seen.set(sessionID, bucket)
  return true
}

/** Literal FileChanged matcher entries are the static watch list. */
function staticWatchPaths(settings: Settings): readonly string[] {
  return [
    ...new Set(
      (settings.hooks?.FileChanged ?? [])
        .flatMap((group) => (group.matcher === undefined || group.matcher === "" ? [] : group.matcher.split("|")))
        .filter(Boolean),
    ),
  ]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessionHooks = yield* SessionHooks.Service
    // Optional: only a full runtime has sessions that can veto a reload and watchers to refresh.
    const configChange = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
    const fileWatch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
    const handlerContext = Context.pick(
      MCP.Service,
      Provider.Service,
      Auth.Service,
      FSUtil.Service,
      ChildProcessSpawner,
      HttpClient.HttpClient,
    )(yield* Effect.context())

    const state = yield* InstanceState.make(
      Effect.fn("SettingsHook.state")(function* (instCtx) {
        const chain = loadChainWithSummaries(instCtx.root)
        const stateObj = {
          settings: chain.settings,
          hooksList: chain.summaries,
          cwd: instCtx.directory,
          root: instCtx.root,
          seen: new Map<string, Set<string>>(),
          once: new Map<string, WeakSet<HookCommand>>(),
          onceRunning: new Map<string, WeakMap<HookCommand, string>>(),
          stopRewakeChains: new Map<string, StopRewakeChain>(),
          asyncResults: new Map<string, TriggerResult>(),
          asyncFibers: new Map<string, Set<Fiber.Fiber<unknown, unknown>>>(),
          endFibers: new Set<Fiber.Fiber<unknown, unknown>>(),
        } satisfies State

        // Async commands are started from the service's background scope, but
        // their ownership is the directory instance. Dispose must interrupt
        // every command before the instance disappears.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [...stateObj.asyncFibers.values()].flatMap((fibers) => [...fibers]).concat([...stateObj.endFibers]),
            (fiber) => Fiber.interrupt(fiber),
            { discard: true },
          ),
        )

        // [FORK:hook-ext] Hot-reload hooks.json at runtime. A changed file produces a
        // CANDIDATE chain. Invalid JSON never replaces a valid chain. The ConfigChange hooks
        // then run against the CURRENT (old) settings in the real sessions of this instance;
        // a block keeps the old chain. Only an accepted candidate is committed, in one
        // synchronous assignment, and the static FileChanged watchers follow it. The watcher
        // serializes reloads and its close() (run by the finalizer below) interrupts the one
        // in flight, so a disposed instance can never commit.
        const bridge = yield* EffectBridge.make()
        const reloadCandidate = Effect.fn("SettingsHook.reloadCandidate")(function* (changedFile: string) {
          const candidate = loadChainWithSummaries(instCtx.root)
          if (candidate.invalid.length > 0) {
            log.warn("hooks.json is not valid JSON; keeping the current hooks", { files: candidate.invalid })
            return undefined
          }
          const scope = chainCandidates(instCtx.root).find((item) => item.file === changedFile)?.scope
          const source =
            scope === "global" ? "user_settings" : scope === "local" ? "local_settings" : "project_settings"
          // Real sessions of this instance decide first; with none registered, the hooks
          // run once without a session. Failures of the hooks themselves never block.
          const asked: HookConfigChange.Decision = configChange
            ? yield* configChange
                .checkInstance({ path: changedFile, source })
                .pipe(Effect.catch(() => Effect.succeed<HookConfigChange.Decision>({})))
            : {}
          let blocked = asked.blocked
          if ((asked.checked ?? 0) === 0) {
            const fallback: TriggerResult = yield* trigger(
              { event: "ConfigChange", source, configPath: changedFile },
              { sessionID: "", transcriptPath: "" },
            ).pipe(
              Effect.catchCause(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
            )
            blocked = fallback.blocked
          }
          if (blocked) {
            log.info("hooks reload blocked by a ConfigChange hook", { file: changedFile })
            return undefined
          }
          stateObj.settings = candidate.settings
          stateObj.hooksList = candidate.summaries
          if (fileWatch)
            yield* fileWatch.refreshStatic(
              candidate.settings.disableAllHooks === true ? [] : staticWatchPaths(candidate.settings),
            )
          return candidate.settings
        })
        const handle = watchSettings(
          instCtx.root,
          (changedFile) => bridge.run(reloadCandidate(changedFile)),
          () => {},
          Global.Path.config,
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            handle.close()
            for (const key of stateObj.stopRewakeChains.keys()) removeStopChain(stateObj, key)
          }),
        )

        return stateObj
      }),
    )

    // Handlers resolve their deps lazily at trigger time from the ambient context.
    // This keeps the layer lightweight (only SessionHooks needed at
    // construction), following the Todo pattern exactly.
    const handlers: Record<string, HookHandler> = {
      command: commandHandler,
      mcp: mcpHandler,
      mcp_tool: mcpToolHandler,
      http: httpHandler,
      prompt: promptHandler,
      agent: agentHandler,
    }

    // [FORK:hook-ext] Assemble fork middleware — wired from hook/extensions/index.ts
    // When undefined, trigger() behaves identically to upstream.
    const forkHooks: ForkHooks | undefined = buildForkHooks ? buildForkHooks({ sessionHooks }) : undefined

    /**
     * Execute a single hook entry. Never throws. Returns the parsed JSON
     * output + a synthetic blocking signal for exit-code-2 protocol.
     */
    const runEntry = Effect.fn("SettingsHook.runEntry")(function* (
      entry: HookCommand,
      envelope: HookEnvelope,
      cwd: string,
      inHook: boolean,
      environmentFile?: string,
      environment?: Record<string, string | undefined>,
      canonicalName?: string,
      projectDir?: string,
      effort?: HookEffort,
      toolOutput?: unknown,
    ) {
      using _ = log.time("runEntry", { type: entry.type, command: commandText(entry).slice(0, 80) })
      const resolvedCwd = resolveHookCwd([cwd, projectDir, os.homedir(), os.tmpdir()])
      if (resolvedCwd !== cwd)
        log.warn("hook working directory unavailable; using fallback", { cwd, fallback: resolvedCwd })
      // CLAUDE_PROJECT_DIR names the project root for the whole session, even
      // when the session was opened in (or moved to) a checkout subdirectory.
      // `root` is resolved at instance creation and always exists.
      const hookProjectDir = projectDir ?? resolvedCwd
      if (entry.type === "http") {
        const settings = (yield* InstanceState.get(state)).settings
        if (!httpHookUrlAllowed(httpUrl(entry), settings.allowedHttpHookUrls)) {
          log.warn("http hook destination rejected by allowedHttpHookUrls", { url: httpUrl(entry) })
          return {
            json: undefined as HookJSONOutput | undefined,
            exitBlock: undefined as string | undefined,
            rawStdout: undefined as string | undefined,
            exitCode: undefined as number | null | undefined,
          }
        }
        if (settings.httpHookAllowedEnvVars !== undefined) {
          const allowed = new Set(settings.httpHookAllowedEnvVars)
          entry = { ...entry, allowedEnvVars: (entry.allowedEnvVars ?? []).filter((name) => allowed.has(name)) }
        }
      }
      const handler = handlers[entry.type]
      if (!handler) {
        // Defensive fallback: handlers table is exhaustive over the schema's 5 types
        // (command/mcp/http/prompt/agent). This guards against future schema additions
        // that miss handler registration. Currently dead-code by construction.
        log.warn("hook type not registered (defensive fallback)", { type: entry.type, command: commandText(entry) })
        return {
          json: undefined as HookJSONOutput | undefined,
          exitBlock: `hook type "${entry.type}" not yet implemented` as string | undefined,
          rawStdout: undefined as string | undefined,
          exitCode: undefined as number | null | undefined,
        }
      }
      const nativeName = typeof envelope.tool_name === "string" ? envelope.tool_name : ""
      const claudeName =
        entry.inputFormat === "claude-code"
          ? (canonicalName ?? claudeTools.get(nativeName.toLowerCase())?.name)
          : undefined
      const adapted = claudeName
        ? {
            ...envelope,
            tool_name: claudeName,
            tool_input: isRecord(envelope.tool_input)
              ? translateClaudeInput(nativeName, envelope.tool_input, true)
              : envelope.tool_input,
            ...(envelope.hook_event_name === "PostToolUse"
              ? {
                  tool_response: claudeToolResponse(
                    nativeName,
                    envelope.tool_input,
                    toolOutput,
                    envelope.tool_response,
                  ),
                }
              : {}),
          }
        : envelope
      const result = yield* handler
        .run(entry, adapted, resolvedCwd, inHook, environmentFile, environment, canonicalName, effort, hookProjectDir)
        .pipe(Effect.updateContext((current: Context.Context<never>) => Context.merge(handlerContext, current)))
      const hso = result.json?.hookSpecificOutput
      if (claudeName && envelope.hook_event_name === "PreToolUse" && hso && "updatedInput" in hso && hso.updatedInput)
        hso.updatedInput = translateClaudeInput(nativeName, hso.updatedInput, false, envelope.tool_input)
      if (
        claudeName &&
        envelope.hook_event_name === "PermissionRequest" &&
        hso &&
        "decision" in hso &&
        hso.decision?.updatedInput
      )
        hso.decision.updatedInput = translateClaudeInput(
          nativeName,
          hso.decision.updatedInput,
          false,
          envelope.tool_input,
        )
      return result
    })

    // Background scope for async hooks. Lives as long as the SettingsHook service
    // instance; closed via finalizer when the instance is disposed.
    const bgScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(bgScope, Exit.void))

    const clearEndedSession = Effect.fn("SettingsHook.clearEndedSession")(function* (s: State, sessionID: string) {
      yield* sessionHooks.clear(SessionID.make(sessionID))
      s.seen.delete(sessionID)
      s.once.delete(sessionID)
      s.onceRunning.delete(sessionID)
      s.asyncResults.delete(sessionID)
      for (const fiber of s.asyncFibers.get(sessionID) ?? []) yield* Fiber.interrupt(fiber)
      s.asyncFibers.delete(sessionID)
    })

    /**
     * Async hook completion handler. Computes rewake-worthiness from the result
     * and, when `asyncRewake` is set, admits a steer prompt to the originating
     * session via the opencode Session.Service (ambient in the session runtime).
     * Best-effort — all errors swallowed to honor the "never crash host" contract.
     */
    const onAsyncComplete = Effect.fnUntraced(function* (
      entry: HookCommand,
      sessionEntry: SessionHookEntry | undefined,
      sessionOwner: string | undefined,
      event: HookEvent,
      sessionID: string | undefined,
      hookRewake: HookRewake.Interface | undefined,
      state: State,
      stopChain: StopRewakeChain | undefined,
      result: HookExecution,
      entryToken?: string,
    ) {
      const running = state.onceRunning.get(sessionOwner ?? sessionID ?? "")
      const ownsEntry = !!entryToken && running?.get(entry) === entryToken
      if (ownsEntry) running?.delete(entry)
      if (
        sessionEntry &&
        sessionEntry.kind !== "agent" &&
        entry.once &&
        ownsEntry &&
        result.succeeded === true &&
        !result.exitBlock &&
        sessionID
      ) {
        const onceBucket = state.once.get(sessionOwner ?? sessionID) ?? new WeakSet<HookCommand>()
        onceBucket.add(entry)
        state.once.set(sessionOwner ?? sessionID, onceBucket)
      }
      // SessionEnd has no later turn.
      if (event === "SessionEnd") return
      if (!sessionID) return
      const parts: string[] = []
      if (result.exitBlock) parts.push(result.exitBlock)
      if (result.json?.systemMessage) parts.push(result.json.systemMessage)
      if (result.json?.decision === "block" && result.json.reason) parts.push(result.json.reason)
      const hso = result.json?.hookSpecificOutput
      if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string") {
        parts.push(hso.additionalContext)
      }
      // Asynchronous hooks deliver only their JSON fields; plain stdout is never context.
      if (parts.length === 0) {
        return
      }

      // Ordinary async output waits for the next actual turn. asyncRewake only
      // wakes an idle session on exit 2; normal completion never invents a turn.
      if (!entry.asyncRewake || result.exitCode !== 2 || !hookRewake) {
        const queued = state.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
        // Ordinary async JSON fields are both model feedback on the next turn;
        // unlike synchronous systemMessage, neither is an ephemeral UI warning.
        // Sanitize at the queue's only producer: both consumers (V1 SessionPrompt
        // and the V2 turn bridge) drain raw strings, so an escaped/bounded value
        // must already be in the queue. This also keeps an oversized payload from
        // accumulating in memory while it waits for the next turn.
        const spillDir = yield* HookTranscript.scratchpadDir(sessionID)
        if (result.json?.systemMessage)
          queued.additionalContexts.push(sanitizeHookContext(result.json.systemMessage, spillDir))
        if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string")
          queued.additionalContexts.push(sanitizeHookContext(hso.additionalContext, spillDir))
        state.asyncResults.set(sessionID, queued)
        return
      }

      if (stopChain) {
        // A newer non-hook prompt, SessionEnd, or session cancel invalidates
        // pending Stop callbacks.
        if (state.stopRewakeChains.get(`${event}:${sessionID}`) !== stopChain) {
          log.debug("async Stop callback discarded: chain invalidated", { sessionID, event })
          return
        }
        const continuationCap = stopHookBlockCap()
        if (stopChain.count >= continuationCap) {
          log.warn("async Stop hook continuation limit reached", { sessionID, limit: continuationCap })
          return
        }
        // Reserve before yielding so concurrent completions share the same bound.
        stopChain.count++
      }

      // Claude ignores StopFailure output and exit code. Keep the chain invalidation above so a cancelled callback
      // is still discarded, but never queue context or start a new turn from this event.
      if (event === "StopFailure") return

      const text = buildRewakePrompt(
        entry,
        event,
        result.exitBlock ?? parts.join("\n"),
        yield* HookTranscript.scratchpadDir(sessionID),
      )
      // The token rides along so SessionPrompt can re-check validity at the
      // real admission point — cancel can invalidate after this completion
      // check but before the rewake lands.
      yield* hookRewake
        .rewake({
          sessionID: SessionID.make(sessionID),
          text,
          stopChain,
          valid: () =>
            Effect.sync(() => !stopChain || state.stopRewakeChains.get(`${event}:${sessionID}`) === stopChain),
        })
        .pipe(Effect.catchDefect(() => Effect.logError("async hook rewake failed", { sessionID })))
    })

    const triggerRun = Effect.fn("SettingsHook.trigger")(function* (
      payload: HookPayload,
      ctx: TriggerContext,
      owner?: ReturnType<typeof SessionCancellation.request>,
    ) {
      using _ = log.time("trigger", { event: payload.event, sessionID: ctx.sessionID })
      const s = yield* InstanceState.get(state)
      const result: TriggerResult = { additionalContexts: [], systemMessages: [] }
      if (owner && !owner.valid()) return result

      // Hook rewake prompts skip UserPromptSubmit in SessionPrompt. Every other
      // prompt (including a Goal continuation) begins a new automatic hook chain.
      const clearStopChains = (sessionID: string) => {
        for (const key of s.stopRewakeChains.keys()) if (key.endsWith(`:${sessionID}`)) removeStopChain(s, key)
      }
      if (payload.event === "UserPromptSubmit" && ctx.sessionID) clearStopChains(ctx.sessionID)
      if (payload.event === "SessionEnd" && ctx.sessionID) clearStopChains(ctx.sessionID)
      let stopChain: StopRewakeChain | undefined
      if (
        (payload.event === "Stop" || payload.event === "StopFailure" || payload.event === "SubagentStop") &&
        ctx.sessionID
      ) {
        // Stop, StopFailure and SubagentStop have independent chains. Sharing one key leaks stop_hook_active from a
        // main Stop rewake into a later subagent stop.
        const chainKey = `${payload.event}:${ctx.sessionID}`
        stopChain = s.stopRewakeChains.get(chainKey)
        if (!stopChain) {
          const chain: StopRewakeChain = { count: 0 }
          const unregister = owner?.register(
            () =>
              Effect.sync(() => {
                removeStopChain(s, chainKey, chain)
              }),
            s.cwd,
          )
          if (owner && !unregister) return result
          chain.unregister = unregister
          stopChain = chain
          s.stopRewakeChains.set(chainKey, chain)
        }
        if (stopChain.count > 0) payload = { ...payload, stopHookActive: true }
      }

      // ── SessionEnd lifecycle cleanup (F2) ──────────────────────
      // Evict this session's additionalContext dedup bucket AND its dynamic
      // session-hook store. Both are keyed by sessionID and have no other
      // eviction path, so without this the process accumulates one bucket +
      // one hook list per historical session for its entire lifetime.
      // SessionHooks.clear was previously defined but never invoked — this is
      // the single call site that fixes that leak.
      //
      // Runs BEFORE the WP-6A short-circuit below: a session that registered
      // no SessionEnd hook (the common case) must still have its state freed,
      // and placing it after the matcher loop would skip cleanup whenever the
      // short-circuit fires. Clearing first is safe — a SessionEnd hook that
      // returns additionalContext just repopulates a bucket for an ending
      // session, which is harmless.
      if (payload.event === "SessionEnd" && ctx.sessionID) {
        s.seen.delete(ctx.sessionID)
        s.once.delete(ctx.sessionID)
        s.onceRunning.delete(ctx.sessionID)
        // NOTE: sessionHooks.clear is deferred to after hook execution
        // (before each return point below) — clearing here would remove
        // session-registered SessionEnd hooks before the matcher can see them.
      }

      // Compaction dropped earlier injected context from model history: forget what this
      // session has seen so re-injection is not suppressed (per-session dedup resumes after).
      // Done before the short-circuits: other events' texts must be forgotten even when no
      // SessionStart hook is configured.
      if (payload.event === "SessionStart" && payload.source === "compact") s.seen.delete(ctx.sessionID)

      // ── WP-6A: O(1) short-circuit ─────────────────────────────
      // Skip the entire matcher pipeline (envelope build, target derivation,
      // session merge allocation, matcher regex) when neither the on-disk
      // settings chain nor the session store has any entry for this event.
      // s.settings is already cached on the InstanceState, so the file-side
      // probe is a property access. The session probe is O(1) (Map.get +
      // .some over the session's own array, typically empty).
      const sessionEvent: HookEvent = payload.event
      if (s.settings.disableAllHooks === true) {
        log.info("trigger short-circuit", { event: payload.event, reason: "disableAllHooks" })
        if (payload.event === "SessionEnd" && ctx.sessionID) yield* clearEndedSession(s, ctx.sessionID)
        return result
      }
      const hasFile = (s.settings.hooks?.[payload.event]?.length ?? 0) > 0
      const hasSession = ctx.sessionID
        ? yield* sessionHooks.hasForEvent(SessionID.make(ctx.sessionID), sessionEvent)
        : false
      const hasChildAgent =
        payload.event === "SubagentStop" && payload.agentID
          ? yield* sessionHooks.hasForEvent(SessionID.make(payload.agentID), "SubagentStop")
          : false
      if (!hasFile && !hasSession && !hasChildAgent) {
        log.info("trigger short-circuit", { event: payload.event, reason: "no_matchers", hasFile, hasSession })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* clearEndedSession(s, ctx.sessionID)
        }
        return result
      }

      const fileMatchers = s.settings.hooks?.[payload.event] ?? []

      // ── Session-scoped hook resolution (WP-5D) ────────────────
      // Sub-agent stop semantics: if the caller marks this trigger as
      // running inside a sub-agent and fires `Stop`, look up SubagentStop
      // session hooks. Settings-file lookup still uses payload.event verbatim
      // (the on-disk chain is already correctly addressed by callers).
      const sessionEntries = ctx.sessionID
        ? yield* sessionHooks.list(SessionID.make(ctx.sessionID), sessionEvent)
        : ([] as readonly SessionHookEntry[])
      // Task publishes its terminal SubagentStop from the parent session, but
      // frontmatter belongs to the child session. Include only that child's
      // agent-scoped entries; unrelated dynamic hooks cannot cross sessions.
      const childAgentEntries =
        payload.event === "SubagentStop" && payload.agentID
          ? (yield* sessionHooks.list(SessionID.make(payload.agentID), "SubagentStop")).filter(
              (entry) => entry.kind === "agent" && entry.child,
            )
          : []

      // Tag matchers with their origin so once-cleanup can remove session ones
      // after execution. The settings chain matchers carry no _sessionEntry.
      type RunMatcher = HookMatcher & { _sessionEntry?: SessionHookEntry; _sessionOwner?: string }
      const matchers: RunMatcher[] = [
        ...fileMatchers,
        ...sessionEntries.map(
          (e) =>
            ({
              matcher: e.matcher,
              hooks: e.hooks,
              _sessionEntry: e,
              _sessionOwner: ctx.sessionID,
            }) satisfies RunMatcher,
        ),
        ...childAgentEntries.map(
          (e) =>
            ({
              matcher: e.matcher,
              hooks: e.hooks,
              _sessionEntry: e,
              _sessionOwner: payload.event === "SubagentStop" ? payload.agentID : undefined,
            }) satisfies RunMatcher,
        ),
      ]
      if (!matchers.length) {
        log.info("trigger short-circuit", { event: payload.event, reason: "empty_matchers" })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* clearEndedSession(s, ctx.sessionID)
        }
        return result
      }

      const targets = matcherTargets(payload, ctx)
      // CC's `scratchpad_dir`: create it only now, after the short-circuits, so
      // sessions that never run a hook leave no directory behind. A failed
      // mkdir makes the field absent instead of failing the hook.
      const scratchpadDir =
        ctx.scratchpadDir ?? (ctx.sessionID ? yield* HookTranscript.scratchpadDir(ctx.sessionID) : undefined)
      const envelope = buildStdinEnvelope(payload, scratchpadDir ? { ...ctx, scratchpadDir } : ctx, s.cwd)
      // Identical handlers matched by several groups/layers run once per trigger.
      const ran = new Set<string>()
      // additionalContext dedup: only within this trigger for tool events,
      // per session otherwise (see PER_TRIGGER_DEDUP_EVENTS).
      const local = new Set<string>()
      const addContext = (raw: string) => {
        const text = sanitizeHookContext(raw, scratchpadDir)
        if (local.has(text)) return
        local.add(text)
        // SubagentStart lands in the target child's history, so only that child's own
        // earlier copy suppresses it; a sibling or the parent never does.
        const bucket = payload.event === "SubagentStart" ? payload.agentID : ctx.sessionID
        if (!PER_TRIGGER_DEDUP_EVENTS.has(payload.event) && !addSeen(s.seen, bucket, text)) return
        result.additionalContexts.push(text)
      }
      const runWithStatus = (entry: HookCommand, origin?: string) =>
        Effect.gen(function* () {
          // Never publish the handler definition: commands and HTTP headers can
          // contain private values. The stable digest only correlates spinner
          // start and finish events for this handler.
          const hookID = createHash("sha256").update(handlerKey(entry, origin)).digest("hex")
          if (entry.statusMessage && ctx.sessionID)
            yield* HookNotification.status(ctx.sessionID, hookID, entry.statusMessage, "started")
          return yield* runEntry(
            entry,
            envelope,
            s.cwd,
            false,
            ctx.environmentFile,
            ctx.environment,
            ctx.canonicalToolName,
            s.root,
            ctx.effort,
            payload.event === "PostToolUse" ? payload.toolOutput : undefined,
          ).pipe(
            Effect.ensuring(
              entry.statusMessage && ctx.sessionID
                ? HookNotification.status(ctx.sessionID, hookID, entry.statusMessage, "finished")
                : Effect.void,
            ),
          )
        })

      // Match and claim once before starting any handlers. Foreground handlers
      // then start concurrently; their results are reduced below in settings
      // order so conflicting decisions remain deterministic.
      const planned = new Map<string, Fiber.Fiber<HookExecution> | "async">()
      const claimedEntries = new Map<
        string,
        {
          owner: string
          id: string
          token: string
          remaining: Set<string>
          transferred: Set<string>
          succeeded: boolean
        }
      >()
      const settleGroup = Effect.fnUntraced(function* (claimKey: string, entryKey: string, succeeded: boolean) {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const claim = claimedEntries.get(claimKey)
            if (!claim?.remaining.delete(entryKey)) return
            claim.succeeded ||= succeeded
            if (claim.remaining.size > 0) return
            yield* sessionHooks.complete(SessionID.make(claim.owner), claim.id, claim.token, claim.succeeded)
            claimedEntries.delete(claimKey)
          }),
        )
      })
      const runningEntries: Array<{ owner: string; entry: HookCommand; token: string }> = []
      const releaseRunning = (owner: string, entry: HookCommand, token?: string) => {
        const running = s.onceRunning.get(owner)
        const owned = !!token && running?.get(entry) === token
        if (owned) running?.delete(entry)
        const index = runningEntries.findIndex(
          (item) => item.owner === owner && item.entry === entry && item.token === token,
        )
        if (index !== -1) runningEntries.splice(index, 1)
        return owned
      }
      const transferRunning = (owner: string, entry: HookCommand, token?: string) => {
        const index = runningEntries.findIndex(
          (item) => item.owner === owner && item.entry === entry && item.token === token,
        )
        if (index !== -1) runningEntries.splice(index, 1)
      }
      // A trigger may be interrupted while joining a foreground handler. Scope
      // finalization releases every reservation it still owns, including a
      // group claim made before the first handler started.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const [key, claim] of claimedEntries) {
            // Only background entries transferred to bgScope may outlive this
            // trigger. Interrupted foreground and not-yet-forked entries fail.
            for (const entryKey of claim.remaining)
              if (!claim.transferred.has(entryKey)) claim.remaining.delete(entryKey)
            if (claim.remaining.size === 0) {
              yield* sessionHooks.complete(SessionID.make(claim.owner), claim.id, claim.token, claim.succeeded)
              claimedEntries.delete(key)
            }
          }
          for (let index = runningEntries.length - 1; index >= 0; index--) {
            const item = runningEntries[index]
            if (item) releaseRunning(item.owner, item.entry, item.token)
          }
        }),
      )
      for (const group of matchers) {
        if (targets !== undefined && !targets.some((target) => matches(group.matcher, target, payload.event))) continue
        let claimed = false
        for (const entry of group.hooks) {
          if (!supportsHandler(payload.event, entry.type)) continue
          if (
            (entry.type === "mcp_tool" || entry.type === "mcp") &&
            (payload.event === "Setup" ||
              (payload.event === "SessionStart" && ["startup", "resume", "fork"].includes(payload.source)))
          )
            continue
          if (
            forkHooks?.beforeRunEntry &&
            !forkHooks.beforeRunEntry(entry, envelope, payload.event, {
              canonicalToolName: canonicalToolName(payload, ctx),
            })
          )
            continue
          const key = handlerKey(entry, group._sessionEntry?.origin)
          if (planned.has(key)) continue
          const onceOwner = group._sessionOwner ?? ctx.sessionID
          const onceBucket = s.once.get(onceOwner) ?? new WeakSet<HookCommand>()
          const runningBucket = s.onceRunning.get(onceOwner) ?? new WeakMap<HookCommand, string>()
          if (
            entry.once &&
            group._sessionEntry &&
            group._sessionEntry.kind !== "agent" &&
            (onceBucket.has(entry) || runningBucket.has(entry))
          )
            continue
          if (group._sessionEntry?.once && group._sessionOwner && !claimed) {
            const owner = group._sessionOwner
            const id = group._sessionEntry.id
            const token = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const reserved = yield* sessionHooks.claim(SessionID.make(owner), id)
                if (!reserved) return undefined
                claimedEntries.set(`${owner}:${id}`, {
                  owner,
                  id,
                  token: reserved,
                  remaining: new Set<string>(),
                  transferred: new Set<string>(),
                  succeeded: false,
                })
                return reserved
              }),
            )
            if (!token) break
            claimed = true
          }
          if (entry.once && group._sessionEntry && group._sessionEntry.kind !== "agent") {
            const token = crypto.randomUUID()
            runningBucket.set(entry, token)
            s.onceRunning.set(onceOwner, runningBucket)
            runningEntries.push({ owner: onceOwner, entry, token })
          }
          if (group._sessionEntry?.once && group._sessionOwner)
            claimedEntries.get(`${group._sessionOwner}:${group._sessionEntry.id}`)?.remaining.add(key)
          planned.set(
            key,
            isAsync(entry) ? "async" : yield* runWithStatus(entry, group._sessionEntry?.origin).pipe(Effect.forkChild),
          )
        }
      }

      for (const group of matchers) {
        if (targets !== undefined && !targets.some((target) => matches(group.matcher, target, payload.event))) continue

        for (const entry of group.hooks) {
          // Forward-compat: skip truly unknown types so future schema additions don't crash
          // older handlers. Known types (command/mcp/http/prompt/agent) all flow into runEntry.
          const key = handlerKey(entry, group._sessionEntry?.origin)
          if (ran.has(key)) continue
          const pending = planned.get(key)
          if (!pending) continue
          ran.add(key)

          // ── Async fork (hook-async-rewake) ──────────────────────
          // async:true and asyncRewake:true entries are forked into the background and do NOT
          // participate in the current TriggerResult aggregation. Their output
          // (when asyncRewake:true) is delivered back via onAsyncComplete →
          // Session.rewake once the background fiber settles.
          if (isAsync(entry)) {
            const hookRewake = Option.getOrUndefined(yield* Effect.serviceOption(HookRewake.Service))
            const capturedEvent = payload.event
            const capturedSessionID = ctx.sessionID
            const claimKey = `${group._sessionOwner}:${group._sessionEntry?.id}`
            const claim = claimedEntries.get(claimKey)
            const owner = group._sessionOwner ?? capturedSessionID
            const entryToken = s.onceRunning.get(owner)?.get(entry)
            let fiber: Fiber.Fiber<unknown, unknown> | undefined
            let succeeded = false
            const background = runWithStatus(entry, group._sessionEntry?.origin).pipe(
              Effect.catchDefect((defect) => {
                log.warn("async hook entry defect swallowed (host protected)", {
                  event: capturedEvent,
                  command: commandText(entry),
                  error: String(defect),
                })
                return Effect.succeed({
                  json: undefined as HookJSONOutput | undefined,
                  exitBlock: undefined as string | undefined,
                  rawStdout: undefined as string | undefined,
                  exitCode: undefined as number | null | undefined,
                  succeeded: false,
                })
              }),
              Effect.flatMap((r) => {
                succeeded = r.succeeded === true && !r.exitBlock
                return Effect.gen(function* () {
                  // Exit-2 rewake may park in a busy session. Its command has
                  // settled, so release this handler before waiting there.
                  // Ordinary async output, however, must reach the next-turn
                  // queue before the claim becomes an observable barrier.
                  if (claim && entry.asyncRewake && r.exitCode === 2 && hookRewake)
                    yield* settleGroup(claimKey, key, succeeded)
                  yield* onAsyncComplete(
                    entry,
                    group._sessionEntry,
                    group._sessionOwner,
                    capturedEvent,
                    capturedSessionID,
                    hookRewake,
                    s,
                    stopChain,
                    r,
                    entryToken,
                  )
                  if (claim) yield* settleGroup(claimKey, key, succeeded)
                })
              }),
              Effect.catchDefect((defect) => {
                log.warn("async hook completion defect swallowed", {
                  command: commandText(entry),
                  error: String(defect),
                })
                return Effect.void
              }),
              Effect.ensuring(
                Effect.gen(function* () {
                  if (claim) yield* settleGroup(claimKey, key, succeeded)
                  const running = s.onceRunning.get(owner)
                  if (entryToken && running?.get(entry) === entryToken) running.delete(entry)
                  if (fiber) {
                    s.endFibers.delete(fiber)
                    s.asyncFibers.get(capturedSessionID)?.delete(fiber)
                  }
                }),
              ),
            )
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                claim?.transferred.add(key)
                fiber = yield* background.pipe(Effect.forkIn(bgScope))
                if (capturedEvent === "SessionEnd") s.endFibers.add(fiber)
                else {
                  const owned = s.asyncFibers.get(capturedSessionID) ?? new Set<Fiber.Fiber<unknown, unknown>>()
                  owned.add(fiber)
                  s.asyncFibers.set(capturedSessionID, owned)
                }
                transferRunning(owner, entry, entryToken)
              }),
            )
            continue
          }
          if (pending === "async") continue

          // "Never crash host" contract: a hook handler can throw an unrecoverable
          // defect (null deref, OOM, native assert). Effect.catch at the tool-layer
          // call sites only catches typed Failures, so a defect would propagate and
          // kill the session. Catch defects here at the single entry-execution point
          // (covers all handler types: command/mcp/http/prompt/agent) → silent allow,
          // log, and continue to the next entry.
          const { json, exitBlock, rawStdout, exitCode, succeeded, failureMessage } = yield* Fiber.join(pending).pipe(
            Effect.catchDefect((defect) => {
              log.warn("hook entry defect swallowed (host protected)", {
                event: payload.event,
                command: commandText(entry),
                error: String(defect),
              })
              return Effect.succeed({
                json: undefined,
                exitBlock: undefined,
                rawStdout: undefined,
                exitCode: undefined,
                succeeded: false,
                failureMessage: undefined,
              })
            }),
          )
          // Reference parity: a hook that failed without blocking still leaves a
          // user-visible `<hook name> hook error` notice. It never enters model
          // context, tool feedback, or any hook decision.
          if (succeeded !== true && !exitBlock && failureMessage)
            (result.hookErrors ??= []).push(
              `${group.matcher ? `${payload.event}:${group.matcher}` : payload.event} hook error: ${sanitizeHookContext(failureMessage, scratchpadDir)}`,
            )
          if (group._sessionEntry?.once && group._sessionOwner)
            yield* settleGroup(
              `${group._sessionOwner}:${group._sessionEntry.id}`,
              key,
              succeeded === true && !exitBlock,
            )
          const onceOwner = group._sessionOwner ?? ctx.sessionID
          const owned = releaseRunning(
            onceOwner,
            entry,
            runningEntries.find((item) => item.owner === onceOwner && item.entry === entry)?.token,
          )
          if (
            entry.once &&
            owned &&
            succeeded &&
            !exitBlock &&
            group._sessionEntry &&
            group._sessionEntry.kind !== "agent"
          ) {
            const owner = group._sessionOwner ?? ctx.sessionID
            const onceBucket = s.once.get(owner) ?? new WeakSet<HookCommand>()
            onceBucket.add(entry)
            s.once.set(owner, onceBucket)
          }

          // [FORK:hook-ext] Post-dispatch observation — never modifies result
          forkHooks?.afterRunEntry?.(entry, envelope, payload.event, { json, exitBlock })

          // Exit-code-2 block beats stdout decision
          const observational = new Set<HookEvent>([
            "Setup",
            "Notification",
            "SessionStart",
            "SubagentStart",
            "PostModelSwitch",
            "SessionEnd",
            "PostCompact",
            "InstructionsLoaded",
            "StopFailure",
            "CwdChanged",
            "DirectoryAdded",
            "FileChanged",
            "MessageDisplay",
            "WorktreeCreate",
            "WorktreeRemove",
          ])
          if (exitBlock && SHOW_STDERR_EVENTS.has(payload.event))
            result.systemMessages.push(sanitizeHookContext(exitBlock, scratchpadDir))
          if (exitBlock && payload.event !== "PermissionRequest" && !observational.has(payload.event)) {
            result.blocked = { reason: exitBlock, command: commandText(entry) }
            // A failed or exit-2 PreToolUse hook is a deny that outranks defer, and no JSON
            // from any hook can lift it.
            if (payload.event === "PreToolUse") {
              result.permissionDecision = "deny"
              result.permissionDecisionReason = exitBlock
              result.updatedInput = undefined
            }
          }
          if (exitBlock && payload.event === "PermissionRequest" && entry.onFailure === "block" && exitCode !== 2)
            result.permissionRequestDecision = { behavior: "deny", message: exitBlock }
          if (payload.event === "Elicitation" || payload.event === "ElicitationResult") {
            if (exitBlock) {
              result.elicitation = { action: "decline" }
              result.blocked = undefined
            }
          }
          if (payload.event === "WorktreeCreate" && exitCode !== undefined && exitCode !== 0)
            result.blocked = { reason: exitBlock ?? "Worktree creation hook failed", command: commandText(entry) }
          if (
            payload.event === "WorktreeRemove" &&
            exitCode !== undefined &&
            exitCode !== 0 &&
            existsSync(payload.worktreePath ?? payload.path ?? "")
          ) {
            result.worktreeRemoveFailed = true
            result.blocked = { reason: exitBlock ?? "Worktree removal hook failed", command: commandText(entry) }
          }
          if (payload.event === "PreModelSwitch" && exitCode === null)
            result.blocked = { reason: "Model-switch hook timed out", command: commandText(entry) }

          if (
            payload.event === "WorktreeCreate" &&
            (entry.type === "command" || entry.type === "mcp" || entry.type === "mcp_tool")
          ) {
            if (succeeded) {
              const lines = (rawStdout ?? "")
                .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
                .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
              const returned = lines.at(-1)
              if (returned) result.worktreePath = returned
              else result.blocked = { reason: "Worktree creation hook returned no path", command: commandText(entry) }
            }
            continue
          }

          if (!json) {
            // P1a: exit-0 plain-text stdout → additionalContext for the two
            // events CC injects it for (UserPromptSubmit / SessionStart). JSON
            // stdout was already parsed above (json defined → this branch
            // skipped); only non-JSON exit-0 output reaches here. Runs through
            // the same per-session dedup bucket as hookSpecificOutput.
            if (
              rawStdout &&
              succeeded &&
              (payload.event === "UserPromptSubmit" ||
                payload.event === "UserPromptExpansion" ||
                payload.event === "SessionStart" ||
                payload.event === "PostModelSwitch")
            ) {
              const text = rawStdout.trim()
              if (text) addContext(text)
            }
            continue
          }

          const topLevelBlockEvents = new Set<HookEvent>([
            "UserPromptSubmit",
            "UserPromptExpansion",
            "PostToolUse",
            "PostToolUseFailure",
            "PostToolBatch",
            "Stop",
            "SubagentStop",
            "ConfigChange",
            "PreCompact",
            "TaskCreated",
            "TaskCompleted",
            "PreModelSwitch",
          ])
          if (json.decision === "block" && topLevelBlockEvents.has(payload.event) && !result.blocked) {
            result.blocked = { reason: json.reason ?? "Blocked by hook", command: commandText(entry) }
          }
          if ((payload.event === "Elicitation" || payload.event === "ElicitationResult") && json.decision === "block") {
            result.elicitation = { action: "decline" }
            result.blocked = undefined
          }

          if (
            json.continue === false &&
            !observational.has(payload.event) &&
            payload.event !== "TaskCreated" &&
            !(payload.event === "TaskCompleted" && payload.source === "task_update") &&
            payload.event !== "ConfigChange" &&
            payload.event !== "PreCompact" &&
            payload.event !== "Elicitation" &&
            payload.event !== "ElicitationResult"
          ) {
            result.preventContinuation = true
            if (json.stopReason && !result.stopReason) result.stopReason = json.stopReason
          }

          if (
            json.systemMessage &&
            (!observational.has(payload.event) ||
              payload.event === "FileChanged" ||
              payload.event === "CwdChanged" ||
              payload.event === "SessionStart" ||
              payload.event === "SubagentStart" ||
              payload.event === "PostModelSwitch") &&
            payload.event !== "ConfigChange" &&
            payload.event !== "PreCompact" &&
            payload.event !== "Elicitation" &&
            payload.event !== "ElicitationResult"
          )
            result.systemMessages.push(sanitizeHookContext(json.systemMessage, scratchpadDir))
          if ((payload.event === "FileChanged" || payload.event === "CwdChanged") && json.watchPaths)
            result.watchPaths = json.watchPaths
          if (json.terminalSequence && validTerminalSequence(json.terminalSequence))
            (result.terminalSequences ??= []).push(json.terminalSequence)
          if (json.terminalSequence && validTerminalSequence(json.terminalSequence) && ctx.sessionID)
            yield* HookNotification.terminal(ctx.sessionID, json.terminalSequence)

          // Missing discriminator is retained as a legacy OpenCode alias; a
          // present but different event name cannot control this event.
          const parsedHso = HookSpecificOutputSchema.safeParse(json.hookSpecificOutput)
          const hso =
            (!(payload.event === "Elicitation" || payload.event === "ElicitationResult") ||
              exitCode === undefined ||
              exitCode === 0) &&
            (!json.hookSpecificOutput?.hookEventName || json.hookSpecificOutput.hookEventName === payload.event)
              ? parsedHso.success
                ? parsedHso.data
                : undefined
              : undefined
          // Property-based narrowing — works across union variants without depending on
          // hookEventName tag (which the fallback variant may also accept).
          if (
            hso &&
            "additionalContext" in hso &&
            typeof hso.additionalContext === "string" &&
            new Set<HookEvent>([
              "SessionStart",
              "SubagentStart",
              "UserPromptSubmit",
              "UserPromptExpansion",
              "PreToolUse",
              "PostToolUse",
              "PostToolUseFailure",
              "PostToolBatch",
              "Stop",
              "SubagentStop",
              "PostModelSwitch",
            ]).has(payload.event)
          ) {
            // Per-session dedup (F2) applies to non-tool events; the bucket is
            // keyed by TriggerContext.sessionID (see addContext).
            addContext(hso.additionalContext)
          }
          // Deprecated top-level approve/block map to allow/deny; hookSpecificOutput wins.
          const hsoDecision = hso && "permissionDecision" in hso ? hso.permissionDecision : undefined
          const preDecision =
            payload.event === "PreToolUse"
              ? (hsoDecision ?? (json.decision ? (json.decision === "approve" ? "allow" : "deny") : undefined))
              : undefined
          const preReason =
            hsoDecision !== undefined && hso && "permissionDecisionReason" in hso
              ? hso.permissionDecisionReason
              : hsoDecision === undefined
                ? json.reason
                : undefined
          if (payload.event === "PreToolUse" && preDecision) {
            const incoming = preDecision
            const current = result.permissionDecision
            // Most-restrictive-wins: deny > defer > ask > allow. A later hook cannot
            // relax an earlier hook's deny (Claude Code permission semantics).
            const moreRestrictive =
              current === undefined ||
              { allow: 0, ask: 1, defer: 2, deny: 3 }[incoming] > { allow: 0, ask: 1, defer: 2, deny: 3 }[current]
            if (moreRestrictive) {
              result.permissionDecision = incoming
              result.permissionDecisionReason = preReason
            }
          }
          if (
            payload.event === "PreToolUse" &&
            hso &&
            "updatedInput" in hso &&
            hso.updatedInput &&
            result.permissionDecision !== "defer" &&
            !result.blocked
          ) {
            result.updatedInput = hso.updatedInput
          }
          if (
            payload.event === "PermissionRequest" &&
            hso &&
            "decision" in hso &&
            hso.decision &&
            (entry.type === "command" || entry.type === "http" || entry.type === "mcp" || entry.type === "mcp_tool")
          ) {
            if (hso.decision.behavior === "deny" || result.permissionRequestDecision?.behavior !== "deny")
              result.permissionRequestDecision = hso.decision
          }
          if (payload.event === "PostToolUse" && hso) {
            if (Object.hasOwn(hso, "updatedToolOutput"))
              result.updatedToolOutput = (hso as { updatedToolOutput?: unknown }).updatedToolOutput
            if (Object.hasOwn(hso, "updatedMCPToolOutput"))
              result.updatedMCPToolOutput = (hso as { updatedMCPToolOutput?: unknown }).updatedMCPToolOutput
          }
          if (
            (payload.event === "Elicitation" || payload.event === "ElicitationResult") &&
            hso &&
            "action" in hso &&
            hso.action
          ) {
            if (hso.action === "decline" || result.elicitation?.action !== "decline")
              result.elicitation = { action: hso.action, content: "content" in hso ? hso.content : undefined }
          }
          if (payload.event === "SessionStart" && hso) {
            // This value is admitted as a user turn, so it gets the same reminder
            // escaping and length bound as every other hook-supplied string.
            if (hso.initialUserMessage !== undefined)
              result.initialUserMessage = sanitizeHookContext(hso.initialUserMessage, scratchpadDir)
            if ("watchPaths" in hso) result.watchPaths = hso.watchPaths
            if ("sessionTitle" in hso) result.sessionTitle = hso.sessionTitle
            if ("reloadSkills" in hso) result.reloadSkills = hso.reloadSkills
          }
          if ((payload.event === "FileChanged" || payload.event === "CwdChanged") && hso && "watchPaths" in hso)
            result.watchPaths = hso.watchPaths
          if (payload.event === "UserPromptSubmit" && hso) {
            if ("sessionTitle" in hso) result.sessionTitle = hso.sessionTitle
            if ("suppressOriginalPrompt" in hso) result.suppressOriginalPrompt = hso.suppressOriginalPrompt
          }
          if (payload.event === "PermissionDenied" && hso && hso.retry === true) result.retry = true
          if (
            payload.event === "PreModelSwitch" &&
            hso &&
            hso.permissionDecision &&
            hso.permissionDecision !== "defer"
          ) {
            const incoming = hso.permissionDecision
            const current = result.modelSwitchDecision
            if (
              current === undefined ||
              { allow: 0, ask: 1, deny: 2 }[incoming] > { allow: 0, ask: 1, deny: 2 }[current]
            ) {
              result.modelSwitchDecision = incoming
              result.modelSwitchDecisionReason = hso.permissionDecisionReason
            }
          }
          if (payload.event === "MessageDisplay" && hso && Object.hasOwn(hso, "displayContent"))
            result.displayContent = hso.displayContent
          if (payload.event === "WorktreeCreate" && hso && "worktreePath" in hso) result.worktreePath = hso.worktreePath
        }
      }

      if (payload.event === "WorktreeCreate" && ran.size > 0) {
        if (!result.worktreePath) {
          result.blocked ??= { reason: "Worktree creation hook returned no path", command: "WorktreeCreate" }
        } else {
          const resolved = resolveWorktreeHookPath(result.worktreePath, s.cwd)
          if (resolved.error) result.blocked = { reason: resolved.error, command: "WorktreeCreate" }
          else result.worktreePath = resolved.path
        }
      }

      if (payload.event === "SessionEnd" && ctx.sessionID) {
        yield* clearEndedSession(s, ctx.sessionID)
      }
      return result
    })
    const trigger = (payload: HookPayload, ctx: TriggerContext) => {
      if (!ctx.sessionID || !["Stop", "StopFailure", "SubagentStop"].includes(payload.event))
        return triggerRun(payload, ctx).pipe(Effect.scoped)
      return Effect.suspend(() => {
        const owner = SessionCancellation.request(ctx.sessionID)
        return owner.wait.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              owner.valid()
                ? triggerRun(payload, ctx, owner)
                : Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] }),
            ),
          ),
          Effect.ensuring(Effect.sync(() => owner.release())),
          Effect.scoped,
        )
      })
    }

    const list = Effect.fn("SettingsHook.list")(function* () {
      const s = yield* InstanceState.get(state)
      // The kill switch disables every trigger; reporting the configured
      // entries would advertise hooks and background wakes that never run.
      return s.settings.disableAllHooks === true ? [] : s.hooksList
    })

    const hasEvent = Effect.fn("SettingsHook.hasEvent")(function* (event: HookEvent, sessionID?: SessionID | string) {
      const s = yield* InstanceState.get(state)
      if (s.settings.disableAllHooks === true) return false
      if ((s.settings.hooks?.[event]?.length ?? 0) > 0) return true
      return sessionID ? yield* sessionHooks.hasForEvent(SessionID.make(sessionID), event) : false
    })

    const drainAsync = Effect.fn("SettingsHook.drainAsync")(function* (sessionID: SessionID | string) {
      const s = yield* InstanceState.get(state)
      const queued = s.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
      s.asyncResults.delete(sessionID)
      return queued
    })

    const clearSession = Effect.fn("SettingsHook.clearSession")(function* (sessionID: SessionID | string) {
      const s = yield* InstanceState.get(state)
      s.asyncResults.delete(sessionID)
      s.seen.delete(sessionID)
      s.once.delete(sessionID)
      s.onceRunning.delete(sessionID)
      for (const key of s.stopRewakeChains.keys()) if (key.endsWith(`:${sessionID}`)) removeStopChain(s, key)
      for (const fiber of s.asyncFibers.get(sessionID) ?? []) yield* Fiber.interrupt(fiber)
      s.asyncFibers.delete(sessionID)
      yield* sessionHooks.clear(SessionID.make(String(sessionID)))
    })

    const fileWatchPaths = Effect.fn("SettingsHook.fileWatchPaths")(function* () {
      const s = yield* InstanceState.get(state)
      return s.settings.disableAllHooks === true ? [] : staticWatchPaths(s.settings)
    })

    const sessionEndTimeout = Effect.fn("SettingsHook.sessionEndTimeout")(function* () {
      const override = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS)
      if (Number.isFinite(override) && override > 0) return override
      const s = yield* InstanceState.get(state)
      const configured = (s.settings.hooks?.SessionEnd ?? [])
        .flatMap((group) => group.hooks)
        .map((entry) => (entry.timeout === undefined ? 1_500 : entry.timeout * 1000))
      return Math.min(60_000, Math.max(1_500, ...configured))
    })

    // Async SessionEnd commands run for side effects after the session ends. A headless client waits for the
    // configured SessionEnd budget, then cancels what remains; an instance that outlives the process keeps them.
    const settleSessionEnd = Effect.fn("SettingsHook.settleSessionEnd")(function* () {
      const s = yield* InstanceState.get(state)
      const fibers = [...s.endFibers]
      if (fibers.length === 0) return
      yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { concurrency: "unbounded" }).pipe(
        Effect.onInterrupt(() =>
          Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded" }),
        ),
        Effect.asVoid,
      )
    })

    const registerScoped = Effect.fn("SettingsHook.registerScoped")(
      (sessionID: SessionID | string, input: ScopedHooksInput) =>
        sessionHooks.registerScoped(SessionID.make(String(sessionID)), input).pipe(
          Effect.catchTag("InvalidHookError", (error) => {
            log.warn("invalid scoped hooks ignored", { kind: input.kind, origin: input.origin, error: error.message })
            return Effect.void
          }),
        ),
    )

    const unregisterScoped = Effect.fn("SettingsHook.unregisterScoped")(
      (sessionID: SessionID | string, origin: string) =>
        sessionHooks.unregisterScoped(SessionID.make(String(sessionID)), origin),
    )

    // A pending Stop/SubagentStop/StopFailure rewake chain dies with the
    // user's cancel intent. `stopRewakeChains` holds one chain object per
    // session while callbacks are in flight; identity comparison is monotonic
    // across abort/prompt cycles: after invalidation, a later Stop trigger
    // creates a new chain object, so an old token cannot match that chain.
    const invalidateStopRewakeChain = Effect.fn("SettingsHook.invalidateStopRewakeChain")(function* (
      sessionID: SessionID | string,
    ) {
      const s = yield* InstanceState.get(state)
      let deleted = false
      for (const key of s.stopRewakeChains.keys())
        if (key.endsWith(`:${sessionID}`)) deleted = removeStopChain(s, key) || deleted
      if (deleted) log.info("stop rewake chain invalidated", { sessionID })
    })

    const validateStopRewakeChain = Effect.fn("SettingsHook.validateStopRewakeChain")(function* (
      sessionID: SessionID | string,
      token: unknown,
    ) {
      const s = yield* InstanceState.get(state)
      for (const [key, chain] of s.stopRewakeChains) if (key.endsWith(`:${sessionID}`) && chain === token) return true
      return false
    })

    return Service.of({
      trigger,
      list,
      hasEvent,
      drainAsync,
      clearSession,
      fileWatchPaths,
      sessionEndTimeout,
      settleSessionEnd,
      registerScoped,
      unregisterScoped,
      invalidateStopRewakeChain,
      validateStopRewakeChain,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionHooks.defaultLayer),
    Layer.provide(HookConfigChange.defaultLayer),
    Layer.provide(HookFileWatch.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
  ),
)

// Resolve module references after initialization; provider/plugin imports can
// otherwise encounter this module while their own node exports are in the TDZ.
export const node = {
  ...LayerNode.make(layer, [SessionHooks.node]),
  get dependencies() {
    return [
      SessionHooks.node,
      HookConfigChange.node,
      HookFileWatch.node,
      MCP.node,
      Provider.node,
      Auth.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      LayerNode.make(FetchHttpClient.layer, []),
    ]
  },
}

export * as SettingsHook from "./settings"
