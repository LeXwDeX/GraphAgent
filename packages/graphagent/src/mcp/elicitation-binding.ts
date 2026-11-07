import type { Client } from "@modelcontextprotocol/client"
import type { HookPermissionInterrupt } from "@/permission/hook-control"

const hookSource = Symbol("OpenCode MCP hook source")
type HookSource = { sessionID?: string; inHook: true }
export function mcpHookOptions<T extends object>(options: T, sessionID?: string): T {
  return Object.assign({}, options, { [hookSource]: { sessionID, inHook: true } satisfies HookSource })
}
export function mcpHookSource(options: object): HookSource | undefined {
  return (options as { [hookSource]?: HookSource })[hookSource]
}
export interface Binding {
  sessionID?: string
  callID: string
  inHook: boolean
  controller: AbortController
  stopped?: HookPermissionInterrupt
  reverseDepth: number
  children: Set<Promise<void>>
}
interface Waiter {
  grant(): void
}
interface State {
  locked: boolean
  queue: Waiter[]
  active?: Binding
  hookCalls: number
}
const clients = new WeakMap<Client, State>()
function state(client: Client) {
  let current = clients.get(client)
  if (!current) clients.set(client, (current = { locked: false, queue: [], hookCalls: 0 }))
  return current
}
function aborted(signal?: AbortSignal) {
  return signal?.reason ?? new DOMException("MCP call cancelled", "AbortError")
}
function acquire(current: State, signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted(signal))
      return
    }
    const waiter: Waiter = {
      grant() {
        signal?.removeEventListener("abort", cancel)
        let released = false
        resolve(() => {
          if (released) return
          released = true
          const next = current.queue.shift()
          if (next) next.grant()
          else current.locked = false
        })
      },
    }
    const cancel = () => {
      const index = current.queue.indexOf(waiter)
      if (index >= 0) current.queue.splice(index, 1)
      reject(aborted(signal))
    }
    signal?.addEventListener("abort", cancel, { once: true })
    if (current.locked) current.queue.push(waiter)
    else {
      current.locked = true
      waiter.grant()
    }
  })
}

/** Actual-client serialization: legacy reverse requests have no originating tool request id. */
export async function withClientElicitationCall<T>(
  client: Client,
  input: { sessionID?: string; callID: string; signal?: AbortSignal; inHook?: boolean },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const current = state(client)
  // A trusted same-session Elicitation hook can call its own server while the
  // business call awaits the reverse answer. Nested hooks cannot elicit again.
  const reentrant =
    input.inHook &&
    (current.active?.reverseDepth ?? 0) > 0 &&
    input.sessionID !== undefined &&
    current.active?.sessionID === input.sessionID
  const release = reentrant ? () => {} : await acquire(current, input.signal)
  const previous = current.active
  const binding: Binding = {
    sessionID: input.sessionID,
    callID: input.callID,
    inHook: input.inHook === true,
    controller: new AbortController(),
    reverseDepth: 0,
    children: new Set(),
  }
  let childDone: (() => void) | undefined
  const child = reentrant
    ? new Promise<void>((resolve) => {
        childDone = resolve
      })
    : undefined
  if (child) {
    previous!.children.add(child)
    current.hookCalls++
  }
  const signals = [input.signal, ...(reentrant ? [previous?.controller.signal] : [])].filter(
    (value): value is AbortSignal => value !== undefined,
  )
  const listeners = signals.map((signal) => {
    const abort = () => binding.controller.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    return () => signal.removeEventListener("abort", abort)
  })
  if (!reentrant) current.active = binding
  try {
    if (binding.controller.signal.aborted) throw aborted(binding.controller.signal)
    const result = await run(binding.controller.signal)
    if (binding.stopped) throw binding.stopped
    return result
  } catch (error) {
    if (binding.stopped) throw binding.stopped
    throw error
  } finally {
    listeners.forEach((remove) => remove())
    if (reentrant) {
      current.hookCalls--
      previous!.children.delete(child!)
      childDone!()
    } else {
      // Bound hook calls inherit cancellation; do not hand the client to a new
      // session until every nested call has settled.
      await Promise.all(binding.children)
      if (current.active === binding) current.active = undefined
    }
    release()
  }
}

export function clientElicitationBinding(client: Client) {
  const current = clients.get(client)
  return current?.hookCalls ? undefined : current?.active
}
export function stopElicitation(binding: Binding, error: HookPermissionInterrupt) {
  binding.stopped = error
  binding.controller.abort(error)
}
export async function withClientReverseRequest<T>(client: Client, run: () => Promise<T>) {
  const binding = state(client).active
  if (!binding) return run()
  binding.reverseDepth++
  try {
    return await run()
  } finally {
    binding.reverseDepth--
  }
}
