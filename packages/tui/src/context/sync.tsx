import type { PromptInfo } from "../prompt/history"
import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  Goal,
  DagWorkflowSummary,
  SessionDagMode,
  SessionOverhead,
  SessionUsage,
  PrWatchEntry,
  SessionReminder,
  ReferenceInfo,
  ProjectTrustEntry,
  ProjectTrustDecision,
  Event as SdkEvent,
  LifecycleStateEntry,
  LifecycleStateRef,
} from "@graphagent/sdk"

export type { DagWorkflowSummary }
import { createStore, produce, reconcile } from "solid-js/store"
import { DagMerge } from "@graphagent/core/dag/merge"
import { dagFinite, dagNodeRow } from "../dag/model"
import { createEventGate } from "./event-gate"
import { createInterestAggregator } from "./interest"
import {
  entryFromState,
  entryFromTransition,
  goalStatus,
  isPullableDomain,
  lifecycleKey,
  overflowKeys,
  type LifecycleMirrorEntry,
  type LifecycleTransition,
} from "./lifecycle-mirror"
import { createStreamBuffer } from "./stream-buffer"
import { importedEntryIds, snapshotTrust, type TrustSnapshot } from "./trust-import"
import {
  backgroundResultOf,
  createSummary,
  HYDRATED_MAX,
  mergeSession,
  mergeSnapshot,
  mergeStatus,
  mergeToolPart,
  summarizeMessages,
  taskIndexEntry,
  type BackgroundResult,
  type SessionSummary,
  type TaskIndexEntry,
  type ToolPartLike,
} from "./session-summary"
import { initLanguage } from "../i18n"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK, locationHeaders } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { TuiLog } from "../util/log"
import { isRoot } from "../session/role"

type SdkEventOf<T extends SdkEvent["type"]> = Extract<SdkEvent, { type: T }>["properties"]

/** How a session's latest turn ended (`session.turn.settled`). */
export type TurnOutcomeType = SdkEventOf<"session.turn.settled">["outcome"]["type"]

/** The latest turn a session settled; later turns replace it. */
export interface SettledTurn {
  turnID: string
  outcome: TurnOutcomeType
  /** Epoch milliseconds. */
  timeEnded: number
}

/** A workflow a display surface shows, and the session that owns it. */
export interface DagWatch {
  workflowID: string
  sessionID: string
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function before(a: { id: string; time: { created: number } }, b: { id: string; time: { created: number } }) {
  if (a.time.created !== b.time.created) return a.time.created < b.time.created
  return a.id < b.id
}

function searchMessages(messages: Message[], target: Message) {
  let left = 0
  let right = messages.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = messages[middle]
    if (before(value, target)) left = middle + 1
    else if (before(target, value)) right = middle - 1
    else return { found: true, index: middle }
  }
  return { found: false, index: left }
}

/**
 * Messages requested per session snapshot. A reply shorter than this holds the
 * session's whole history; a full one may be cut, so recounts built from it
 * are lower bounds (#886 5.4).
 */
