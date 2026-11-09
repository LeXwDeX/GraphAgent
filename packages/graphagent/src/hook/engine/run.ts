/**
 * Hook engine: entry execution, trigger pipeline, and service methods.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import { Effect, Option, Scope, Exit, Fiber } from "effect"
import * as Log from "@/util/log"
import { Global } from "@graphagent/core/global"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { SessionID } from "@/session/schema"
import { SessionCancellation } from "@/session/cancellation"
import type { SessionHooks } from "../session-hooks"
import type { SessionHookEntry } from "../session-hooks"
import type { HookConfigChange } from "../config-change"
import type { HookFileWatch } from "../file-watch"
import { HookRewake } from "../rewake"
import { watchSettings } from "../extensions/hot-reload"
import { makeRunContext } from "./context"
import { withPromptIdentity } from "../prompt-identity"
import { chainCandidates, loadChainWithSummaries } from "../config/chain"
import { buildStdinEnvelope, resolveWorktreeHookPath } from "../envelope"
import { canonicalToolName, evaluateCondition, matcherTargets } from "../match"
import { commandHandler } from "../handlers/command"
import { httpHandler } from "../handlers/http"
import { mcpToolHandler } from "../handlers/mcp-tool"
import { promptHandler } from "../handlers/prompt"
import { agentHandler } from "../handlers/agent"
import type { HookExecution, HookHandler } from "../handlers/shared"
import type {
  HookCommand,
  HookEvent,
  HookJSONOutput,
  HookMatcher,
  HookPayload,
  ToolHookContext,
  TriggerContext,
} from "../types"
import type { TriggerResult } from "../trigger-result"
import { applyResult, PER_TRIGGER_DEDUP_EVENTS } from "./reduce"
import { addSeen, removeStopChain, staticWatchPaths } from "./state"
import type { State, StopRewakeChain } from "./state"
import { entryEligible, compileGroup, groupMatches, handlerKey } from "./plan"
import { HookIndexByEvent } from "../index-by-event"
import type { CompiledMatcher } from "../match"
import { onAsyncComplete, sanitizeHookContext } from "./async"
import { commandText } from "../exec/command"
import { isAsync } from "../types"
import { makeEntryRunner } from "./entry"
import { makeServiceMethods } from "./methods"
import { runMonitored } from "./monitor"
import type { Interface } from "../service"

const log = Log.create({ service: "hook.settings" })

/**
 * D1 PR3 test hook: observes the time one trigger spends preparing — matcher
 * selection, lazy context resolution, and envelope construction — before any
 * handler starts. Undefined in production; tests install a callback and reset
 * it in a finalizer. Not part of the hook's public API.
 */
export const prepareObserver: { current?: (event: HookEvent, durationMs: number) => void } = {}

export interface EngineDeps {
  sessionHooks: SessionHooks.Interface
  configChange?: HookConfigChange.Interface
  fileWatch?: HookFileWatch.Interface
}

