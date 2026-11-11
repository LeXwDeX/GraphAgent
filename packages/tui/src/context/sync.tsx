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
  ReferenceInfo,
  ProjectTrustEntry,
  ProjectTrustDecision,
  Event as SdkEvent,
} from "@graphagent/sdk"

export type { DagWorkflowSummary }
import { createStore, produce, reconcile } from "solid-js/store"
import { createEventGate } from "./event-gate"
import { createInterestAggregator } from "./interest"
import { createStreamBuffer } from "./stream-buffer"
import { importedEntryIds, snapshotTrust, type TrustSnapshot } from "./trust-import"
import {
  createSummary,
  HYDRATED_MAX,
  mergeSession,
  mergeStatus,
  mergeToolPart,
  taskIndexEntry,
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
import { batch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { TuiLog } from "../util/log"

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
      summary: {
        [sessionID: string]: SessionSummary
      }
      /** LRU order, most recently hydrated first. */
      hydrated: string[]
      taskIndex: {
        [childSessionID: string]: TaskIndexEntry
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
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      dag: {},
      summary: {},
      hydrated: [],
      taskIndex: {},
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
          writeSummary(sessionID, mergeStatus(summaryRaw.get(sessionID), sessionID, status))
          break
        }
        case "session.idle": {
          const sessionID = event.properties.sessionID
          writeSummary(sessionID, mergeStatus(summaryRaw.get(sessionID), sessionID, { type: "idle" }))
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
          if (task) setStore("taskIndex", task.childSessionID, reconcile(task.entry))
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
      const keep: string[] = []
      const drop: string[] = []
      for (const sessionID of store.hydrated) {
        if (keep.length < limit || protectedSessions.has(sessionID)) keep.push(sessionID)
        else drop.push(sessionID)
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
      const messages = store.message[sessionID] ?? []
      const partIDs = messages.flatMap((message) => (store.part[message.id] ?? []).map((part) => part.id))
      stream.clearParts(partIDs)
      summarySeen.delete(sessionID)
      summaryRaw.delete(sessionID)
      ancillaryAttempts.delete(sessionID)
      fullSyncedSessions.delete(sessionID)
      syncingSessions.delete(sessionID)
      hydratingSessions.delete(sessionID)
      setStore(
        produce((draft) => {
          for (const message of draft.message[sessionID] ?? []) delete draft.part[message.id]
          delete draft.message[sessionID]
          delete draft.summary[sessionID]
          delete draft.permission[sessionID]
          delete draft.question[sessionID]
          delete draft.todo[sessionID]
          delete draft.goal[sessionID]
          delete draft.session_diff[sessionID]
          delete draft.dag[sessionID]
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
        .filter((session) => !session.parentID)
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
              .then((x) => setStore("dag", session.id, reconcile(x.data ?? [])))
              .catch(() => {}),
          ),
      )
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
          break

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
            setStore("session", result.index, reconcile(event.properties.info))
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
          const { messageID, partID, tail, totalLength } = event.properties
          const parts = store.part[messageID]
          if (!parts) break
          const result = search(parts, partID, (p) => p.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, partID)
          // Non-durable running preview (#1016 HS4a): replace the tool output
          // in place. The next durable part snapshot supersedes it.
          setStore(
            "part",
            messageID,
            produce((draft) => {
              const part = draft.find((item) => item.id === partID)
              if (!part || part.type !== "tool" || part.state.status !== "running") return
              part.state.metadata = {
                ...(part.state.metadata ?? {}),
                output: tail,
                previewTotalLength: totalLength,
              }
            }),
          )
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
            .then((x) => setStore("dag", sessionID, reconcile(x.data ?? [])))
            .catch(() => {}),
        ),
      ).then(() => undefined)
    }

    // #349/F3: goal.updated/goal.cleared are ephemeral (not in the durable
    // replay set), so a goal.cleared missed during a disconnect would leave
    // a stale goal in the sidebar indefinitely — the reconnect hook must
    // refresh goals too, symmetric with refreshDagSummaries. Only sessions
    // with a stored goal can go stale; a missing goal has nothing to clear.
    let goalReconnectInFlight = false
    const refreshGoals = (): Promise<void> => {
      const sessionIDs = Object.keys(store.goal)
      if (sessionIDs.length === 0) return Promise.resolve()
      return Promise.all(
        sessionIDs.map((sessionID) =>
          sdk.client.session
            .goal({ sessionID }, { throwOnError: false })
            .then((response) => {
              if (response.data) setStore("goal", sessionID, response.data)
              else if (response.response?.status === 404) setStore("goal", sessionID, undefined)
            })
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
    const guardedRefreshGoals = (): Promise<void> => {
      if (goalReconnectInFlight) return Promise.resolve()
      goalReconnectInFlight = true
      return refreshGoals().finally(() => {
        goalReconnectInFlight = false
      })
    }

    // #1040: project-layer trust is global state. The change event only names
    // ids, so every notification re-reads the snapshot rather than merging.
    const refreshTrust = (): Promise<void> => {
      const workspace = project.workspace.current()
      return sdk.client.project.trust
        .list({ headers: locationHeaders({ workspace }) })
        .then((x) => {
          setStore("trust", reconcile(x.data?.entries ?? []))
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
    onResync(guardedRefreshDagSummaries)
    onResync(guardedRefreshGoals)
    onResync(refreshTrust)

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
      ancillaryAttempts.clear()
      submissionAccepted.clear()
      unsubscribeStream()
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
              sdk.client.session.messages({ sessionID, limit: 100 }),
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
          await fetchDagSummaries(sessionTree(rootID), true)
        },
        deactivate() {
          routeChain = []
          void interest.delete("route").catch(() => {})
          evictHydrated()
        },
      },
      /** Subscribe a refresh function to the single reconnect entry point. */
      onResync,
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
