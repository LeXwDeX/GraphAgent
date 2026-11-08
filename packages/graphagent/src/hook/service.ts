/**
 * SettingsHook Effect service: public interface, layer wiring, and node metadata.
 *
 * Split from the former monolithic the former monolithic settings module (D1 PR1); behavior is unchanged.
 */
import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { FetchHttpClient } from "effect/http"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { SessionID } from "@/session/schema"
import { SessionHooks, type ScopedHooksInput } from "./session-hooks"
import { HookConfigChange } from "./config-change"
import { HookFileWatch } from "./file-watch"
import type { HookEvent, HookPayload, HookSummary, ToolHookContext, TriggerContext } from "./types"
import type { TriggerResult } from "./trigger-result"
import { makeEngine } from "./engine/run"

// ── Effect service ──────────────────────────────────────────────

export interface Interface {
  readonly trigger: (payload: HookPayload, ctx: TriggerContext) => Effect.Effect<TriggerResult>
  /**
   * Narrow entry for tool-lifecycle hooks. Callers provide only the real
   * session and tool/MCP identity; the engine fills the transcript,
   * environment, prompt identity and permission mode lazily through the single
   * trigger pipeline. Optional so partial test mocks stay valid; when absent,
   * callers fall back to `trigger` with the same narrow context.
   */
  readonly hookCall?: (payload: HookPayload, ctx: ToolHookContext) => Effect.Effect<TriggerResult>
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessionHooks = yield* SessionHooks.Service
    // Optional: only a full runtime has sessions that can veto a reload and watchers to refresh.
    const configChange = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
    const fileWatch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
    return Service.of(yield* makeEngine({ sessionHooks, configChange, fileWatch }))
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
