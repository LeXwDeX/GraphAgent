export type SessionAttentionUpdate = {
  sessionID: string
  clientID: string
  clientType: "terminal" | "web"
  activity?: number
  backgroundView?: boolean
  closed?: boolean
}

/** A client lifetime, with ordered updates and no typed content in its payload. */
export function createSessionAttention(input: {
  clientType: SessionAttentionUpdate["clientType"]
  send: (update: SessionAttentionUpdate, signal: AbortSignal) => Promise<unknown>
}) {
  type Client = { sessionID: string; clientID: string; activity: number; view: boolean }
  let current: Client | undefined
  let disposed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let typing: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string, SessionAttentionUpdate>()
  let sending: Promise<void> | undefined
  let active: { update: SessionAttentionUpdate; cancel: () => void } | undefined
  let closing: Promise<void> | undefined
  let closeDeadline: number | undefined

  // A transport can ignore AbortSignal. The gate still releases our queue and
  // resources; both late outcomes are observed without changing client state.
  const transmit = (update: SessionAttentionUpdate) =>
    new Promise<void>((resolve) => {
      const controller = new AbortController()
      // Share the close deadline across queued closes so one stalled old
      // client cannot consume every remaining notification opportunity.
      const remaining = closeDeadline === undefined ? 2_000 : (closeDeadline - Date.now()) / (pending.size + 1)
      const budget = Math.max(0, Math.min(2_000, Math.floor(remaining)))
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.signal.removeEventListener("abort", finish)
        if (active === request) active = undefined
        resolve()
      }
      const request = {
        update,
        cancel: () => {
          controller.abort()
          finish()
        },
      }
      const timer = setTimeout(request.cancel, budget)
      active = request
      controller.signal.addEventListener("abort", finish, { once: true })
      if (budget === 0) {
        request.cancel()
        return
      }
      void Promise.resolve()
        .then(() => {
          if (!controller.signal.aborted) return input.send(update, controller.signal)
          return undefined
        })
        .then(finish, finish)
    })

  const drain = () => {
    if (sending) return
    sending = (async () => {
      while (pending.size) {
        const next = pending.values().next().value
        if (!next) break
        pending.delete(next.clientID)
        if (closeDeadline !== undefined && Date.now() >= closeDeadline) {
          pending.clear()
          break
        }
        await transmit(next)
      }
    })().finally(() => {
      sending = undefined
      if (pending.size) drain()
    })
  }
  const post = (client: Client, closed = false) => {
    pending.set(client.clientID, {
      sessionID: client.sessionID,
      clientID: client.clientID,
      clientType: input.clientType,
      ...(client.activity > 0 ? { activity: client.activity } : {}),
      backgroundView: closed ? false : client.view,
      ...(closed ? { closed: true } : {}),
    })
    drain()
  }
  const clearTimers = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (typing !== undefined) clearTimeout(typing)
    heartbeat = undefined
    typing = undefined
  }
  const renew = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = current?.view
      ? setInterval(() => {
          if (current) post(current)
        }, 15_000)
      : undefined
  }
  const view = (visible: boolean) => {
    if (!current || disposed || current.view === visible) return
    current.view = visible
    renew()
    post(current)
  }
  return {
    select(sessionID?: string, backgroundView = false) {
      if (disposed) return
      if (current?.sessionID === sessionID) {
        view(backgroundView)
        return
      }
      clearTimers()
      if (current) post(current, true)
      current = sessionID ? { sessionID, clientID: crypto.randomUUID(), activity: 0, view: backgroundView } : undefined
      if (current) post(current)
      renew()
    },
    activity() {
      if (!current || disposed) return
      current.activity++
      if (typing !== undefined) return
      const client = current
      const sent = client.activity
      post(client)
      typing = setTimeout(() => {
        typing = undefined
        if (current === client && client.activity !== sent) post(client)
      }, 100)
    },
    view,
    close(): Promise<void> {
      if (closing) return closing
      disposed = true
      clearTimers()
      closeDeadline = Date.now() + 2_000
      // Preserve previously queued closes, but discard stale presence/activity.
      const closes = [...pending.values()].filter((update) => update.closed)
      if (active?.update.closed) closes.unshift(active.update)
      pending.clear()
      for (const update of closes) pending.set(update.clientID, update)
      active?.cancel()
      if (current) post(current, true)
      current = undefined
      closing = (async () => {
        for (;;) {
          const next = sending
          if (!next) break
          await next
        }
        pending.clear()
        active?.cancel()
      })()
      return closing
    },
  }
}
