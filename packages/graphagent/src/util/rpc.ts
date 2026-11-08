type Definition = {
  [method: string]: (input: any) => any
}

type EventDefinition = {
  [event: string]: unknown
}

export function listen<T extends Definition>(rpc: T) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      // Propagate handler failures to the caller instead of letting them
      // escape as unhandledRejection while the client promise hangs forever.
      try {
        const handler = rpc[parsed.method] as ((input: unknown) => unknown) | undefined
        if (typeof handler !== "function") throw new Error(`RpcMethodNotFound: ${parsed.method}`)
        const result = await handler(parsed.input)
        postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        postMessage(JSON.stringify({ type: "rpc.result", error: message, id: parsed.id }))
      }
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition, E extends EventDefinition = EventDefinition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const entry = pending.get(parsed.id)
      if (entry) {
        pending.delete(parsed.id)
        if (typeof parsed.error === "string") entry.reject(new Error(parsed.error))
        else entry.resolve(parsed.result)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T & string>(
      method: Method,
      ...args: Parameters<T[Method]>
    ): Promise<Awaited<ReturnType<T[Method]>>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input: args[0], id: requestId }))
      })
    },
    on<Event extends keyof E & string>(event: Event, handler: (data: E[Event]) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler as (data: any) => void)
      return () => {
        handlers!.delete(handler as (data: any) => void)
      }
    },
  }
}

export * as Rpc from "./rpc"
