import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { errorMessage } from "../util/error"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

/**
 * A prompt failure response (except "not found", timeout, and throttling) is
 * treated as final for compatibility. Command submissions only become final on
 * an exact accepted message event: a proxy or gateway can return any status or
 * body while the origin still runs the command, so no negative response is
 * treated as proof that the command was cancelled.
 */
function definiteRejection(error: unknown, command: boolean) {
  if (command) return false
  if (!(error instanceof Error)) return false
  const cause = error.cause
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return false
  const status = (cause as { status?: unknown }).status
  if (typeof status !== "number" || status < 400) return false
  return status !== 404 && status !== 408 && status !== 429
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              text: `Agent not found: ${name}`,
              level: "warning",
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
        queued: Record<string, number | undefined>
        commandPending: Record<string, boolean | undefined>
        commandUncertain: Record<string, boolean | undefined>
        uncertainOwner: Record<string, number | undefined>
        uncertain: Record<string, "pending" | "stopping" | "unknown" | undefined>
        sessionVariant: Record<
          string,
          | {
              key: string
              model: { providerID: string; modelID: string }
              savedModel: { providerID: string; modelID: string }
              value: string | undefined
              saved: string | undefined
              dirty: boolean
            }
          | undefined
        >
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
        queued: {},
        commandPending: {},
        commandUncertain: {},
        uncertainOwner: {},
        uncertain: {},
        sessionVariant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      type Model = { providerID: string; modelID: string }
      const snapshot = (model: Model): Model => ({ providerID: model.providerID, modelID: model.modelID })
      type SessionState = {
        tail: Promise<void>
        revision: number
        visibleRevision: number
        visibleOperation?: { revision: number; pending: boolean }
        pending: number
        restoreToken?: object
        restoreController?: AbortController
        reads: Set<AbortController>
        cancel: Set<() => void>
        interrupt: Set<() => void>
        queued: Set<() => void>
      }
      const sessions = new Map<string, SessionState>()
      let disposed = false
      function sessionState(sessionID: string) {
        let state = sessions.get(sessionID)
        if (!state) {
          state = {
            tail: Promise.resolve(),
            revision: 0,
            visibleRevision: 0,
            pending: 0,
            reads: new Set(),
            cancel: new Set(),
            interrupt: new Set(),
            queued: new Set(),
          }
          sessions.set(sessionID, state)
        }
        return state
      }
      function begin(sessionID: string) {
        const state = sessionState(sessionID)
        const current = currentModel()
        if (!modelStore.sessionVariant[sessionID] && current) {
          const persisted = sync.session.get(sessionID)?.model
          const value =
            persisted?.providerID === current.providerID && persisted.id === current.modelID
              ? persisted.variant
              : undefined
          setModelStore("sessionVariant", sessionID, {
            key: `${current.providerID}/${current.modelID}`,
            model: snapshot(current),
            savedModel: snapshot(current),
            value,
            saved: value,
            dirty: true,
          })
        }
        if (modelStore.sessionVariant[sessionID]) setModelStore("sessionVariant", sessionID, "dirty", true)
        const previousVisibleRevision = state.visibleRevision
        const previousVisibleOperation = state.visibleOperation
        const revision = ++state.revision
        state.visibleRevision = revision
        const visibleOperation = { revision, pending: true }
        state.visibleOperation = visibleOperation
        state.pending++
        state.restoreToken = undefined
        state.restoreController?.abort()
        state.restoreController = undefined
        const turn = state.tail
        let release!: () => void
        state.tail = new Promise<void>((resolve) => (release = resolve))
        let done = false
        const valid = () => !disposed && sessions.get(sessionID) === state
        const finish = () => {
          if (done) return
          done = true
          visibleOperation.pending = false
          state.cancel.delete(finish)
          state.pending--
          release()
        }
        state.cancel.add(finish)
        return { state, revision, previousVisibleRevision, previousVisibleOperation, turn, valid, finish }
      }
      function confirmed(
        sessionID: string,
        model: Model,
        variant: string | undefined,
        revision: number,
        agentName?: string,
      ) {
        const state = sessions.get(sessionID)
        if (!state) return
        const previous = modelStore.sessionVariant[sessionID]
        const value = variant
        const visible = state.visibleRevision === revision
        const chosen = visible ? model : (previous?.model ?? model)
        setModelStore("sessionVariant", sessionID, {
          key: `${chosen.providerID}/${chosen.modelID}`,
          model: snapshot(chosen),
          value: visible ? value : previous ? previous.value : value,
          savedModel: snapshot(model),
          saved: value,
          dirty: true,
        })
        if (
          visible &&
          agentName &&
          route.data.type === "session" &&
          route.data.sessionID === sessionID &&
          agent.current()?.name === agentName
        )
          setModelStore("model", agentName, snapshot(model))
      }
      function rollback(sessionID: string, revision: number, agentName?: string) {
        const state = sessions.get(sessionID)
        const previous = modelStore.sessionVariant[sessionID]
        if (!state || state.visibleRevision !== revision || !previous) return
        const model = snapshot(previous.savedModel)
        setModelStore("sessionVariant", sessionID, {
          key: `${model.providerID}/${model.modelID}`,
          model: snapshot(model),
          savedModel: snapshot(model),
          value: previous.saved,
          saved: previous.saved,
          dirty: true,
        })
        if (
          agentName &&
          route.data.type === "session" &&
          route.data.sessionID === sessionID &&
          agent.current()?.name === agentName
        )
          setModelStore("model", agentName, snapshot(model))
      }
      function adoptConfirmed(sessionID: string) {
        const state = sessions.get(sessionID)
        const previous = modelStore.sessionVariant[sessionID]
        if (!state || !previous) return
        // Restore the last server-confirmed model but keep the newest variant
        // choice: interrupting must not undo a later Ctrl+T selection.
        const model = snapshot(previous.savedModel)
        setModelStore("sessionVariant", sessionID, {
          key: `${model.providerID}/${model.modelID}`,
          model: snapshot(model),
          savedModel: snapshot(model),
          value: previous.value,
          saved: previous.saved,
          dirty: true,
        })
        const agentName = agent.current()?.name
        if (agentName && route.data.type === "session" && route.data.sessionID === sessionID)
          setModelStore("model", agentName, snapshot(model))
      }
      function drop(sessionID: string) {
        const state = sessions.get(sessionID)
        if (state) {
          sessions.delete(sessionID)
          for (const read of state.reads) read.abort()
          for (const cancel of state.cancel) cancel()
        }
        setModelStore("sessionVariant", sessionID, undefined)
        setModelStore("commandPending", sessionID, undefined)
        setModelStore("commandUncertain", sessionID, undefined)
        setModelStore("uncertainOwner", sessionID, undefined)
        setModelStore("uncertain", sessionID, undefined)
      }
      const offDeleted = useEvent().on("session.deleted", (event) => drop(event.properties.info.id))
      onCleanup(() => {
        disposed = true
        offDeleted()
        for (const sessionID of sessions.keys()) drop(sessionID)
      })
      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((item) => item.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          void this.set({ ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              text: "Add a favorite model to use this shortcut",
              level: "info",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          void this.set({ ...next }, { recent: true })
        },
        set(
          model: { providerID: string; modelID: string },
          options?: { recent?: boolean; source?: "picker" | "command" },
        ) {
          model = snapshot(model)
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          const agentName = agent.current()?.name
          const matchesSelection = () =>
            (route.data.type === "session" ? route.data.sessionID : undefined) === sessionID &&
            agent.current()?.name === agentName
          if (!isModelValid(model)) {
            toast.show({
              text: `Model ${model.providerID}/${model.modelID} is not valid`,
              level: "warning",
              duration: 3000,
            })
            return Promise.resolve(false)
          }
          if (!sessionID) {
            if (!agentName) return Promise.resolve(false)
            setModelStore("model", agentName, snapshot(model))
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
            return Promise.resolve(true)
          }
          const operation = begin(sessionID)
          return operation.turn.then(async () => {
            if (!operation.valid()) return false
            try {
              await sdk.client.session.setModel(
                {
                  sessionID,
                  model,
                  source: options?.source ?? "picker",
                  hookMode: "interactive",
                },
                { throwOnError: true },
              )
              if (!operation.valid()) return false
              confirmed(sessionID, model, "default", operation.revision, agentName)
              if (matchesSelection() && operation.state.visibleRevision === operation.revision && options?.recent) {
                setModelStore("recent", recentModels(model, modelStore.recent))
                save()
              }
              return matchesSelection() && operation.state.visibleRevision === operation.revision
            } catch (error) {
              if (operation.valid()) rollback(sessionID, operation.revision, agentName)
              if (operation.valid() && operation.state.visibleRevision === operation.revision && matchesSelection())
                toast.show({
                  text: errorMessage(error),
                  level: "warning",
                  duration: 5000,
                })
              return false
            } finally {
              operation.finish()
            }
          })
        },
        submit(input: {
          sessionID: string
          model: Model
          variant: string | undefined
          messageID: string
          command: boolean
          send: () => Promise<unknown>
          accepted: () => void
          failed: (error: unknown) => void
          /** Restores the submitted draft after an unconfirmed interruption without claiming failure. */
          interrupted?: () => void
        }) {
          const { sessionID, model, variant, messageID } = input
          const agentName = agent.current()?.name
          const operation = begin(sessionID)
          let settled = false
          let interrupted = false
          let sent = false
          let unsubscribe = () => {}
          const uncertain = (stopping = false) => {
            if (!operation.valid() || settled) return
            setModelStore("uncertainOwner", sessionID, operation.revision)
            setModelStore("uncertain", sessionID, stopping ? "stopping" : "unknown")
            if (input.command) setModelStore("commandUncertain", sessionID, true)
          }
          // Only the operation that currently owns the session-level uncertainty
          // may clear it. A late ordinary-prompt response must not erase a newer
          // command's unknown state.
          const clearUncertain = () => {
            if (modelStore.uncertainOwner[sessionID] !== operation.revision) return
            setModelStore("uncertainOwner", sessionID, undefined)
            setModelStore("uncertain", sessionID, undefined)
          }
          const unqueue = () => {
            if (!operation.state.queued.delete(onInterrupt)) return
            setModelStore("queued", sessionID, operation.state.queued.size || undefined)
          }
          const remove = () => {
            unsubscribe()
            operation.state.cancel.delete(onDelete)
            operation.state.interrupt.delete(onInterrupt)
          }
          const cancel = (message: string) => {
            if (settled) return
            settled = true
            unqueue()
            remove()
            if (operation.state.visibleRevision === operation.revision) {
              const previous = operation.previousVisibleOperation
              if (operation.valid() && !(previous?.pending && previous.revision === operation.previousVisibleRevision))
                rollback(sessionID, operation.revision, agentName)
              operation.state.visibleRevision = operation.previousVisibleRevision
              operation.state.visibleOperation = previous
            }
            // A cancelled queued operation must not release later work before its predecessor.
            void operation.turn.then(operation.finish)
            if (!disposed) input.failed(new Error(message))
          }
          const onDelete = () => cancel("Session was deleted before submission completed")
          const onInterrupt = () => {
            if (settled) return
            if (interrupted) return
            if (!sent) {
              cancel("Submission interrupted before it was sent")
              return
            }
            if (!operation.valid()) return
            // The visible model falls back to the last confirmed server write,
            // while the latest unsent variant selection stays visible.
            adoptConfirmed(sessionID)
            interrupted = true
            input.interrupted?.()
            if (input.command) {
              // Only this command's own response confirms its outcome. An abort
              // or a local signal cannot release later model writes early, so
              // keep its queue slot until the request settles. Never downgrade
              // an already observed unknown to the weaker stopping marker.
              if (modelStore.uncertain[sessionID] !== "unknown") uncertain(true)
              return
            }
            // The prompt's own HTTP response (or an explicit idle observation)
            // is its terminal evidence. Keep the accepted listener and the
            // truthful unknown state until then; do not claim it was cancelled.
            unqueue()
            setModelStore("uncertain", sessionID, "stopping")
            operation.finish()
          }
          operation.state.cancel.add(onDelete)
          operation.state.interrupt.add(onInterrupt)
          operation.state.queued.add(onInterrupt)
          setModelStore("queued", sessionID, operation.state.queued.size)

          const complete = () => {
            if (settled) return
            settled = true
            clearUncertain()
            if (input.command) {
              setModelStore("commandPending", sessionID, undefined)
              setModelStore("commandUncertain", sessionID, undefined)
            }
            remove()
            try {
              input.accepted()
            } finally {
              if (!operation.valid() || interrupted) {
                // A late acceptance of an interrupted command must not confirm
                // its old model state; just release the queue for newer work.
                operation.finish()
              } else if (!input.command && variant !== undefined) {
                try {
                  confirmed(sessionID, model, variant, operation.revision, agentName)
                } finally {
                  operation.finish()
                }
              } else {
                const controller = new AbortController()
                operation.state.reads.add(controller)
                void sdk.client.session
                  .get({ sessionID }, { throwOnError: true, signal: controller.signal })
                  .then((result) => {
                    if (!operation.valid() || !result.data?.model) return
                    const saved = result.data.model
                    confirmed(
                      sessionID,
                      { providerID: saved.providerID, modelID: saved.id },
                      saved.variant,
                      operation.revision,
                      agentName,
                    )
                  })
                  .catch(() => {})
                  .finally(() => {
                    operation.state.reads.delete(controller)
                    operation.finish()
                  })
              }
            }
          }

          void operation.turn.then(() => {
            if (!operation.valid() || settled) return
            unsubscribe = sync.submission.onAccepted(messageID, complete)
            void Promise.resolve()
              .then(() => {
                if (!operation.valid() || settled) return
                unqueue()
                sent = true
                if (input.command) setModelStore("commandPending", sessionID, true)
                setModelStore("uncertainOwner", sessionID, operation.revision)
                setModelStore("uncertain", sessionID, "pending")
                return input.send()
              })
              .then(() => {
                if (operation.valid()) complete()
              })
              .catch((error) => {
                if (settled) return
                if (interrupted) {
                  if (!definiteRejection(error, input.command)) {
                    uncertain()
                    return
                  }
                  settled = true
                  unqueue()
                  remove()
                  clearUncertain()
                  if (input.command) {
                    setModelStore("commandPending", sessionID, undefined)
                    setModelStore("commandUncertain", sessionID, undefined)
                  }
                  operation.finish()
                  input.failed(error)
                  return
                }
                if (sent) {
                  if (definiteRejection(error, input.command)) {
                    settled = true
                    unqueue()
                    remove()
                    clearUncertain()
                    if (input.command) {
                      setModelStore("commandPending", sessionID, undefined)
                      setModelStore("commandUncertain", sessionID, undefined)
                    }
                    if (operation.valid()) rollback(sessionID, operation.revision, agentName)
                    operation.finish()
                    input.failed(error)
                    return
                  }
                  uncertain()
                  return
                }
                settled = true
                unqueue()
                remove()
                if (operation.valid()) rollback(sessionID, operation.revision, agentName)
                operation.finish()
                input.failed(error)
              })
          })
        },
        interrupt(sessionID: string) {
          for (const cancel of Array.from(sessions.get(sessionID)?.interrupt ?? []).reverse()) cancel()
        },
        queued(sessionID: string) {
          return (modelStore.queued[sessionID] ?? 0) > 0
        },
        uncertain(sessionID: string) {
          return modelStore.uncertain[sessionID]
        },
        interruptQueued(sessionID: string) {
          for (const cancel of Array.from(sessions.get(sessionID)?.queued ?? []).reverse()) cancel()
        },
        commandActive(sessionID: string) {
          return Boolean(modelStore.commandPending[sessionID] || modelStore.commandUncertain[sessionID])
        },
        acknowledgePromptInterrupt(sessionID: string) {
          // Only an ordinary prompt's local stopping marker is acknowledged.
          // Command uncertainty stays until its own accepted/terminal evidence.
          if (modelStore.commandPending[sessionID] || modelStore.commandUncertain[sessionID]) return
          if (modelStore.uncertain[sessionID] === "stopping") {
            setModelStore("uncertainOwner", sessionID, undefined)
            setModelStore("uncertain", sessionID, undefined)
          }
        },
        // Mirrors an already-persisted session model into the local per-agent cache.
        // It sends no setModel request, so no model-switch hook runs and the server
        // value is not overwritten; it also leaves recents and toasts untouched.
        restore(model: { providerID: string; modelID: string; variant?: string }) {
          const a = agent.current()
          if (!a || !isModelValid(model)) return false
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          batch(() => {
            const key = `${model.providerID}/${model.modelID}`
            const existing = sessionID ? modelStore.sessionVariant[sessionID] : undefined
            const value = model.variant
            if (sessionID && existing?.dirty) {
              setModelStore("model", a.name, snapshot(existing.model))
              const state = sessionState(sessionID)
              if (state.pending) return
              const token = {}
              const revision = state.revision
              state.restoreController?.abort()
              const controller = new AbortController()
              state.restoreController = controller
              state.reads.add(controller)
              state.restoreToken = token
              void sdk.client.session
                .get({ sessionID }, { throwOnError: true, signal: controller.signal })
                .then((result) => {
                  if (
                    disposed ||
                    sessions.get(sessionID) !== state ||
                    state.restoreToken !== token ||
                    state.revision !== revision ||
                    state.pending
                  )
                    return
                  const saved = result.data?.model
                  if (!saved) return
                  const fresh = { providerID: saved.providerID, modelID: saved.id }
                  if (!isModelValid(fresh)) return
                  const selected = saved.variant
                  batch(() => {
                    setModelStore("sessionVariant", sessionID, {
                      key: `${fresh.providerID}/${fresh.modelID}`,
                      model: snapshot(fresh),
                      savedModel: snapshot(fresh),
                      value: selected,
                      saved: selected,
                      dirty: true,
                    })
                    if (
                      route.data.type === "session" &&
                      route.data.sessionID === sessionID &&
                      agent.current()?.name === a.name
                    )
                      setModelStore("model", a.name, snapshot(fresh))
                  })
                })
                .catch(() => {})
                .finally(() => {
                  state.reads.delete(controller)
                  if (state.restoreController === controller) state.restoreController = undefined
                })
              return
            }
            const restoredModel = { providerID: model.providerID, modelID: model.modelID }
            setModelStore("model", a.name, snapshot(restoredModel))
            if (sessionID)
              setModelStore("sessionVariant", sessionID, {
                key,
                model: snapshot(restoredModel),
                savedModel: snapshot(restoredModel),
                value,
                saved: value,
                dirty: false,
              })
          })
          return true
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                text: `Model ${model.providerID}/${model.modelID} is not valid`,
                level: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
            const selected = sessionID ? modelStore.sessionVariant[sessionID] : undefined
            if (selected?.key === key) return selected.value
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((item) => item.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
            const next = value ?? "default"
            if (!sessionID) {
              setModelStore("variant", key, next)
              save()
              return
            }
            const previous = modelStore.sessionVariant[sessionID]
            const persisted = sync.session.get(sessionID)?.model
            const saved = previous
              ? previous.saved
              : persisted?.providerID === m.providerID && persisted.id === m.modelID
                ? persisted.variant
                : undefined
            const operation = begin(sessionID)
            const agentName = agent.current()?.name
            const selectedModel = { providerID: m.providerID, modelID: m.modelID }
            const savedModel = previous?.savedModel ?? selectedModel
            setModelStore("sessionVariant", sessionID, {
              key,
              model: snapshot(selectedModel),
              savedModel: snapshot(savedModel),
              value: next,
              saved,
              dirty: true,
            })
            const bypassQueue =
              Boolean(modelStore.commandPending[sessionID]) || Boolean(modelStore.commandUncertain[sessionID])
            const send = async () => {
              if (!operation.valid()) return
              try {
                await sdk.client.session.setModel(
                  {
                    sessionID,
                    model: selectedModel,
                    variant: next,
                    source: "picker",
                    hookMode: "interactive",
                  },
                  { throwOnError: true },
                )
                if (operation.valid()) confirmed(sessionID, selectedModel, next, operation.revision, agentName)
              } catch (error) {
                if (operation.valid()) rollback(sessionID, operation.revision, agentName)
                if (
                  operation.valid() &&
                  operation.state.visibleRevision === operation.revision &&
                  route.data.type === "session" &&
                  route.data.sessionID === sessionID &&
                  agent.current()?.name === agentName
                ) {
                  toast.show({
                    text: errorMessage(error),
                    level: "warning",
                    duration: 5000,
                  })
                }
              } finally {
                // Bypassing the command queue must not release the commands and
                // prompts queued behind that command. Keep this operation's turn
                // until the command settles, then release the queue in order.
                if (bypassQueue) await operation.turn.catch(() => {})
                operation.finish()
              }
            }
            // An explicit model write is the user's current intent: do not hold
            // it behind an unconfirmed submission. The server-side causal fence
            // prevents that old command from overwriting this newer selection.
            if (bypassQueue) void send()
            else void operation.turn.then(send)
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const event = useEvent()

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        text: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        level: "warning",
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
    }
    return result
  },
})
