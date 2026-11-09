// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { GlobalEvent } from "@graphagent/sdk"
import type { RpcContext, RpcError } from "@/util/rpc"

/**
 * The typed contract between the TUI launcher and its worker.
 *
 * Keep this module free of runtime imports: both sides use it only for types
 * and pure helpers, so a drift between `Rpc.listen` and `Rpc.client` fails at
 * typecheck instead of at runtime as a `TypeError` on an unknown method.
 */

export type { RpcError } from "@/util/rpc"

export type RpcFetchRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body?: Uint8Array<ArrayBuffer>
}

export type RpcFetchResponse = {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array<ArrayBuffer>
}

export type WorkerMethods = {
  fetch(input: RpcFetchRequest, context?: RpcContext): Promise<RpcFetchResponse>
  snapshot(): Promise<string>
  reload(): Promise<void>
  shutdown(): Promise<void>
  /** Replace the set of sessions whose full event stream is forwarded. */
  setInterest(input: { full: readonly string[] }): Promise<void>
}

export type WorkerEvents = {
  "global.events": GlobalEvent[]
  "worker.fatal": { message: string; stack?: string }
}

/**
 * State-changing POSTs must not be cancelled on client disconnect: stopping a
 * turn goes through `POST /session/:id/abort`. Only the whitelisted read-like
 * POST may be aborted. GET/HEAD are always cancellable.
 */
export const CANCELLABLE_POSTS = [/^\/session\/[^/]+\/btw$/]

export function isCancellableRequest(method: string, pathname: string): boolean {
  const normalized = method.toUpperCase()
  if (normalized === "GET" || normalized === "HEAD") return true
  if (normalized !== "POST") return false
  return CANCELLABLE_POSTS.some((pattern) => pattern.test(pathname))
}
