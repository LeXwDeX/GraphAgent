// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { Effect, Layer, Schedule, Sink, Stream } from "effect"

export interface FakeShellOptions {
  /** Number of output lines emitted during the run. */
  readonly chunks?: number
  /** Virtual milliseconds between two lines. */
  readonly intervalMs?: number
  /** Exit code reported after the last line. */
  readonly exitCode?: number
}

export interface FakeShell {
  /** Spawner service to provide explicitly where `ShellTool` is built. */
  readonly service: ChildProcessSpawner.ChildProcessSpawner["Service"]
  /** Layer form of `service`, for harnesses that can substitute the spawner. */
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
  /** Number of spawned processes; poll this before advancing `TestClock`. */
  readonly spawns: () => number
}

/**
 * Scripted `ChildProcessSpawner` for the S6 shell scenario.
 *
 * It replaces the real spawner so a two-minute command costs no wall-clock
 * time: one line is emitted per `intervalMs` on Effect's clock and the process
 * exits one interval after the last line, leaving time for the final preview
 * to flush. Drive it with `TestClock.adjust`, never with a real sleep. Tests
 * that need real commands keep using `CrossSpawnSpawner.defaultLayer`.
 */
export function makeFakeShell(options?: FakeShellOptions): FakeShell {
  const chunks = options?.chunks ?? 600
  const intervalMs = options?.intervalMs ?? 200
  const exitCode = options?.exitCode ?? 0
  const encoder = new TextEncoder()
  let spawns = 0
  const output = Stream.fromIterable(Array.from({ length: chunks }, () => encoder.encode("line\n"))).pipe(
    Stream.schedule(Schedule.spaced(`${intervalMs} millis`)),
  )
  const service = ChildProcessSpawner.make(() => {
    spawns += 1
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.sleep(`${(chunks + 1) * intervalMs} millis`).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(exitCode)),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return {
    service,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
    spawns: () => spawns,
  }
}
