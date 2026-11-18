// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the double fails a write with a plain Error; the service types its failures as PlatformError.
import { FSUtil } from "@graphagent/core/fs-util"
import { Effect, Layer } from "effect"
import { Truncate } from "@/tool/truncate"

/**
 * The real truncation service over a disk that refuses every write with
 * `message`, which is what a full or read-only data directory looks like.
 * `onWrite` sees each attempt.
 */
export const truncateFailingWith = (message: string, onWrite?: () => void) =>
  Truncate.layer.pipe(
    Layer.provide(
      Layer.effect(
        FSUtil.Service,
        Effect.map(FSUtil.Service, (fs) =>
          FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () =>
              Effect.sync(() => onWrite?.()).pipe(Effect.andThen(Effect.fail(new Error(message) as never))),
          }),
        ),
      ).pipe(Layer.provide(FSUtil.defaultLayer)),
    ),
  )

/** The write fails with `disk full`, so a result that could not be saved can name that reason. */
export const unwritableTruncate = truncateFailingWith("disk full")
