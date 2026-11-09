// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Duration, Effect, Schema, Stream } from "effect"

export class CompactionTimeoutError extends Schema.TaggedError<CompactionTimeoutError>()(
  "CompactionTimeoutError",
  { message: Schema.String },
) {}

export function watchCompactionStream<A, E, R>(stream: Stream.Stream<A, E, R>, duration: Duration.Input = "2 minutes") {
  // Time upstream inactivity, not total generation time. Reasoning events are progress too.
  return Stream.transformPull(stream, (pull) =>
    Effect.succeed(
      pull.pipe(
        Effect.timeoutOrElse({
          duration,
          orElse: () =>
            Effect.fail(new CompactionTimeoutError({ message: "Compaction stream timed out without progress" })),
        }),
      ),
    ),
  )
}
