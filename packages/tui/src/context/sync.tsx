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
  ConsoleState,
  Goal,
  DagWorkflowSummary,
} from "@opencode-ai/sdk/v2"

export type { DagWorkflowSummary }
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { TuiLog } from "../util/log"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
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
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
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
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
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
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

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

    event.subscribe((event, { workspace }) => {
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
          ancillaryAttempts.delete(event.properties.info.id)
          fullSyncedSessions.delete(event.properties.info.id)
          const result = search(store.session, event.properties.info.id, (s) => s.id)
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
          setStore("session_status", event.properties.sessionID, event.properties.status)
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
          touchPart(event.properties.part.sessionID, event.properties.part.id)
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
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
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
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
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
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          if (disposed || attempt !== bootstrapAttempt) return undefined
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (disposed || attempt !== bootstrapAttempt) return
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => {
              if (!disposed && attempt === bootstrapAttempt) setStore("console_state", reconcile(consoleState))
            }),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
            // DAG summaries: fetch per visible session as the initial baseline.
            // The summary publisher's ephemeral events keep these fresh thereafter;
            // this fetch is the safety net for events missed before subscribe.
            // Chained off sessionListPromise so store.session is populated first,
            // and runs on both fresh start and --continue.
            sessionListPromise.then((sessions) =>
              Promise.all(
                sessions.map((s) =>
                  sdk.client.dag
                    .summary({ sessionID: s.id, workspace })
                    .then((x) => setStore("dag", s.id, reconcile(x.data ?? [])))
                    .catch(() => {}),
                ),
              ),
            ),
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
            .summary({ sessionID, workspace })
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
    const unsubscribeReconnect = sdk.event.on("reconnected", () => {
      if (dagReconnectInFlight) return
      dagReconnectInFlight = true
      refreshDagSummaries().finally(() => {
        dagReconnectInFlight = false
      })
      if (goalReconnectInFlight) return
      goalReconnectInFlight = true
      void refreshGoals().finally(() => {
        goalReconnectInFlight = false
      })
    })

    onMount(() => {
      void bootstrap()
    })

    onCleanup(() => {
      disposed = true
      ancillaryAttempts.clear()
      submissionAccepted.clear()
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
          if (fullSyncedSessions.has(sessionID)) return
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
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
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
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
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
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