const MESSAGE_WINDOW = 100

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      failed_submission: { [sessionID: string]: PromptInfo | undefined }
      submission_attempt: { [sessionID: string]: string | undefined }
      pending_submission: { [sessionID: string]: string | undefined }
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_load_errors: { [sessionID: string]: string[] }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      goal: {
        [sessionID: string]: Goal | undefined
      }
      /**
       * The PR/MR watches of a session tree (#1036 F6), per root session (the one that registered them) and then per
       * watch. `pr.watch.updated` upserts one entry; the read (`GET /session/:id/pr-watch`: the live watches and the ones
       * that ended within the last 10 minutes) replaces the root's whole map, when the tree is first entered and on
       * reconnect, since the event is not durable. An event never removes an entry: an ended watch stays until a read
       * no longer returns it. The store does not say whether a change came from an event or from a read; what must
       * react to events only (a toast) listens to the event.
       */
      pr_watch: {
        [rootSessionID: string]: { [watchID: string]: PrWatchEntry }
      }
      /**
       * The reminders of a session that can still fire or are owed, soonest first (`GET /session/:id/reminder`). No
       * event carries them: a `lifecycle.transitioned` of the `reminder` domain reads the session's list again, and
       * so do the first entry into its tree and a reconnect.
       */
      reminder: {
        [sessionID: string]: SessionReminder[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      dag: {
        [sessionID: string]: DagWorkflowSummary[]
      }
      /**
       * Node tables of the workflows a display surface shows (#1032 F4), one
       * merge feed each; see `dag.watch`. Rows carry no `output`.
       */
      dagNodes: {
        [workflowID: string]: DagMerge.Feed
      }
      /**
       * The DAG mode snapshot of the root session of the tree the route is in (`GET /session/:id/dag-mode`): the
       * effective budget and its warning ratio, and the process's limits (#1032 7). Read when the tree is entered
       * with DAG mode on or a workflow in it (or becomes so), and again when the session's budget changes, the
       * global `dag` configuration changes (`config.updated`) or the stream reconnects; the usage between reads
       * comes from the workflow summaries, and the mode itself from the session, so nothing polls. A session that
       * has neither never reads it.
       */
      dagMode: {
        [rootSessionID: string]: SessionDagMode
      }
      /**
       * What a whole task tree has used (`GET /session/:id/usage`, #1475): the tokens by kind and the cost summed over
       * the root, its sub-agents and its DAG nodes, held per root session. Display only. A root is read only while
       * something on screen watches it (`usage.watch`: the drawer while it is open), and then again on three
       * triggers: the watch itself, a settled turn anywhere in the tree (`session.turn.settled`, the moment a
       * session's usage is last written) and a reconnect. Nothing polls, and a root nobody watches costs no read.
       */
      usage: {
        [rootSessionID: string]: SessionUsage
      }
      /**
       * What the latest request of a session carried besides its messages, by source (`GET /session/:id/overhead`,
       * #1461): the fixed overhead, held per session, the sub-agent on screen included. Display only. A session is
       * read only while something on screen watches it (`overhead.watch`: the drawer while it is open), and then
       * again on three triggers: the watch itself, the session's own `session.turn.settled` (its requests are
       * recorded as the turn runs) and a reconnect. Nothing polls, and a session nobody watches costs no read.
       */
      overhead: {
        [sessionID: string]: SessionOverhead
      }
      /**
       * The DAG slots running in the whole server process, as the latest report of any source says: a workflow
       * summary that carries `concurrencyRunning` (event or read), or a mode snapshot's `limits.running`, whichever
       * arrived last. The count belongs to the process, but a summary event carries it only for the session it is
       * about, so the figures of the session shown go stale while another session's workflows move the slots; the
       * status band and the `/dag` panel's mode line read this one instead. Undefined until a source has said. It has
       * no read of its own: the summary and snapshot reads refresh it, and a reconnect runs those again.
       */
      dagRunning?: number
      /**
       * What the user did in the `/dag` panel, per session tree (keyed by its root session): the workflow
       * they picked and the ones they opened. Memory only, never sent or persisted, so a reconnect has
       * nothing to refresh; the status band follows it (#1032 2.5).
       */
      dag_focus: {
        [rootSessionID: string]: { chosen?: string; acknowledged: string[] }
      }
      /** The latest settled turn per session; a reconnect clears it, since nothing can read it back. */
      turn_settled: {
        [sessionID: string]: SettledTurn
      }
      summary: {
        [sessionID: string]: SessionSummary
      }
      /** LRU order, most recently hydrated first. */
      hydrated: string[]
      taskIndex: {
        [childSessionID: string]: TaskIndexEntry
      }
      /** Cross-domain lifecycle mirror keyed `domain:id` (#1069). */
      lifecycle: {
        [key: string]: LifecycleMirrorEntry
      }
      reference: ReferenceInfo[]
      /** Project-layer executable entries and their trust state (#1040). */
      trust: ProjectTrustEntry[]
      /** Whether the trust snapshot has loaded once; gates the first-open panel. */
      trust_loaded: boolean
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      failed_submission: {},
      submission_attempt: {},
      pending_submission: {},
      session_status: {},
      session_load_errors: {},
      session_diff: {},
      todo: {},
      goal: {},
      pr_watch: {},
      reminder: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      dag: {},
      dagNodes: {},
      dagMode: {},
      usage: {},
      overhead: {},
      dagRunning: undefined,
      dag_focus: {},
      turn_settled: {},
      summary: {},
      hydrated: [],
      taskIndex: {},
      lifecycle: {},
      reference: [],
      trust: [],
      trust_loaded: false,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const stream = createStreamBuffer()
    const pendingAskSessions = () => {
      const pending = new Set<string>()
      for (const [sessionID, requests] of Object.entries(store.permission)) {
        if (requests.length > 0) pending.add(sessionID)
      }
      for (const [sessionID, requests] of Object.entries(store.question)) {
        if (requests.length > 0) pending.add(sessionID)
      }
      return pending
    }
    // The gate calls this once per event; the memo keeps it off the proxy read
    // path until a permission or question actually changes (#1025 P14).
    const pendingAskSet = createMemo(pendingAskSessions)
    const interest = createInterestAggregator({
      submit: (full) => sdk.setInterest(full),
      pendingAsks: () => pendingAskSet(),
      frame: sdk.frameClock,
    })
    sdk.setEventGate(createEventGate(() => interest.full()))
    const unsubscribeStream = sdk.frameClock.onFlush(() => stream.bump())
    const resyncHandlers = new Set<() => void | Promise<void>>()
    const summarySeen = new Map<string, Set<string>>()
    // Mirror of `store.summary` in plain objects. The reducer reads it instead
    // of the Solid proxy: a summary event costs a handful of proxy reads plus
    // a write, and with many background sessions that dominates the frame
    // (#1025 P14). Store writes below stay the only notification source.
    const summaryRaw = new Map<string, SessionSummary>()
    // Hydrated sessions must keep receiving full events; like the route chain,
    // this is an interest source of its own.
    const syncInterest = () => {
      void interest.set("hydrated", [...store.hydrated]).catch(() => {})
    }
    /** Full message/part state is only kept for hydrated or hydrating sessions. */
    const storesMessages = (sessionID: string) => hydratingSessions.has(sessionID) || store.hydrated.includes(sessionID)

    let disposed = false
    let bootstrapAttempt = 0
    // #1032 F4: the node tables of the workflows a display surface shows.
    // `dagFeeds` holds the authoritative merge feed per workflow; `store.dagNodes`
    // mirrors it for readers. Every change replaces a whole entry, so the store
    // never mutates an object the feed still shares with it.
    const dagFeeds = new Map<string, DagMerge.Feed>()
    // Surface -> (workflow -> owning session): what each surface shows.
    const dagWatches = new Map<string, Map<string, string>>()
    // The table read in flight per workflow. A newer read replaces it, and an
    // answer that no longer matches is dropped.
    const dagReads = new Map<string, symbol>()
    // The mode snapshot read in flight per session. A newer read replaces it and the older answer is dropped; a
    // read that is still out also stands in for another one that only wants the snapshot to exist.
    const dagModeReads = new Map<string, symbol>()
    // #1475: the usage read in flight per root session (a newer read cannot start while one is out), the roots that
    // were triggered again while their read was out and so are read once more when it ends, and how many surfaces
    // watch each root. Only a watched root is read.
    const usageReads = new Map<string, symbol>()
    const usageDirty = new Set<string>()
    const usageWatchers = new Map<string, number>()
    // #1461: the same three for the fixed overhead, held per session and not per root.
    const overheadReads = new Map<string, symbol>()
    const overheadDirty = new Set<string>()
    const overheadWatchers = new Map<string, number>()
    // #1036 F6: the PR watch read in flight per root session. A newer read replaces it and the older answer is
    // dropped. `touched` names the watches that events updated since the read began: they are newer than the answer.
    const prWatchReads = new Map<string, { touched: Set<string> }>()
    // The roots whose PR watches a read answered. An event that reaches a root first creates its map with that one
    // watch, so holding a map does not mean the snapshot was read: the first entry still has to read it.
    const prWatchLoaded = new Set<string>()
    // The reminder read in flight per session; a newer read replaces it and the older answer is dropped.
    const reminderReads = new Map<string, symbol>()
    // The session set last handed to the aggregator and its confirmation: a
    // second surface showing the same workflow must wait for the same answer
    // before it reads, or it would read ahead of the worker.
    let dagInterestKey = ""
    let dagInterestSettled: Promise<void> = Promise.resolve()
    const submissionAccepted = new Map<string, () => void>()
    const ancillaryAttempts = new Map<string, object>()
    const ancillaryRevision = new Map<string, number>()
    const changedAncillary = (sessionID: string, kind: string) => {
      const key = `${sessionID}:${kind}`
      ancillaryRevision.set(key, (ancillaryRevision.get(key) ?? 0) + 1)
      setStore("session_load_errors", sessionID, (errors = []) => errors.filter((item) => item !== kind))
    }
    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string>; session: boolean }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function getSession(sessionID: string) {
      const match = search(store.session, sessionID, (s) => s.id)
      return match.found ? store.session[match.index] : undefined
    }

    function seenTools(sessionID: string) {
      let seen = summarySeen.get(sessionID)
      if (!seen) {
        seen = new Set()
        summarySeen.set(sessionID, seen)
      }
      return seen
    }

    function writeSummary(sessionID: string, summary: SessionSummary) {
      // Every reducer below returns a complete summary, so a plain replacement
      // is equivalent to `reconcile` without its deep diff. Background tool
      // traffic pays this per event per frame (#1025 P14). Activity-only churn
      // is coalesced below one second: the compact view shows relative times,
      // and rewriting the node per streamed event is pure frame cost.
      const previous = summaryRaw.get(sessionID)
      if (
        previous &&
        previous.status === summary.status &&
        previous.toolCalls === summary.toolCalls &&
        previous.current === summary.current &&
        previous.error === summary.error &&
        summary.lastActivityAt - previous.lastActivityAt < 1_000
      ) {
        return
      }
      summaryRaw.set(sessionID, summary)
      setStore("summary", sessionID, summary)
    }

    function reduceSummary(event: SdkEvent) {
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties.info
          writeSummary(info.id, mergeSession(summaryRaw.get(info.id), info))
          break
        }
        case "session.status": {
          const { sessionID, status } = event.properties
          writeSummary(sessionID, mergeStatus(summaryRaw.get(sessionID), sessionID, status, Date.now()))
          break
        }
        case "session.idle": {
          const sessionID = event.properties.sessionID
          writeSummary(sessionID, mergeStatus(summaryRaw.get(sessionID), sessionID, { type: "idle" }, Date.now()))
          break
        }
        case "session.error": {
          const sessionID = event.properties.sessionID
          if (!sessionID) break
          const error = event.properties.error
          const data: unknown = error?.data
          const message =
            typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
              ? data.message
              : error?.name
          const previous = summaryRaw.get(sessionID) ?? {
            id: sessionID,
            status: "unknown" as const,
            lastActivityAt: 0,
          }
          writeSummary(sessionID, {
            ...previous,
            status: "idle",
            error: message,
            lastActivityAt: Date.now(),
          })
          break
        }
        case "message.part.updated": {
          const part = event.properties.part
          if (part.type !== "tool") break
          const at = typeof event.properties.time === "number" ? event.properties.time : undefined
          writeSummary(
            part.sessionID,
            mergeToolPart(summaryRaw.get(part.sessionID), part as ToolPartLike, seenTools(part.sessionID), at),
          )
          const task = taskIndexEntry(part as ToolPartLike)
          if (task && writeTaskLink(task.childSessionID, task.entry)) wantJob(task.childSessionID)
          break
        }
      }
    }

    function parentChain(sessionID: string): string[] {
      const chain: string[] = []
      const seen = new Set<string>()
      let current: string | undefined = sessionID
      while (current && !seen.has(current)) {
        chain.push(current)
        seen.add(current)
        current = getSession(current)?.parentID
      }
      return chain
    }

    /** The root of the tree `sessionID` is in: the last of its parent chain, the session itself when it has no parent. */
    function rootOf(sessionID: string) {
      return parentChain(sessionID).at(-1) ?? sessionID
    }

    function touchHydrated(sessionID: string) {
      setStore("hydrated", (current = []) => {
        const next = current.filter((id) => id !== sessionID)
        next.unshift(sessionID)
        return next
      })
      syncInterest()
    }

    /** Navigation parent chain keeps its sessions inside the LRU limit. */
    let routeChain: string[] = []

    function evictHydrated() {
      const limit = Math.max(HYDRATED_MAX, routeChain.length + 1)
      // The `hydrated` interest source mirrors the LRU itself; protecting it
      // would exempt every candidate. Only the route chain and pending asks
      // need their messages outside the cache.
      const protectedSessions = new Set<string>(routeChain)
      for (const sessionID of pendingAskSessions()) protectedSessions.add(sessionID)
      // Protected sessions occupy their slots first, wherever they sit in the
      // LRU order; only the remaining budget goes to the most recent others.
      // Pending asks may still push the total past the limit: their messages
      // are needed regardless.
      const protectedCount = store.hydrated.filter((sessionID) => protectedSessions.has(sessionID)).length
      let budget = limit - protectedCount
      const keep: string[] = []
      const drop: string[] = []
      for (const sessionID of store.hydrated) {
        if (protectedSessions.has(sessionID)) keep.push(sessionID)
        else if (budget > 0) {
          keep.push(sessionID)
          budget--
        } else drop.push(sessionID)
      }
      if (drop.length === 0) return
      const removedParts: string[] = []
      setStore(
        produce((draft) => {
          for (const sessionID of drop) {
            for (const message of draft.message[sessionID] ?? []) {
              removedParts.push(...(draft.part[message.id] ?? []).map((part) => part.id))
              delete draft.part[message.id]
            }
            delete draft.message[sessionID]
          }
        }),
      )
      stream.clearParts(removedParts)
      for (const sessionID of drop) {
        fullSyncedSessions.delete(sessionID)
        syncingSessions.delete(sessionID)
        hydratingSessions.delete(sessionID)
        ancillaryAttempts.delete(sessionID)
      }
      setStore("hydrated", keep)
      syncInterest()
    }

    function dropSession(sessionID: string) {
      dropDagOwner(sessionID)
      dagModeReads.delete(sessionID)
      usageReads.delete(sessionID)
      usageDirty.delete(sessionID)
      usageWatchers.delete(sessionID)
      overheadReads.delete(sessionID)
      overheadDirty.delete(sessionID)
      overheadWatchers.delete(sessionID)
      // A read still out must not bring the session's entries back.
      prWatchReads.delete(sessionID)
      prWatchLoaded.delete(sessionID)
      reminderReads.delete(sessionID)
      const messages = store.message[sessionID] ?? []
      const partIDs = messages.flatMap((message) => (store.part[message.id] ?? []).map((part) => part.id))
      stream.clearParts(partIDs)
      summarySeen.delete(sessionID)
      summaryRaw.delete(sessionID)
      ancillaryAttempts.delete(sessionID)
      fullSyncedSessions.delete(sessionID)
      syncingSessions.delete(sessionID)
      hydratingSessions.delete(sessionID)
      dropLifecycle([...lifecycleRaw].filter(([, entry]) => entry.sessionID === sessionID).map(([key]) => key))
      setStore(
        produce((draft) => {
          for (const message of draft.message[sessionID] ?? []) delete draft.part[message.id]
          delete draft.message[sessionID]
          delete draft.summary[sessionID]
          delete draft.permission[sessionID]
          delete draft.question[sessionID]
          delete draft.todo[sessionID]
          delete draft.goal[sessionID]
          delete draft.pr_watch[sessionID]
          delete draft.reminder[sessionID]
          delete draft.session_diff[sessionID]
          delete draft.dag[sessionID]
          delete draft.dagMode[sessionID]
          delete draft.usage[sessionID]
          delete draft.overhead[sessionID]
          delete draft.dag_focus[sessionID]
          delete draft.turn_settled[sessionID]
          delete draft.session_status[sessionID]
          delete draft.session_load_errors[sessionID]
          for (const [childID, entry] of Object.entries(draft.taskIndex)) {
            if (childID === sessionID || entry.parentSessionID === sessionID) delete draft.taskIndex[childID]
          }
        }),
      )
      setStore("hydrated", (current = []) => current.filter((id) => id !== sessionID))
      syncInterest()
    }

    function seedSummaries(sessions: Session[]) {
      const next = new Map<string, SessionSummary>()
      for (const session of sessions) {
        const status = store.session_status[session.id]
        const previous = summaryRaw.get(session.id)
        next.set(session.id, status ? createSummary(session, status, previous) : mergeSession(previous, session))
      }
      for (const [id, summary] of next) summaryRaw.set(id, summary)
      setStore(
        "summary",
        produce((draft) => {
          for (const [id, summary] of next) draft[id] = summary
        }),
      )
    }

    /**
     * Writes the link a Task part made. The part does not know how a background run ended, so the result the link
     * already holds stays with it, unless the part started after that result ended (a resumed task's new run). Returns
     * whether the link is a background one with no result: the state of its run is then asked for (`wantJob`).
     */
    function writeTaskLink(childSessionID: string, entry: TaskIndexEntry): boolean {
      const held = store.taskIndex[childSessionID]
      // A resumed task (`task_id`) starts a new run after the held result ended: that result belongs to the old run.
      const result =
        held?.result && !(entry.startedAt !== undefined && entry.startedAt > held.result.endedAt)
          ? held.result
          : undefined
      setStore("taskIndex", childSessionID, reconcile(result ? { ...entry, result } : entry))
      return entry.background === true && result === undefined
    }

    /**
     * A finished background run is reported in a message the server adds to the parent session, not on its Task part:
     * the result joins the link of the child it names. A child whose Task part was not seen yet gets a minimal link, so
     * the result is not lost; the part's own write fills the rest and keeps the result. A result that ended earlier
     * than the one held, or before the linked run started (a resumed task), does not replace it.
     */
    function writeBackgroundResult(parentSessionID: string, childSessionID: string, result: BackgroundResult) {
      const held = store.taskIndex[childSessionID]
      if (held?.result && held.result.endedAt > result.endedAt) return
      // A result that ended before the linked run started belongs to an earlier run of a resumed task.
      if (held?.startedAt !== undefined && held.startedAt > result.endedAt) return
      if (held) {
        setStore("taskIndex", childSessionID, "result", reconcile(result))
        return
      }
      setStore(
        "taskIndex",
        childSessionID,
        reconcile({
          parentSessionID,
          parentMessageID: result.messageID,
          partID: result.partID,
          description: result.title,
          background: true,
          initiator: result.initiator,
          command: result.command,
          result,
        }),
      )
    }

    /** A text part that reports a finished background run joins the link of the child it names. */
    function noteBackgroundResult(part: Part) {
      if (part.type !== "text") return
      const found = backgroundResultOf(part)
      if (found) writeBackgroundResult(part.sessionID, found.childSessionID, found.result)
    }

    /**
     * #886 5.4: recount a hydrated session from its loaded messages and relink
     * its Task parts and the results of its finished background runs. Hydration
     * and reconnect are the moments the event reducer cannot be trusted alone:
     * it never saw the history of a cold session, and it missed whatever
     * happened while disconnected. The seen set restarts from the snapshot so
     * later live updates of the same tool parts are not counted twice.
     */
    function rebuildSummary(sessionID: string, complete: boolean) {
      const snapshot = summarizeMessages(
        (store.message[sessionID] ?? []).map((message) => ({ parts: store.part[message.id] ?? [] })),
      )
      batch(() => {
        writeSummary(sessionID, mergeSnapshot(summaryRaw.get(sessionID), sessionID, snapshot, complete))
        for (const task of snapshot.tasks) writeTaskLink(task.childSessionID, task.entry)
        // After the links: a result for a child whose Task part is outside the window gets a minimal link.
        for (const found of snapshot.results) writeBackgroundResult(sessionID, found.childSessionID, found.result)
        // A cold history names runs whose state no event reported: ask their jobs (one read for all of them).
        for (const task of snapshot.tasks) wantJob(task.childSessionID)
      })
      pullLifecycle()
      // A cut window knows only the newest tool parts; the ones the events
      // already counted stay in the set so their updates are not counted again.
      summarySeen.set(
        sessionID,
        complete ? snapshot.toolPartIDs : new Set([...seenTools(sessionID), ...snapshot.toolPartIDs]),
      )
    }

    // #1069: mirror of the shared lifecycle contract. `lifecycle.transitioned`
    // is transient, so the event only seeds an entry and queues its ref; the
    // owner is then asked about every queued ref in one `POST /lifecycle/states`
    // per frame, and a reconnect asks about everything the mirror holds.
    const lifecycleRaw = new Map<string, LifecycleMirrorEntry>()
    const lifecycleQueued = new Map<string, LifecycleStateRef>()
    // Stamp of the latest transition per ref. An answer is applied only if the
    // stamp it was asked under is still current: a newer transition beats an
    // older read, and has queued its own.
    const lifecycleStamp = new Map<string, number>()
    let lifecycleClock = 0
    let lifecycleInFlight = false
    // Bumped by a reconnect: a read that was out before it may never return and
    // must neither block the refill nor be applied after it.
    let lifecycleEpoch = 0

    function dropLifecycle(keys: readonly string[]) {
      const removed: string[] = []
      for (const key of keys) {
        if (lifecycleRaw.delete(key)) removed.push(key)
        lifecycleStamp.delete(key)
        lifecycleQueued.delete(key)
      }
      if (removed.length === 0) return
      setStore(
        produce((draft) => {
          for (const key of removed) delete draft.lifecycle[key]
        }),
      )
    }

    function writeLifecycle(entry: LifecycleMirrorEntry) {
      const key = lifecycleKey(entry)
      lifecycleRaw.set(key, entry)
      setStore("lifecycle", key, reconcile(entry))
      dropLifecycle(overflowKeys(lifecycleRaw))
    }

    /**
     * The goal slice follows the lifecycle status of its session. The contract
     * carries the status only: the goal itself (text, turns, limits, subgoals)
     * comes from `goal.updated` and from the full reads of `sync` and
     * `refreshGoals`, and so does clearing it. Nothing here moves the goal
     * revision, so a status hint never invalidates a full read in flight.
     */
    function mirrorGoal(sessionID: string, value: string) {
      const goal = store.goal[sessionID]
      const status = goalStatus(value)
      if (!goal || !status || goal.status === status) return
      setStore("goal", sessionID, "status", status)
    }

    function mirrorTransition(transition: LifecycleTransition) {
      const entry = entryFromTransition(transition)
      const key = lifecycleKey(entry)
      lifecycleStamp.set(key, ++lifecycleClock)
      batch(() => {
        writeLifecycle(entry)
        if (entry.domain === "goal") mirrorGoal(entry.id, entry.value)
      })
      // A ref the size limit evicted again has nothing left to confirm, and a
      // domain without an owner resolver would only be answered with null.
      if (lifecycleRaw.has(key) && isPullableDomain(entry.domain))
        lifecycleQueued.set(key, { domain: entry.domain, id: entry.id })
    }

    /**
     * A background run ends without touching its Task part: its state comes from the job it owns, whose id is the
     * child session's. Queues that job unless a result or a transition already accounts for the run. It is called
     * while an event is handled, so the pull that follows the frame (`onFlush`) asks the owner, once for everything
     * the frame queued. Nothing here waits or polls.
     */
    function wantJob(childID: string) {
      const entry = store.taskIndex[childID]
      if (entry?.background !== true || entry.result) return
      const ref: LifecycleStateRef = { domain: "job", id: childID }
      const key = lifecycleKey(ref)
      if (!lifecycleRaw.has(key)) lifecycleQueued.set(key, ref)
    }

    function applyLifecycleStates(
      answers: readonly LifecycleStateEntry[],
      stamps: ReadonlyMap<string, number>,
      goalStamps: ReadonlyMap<string, number>,
    ) {
      batch(() => {
        for (const answer of answers) {
          const key = lifecycleKey(answer)
          const stamp = stamps.get(key)
          if (stamp === undefined || (lifecycleStamp.get(key) ?? 0) !== stamp) continue
          const isGoal = answer.domain === "goal"
          // A background run's job may be new as well: the link asks for the jobs whose transition this client
          // never saw (a Task part that arrived first, a reconnect). A deleted session takes its link with it.
          const isJob = answer.domain === "job" && store.taskIndex[answer.id]?.background === true
          // Evicted or dropped while the read was out. A goal ref may be new:
          // the reconnect refill asks for the goals the store holds.
          if (!isGoal && !isJob && !lifecycleRaw.has(key)) continue
          // A goal event since the read started is newer than the answer.
          if (isGoal && (ancillaryRevision.get(`${answer.id}:goal`) ?? 0) !== goalStamps.get(answer.id)) continue
          if (answer.state === null) {
            // Unknown to the owner (gone, other directory, no resolver): drop
            // the entry instead of guessing. A goal is not cleared on this
            // evidence: the resolver is stricter about directories than the
            // goal read, which decides.
            dropLifecycle([key])
            continue
          }
          const held = lifecycleRaw.get(key)
          const next = entryFromState(answer.state, held?.sessionID ?? (isGoal || isJob ? answer.id : undefined))
          // The answer does not carry the reason a transition gave (`process_restart`); the same value keeps it.
          writeLifecycle(
            held?.reason !== undefined && held.value === next.value ? { ...next, reason: held.reason } : next,
          )
          if (isGoal) mirrorGoal(answer.id, answer.state.value)
        }
      })
    }

    /**
     * Ask the owners about every queued ref in one request. One pull is in
     * flight at a time; refs that queue meanwhile go out at the next frame
     * after it returns, so a frame never sends more than one.
     */
    function pullLifecycle() {
      if (disposed || lifecycleInFlight || lifecycleQueued.size === 0) return
      const refs = [...lifecycleQueued.values()]
      lifecycleQueued.clear()
      const stamps = new Map(refs.map((ref) => [lifecycleKey(ref), lifecycleStamp.get(lifecycleKey(ref)) ?? 0]))
      const goalStamps = new Map(
        refs
          .filter((ref) => ref.domain === "goal")
          .map((ref) => [ref.id, ancillaryRevision.get(`${ref.id}:goal`) ?? 0]),
      )
      lifecycleInFlight = true
      const epoch = lifecycleEpoch
      void sdk.client.lifecycle
        .states({ refs }, { headers: locationHeaders({ workspace: project.workspace.current() }) })
        .then((response) => {
          // A failed read keeps what the events described; the next transition
          // or reconnect asks again.
          if (!disposed && epoch === lifecycleEpoch && response.data)
            applyLifecycleStates(response.data, stamps, goalStamps)
        })
        .catch((error) => {
          TuiLog.write("error", "Applying lifecycle states failed", { error: String(error) })
        })
        .finally(() => {
          if (epoch !== lifecycleEpoch) return
          lifecycleInFlight = false
          if (!disposed && lifecycleQueued.size > 0) sdk.frameClock.schedule(pullLifecycle)
        })
    }
    // Runs right after the frame that delivered the transitions.
    const unsubscribeLifecycle = sdk.frameClock.onFlush(pullLifecycle)

    /** The session subtree rooted at `rootID`, using the current session list. */
    function sessionTree(rootID: string | undefined, sessions: Session[] = store.session): Session[] {
      if (!rootID) return []
      const byID = new Map(sessions.map((session) => [session.id, session]))
      const children = new Map<string, string[]>()
      for (const session of sessions) {
        if (!session.parentID) continue
        const list = children.get(session.parentID) ?? []
        list.push(session.id)
        children.set(session.parentID, list)
      }
      const tree: string[] = []
      const queue = [rootID]
      const seen = new Set<string>()
      while (queue.length > 0) {
        const id = queue.shift()!
        if (seen.has(id)) continue
        seen.add(id)
        tree.push(id)
        queue.push(...(children.get(id) ?? []))
      }
      return tree.flatMap((id) => byID.get(id) ?? [])
    }

    /**
     * The newest root session approximates the current tree at bootstrap. When
     * the user enters another tree, `activate` fetches the summaries it is
     * missing lazily.
     */
    function currentTree(sessions: Session[]): Session[] {
      const rootID = sessions
        .filter((session) => isRoot(session))
        .toSorted((a, b) => b.time.updated - a.time.updated)[0]?.id
      return sessionTree(rootID, sessions)
    }

    function fetchDagSummaries(sessions: Session[], onlyMissing = false) {
      const workspace = project.workspace.current()
      return Promise.all(
        sessions
          .filter((session) => !onlyMissing || !(session.id in store.dag))
          .map((session) =>
            sdk.client.dag
              .summary({ sessionID: session.id }, { headers: locationHeaders({ workspace }) })
              .then((x) =>
                batch(() => {
                  setStore("dag", session.id, reconcile(x.data ?? []))
                  noteDagSummaries(x.data ?? [])
                }),
              )
              .catch(() => {}),
          ),
      )
    }

    /**
     * Keep the process-wide slot count a report carried (#1032 7). The latest report wins wherever it came from:
     * the count is the process's, not the session's, and a summary event carries it only for the session it is
     * about. A report without the figure leaves what is held.
     */
    function noteDagRunning(running: number | undefined) {
      if (running !== undefined) setStore("dagRunning", running)
    }

    /** The slot count of a batch of summaries: the publisher stamps the same figure on each of them. */
    function noteDagSummaries(summaries: readonly Pick<DagWorkflowSummary, "concurrencyRunning">[]) {
      noteDagRunning(summaries.find((summary) => summary.concurrencyRunning !== undefined)?.concurrencyRunning)
    }

    /** The roots whose mode snapshot is held or being read: what a refresh has to cover. */
    function dagModeRoots() {
      return [...new Set([...Object.keys(store.dagMode), ...dagModeReads.keys()])]
    }

    /**
     * Read the DAG mode snapshot of root sessions. `onlyMissing` leaves out the ones that already have one or are
     * being read; any other call reads again and its answer wins over a read that was still out. A failed read keeps
     * what the slice held, and the next trigger reads again.
     */
    function fetchDagMode(sessionIDs: readonly string[], onlyMissing = false) {
      const workspace = project.workspace.current()
      return Promise.all(
        sessionIDs
          .filter((sessionID) => !onlyMissing || !(sessionID in store.dagMode || dagModeReads.has(sessionID)))
          .map((sessionID) => {
            const read = Symbol(sessionID)
            dagModeReads.set(sessionID, read)
            return sdk.client.session
              .dagMode({ sessionID }, { headers: locationHeaders({ workspace }) })
              .then((response) => {
                if (disposed || dagModeReads.get(sessionID) !== read) return
                const snapshot = response.data
                if (!snapshot) {
                  TuiLog.write("error", "Loading the DAG mode failed", { sessionID, status: response.response?.status })
                  return
                }
                batch(() => {
                  setStore("dagMode", sessionID, reconcile(snapshot))
                  noteDagRunning(snapshot.limits.running)
                })
              })
              .catch((error) => {
                TuiLog.write("error", "Loading the DAG mode failed", { sessionID, error: String(error) })
              })
              .finally(() => {
                if (dagModeReads.get(sessionID) === read) dagModeReads.delete(sessionID)
              })
          }),
      ).then(() => undefined)
    }

    /**
     * The snapshot the status band and the /dag title draw their limits from, read the first time the route's tree
     * needs it: the tree has DAG mode on or a workflow, and the snapshot is neither here nor on its way. The three
     * moments are entering the tree, a workflow summary arriving, and the root session's mode turning on. A tree in
     * no such state costs no read at all (a plain session, the home view), and nothing here polls.
     */
    function wantDagMode() {
      const rootID = routeChain.at(-1)
      if (rootID === undefined || rootID in store.dagMode || dagModeReads.has(rootID)) return
      const match = search(store.session, rootID, (item) => item.id)
      const on = match.found && store.session[match.index].dagMode === "on"
      // The sessions with summaries are few (the trees entered), so this is cheaper than walking the session list.
      const owned = Object.entries(store.dag).some(
        ([ownerID, list]) => list.length > 0 && (ownerID === rootID || parentChain(ownerID).at(-1) === rootID),
      )
      if (on || owned) void fetchDagMode([rootID], true)
    }

    /**
     * Read the usage of the trees whose roots are named (#1475) and take the answers in. A root whose read is still
     * out is not asked again at once: it is marked, and read once more when that answer is in, so a burst of triggers
     * costs one more read and not one each. A read that fails leaves what the slice held and is logged; the next
     * trigger reads again. An answer is kept only while the root is still watched and not deleted, so a read that
     * outlives its drawer brings nothing back.
     */
    function fetchUsage(rootIDs: readonly string[]) {
      const workspace = project.workspace.current()
      return Promise.all(
        rootIDs.map(async (rootID) => {
          if (usageReads.has(rootID)) {
            usageDirty.add(rootID)
            return
          }
          const read = Symbol(rootID)
          usageReads.set(rootID, read)
          try {
            const response = await sdk.client.session.usage(
              { sessionID: rootID },
              { headers: locationHeaders({ workspace }) },
            )
            if (disposed || usageReads.get(rootID) !== read) return
            const snapshot = response.data
            if (!snapshot) {
              TuiLog.write("error", "Loading the usage failed", {
                sessionID: rootID,
                status: response.response?.status,
              })
              return
            }
            if (usageWatchers.has(rootID)) setStore("usage", rootID, reconcile(snapshot))
          } catch (error) {
            if (!disposed)
              TuiLog.write("error", "Loading the usage failed", { sessionID: rootID, error: String(error) })
          } finally {
            if (usageReads.get(rootID) === read) {
              usageReads.delete(rootID)
              if (usageDirty.delete(rootID) && !disposed && usageWatchers.has(rootID)) void fetchUsage([rootID])
            }
          }
        }),
      ).then(() => undefined)
    }

    /**
     * Something on screen shows the usage of the tree rooted at `rootID`: count it and read it once. The function it
     * returns lets go; the last one to go ends the reads of that root. A function called twice lets go once.
     */
    function watchUsage(rootID: string) {
      usageWatchers.set(rootID, (usageWatchers.get(rootID) ?? 0) + 1)
      // Called from an effect: the read must not make the effect depend on what it looks at (the workspace).
      untrack(() => void fetchUsage([rootID]))
      let released = false
      return () => {
        if (released) return
        released = true
        const count = usageWatchers.get(rootID)
        if (count === undefined) return
        if (count > 1) usageWatchers.set(rootID, count - 1)
        else usageWatchers.delete(rootID)
      }
    }

    /**
     * Read the fixed overhead of the sessions named (#1461) and take the answers in, the way `fetchUsage` does for a
     * tree: a session whose read is still out is marked and read once more when that answer is in, a read that fails
     * leaves what the slice held and is logged, and an answer is kept only while the session is still watched and
     * not deleted.
     */
    function fetchOverhead(sessionIDs: readonly string[]) {
      const workspace = project.workspace.current()
      return Promise.all(
        sessionIDs.map(async (sessionID) => {
          if (overheadReads.has(sessionID)) {
            overheadDirty.add(sessionID)
            return
          }
          const read = Symbol(sessionID)
          overheadReads.set(sessionID, read)
          try {
            const response = await sdk.client.session.overhead(
              { sessionID },
              { headers: locationHeaders({ workspace }) },
            )
            if (disposed || overheadReads.get(sessionID) !== read) return
            const snapshot = response.data
            if (!snapshot) {
              TuiLog.write("error", "Loading the fixed overhead failed", {
                sessionID,
                status: response.response?.status,
              })
              return
            }
            if (overheadWatchers.has(sessionID)) setStore("overhead", sessionID, reconcile(snapshot))
          } catch (error) {
            if (!disposed)
              TuiLog.write("error", "Loading the fixed overhead failed", { sessionID, error: String(error) })
          } finally {
            if (overheadReads.get(sessionID) === read) {
              overheadReads.delete(sessionID)
              if (overheadDirty.delete(sessionID) && !disposed && overheadWatchers.has(sessionID))
                void fetchOverhead([sessionID])
            }
          }
        }),
      ).then(() => undefined)
    }

    /**
     * Something on screen shows the fixed overhead of `sessionID`: count it and read it once. The function it returns
     * lets go; the last one to go ends the reads of that session. A function called twice lets go once.
     */
    function watchOverhead(sessionID: string) {
      overheadWatchers.set(sessionID, (overheadWatchers.get(sessionID) ?? 0) + 1)
      // Called from an effect: the read must not make the effect depend on what it looks at (the workspace).
      untrack(() => void fetchOverhead([sessionID]))
      let released = false
      return () => {
        if (released) return
        released = true
        const count = overheadWatchers.get(sessionID)
        if (count === undefined) return
        if (count > 1) overheadWatchers.set(sessionID, count - 1)
        else overheadWatchers.delete(sessionID)
      }
    }

    /**
     * Take a `pr.watch.updated` entry in. The event is not durable and may arrive late, so one older than the entry
     * held is dropped. The entry replaces the held one outright (reconcile): a `checks`, `delivery` or `review` that
     * the new state no longer has must not linger.
     */
    function writePrWatch(entry: PrWatchEntry) {
      const map = store.pr_watch[entry.sessionID]
      const held = map?.[entry.watchID]
      if (held && held.updatedAt > entry.updatedAt) return
      prWatchReads.get(entry.sessionID)?.touched.add(entry.watchID)
      // A path through a root that has no map yet cannot be set: the first watch of a root creates the map.
      if (map) setStore("pr_watch", entry.sessionID, entry.watchID, reconcile(entry))
      else setStore("pr_watch", entry.sessionID, { [entry.watchID]: entry })
    }

    /**
     * Read the PR watches of root sessions and replace each root's map with the answer: a watch it does not return
     * has ended for good, and is dropped. Entries that events delivered while the read was out are newer than the
     * answer and stay, unless the answer carries a later state of the same watch; a held state newer than the
     * answer's state of the same watch also stays. `onlyMissing` leaves out the roots
     * a read already answered or that are being read (a map events created does not count); any other call reads
     * again, and its answer wins over a read that was still out. A failed read keeps what the slice held, and the next trigger reads again.
     */
    function fetchPrWatch(rootIDs: readonly string[], onlyMissing = false) {
      const workspace = project.workspace.current()
      return Promise.all(
        rootIDs
          .filter((rootID) => !onlyMissing || !(prWatchLoaded.has(rootID) || prWatchReads.has(rootID)))
          .map((rootID) => {
            const read = { touched: new Set<string>() }
            prWatchReads.set(rootID, read)
            return sdk.client.session
              .prWatch({ sessionID: rootID }, { headers: locationHeaders({ workspace }) })
              .then((response) => {
                if (disposed || prWatchReads.get(rootID) !== read) return
                const entries = response.data?.entries
                if (!entries) {
                  TuiLog.write("error", "Loading the PR watches failed", {
                    sessionID: rootID,
                    status: response.response?.status,
                  })
                  return
                }
                const next: Record<string, PrWatchEntry> = {}
                for (const entry of entries) next[entry.watchID] = entry
                const held = store.pr_watch[rootID]
                for (const watchID of read.touched) {
                  const current = held?.[watchID]
                  if (current && current.updatedAt >= (next[watchID]?.updatedAt ?? -Infinity)) next[watchID] = current
                }
                // An event taken in before the read began may also be newer than the answer's state of its watch.
                for (const [watchID, entry] of Object.entries(next)) {
                  const current = held?.[watchID]
                  if (current && current.updatedAt > entry.updatedAt) next[watchID] = current
                }
                setStore("pr_watch", rootID, reconcile(next))
                prWatchLoaded.add(rootID)
              })
              .catch((error) => {
                TuiLog.write("error", "Loading the PR watches failed", { sessionID: rootID, error: String(error) })
              })
              .finally(() => {
                if (prWatchReads.get(rootID) === read) prWatchReads.delete(rootID)
              })
          }),
      ).then(() => undefined)
    }

    /**
     * Read the reminders of sessions and replace each session's list with the answer. `onlyMissing`, a failed read
     * and a newer read replacing one that is still out behave as in `fetchPrWatch`.
     */
    function fetchReminder(sessionIDs: readonly string[], onlyMissing = false) {
      const workspace = project.workspace.current()
      return Promise.all(
        sessionIDs
          .filter((sessionID) => !onlyMissing || !(sessionID in store.reminder || reminderReads.has(sessionID)))
          .map((sessionID) => {
            const read = Symbol(sessionID)
            reminderReads.set(sessionID, read)
            return sdk.client.session
              .reminder({ sessionID }, { headers: locationHeaders({ workspace }) })
              .then((response) => {
                if (disposed || reminderReads.get(sessionID) !== read) return
                const entries = response.data?.entries
                if (!entries) {
                  TuiLog.write("error", "Loading the reminders failed", {
                    sessionID,
                    status: response.response?.status,
                  })
                  return
                }
                setStore("reminder", sessionID, reconcile(entries))
              })
              .catch((error) => {
                TuiLog.write("error", "Loading the reminders failed", { sessionID, error: String(error) })
              })
              .finally(() => {
                if (reminderReads.get(sessionID) === read) reminderReads.delete(sessionID)
              })
          }),
      ).then(() => undefined)
    }

    /** Workflow -> owning session over every surface; the first surface to name a workflow decides. */
    function dagWatched() {
      const watched = new Map<string, string>()
      for (const entries of dagWatches.values()) {
        for (const [workflowID, sessionID] of entries) {
          if (!watched.has(workflowID)) watched.set(workflowID, sessionID)
        }
      }
      return watched
    }

    /** Set or drop a workflow's feed in the feed map and in the store. */
    function writeDagFeed(workflowID: string, feed: DagMerge.Feed | undefined) {
      if (feed) dagFeeds.set(workflowID, feed)
      else {
        dagFeeds.delete(workflowID)
        dagReads.delete(workflowID)
      }
      setStore(
        "dagNodes",
        produce((draft) => {
          if (feed) draft[workflowID] = feed
          else delete draft[workflowID]
        }),
      )
    }

    /**
     * Read a workflow's whole node table. The read starts a feed in `loading`
     * (or keeps the one that is), so pushes that arrive meanwhile are buffered
     * and replayed on top of the answer. `reset` forgets what was buffered, for
     * a reconnect. A read already in flight is replaced: its answer predates
     * the push that asked for this one. A failed read leaves the feed loading
     * and is not retried by itself; the next resync, graph change or reconnect
     * reads again.
     */
    function readDagNodes(workflowID: string, reset = false) {
      if (!dagWatched().has(workflowID)) return
      const previous = dagFeeds.get(workflowID)
      const feed = previous?.status === "loading" && !reset ? previous : DagMerge.loading()
      if (feed !== previous) writeDagFeed(workflowID, feed)
      const read = Symbol(workflowID)
      dagReads.set(workflowID, read)
      const workspace = project.workspace.current()
      void sdk.client.dag
        .nodes({ dagID: workflowID }, { headers: locationHeaders({ workspace }) })
        .then((response) => {
          if (disposed || dagReads.get(workflowID) !== read) return
          const current = dagFeeds.get(workflowID)
          if (!response.data) {
            TuiLog.write("error", "Loading DAG nodes failed", { workflowID, status: response.response?.status })
            return
          }
          if (!current) return
          writeDagFeed(
            workflowID,
            DagMerge.receive(current, {
              workflowID,
              // The answer names the revision its rows belong to, so pushes buffered meanwhile replay onto it.
              graphRev: dagFinite(response.data.graphRev) ?? 0,
              seq: 0,
              nodes: response.data.nodes.map(dagNodeRow),
            }),
          )
        })
        .catch((error) => {
          TuiLog.write("error", "Loading DAG nodes failed", { workflowID, error: String(error) })
        })
        .finally(() => {
          if (dagReads.get(workflowID) === read) dagReads.delete(workflowID)
        })
    }

    /**
     * `dag.workflow.nodes.updated`: merge a push into the feed of a workflow a
     * surface shows. A push for any other workflow is ignored: it is not
     * loaded, so there is nothing to merge into, and the read that loads it
     * starts after the interest is confirmed.
     */
    function reduceDagNodes(properties: SdkEventOf<"dag.workflow.nodes.updated">) {
      const feed = dagFeeds.get(properties.workflowID)
      if (!feed) return
      const patch: DagMerge.NodesPatch = {
        workflowID: properties.workflowID,
        graphRev: dagFinite(properties.graphRev) ?? 0,
        seq: properties.seq,
        nodes: properties.nodes.map(dagNodeRow),
        removed: properties.removed,
        ...(properties.resync === true ? { resync: true } : {}),
      }
      const next = DagMerge.push(feed, patch)
      // A stale or duplicate push leaves a loaded view as it is.
      if (next === feed) return
      writeDagFeed(properties.workflowID, next)
      // A resync, or a push from another graph revision than the loaded view,
      // cannot be merged: the whole table is read again, once.
      if (patch.resync === true || (feed.status === "ready" && next.status === "loading")) {
        readDagNodes(properties.workflowID)
      }
    }

    function sameWatch(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) {
      if (a.size !== b.size) return false
      for (const [workflowID, sessionID] of a) if (b.get(workflowID) !== sessionID) return false
      return true
    }

    /**
     * Bring feeds and interest in line with what the surfaces show: drop the
     * feed of a workflow nobody shows any more, hand the owning sessions to the
     * aggregator (source `dag`), and only after the worker confirmed them read
     * the table of every workflow that has no feed yet.
     */
    async function applyDagWatches() {
      const watched = dagWatched()
      // Dropping a feed while walking the map is safe: an entry removed behind the walk is not visited again.
      for (const workflowID of dagFeeds.keys()) {
        if (!watched.has(workflowID)) writeDagFeed(workflowID, undefined)
      }
      const sessions = [...new Set(watched.values())].toSorted()
      const key = sessions.join("\u0000")
      if (key !== dagInterestKey) {
        dagInterestKey = key
        dagInterestSettled = sessions.length > 0 ? interest.set("dag", sessions) : interest.delete("dag")
      }
      const settled = dagInterestSettled
      try {
        await settled
      } catch (error) {
        // The worker never confirmed, so nothing is registered: take the source
        // back out, and the next declaration of these sessions asks again. A
        // second failure of the same worker has nothing to add to the log below.
        if (dagInterestSettled === settled) {
          dagInterestKey = ""
          interest.delete("dag").catch(() => {})
        }
        TuiLog.write("error", "Registering DAG interest failed", { error: String(error) })
        return
      }
      if (disposed) return
      for (const workflowID of dagWatched().keys()) {
        if (!dagFeeds.has(workflowID)) readDagNodes(workflowID)
      }
    }

    /**
     * Declare the workflows one display surface (`source`, for example the
     * status band or the `/dag` panel) shows. It replaces what that surface
     * declared before. A surface must end its declaration with
     * `watch(source, [])` when it goes away (a component does so on unmount):
     * the table and the interest stay registered until then. Calling again
     * with the same workflows does nothing. Resolves once the interest is
     * confirmed and the first table reads have started, not when they finish;
     * read the result with `dag.nodes`.
     */
    async function watchDag(source: string, workflows: readonly DagWatch[]) {
      const next = new Map<string, string>()
      for (const { workflowID, sessionID } of workflows) next.set(workflowID, sessionID)
      const previous = dagWatches.get(source)
      if (previous ? sameWatch(previous, next) : next.size === 0) return
      if (next.size === 0) dagWatches.delete(source)
      else dagWatches.set(source, next)
      await applyDagWatches()
    }

    /** A deleted session owns no workflow any more: its watches end. */
    function dropDagOwner(sessionID: string) {
      let changed = false
      for (const [source, entries] of dagWatches) {
        for (const [workflowID, owner] of entries) {
          if (owner !== sessionID) continue
          entries.delete(workflowID)
          changed = true
        }
        if (entries.size === 0) dagWatches.delete(source)
      }
      if (changed) void applyDagWatches()
    }

    function applySessionList(sessions: Session[]) {
      batch(() => {
        setStore("session", reconcile(sessions))
        seedSummaries(sessions)
      })
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      // Store order must stay id-ascending: every session event handler
      // binary-searches by id (search()). Recency ordering is a display
      // concern and lives in the session-list dialog.
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    }

    // #886 5.1: the worker forwards full events for sessions with a pending
    // permission or question, but the client may never have hydrated them.
    // Pull one snapshot so the prompt has context; no interest registration
    // is needed because the worker already added the session.
    function hydrateOnAsk(sessionID: string) {
      if (fullSyncedSessions.has(sessionID)) return
      if (!getSession(sessionID)) return
      void result.session.sync(sessionID).catch(() => {})
    }

    event.subscribeAll((event, { workspace, decision }) => {
      // The summary reducer runs after the gate and before any store write.
      // "summary" events stop here: they only update the compact view.
      reduceSummary(event)
      if (decision === "summary") return

      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          // #1032 7: a config write that disposes the instance sends this instead of `config.updated`, and the
          // bootstrap does not read the mode snapshots: every one held or being read is read again here.
          void fetchDagMode(dagModeRoots())
          // #1036 F6: the watches and the reminders live in the instance too, and no event says what the new one
          // holds: they are read again as after a reconnect (every root held, and the root of the route).
          void refreshPrWatches()
          void refreshReminders()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          hydrateOnAsk(event.properties.sessionID)
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected":
        case "question.timed_out": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.interacted": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore("question", event.properties.sessionID, match.index, "expiresAt", undefined)
          break
        }

        case "question.asked": {
          hydrateOnAsk(event.properties.sessionID)
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          changedAncillary(event.properties.sessionID, "todo")
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "goal.updated":
          changedAncillary(event.properties.sessionID, "goal")
          setStore("goal", event.properties.sessionID, event.properties.goal)
          break

        case "goal.cleared":
          changedAncillary(event.properties.sessionID, "goal")
          setStore("goal", event.properties.sessionID, undefined)
          break

        case "lifecycle.transitioned":
          mirrorTransition(event.properties)
          // #1036 F6: no event carries the reminders; a transition of one says its session's list changed.
          if (
            event.properties.domain === "reminder" &&
            event.properties.sessionID !== undefined &&
            (workspace === undefined || workspace === project.workspace.current())
          )
            void fetchReminder([event.properties.sessionID])
          break

        // #1036 F6: the state of a PR/MR watch, published by the watch itself and not durable: a reconnect reads the
        // watches again (`refreshPrWatches`). Session-summary scoped, so it arrives whether or not its session is loaded.
        case "pr.watch.updated":
          if (workspace !== undefined && workspace !== project.workspace.current()) break
          writePrWatch(event.properties)
          break

        // ── DAG workflow summary ────────────────────────────────────
        // Stateless derived-view publisher (server-side) emits the full
        // WorkflowSummary[] for a session whenever any dag.* event changes
        // its visible progress. We just store it — no client-side aggregation.
        case "dag.workflow.summary.updated":
          if (workspace !== undefined && workspace !== project.workspace.current()) break
          // reconcile (like bootstrap/reconnect) so unchanged same-ID rows keep
          // store-node identity: a no-op summary must not remount expanded
          // sidebar rows and re-trigger their signature-guarded fetches.
          setStore("dag", event.properties.sessionID, reconcile(event.properties.summaries))
          // The slot count is the process's: any session's event is the newest report of it.
          noteDagSummaries(event.properties.summaries)
          if (event.properties.summaries.length > 0) wantDagMode()
          break

        // #1032: node-level push for a workflow a surface shows; merged by the
        // rules in `DagMerge`, and only after the interest that delivers it.
        case "dag.workflow.nodes.updated":
          if (workspace !== undefined && workspace !== project.workspace.current()) break
          reduceDagNodes(event.properties)
          break

        // #1032 D3: how the latest turn of a session ended. Nothing reads it
        // back, so an event that arrives out of order must not replace a newer one.
        case "session.turn.settled": {
          const { sessionID, turnID, outcome, timeEnded } = event.properties
          // #1475: a session's usage is last written when its turn settles, so a tree someone watches is read again
          // here, whichever session of it settled and in whatever order the events came.
          const rootID = rootOf(sessionID)
          if (usageWatchers.has(rootID)) void fetchUsage([rootID])
          // #1461: the requests of a turn are recorded as it runs, so the session's own overhead is read again now.
          if (overheadWatchers.has(sessionID)) void fetchOverhead([sessionID])
          const previous = store.turn_settled[sessionID]
          if (previous && previous.timeEnded > timeEnded) break
          setStore("turn_settled", sessionID, { turnID, outcome: outcome.type, timeEnded })
          break
        }

        case "session.diff":
          changedAncillary(event.properties.sessionID, "session_diff")
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const sessionID = event.properties.info.id
          dropSession(sessionID)
          const result = search(store.session, sessionID, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.created":
        case "session.updated": {
          const hydration = hydratingSessions.get(event.properties.info.id)
          if (hydration) hydration.session = true
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            // The mode itself is the session's own field and needs no read; the effective budget also depends on
            // the global default, which only the server knows, so a change to the session's budget reads it again.
            const before = store.session[result.index]
            const budgetChanged =
              before.dagBudgetTokens !== event.properties.info.dagBudgetTokens ||
              before.dagBudgetUnlimited !== event.properties.info.dagBudgetUnlimited
            setStore("session", result.index, reconcile(event.properties.info))
            // A read still out may have been answered before the change, so it is replaced as well.
            const held = event.properties.info.id in store.dagMode || dagModeReads.has(event.properties.info.id)
            if (budgetChanged && held) void fetchDagMode([event.properties.info.id])
            else if (event.properties.info.id === routeChain.at(-1)) wantDagMode()
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          const { sessionID, status } = event.properties
          setStore("session_status", sessionID, status)
          if (status.type === "idle") void finishTrustImport(sessionID)
          break
        }

        case "message.updated": {
          const accepted = submissionAccepted.get(event.properties.info.id)
          if (accepted) {
            submissionAccepted.delete(event.properties.info.id)
            accepted()
          }
          if (store.pending_submission[event.properties.info.sessionID] === event.properties.info.id)
            setStore("pending_submission", event.properties.info.sessionID, undefined)
          if (!storesMessages(event.properties.info.sessionID)) break
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = searchMessages(messages, event.properties.info)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          if (!storesMessages(event.properties.sessionID)) break
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          if (!messages) break
          const index = messages.findIndex((m) => m.id === event.properties.messageID)
          if (index >= 0) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          if (!storesMessages(event.properties.part.sessionID)) break
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          // A snapshot supersedes whatever deltas were buffered for this part.
          stream.settle(event.properties.part.id)
          noteBackgroundResult(event.properties.part)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          if (!storesMessages(event.properties.sessionID)) break
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (p) => p.id)
          // A delta without its first snapshot is dropped: there is no part
          // identity to read it back against (same as the old store lookup).
          if (!result.found) break
          const field = event.properties.field
          if (field !== "text" && field !== "reasoning") break
          touchPart(event.properties.sessionID, event.properties.partID)
          stream.append(event.properties.partID, field, event.properties.delta)
          break
        }

        case "message.part.preview": {
          if (!storesMessages(event.properties.sessionID)) break
          const { messageID, partID, tail, totalLength, seq } = event.properties
          const parts = store.part[messageID]
          if (!parts) break
          const result = search(parts, partID, (p) => p.id)
          if (!result.found) break
          // Non-durable running preview (#1016 HS4a, #886 5.3). Only a running
          // tool part has a window to show. The window replaces the previous
          // one inside the stream buffer; `store.part` is not written, and the
          // durable snapshot that ends the run settles it. The part is not
          // `touchPart`ed: nothing in the store changed, so a hydration
          // snapshot must stay free to replace the part.
          const part = parts[result.index]
          if (part.type !== "tool" || part.state.status !== "running") break
          stream.preview(partID, tail, totalLength, seq)
          break
        }

        case "message.part.removed": {
          if (!storesMessages(event.properties.sessionID)) break
          touchPart(event.properties.sessionID, event.properties.partID)
          stream.settle(event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp
            .status({ headers: locationHeaders({ workspace }) })
            .then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }

        // #1040: the event names the decided ids only; the full snapshot is
        // the source of truth for state, change flags and risk notes.
        case "project.trust.updated": {
          void refreshTrust()
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const attempt = ++bootstrapAttempt
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const headers = locationHeaders({ workspace })
      const providersPromise = sdk.client.config.providers({ throwOnError: true, headers })
      const providerListPromise = sdk.client.provider.list({ throwOnError: true, headers })
      const agentsPromise = sdk.client.app.agents({ throwOnError: true, headers })
      const configPromise = sdk.client.config.get({ throwOnError: true, headers })
      await Promise.all([
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          if (disposed || attempt !== bootstrapAttempt) return undefined
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const agents = responses[2]
            const config = responses[3]
            const sessions = responses[4]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("agent", reconcile(agents))
              initLanguage(config.language)
              setStore("config", reconcile(config))
              if (sessions !== undefined) applySessionList(sessions)
            })
          })
        })
        .then(() => {
          if (disposed || attempt !== bootstrapAttempt) return
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => applySessionList(sessions))]),
            sdk.client.command.list({ headers }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ headers }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ headers }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ headers })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ headers }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ headers }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
              seedSummaries(store.session)
            }),
            sdk.client.provider.auth({ headers }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ headers }).then((x) => setStore("vcs", reconcile(x.data))),
            // #886 5.7: the @alias list now comes from the sync store.
            sdk.client.reference
              .list({ headers })
              .then((x) => setStore("reference", reconcile(x.data ?? [])))
              .catch(() => {}),
            // #1040: the first trust snapshot also gates the first-open panel.
            refreshTrust(),
            project.workspace.sync(),
            // #886 5.6: DAG summaries are only fetched for the current session
            // tree; entering another tree fetches its missing summaries lazily.
            sessionListPromise.then((sessions) => fetchDagSummaries(currentTree(sessions))),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          if (disposed || attempt !== bootstrapAttempt) return
          TuiLog.write("error", "tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    // Reconnect recovery for DAG summaries: the summary publisher emits
    // ephemeral events that are not durable. When the SSE stream reconnects,
    // any events missed during the disconnect are unrecoverable by replay.
    // This snapshots every session already represented in `store.dag` (the
    // exact recovery set, not the visible-session query used by bootstrap)
    // and replaces each slice with a fresh complete response. Deduplicated
    // against an in-flight flag so rapid reconnects don't stack requests.
    const refreshDagSummaries = (): Promise<void> => {
      const sessionIDs = Object.keys(store.dag)
      if (sessionIDs.length === 0) return Promise.resolve()
      const workspace = project.workspace.current()
      return Promise.all(
        sessionIDs.map((sessionID) =>
          sdk.client.dag
            .summary({ sessionID }, { headers: locationHeaders({ workspace }) })
            .then((x) =>
              batch(() => {
                setStore("dag", sessionID, reconcile(x.data ?? []))
                noteDagSummaries(x.data ?? [])
              }),
            )
            .catch(() => {}),
        ),
      ).then(() => undefined)
    }

    let dagReconnectInFlight = false
    const guardedRefreshDagSummaries = (): Promise<void> => {
      if (dagReconnectInFlight) return Promise.resolve()
      dagReconnectInFlight = true
      return refreshDagSummaries().finally(() => {
        dagReconnectInFlight = false
      })
    }

    // #1069: the reconnect refill of the lifecycle mirror. Every ref the mirror
    // holds, plus the goal of every session that has one and the job of every
    // background run no result has ended, goes out in a single read. The
    // answers are states: they correct the mirror and the goal status, while the
    // goal itself is read in full by `refreshGoals` below.
    const refreshLifecycle = (): Promise<void> => {
      lifecycleEpoch++
      lifecycleInFlight = false
      for (const entry of lifecycleRaw.values()) {
        if (!isPullableDomain(entry.domain)) continue
        lifecycleQueued.set(lifecycleKey(entry), { domain: entry.domain, id: entry.id })
      }
      for (const [sessionID, goal] of Object.entries(store.goal)) {
        if (!goal) continue
        const ref: LifecycleStateRef = { domain: "goal", id: sessionID }
        lifecycleQueued.set(lifecycleKey(ref), ref)
      }
      // The job of every background run no result has ended: the transition that would say may have been missed.
      for (const [childID, entry] of Object.entries(store.taskIndex)) {
        if (entry.background !== true || entry.result) continue
        const ref: LifecycleStateRef = { domain: "job", id: childID }
        lifecycleQueued.set(lifecycleKey(ref), ref)
      }
      pullLifecycle()
      return Promise.resolve()
    }

    // #349/F3: goal.updated and goal.cleared are ephemeral (not in the durable
    // replay set), so a goal.cleared missed during a disconnect would leave a
    // stale goal in the drawer, and so would a changed text, turn count, limit
    // or subgoal list. The lifecycle contract reports the status only, so the
    // goal of every stored session is read in full again (AGENTS.md: the goal
    // slice refreshes in full on reconnect). Hydrated sessions are left out:
    // `sync` reloads their goal. Reads run a few at a time, and a newer
    // reconnect supersedes an older round.
    const REFRESH_CONCURRENCY = 4
    let goalEpoch = 0
    const refreshGoal = (sessionID: string, epoch: number): Promise<void> => {
      // A goal event after the read began carries a newer snapshot than it.
      const revision = ancillaryRevision.get(`${sessionID}:goal`) ?? 0
      return sdk.client.session
        .goal({ sessionID }, { throwOnError: false })
        .then((response) => {
          if (disposed || epoch !== goalEpoch) return
          if ((ancillaryRevision.get(`${sessionID}:goal`) ?? 0) !== revision) return
          // 404 is the owner saying there is no goal; any other failure keeps it.
          if (response.data) {
            // The session may have been deleted meanwhile; do not bring its goal back.
            if (store.goal[sessionID]) setStore("goal", sessionID, reconcile(response.data))
          } else if (response.response?.status === 404) {
            setStore("goal", sessionID, undefined)
          }
        })
        .catch((error) => {
          TuiLog.write("error", "Refreshing the goal failed", { sessionID, error: String(error) })
        })
    }
    const refreshGoals = async (): Promise<void> => {
      const epoch = ++goalEpoch
      const sessionIDs = Object.entries(store.goal)
        .filter(([sessionID, goal]) => goal && !store.hydrated.includes(sessionID))
        .map(([sessionID]) => sessionID)
      for (let start = 0; start < sessionIDs.length; start += REFRESH_CONCURRENCY) {
        if (disposed || epoch !== goalEpoch) return
        const round = sessionIDs.slice(start, start + REFRESH_CONCURRENCY)
        await Promise.all(round.map((sessionID) => refreshGoal(sessionID, epoch)))
      }
    }

    // #1036 F6: the PR watches and the reminders mirror server state that no durable event carries, so what changed
    // during a disconnect is known only by reading it again. Every session whose slice is held or being read is read
    // in full, and so is the root of the route even when it holds nothing: its first read may have failed, or a watch
    // may have been set while the stream was down. The answers replace what the slices held. Reads run a few at a
    // time, and a newer reconnect supersedes an older round.
    const refreshRounds = (held: () => Iterable<string>, read: (round: string[]) => Promise<void>) => {
      let epoch = 0
      return async (): Promise<void> => {
        const mine = ++epoch
        const sessionIDs = new Set(held())
        const active = routeChain.at(-1)
        if (active !== undefined) sessionIDs.add(active)
        const ids = [...sessionIDs]
        for (let start = 0; start < ids.length; start += REFRESH_CONCURRENCY) {
          if (disposed || mine !== epoch) return
          await read(ids.slice(start, start + REFRESH_CONCURRENCY))
        }
      }
    }
    const refreshPrWatches = refreshRounds(
      () => [...Object.keys(store.pr_watch), ...prWatchReads.keys()],
      (round) => fetchPrWatch(round),
    )
    const refreshReminders = refreshRounds(
      () => [...Object.keys(store.reminder), ...reminderReads.keys()],
      (round) => fetchReminder(round),
    )

    // #1040: project-layer trust is global state. The change event only names
    // ids, so every notification re-reads the snapshot rather than merging.
    const refreshTrust = (): Promise<void> => {
      const workspace = project.workspace.current()
      return sdk.client.project.trust
        .list({ headers: locationHeaders({ workspace }) })
        .then((x) => {
          // #1659: only an array is a trust list; any other reply shape leaves it empty.
          const entries = x.data?.entries
          setStore("trust", reconcile(Array.isArray(entries) ? entries : []))
          setStore("trust_loaded", true)
        })
        .catch(() => {})
    }

    // #1223: `/import-claude` writes project entries that stay pending until
    // the user confirms them. The snapshot is taken when the command's message
    // is accepted and the diff is computed from the server-scanned entries
    // once the turn goes idle, so the model's report never decides trust.
    const pendingTrustImports = new Map<string, TrustSnapshot>()
    const [trustImportReview, setTrustImportReview] = createSignal<{ sessionID: string; ids: string[] }>()
    const beginTrustImport = async (sessionID: string) => {
      if (!store.trust_loaded) await refreshTrust()
      pendingTrustImports.set(sessionID, snapshotTrust(store.trust))
    }
    const finishTrustImport = async (sessionID: string) => {
      const before = pendingTrustImports.get(sessionID)
      if (!before) return
      pendingTrustImports.delete(sessionID)
      await refreshTrust()
      const ids = importedEntryIds(before, store.trust)
      if (ids.length > 0) setTrustImportReview({ sessionID, ids })
    }

    // #886 5.6: the single reconnect entry point. Features register their own
    // refresh functions here instead of subscribing to `reconnected`.
    function onResync(fn: () => void | Promise<void>) {
      resyncHandlers.add(fn)
      return () => {
        resyncHandlers.delete(fn)
      }
    }
    // #1032 7: the summaries and the mode snapshots are read again together, the answers being states, not events.
    // Only then does the route ask for what it still lacks: a first read that failed left no snapshot to refresh,
    // and a workflow that appeared during the disconnect turns a tree that wanted none into one that wants it.
    onResync(async () => {
      await Promise.all([guardedRefreshDagSummaries(), fetchDagMode(dagModeRoots())])
      if (!disposed) wantDagMode()
    })
    // #1032: every shown workflow reads its table again, from an empty buffer.
    // A shown workflow with no feed yet is one whose interest the worker never
    // confirmed: declaring it again would be a no-op, so the reconnect registers
    // the interest again and reads it only after the worker confirms.
    onResync(async () => {
      let unconfirmed = false
      for (const workflowID of dagWatched().keys()) {
        if (dagFeeds.has(workflowID)) readDagNodes(workflowID, true)
        else unconfirmed = true
      }
      if (unconfirmed) await applyDagWatches()
    })
    // #1475: the usage of every tree something watches is read again, the answers being states, not events.
    onResync(() => fetchUsage([...usageWatchers.keys()]))
    // #1461: so is the fixed overhead of every session something watches.
    onResync(() => fetchOverhead([...overheadWatchers.keys()]))
    // The settled-turn slice has no read-back: a turn that settled during the
    // disconnect is unknown, and an old outcome must not pass for the latest.
    onResync(() => {
      setStore("turn_settled", reconcile({}))
    })
    onResync(refreshLifecycle)
    onResync(refreshGoals)
    onResync(refreshPrWatches)
    onResync(refreshReminders)
    onResync(refreshTrust)

    // #1032 7: a global config write that leaves the instance alone reaches the TUI as `config.updated` and as
    // nothing else (`useEvent` leaves it out, and no session event follows), so this listens on the emitter itself.
    // A change to `dag` can move the snapshot's limits and the effective budget: every snapshot held or being read
    // is read again, and the new answer replaces a read that was out before the change.
    const unsubscribeConfig = sdk.event.on("event", (event) => {
      if (disposed || event.payload.type !== "config.updated") return
      if (event.payload.properties.keys.includes("dag")) void fetchDagMode(dagModeRoots())
    })

    const unsubscribeReconnect = sdk.event.on("reconnected", () => {
      // Deltas that arrived before the disconnect cannot be reconciled with a
      // possibly truncated snapshot: drop them and rebuild from the server.
      stream.clear()
      fullSyncedSessions.clear()
      for (const sessionID of Array.from(store.hydrated)) {
        void result.session.sync(sessionID).catch(() => {})
      }
      for (const handler of resyncHandlers) {
        try {
          void Promise.resolve(handler()).catch(() => {})
        } catch {
          // A failing refresh must not skip the remaining registrations.
        }
      }
    })

    onMount(() => {
      void bootstrap()
    })

    onCleanup(() => {
      disposed = true
      dagFeeds.clear()
      dagWatches.clear()
      dagReads.clear()
      dagModeReads.clear()
      usageReads.clear()
      usageDirty.clear()
      usageWatchers.clear()
      overheadReads.clear()
      overheadDirty.clear()
      overheadWatchers.clear()
      prWatchReads.clear()
      prWatchLoaded.clear()
      reminderReads.clear()
      ancillaryAttempts.clear()
      submissionAccepted.clear()
      unsubscribeStream()
      unsubscribeLifecycle()
      unsubscribeConfig()
      unsubscribeReconnect()
    })

    const result = {
      submission: {
        onAccepted(messageID: string, callback: () => void) {
          submissionAccepted.set(messageID, callback)
          return () => {
            submissionAccepted.delete(messageID)
          }
        },
      },
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        /**
         * The root of the tree `sessionID` is in, the key the per-tree slices (`dag`, `dagMode`) are held under (#1290).
         * It walks the parent links one session at a time, so a selector that calls it depends on the sessions of that
         * one chain and does not traverse the whole list.
         */
        root(sessionID: string) {
          return rootOf(sessionID)
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) {
            touchHydrated(sessionID)
            evictHydrated()
            return
          }
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>(), session: false }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const attempt = {}
            ancillaryAttempts.set(sessionID, attempt)
            const load = <T,>(
              kind: "todo" | "session_diff" | "goal",
              request: Promise<{ data?: T }>,
              apply: (value: T | undefined) => void,
            ) => {
              const key = `${sessionID}:${kind}`
              const revision = ancillaryRevision.get(key) ?? 0
              void request
                .then((response) => {
                  if (
                    disposed ||
                    ancillaryAttempts.get(sessionID) !== attempt ||
                    (ancillaryRevision.get(key) ?? 0) !== revision
                  )
                    return
                  setStore("session_load_errors", sessionID, (errors = []) => errors.filter((item) => item !== kind))
                  apply(response.data)
                })
                .catch((error) => {
                  if (
                    disposed ||
                    ancillaryAttempts.get(sessionID) !== attempt ||
                    (ancillaryRevision.get(key) ?? 0) !== revision
                  )
                    return
                  setStore("session_load_errors", sessionID, (errors = []) => [
                    ...errors.filter((item) => item !== kind),
                    kind,
                  ])
                  TuiLog.write("error", `Loading session ${kind} failed`, { sessionID, error: String(error) })
                })
            }
            load("todo", sdk.client.session.todo({ sessionID }, { throwOnError: true }), (value) =>
              setStore("todo", sessionID, value ?? []),
            )
            load("session_diff", sdk.client.session.diff({ sessionID }, { throwOnError: true }), (value) =>
              setStore("session_diff", sessionID, value ?? []),
            )
            load("goal", sdk.client.session.goal({ sessionID }), (value) => setStore("goal", sessionID, value))
            const [session, messages] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: MESSAGE_WINDOW }),
            ])
            if (disposed || ancillaryAttempts.get(sessionID) !== attempt) return
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found && !tracker.session) draft.session[match.index] = session.data
                if (!match.found && !tracker.session) draft.session.splice(match.index, 0, session.data)
                const currentMessages = draft.message[sessionID] ?? []
                const currentMessageByID = new Map(currentMessages.map((item) => [item.id, item]))
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessageByID.get(message.info.id)
                  return current ? [current] : []
                })
                const infoIDs = new Set(infos.map((item) => item.id))
                infos.push(
                  ...currentMessages.filter((message) => tracker.messages.has(message.id) && !infoIDs.has(message.id)),
                )
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const currentPartByID = new Map(currentParts.map((item) => [item.id, item]))
                  const parts = message.parts.flatMap((part) => {
                    const current = currentPartByID.get(part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  const partIDs = new Set(parts.map((item) => item.id))
                  parts.push(...currentParts.filter((part) => tracker.parts.has(part.id) && !partIDs.has(part.id)))
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
              }),
            )
            // A failed reply says nothing about the history; keep the counters.
            if (messages.data) rebuildSummary(sessionID, messages.data.length < MESSAGE_WINDOW)
            fullSyncedSessions.add(sessionID)
            touchHydrated(sessionID)
            evictHydrated()
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
        /**
         * #886 5.4: the only navigation entry point. Registers the session and
         * its parent chain for full events, waits for the worker to confirm,
         * and only then hydrates the snapshot, so events arriving in between
         * are merged idempotently instead of lost.
         */
        async activate(sessionID: string) {
          routeChain = parentChain(sessionID)
          await interest.set("route", routeChain)
          if (disposed) return
          await result.session.sync(sessionID)
          if (disposed) return
          const rootID = routeChain.at(-1) ?? sessionID
          // #1036 F6: the PR watches and the reminders hang off the root of the tree. The lines that show them draw
          // without the reads, so the route does not wait for them; an event or a reconnect keeps them current after.
          void fetchPrWatch([rootID], true)
          void fetchReminder([rootID], true)
          await fetchDagSummaries(sessionTree(rootID), true)
          // The snapshot is for the status band and the /dag panel, which draw without it: the route does not wait.
          wantDagMode()
        },
        deactivate() {
          routeChain = []
          void interest.delete("route").catch(() => {})
          evictHydrated()
        },
      },
      /** Subscribe a refresh function to the single reconnect entry point. */
      onResync,
      /** #1475: the usage of whole task trees, read while a surface watches them (`data.usage`, keyed by root). */
      usage: {
        watch: watchUsage,
      },
      /** #1461: the fixed overhead of a session, read while a surface watches it (`data.overhead`, keyed by session). */
      overhead: {
        watch: watchOverhead,
      },
      /** #1032: the node tables of the workflows the display surfaces show. */
      dag: {
        watch: watchDag,
        /**
         * Read the mode snapshot of the root of the tree `sessionID` is in, unless one is held or on its way. A tree
         * with DAG mode off and no workflow never reads one by itself (see `dagMode`); the `/config` panel asks for it
         * when it opens, because the limits in force are only known to the server (#1290). Held from then on, it is
         * read again with the others after a `dag` configuration change or a reconnect.
         */
        readMode(sessionID: string) {
          void fetchDagMode([rootOf(sessionID)], true)
        },
        /** The loaded node rows of a workflow, or undefined while its table is not loaded. */
        nodes(workflowID: string) {
          const feed = store.dagNodes[workflowID]
          return feed ? DagMerge.snapshotOf(feed)?.nodes : undefined
        },
        /**
         * What the user did in the `/dag` panel, per session tree, keyed by its root session. The panel
         * writes it and the status band reads it to follow the panel; it lives here so both see one
         * answer. Memory only: nothing is sent, and a reconnect leaves it alone.
         */
        focus: {
          /** The workflow the user picked in the panel, if any; it may no longer exist. */
          chosen(rootSessionID: string): string | undefined {
            return store.dag_focus[rootSessionID]?.chosen
          },
          /** The workflows the user opened in the panel. */
          acknowledged(rootSessionID: string): ReadonlySet<string> {
            return new Set(store.dag_focus[rootSessionID]?.acknowledged)
          },
          choose(rootSessionID: string, workflowID: string) {
            if (store.dag_focus[rootSessionID]?.chosen === workflowID) return
            setStore("dag_focus", rootSessionID, (current) => ({
              chosen: workflowID,
              acknowledged: current?.acknowledged ?? [],
            }))
          },
          acknowledge(rootSessionID: string, workflowID: string) {
            if (store.dag_focus[rootSessionID]?.acknowledged.includes(workflowID)) return
            setStore("dag_focus", rootSessionID, (current) => ({
              ...(current?.chosen !== undefined ? { chosen: current.chosen } : {}),
              acknowledged: [...(current?.acknowledged ?? []), workflowID],
            }))
          },
        },
      },
      /** #1040: project-layer trust entries and decisions. */
      trust: {
        refresh: refreshTrust,
        /** #1223: remember the pre-import snapshot; the idle transition diffs it. */
        beginImport: beginTrustImport,
        /** Entries the latest import created or rewrote, awaiting a decision. */
        get importedReview() {
          return trustImportReview()
        },
        clearImportedReview() {
          setTrustImportReview(undefined)
        },
        async decide(decisions: readonly ProjectTrustDecision[]) {
          const workspace = project.workspace.current()
          const response = await sdk.client.project.trust.decide(
            { projectTrustDecideInput: { decisions: [...decisions] } },
            { headers: locationHeaders({ workspace }), throwOnError: true },
          )
          if (response.data) {
            setStore("trust", reconcile(response.data.entries ?? []))
            setStore("trust_loaded", true)
          }
        },
      },
      /** Store snapshot plus un-settled deltas for text/reasoning parts. */
      readPartText(part: Part) {
        // Track the frame version so memos re-read when a delta batch flushes.
        stream.version()
        return stream.read(part)
      },
      /**
       * Output window of a running tool part that its durable snapshot has not
       * caught up with yet (`message.part.preview`, #886 5.3). The overlay
       * only applies while the part is running; a settled part reads the store.
       */
      readPartPreview(part: Part) {
        // Only a running tool part tracks the frame version: a settled part
        // must not re-evaluate its metadata readers on every streamed frame.
        if (part.type !== "tool" || part.state.status !== "running") return undefined
        stream.version()
        return stream.readPreview(part.id)
      },
      /** Subscribes to the per-frame stream version. */
      get streamVersion() {
        return stream.version()
      },
      interest,
      bootstrap,
    }
    return result
  },
})
