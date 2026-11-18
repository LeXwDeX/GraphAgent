// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { spyOn } from "bun:test"
import { testRender } from "@opentui/solid"
import * as fsp from "fs/promises"
import path from "path"
import type { JSX, ParentProps } from "solid-js"
import * as persistence from "../../src/util/persistence"
import { tmpdir } from "./fixture"
import { FRAME_WAIT_MS, pause } from "./frames"
import { TestTuiContexts } from "./tui-environment"

/** Polls until `predicate` holds, for at most `timeoutMs` of real time; the limit only bounds the wait. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = FRAME_WAIT_MS) {
  const deadline = performance.now() + timeoutMs
  for (let round = 0; !(await predicate()); round++) {
    if (performance.now() >= deadline) throw new Error(`${what} was not reached within ${timeoutMs}ms`)
    await pause(round)
  }
}

type Write = { readonly kind: "write" | "append"; readonly target: string; readonly done: Promise<void> }

/**
 * Records every write the provider issues through the persistence helpers, with the promise of its completion, so a
 * test can tell which writes happened and wait for all of them to land instead of sleeping.
 */
export function recordWrites() {
  const writes: Write[] = []
  const realWrite = persistence.writeText
  const realAppend = persistence.appendText
  const write = spyOn(persistence, "writeText").mockImplementation((target, content) => {
    const done = realWrite(target, content)
    writes.push({ kind: "write", target, done })
    return done
  })
  const append = spyOn(persistence, "appendText").mockImplementation((target, content) => {
    const done = realAppend(target, content)
    writes.push({ kind: "append", target, done })
    return done
  })
  return {
    to: (file: string) => writes.filter((item) => item.target === file),
    /** Every write issued so far has finished, whether it succeeded or not. */
    landed: () => Promise.allSettled(writes.map((item) => item.done)),
    restore() {
      write.mockRestore()
      append.mockRestore()
    },
  }
}

type Operation = "write" | "append"

/**
 * Stands in for the disk under `persistence.ts`, for one file. `mkdir` finishes at once, so a write that is free to
 * run reaches the disk within the same turn of the event loop. The first `Bun.write` ("write") or `appendFile`
 * ("append") to the file, whichever `hold` names, stays pending until `release` lets it run or `fail` rejects it. `ops`
 * lists the calls that reached the disk in the order they started. A write queued behind a held one is not in it, so a
 * test reads `ops` after one turn of the event loop rather than waiting for something not to happen.
 */
export function interceptDisk(file: string, hold?: Operation) {
  const target = path.resolve(file)
  const ops: Operation[] = []
  let entered = false
  let release!: () => void
  let fail!: (error: Error) => void
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  gate.catch(() => undefined)
  const reaches = (destination: unknown) => typeof destination === "string" && path.resolve(destination) === target

  function enter(kind: Operation, run: () => Promise<unknown>) {
    ops.push(kind)
    if (kind !== hold || entered) return run()
    entered = true
    return gate.then(run)
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stubs forward every other call with the arguments it was given.
  const realWrite = Bun.write as (...args: unknown[]) => Promise<number>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as above.
  const realAppend = fsp.appendFile as (...args: unknown[]) => Promise<void>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as above.
  const realMkdir = fsp.mkdir as (...args: unknown[]) => Promise<unknown>
  const spies = [
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stub is only as wide as the call it replaces.
    spyOn(Bun, "write").mockImplementation(((destination: unknown, ...rest: unknown[]) =>
      reaches(destination)
        ? enter("write", () => realWrite.call(Bun, destination, ...rest))
        : realWrite.call(Bun, destination, ...rest)) as typeof Bun.write),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stub is only as wide as the call it replaces.
    spyOn(fsp, "appendFile").mockImplementation(((destination: unknown, ...rest: unknown[]) =>
      reaches(destination)
        ? enter("append", () => realAppend(destination, ...rest))
        : realAppend(destination, ...rest)) as typeof fsp.appendFile),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stub is only as wide as the call it replaces.
    spyOn(fsp, "mkdir").mockImplementation(((directory: unknown, ...rest: unknown[]) =>
      typeof directory === "string" && path.resolve(directory) === path.dirname(target)
        ? Promise.resolve(undefined)
        : realMkdir(directory, ...rest)) as typeof fsp.mkdir),
  ]
  return {
    ops,
    /** The held call has reached the disk. */
    entered: () => entered,
    release,
    fail,
    restore() {
      // Nothing stays pending on a gate that was never opened.
      release()
      for (const spy of spies) spy.mockRestore()
    },
  }
}

function Probe<T>(props: { use: () => T; ready: (value: T) => void }) {
  props.ready(props.use())
  return <box />
}

/**
 * Mounts `Provider` over a state directory whose `name` file holds `seed(directory)`, with the provider's startup read
 * held back: it resolves only when `release` is called, with the text the file had when the read began. Whatever the
 * test does to the store before that, it does while the read is in flight.
 */
export async function mountStoreWithHeldRead<T>(input: {
  name: string
  seed: (directory: string) => string
  Provider: (props: ParentProps) => JSX.Element
  use: () => T
}) {
  const { Provider, use } = input
  const tmp = await tmpdir()
  const file = path.join(tmp.path, input.name)
  const seeded = input.seed(tmp.path)
  await Bun.write(file, seeded)

  let requested = false
  let release!: (text: string) => void
  const held = new Promise<string>((resolve) => (release = resolve))
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stub forwards every other call with the arguments it was given.
  const realFile = Bun.file as (...args: unknown[]) => ReturnType<typeof Bun.file>
  const spy = spyOn(Bun, "file").mockImplementation(((target: unknown, ...rest: unknown[]) => {
    const blob = realFile.call(Bun, target, ...rest)
    if (target !== file) return blob
    requested = true
    return Object.assign(blob, { text: () => held })
  }) as typeof Bun.file)

  let store!: T
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    app = await testRender(
      () => (
        <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <Provider>
            <Probe use={use} ready={(value) => (store = value)} />
          </Provider>
        </TestTuiContexts>
      ),
      { width: 20, height: 5 },
    )
    await waitFor(() => requested, "the provider's startup read through Bun.file(...).text()")
  } catch (error) {
    app?.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
    throw error
  } finally {
    // The provider already holds its read; whatever reads the file from here on must see the real one.
    spy.mockRestore()
  }
  return {
    store,
    file,
    directory: tmp.path,
    release: () => release(seeded),
    dispose: async () => {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}
