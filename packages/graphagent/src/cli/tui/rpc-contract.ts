import type { GlobalEvent } from "@graphagent/sdk/v2"

/**
 * The typed contract between the TUI launcher and its worker.
 *
 * Keep this module free of runtime imports: both sides use it only for types,
 * so a drift between `Rpc.listen` and `Rpc.client` fails at typecheck instead
 * of at runtime as a `TypeError` on an unknown method.
 */

export type RpcError = {
  name: string
  message: string
  status?: number
  data?: unknown
  stack?: string
}

// PR1 keeps the existing string transport. Cancellation and Uint8Array bodies
// change these fields together with the frame protocol.
export type RpcFetchRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export type RpcFetchResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type WorkerMethods = {
  fetch(input: RpcFetchRequest): Promise<RpcFetchResponse>
  snapshot(): Promise<string>
  reload(): Promise<void>
  shutdown(): Promise<void>
}

export type WorkerEvents = {
  "global.event": GlobalEvent
  "worker.fatal": { message: string; stack?: string }
}