export const makeEngine: (deps: EngineDeps) => Effect.Effect<Interface, never, Scope.Scope> = Effect.fnUntraced(
  function* (deps: EngineDeps) {
    const { sessionHooks, configChange, fileWatch } = deps

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
          runningHooks: new Map(),
          endFibers: new Set<Fiber.Fiber<unknown, unknown>>(),
        } satisfies State

        // Async commands are started from the service's background scope, but
        // their ownership is the directory instance. Dispose must interrupt
        // every command before the instance disappears.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [
              ...[...stateObj.asyncFibers.values()].flatMap((fibers) => [...fibers]),
              ...[...stateObj.runningHooks.values()].flatMap((running) => [...running.fibers]),
              ...stateObj.endFibers,
            ],
            (fiber) => Fiber.interrupt(fiber),
            { discard: true },
          ),
        )

        // Hot-reload hooks.json at runtime. A changed file produces a
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
              { sessionID: "" },
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
      mcp_tool: mcpToolHandler,
      http: httpHandler,
      prompt: promptHandler,
      agent: agentHandler,
    }

    const runEntry = yield* makeEntryRunner(state, handlers)

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

    const triggerRun = Effect.fn("SettingsHook.trigger")(function* (
      payload: HookPayload,
      ctx: TriggerContext,
      owner?: ReturnType<typeof SessionCancellation.request>,
    ) {
      using _ = log.time("trigger", { event: payload.event, sessionID: ctx.sessionID })
      const prepareStart = performance.now()
      const observePrepare = () => prepareObserver.current?.(payload.event, performance.now() - prepareStart)
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
        observePrepare()
        return result
      }
      const fileGroups = HookIndexByEvent.groups(HookIndexByEvent.of(s.settings), payload.event)
      const hasFile = fileGroups.length > 0
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
        observePrepare()
        return result
      }

      // Tag matchers with their origin so once-cleanup can remove session ones
      // after execution. The settings chain matchers carry no _sessionEntry.
      type RunMatcher = HookMatcher & { _sessionEntry?: SessionHookEntry; _sessionOwner?: string }
      // Matcher predicates are compiled once per settings snapshot (file groups)
      // or once per distinct (matcher, event) pair (session groups).
      const tests = new Map<RunMatcher, CompiledMatcher>()
      const sessionGroup = (entry: SessionHookEntry, owner: string | undefined): RunMatcher => {
        const group: RunMatcher = {
          matcher: entry.matcher,
          hooks: entry.hooks,
          _sessionEntry: entry,
          _sessionOwner: owner,
        }
        tests.set(group, compileGroup(group, payload.event))
        return group
      }

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

      const matchers: RunMatcher[] = [
        ...fileGroups.map(({ group, test }) => {
          tests.set(group, test)
          return group
        }),
        ...sessionEntries.map((entry) => sessionGroup(entry, ctx.sessionID)),
        ...childAgentEntries.map((entry) =>
          sessionGroup(entry, payload.event === "SubagentStop" ? payload.agentID : undefined),
        ),
      ]
      if (!matchers.length) {
        log.info("trigger short-circuit", { event: payload.event, reason: "empty_matchers" })
        if (payload.event === "SessionEnd" && ctx.sessionID) {
          yield* clearEndedSession(s, ctx.sessionID)
        }
        observePrepare()
        return result
      }

      const targets = matcherTargets(payload, ctx)
      // Planning only reads matcher-visible fields (tool_name/tool_input/cwd). The
      // full stdin envelope — transcript, identity, permission mode, scratchpad —
      // is built after planning, only when a handler is known to run, so a trigger
      // that matches nothing materializes nothing.
      const planEnvelope = buildStdinEnvelope(payload, ctx, s.cwd)
      // Identical handlers matched by several groups/layers run once per trigger.
      const ran = new Set<string>()

      // Match and claim once before starting any handlers. Foreground handlers
      // then start concurrently; their results are reduced below in settings
      // order so conflicting decisions remain deterministic.
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
      type PlannedEntry = { group: RunMatcher; entry: HookCommand; origin?: string; key: string }
      const plannedEntries: PlannedEntry[] = []
      const plannedKeys = new Set<string>()
      for (const group of matchers) {
        const test = tests.get(group)
        if (!test || !groupMatches(test, targets)) continue
        let claimed = false
        for (const entry of group.hooks) {
          if (!entryEligible(payload, entry)) continue
          if (
            !evaluateCondition(entry, planEnvelope, payload.event, {
              canonicalToolName: canonicalToolName(payload, ctx),
            })
          )
            continue
          const key = handlerKey(entry, group._sessionEntry?.origin)
          if (plannedKeys.has(key)) continue
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
          plannedKeys.add(key)
          plannedEntries.push({ group, entry, origin: group._sessionEntry?.origin, key })
        }
      }

      if (!plannedEntries.length) {
        log.info("trigger short-circuit", { event: payload.event, reason: "no_runnable_entries" })
        if (payload.event === "SessionEnd" && ctx.sessionID) yield* clearEndedSession(s, ctx.sessionID)
        observePrepare()
        return result
      }

      // At least one handler will run. Resolve the lazy per-trigger context and
      // build the full envelope; each provider below is evaluated at most once.
      const runContext = yield* makeRunContext(payload, ctx, s.cwd)
      const resolved = yield* Effect.all({
        transcript: ctx.transcript
          ? ctx.transcript()
          : ctx.sessionID
            ? runContext.transcript()
            : Effect.succeed<string | undefined>(undefined),
        identity: runContext.promptIdentity(),
        permissionMode: runContext.permissionMode(),
        // CC's `scratchpad_dir`: created only now, so sessions that never run a
        // hook leave no directory behind. A failed mkdir makes the field absent.
        scratchpadDir: runContext.scratchpad(),
        agentTranscript: runContext.agentTranscript(),
      })
      const scratchpadDir = resolved.scratchpadDir
      // CC's prompt-scoped fields: an explicit caller value wins over the
      // transcript-derived guess (see withPromptIdentity).
      const envelopeContext = {
        ...withPromptIdentity(ctx, resolved.identity),
        ...(resolved.transcript !== undefined ? { transcriptPath: resolved.transcript } : {}),
        ...(resolved.permissionMode !== undefined ? { permissionMode: resolved.permissionMode } : {}),
        ...(scratchpadDir !== undefined ? { scratchpadDir } : {}),
      }
      const envelopePayload =
        payload.event === "SubagentStop" &&
        payload.agentTranscriptPath === undefined &&
        resolved.agentTranscript !== undefined
          ? { ...payload, agentTranscriptPath: resolved.agentTranscript }
          : payload
      const envelope = buildStdinEnvelope(envelopePayload, envelopeContext, s.cwd)
      // Planning and preparation end here; handlers start below.
      observePrepare()
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
      const runWithStatus = (entry: HookCommand, origin: string | undefined, monitored: boolean) =>
        Effect.gen(function* () {
          // Only a command handler consumes the sourced environment; every other
          // handler type skips the shell round-trip entirely.
          let shell: { environmentFile?: string; environment?: Record<string, string | undefined> } | undefined
          if (entry.type === "command")
            shell = {
              environmentFile: yield* runContext.environmentFile().pipe(Effect.orDie),
              environment: yield* runContext.environment().pipe(Effect.orDie),
            }
          const execute = runEntry(
            entry,
            envelope,
            s.cwd,
            false,
            shell?.environmentFile,
            shell?.environment,
            ctx.canonicalToolName,
            s.root,
            ctx.effort,
            payload.event === "PostToolUse" ? payload.toolOutput : undefined,
          )
          if (!monitored) return yield* execute
          const input = { state: s, sessionID: ctx.sessionID, event: payload.event, entry, origin, execute }
          return yield* runMonitored(input)
        })

      const foreground: Array<{ planned: PlannedEntry; fiber: Fiber.Fiber<HookExecution> }> = []
      for (const planned of plannedEntries) {
        const { group, entry, key } = planned
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
          const background = runWithStatus(entry, group._sessionEntry?.origin, false).pipe(
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
        // Foreground handlers all start together after planning; they are joined
        // below in settings order so conflicting decisions stay deterministic.
        foreground.push({ planned, fiber: yield* runWithStatus(entry, planned.origin, true).pipe(Effect.forkChild) })
      }

      for (const { planned, fiber } of foreground) {
        const { group, entry, key } = planned

        // "Never crash host" contract: a hook handler can throw an unrecoverable
        // defect (null deref, OOM, native assert). Effect.catch at the tool-layer
        // call sites only catches typed Failures, so a defect would propagate and
        // kill the session. Catch defects here at the single entry-execution point
        // (covers all handler types: command/mcp_tool/http/prompt/agent) → silent allow,
        // log, and continue to the next entry.
        const { json, exitBlock, rawStdout, exitCode, succeeded, failureMessage } = yield* Fiber.join(fiber).pipe(
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
          yield* settleGroup(`${group._sessionOwner}:${group._sessionEntry.id}`, key, succeeded === true && !exitBlock)
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

        yield* applyResult({
          payload,
          ctx,
          scratchpadDir,
          result,
          addContext,
          entry,
          json,
          exitBlock,
          rawStdout,
          exitCode,
          succeeded,
        })
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

    // Narrow tool-hook entry: same single trigger pipeline, but callers only name
    // the session and the real tool/MCP identity. The engine derives everything
    // else lazily (so a tool call with no matching hook materializes nothing).
    const hookCall = (payload: HookPayload, ctx: ToolHookContext) => trigger(payload, ctx)

    const methods = makeServiceMethods(state, sessionHooks)

    return { trigger, hookCall, ...methods } satisfies Interface
  },
)
