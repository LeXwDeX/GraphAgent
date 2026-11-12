/**
 * Method-syntax signatures keep parameters bivariant (strictFunctionTypes
 * exempts methods), so concrete handlers with precise inputs stay assignable
 * while the transport can dispatch `unknown` without an assertion.
 */
type RpcMethod = {
  handle(input: unknown, context: RpcContext): unknown
}["handle"]

/** Bivariant event handler shape used by the listener map. */
type EventHandler = {
  handle(data: unknown): void
}["handle"]

/** Bivariant promise resolver shape used by the pending-call map. */
type Settle = {
  settle(result: unknown): void
}["settle"]

type Definition = {
  readonly [method: string]: RpcMethod
}

type EventDefinition = {
  readonly [event: string]: unknown
}

export type RpcContext = {
  readonly signal: AbortSignal
}

export type RpcError = {
  name: string
  message: string
  status?: number
  data?: unknown
  stack?: string
}

export type RpcCallOptions = {
  signal?: AbortSignal
}

type RequestFrame = { t: "req"; id: number; method: string; input: unknown }
type CancelFrame = { t: "cancel"; id: number }
type ResponseFrame =
  { t: "res"; id: number; ok: true; result: unknown } | { t: "res"; id: number; ok: false; error: RpcError }
type EventFrame = { t: "evt"; name: string; data: unknown }
type FromWorker = ResponseFrame | EventFrame

export type ListenTransport = {
  postMessage(data: unknown, transfer?: Transferable[]): void
  receive(handler: (data: unknown) => void): void
}

/** Error raised in the client when the worker reports a structured failure. */
export class RpcWorkerError extends Error {
  readonly status?: number
  readonly data?: unknown

  constructor(error: RpcError) {
    super(error.message)
    this.name = error.name
    if (error.status !== undefined) this.status = error.status
    if ("data" in error) this.data = error.data
    if (error.stack) this.stack = error.stack
  }
}

/** Error raised in the client when the caller's AbortSignal stops the call. */
export class RpcAbortError extends Error {
  constructor() {
    super("The RPC call was aborted")
    this.name = "AbortError"
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof Error) {
    const value = error as Error & { status?: unknown; data?: unknown }
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      ...("data" in value ? { data: value.data } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return { name: "Error", message: String(error) }
}

function postFrame(frame: unknown, transfer?: Transferable[]) {
  const post = (globalThis as unknown as { postMessage?: (data: unknown, transfer?: Transferable[]) => void })
    .postMessage
  if (!post) return
  if (transfer?.length) post(frame, transfer)
  else post(frame)
}

/**
 * A frame can carry a response body as a `Uint8Array`. Transfer its buffer so
 * the bytes are not copied across the worker boundary; the handler constructs
 * a fresh buffer per response, so detaching it is safe.
 */
function responseTransfer(result: unknown): Transferable[] | undefined {
  if (!result || typeof result !== "object" || !("body" in result)) return
  const body = (result as { body?: unknown }).body
  if (!(body instanceof Uint8Array) || !(body.buffer instanceof ArrayBuffer)) return
  return [body.buffer]
}

export function listen<T extends Definition>(rpc: T, transport?: ListenTransport) {
  const controllers = new Map<number, AbortController>()
  const receive =
    transport?.receive ??
    ((handler: (data: unknown) => void) => {
      onmessage = (evt: MessageEvent) => handler(evt.data)
    })
  const post: (data: unknown, transfer?: Transferable[]) => void = transport
    ? (data, transfer) => transport.postMessage(data, transfer)
    : postFrame

  const handle = async (frame: RequestFrame) => {
    const controller = new AbortController()
    controllers.set(frame.id, controller)
    try {
      const handler = rpc[frame.method]
      if (typeof handler !== "function") {
        const error = new Error(`Unknown RPC method: ${frame.method}`)
        error.name = "RpcMethodNotFound"
        throw error
      }
      // The frame input is unknown at the transport boundary; the concrete
      // handler owns validation and the table type carries no `any`.
      const result = await handler(frame.input, { signal: controller.signal })
      post({ t: "res", id: frame.id, ok: true, result }, responseTransfer(result))
    } catch (error) {
      // Propagate handler failures to the caller instead of letting them
      // escape as unhandledRejection while the client promise hangs forever.
      post({ t: "res", id: frame.id, ok: false, error: toRpcError(error) })
    } finally {
      controllers.delete(frame.id)
    }
  }

  receive((data) => {
    const frame = data as RequestFrame | CancelFrame
    if (frame?.t === "cancel") {
      controllers.get(frame.id)?.abort()
      return
    }
    if (frame?.t !== "req") return
    void handle(frame)
  })
}

/**
 * Events cross the worker boundary through structured clone. The pump encodes
 * every schema-backed payload to its wire shape before emitting, so a value
 * that cannot be cloned is a bridge contract violation, not something to
 * normalize with a JSON round trip.
 */
export function cloneEventData(data: unknown): unknown {
  return structuredClone(data)
}

export function emit(event: string, data: unknown) {
  postFrame({ t: "evt", name: event, data: cloneEventData(data) })
}

export type RpcClient<T extends Definition, E extends EventDefinition> = {
  call<Method extends keyof T & string>(
    method: Method,
    ...args: CallArgs<T[Method]>
  ): Promise<Awaited<ReturnType<T[Method]>>>
  on<Event extends keyof E & string>(event: Event, handler: (data: E[Event]) => void): () => void
}

type CallArgs<F> = F extends (...args: never[]) => unknown
  ? Parameters<F> extends []
    ? [input?: undefined, options?: RpcCallOptions]
    : [input: Parameters<F>[0], options?: RpcCallOptions]
  : never

export function client<T extends Definition, E extends EventDefinition = EventDefinition>(target: {
  postMessage: (data: unknown) => void | null
  onmessage: ((ev: MessageEvent<unknown>) => unknown) | null
}): RpcClient<T, E> {
  const pending = new Map<
    number,
    { resolve: Settle; reject: (error: Error) => void; cleanup: () => void }
  >()
  // Handlers are keyed by event name and receive the contract's typed payload;
  // the transport frame itself is unknown until dispatch.
  const listeners = new Map<string, Set<EventHandler>>()
  let id = 0
  target.onmessage = (evt) => {
    const frame = evt.data as FromWorker
    if (frame?.t === "res") {
      const entry = pending.get(frame.id)
      if (!entry) return
      pending.delete(frame.id)
      entry.cleanup()
      if (frame.ok) entry.resolve(frame.result)
      else entry.reject(new RpcWorkerError(frame.error))
    }
    if (frame?.t === "evt") {
      const handlers = listeners.get(frame.name)
      if (handlers) {
        for (const handler of handlers) {
          handler(frame.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T & string>(method: Method, ...args: CallArgs<T[Method]>) {
      const [input, options] = args as [unknown, RpcCallOptions?]
      const requestId = id++
      return new Promise<Awaited<ReturnType<T[Method]>>>((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) {
          reject(new RpcAbortError())
          return
        }
        const abort = () => {
          if (!pending.delete(requestId)) return
          reject(new RpcAbortError())
          target.postMessage({ t: "cancel", id: requestId } satisfies CancelFrame)
        }
        signal?.addEventListener("abort", abort, { once: true })
        pending.set(requestId, {
          // The promise's generic is the caller's typed view of the untyped frame.
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener("abort", abort),
        })
        target.postMessage({ t: "req", method, input, id: requestId } satisfies RequestFrame)
      })
    },
    on<Event extends keyof E & string>(event: Event, handler: (data: E[Event]) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
