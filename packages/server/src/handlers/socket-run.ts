// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import * as Socket from "effect/socket/Socket"

/**
 * Consumes a socket until it terminates: acquires the reader, runs `onOpen` once, then feeds every
 * incoming frame to `handler`. Every termination (clean close included) fails with a `SocketError`.
 */
export const runRaw = <E = never, R = never, EO = never, RO = never>(
  socket: Socket.Socket,
  handler: (message: string | Uint8Array) => Effect.Effect<unknown, E, R> | void,
  options?: { readonly onOpen?: Effect.Effect<unknown, EO, RO> },
): Effect.Effect<never, Socket.SocketError | E | EO, R | RO> =>
  Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* socket.reader
      if (options?.onOpen) yield* options.onOpen
      while (true) {
        const batch = yield* reader.pull
        for (const message of batch) {
          const result = handler(message)
          if (Effect.isEffect(result)) yield* result
        }
      }
    }),
  )
