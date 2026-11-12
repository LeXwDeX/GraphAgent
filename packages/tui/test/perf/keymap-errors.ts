// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Keymap failures that make a benchmark sample meaningless: the key a scenario
 * sent never reached its command. The keymap reports them on stderr and keeps
 * going, so a run that hits them still exits 0 with plausible-looking numbers
 * (every `/` round after the first, before the ESC fix).
 */
export const KEYMAP_ERROR_PATTERN = /event-match-resolver-error|Invalid key name/

export type KeymapErrorGuard = {
  /** First line of every distinct matching message seen since `watchKeymapErrors`. */
  readonly hits: readonly string[]
  /** Puts the original `console` and stderr writers back. Idempotent. */
  restore(): void
}

type Write = typeof process.stderr.write

function describe(value: unknown) {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`
  return typeof value === "string" ? value : String(value)
}

/**
 * Watches `console.error`, `console.warn` and raw stderr writes for keymap
 * failures. Output still reaches the original writers unless `quiet` is set.
 */
export function watchKeymapErrors(options: { quiet?: boolean } = {}): KeymapErrorGuard {
  const hits = new Set<string>()
  const record = (text: string) => {
    if (!KEYMAP_ERROR_PATTERN.test(text)) return
    hits.add((text.split("\n").find((line) => line.trim()) ?? text).trim().slice(0, 200))
  }

  // oxlint-disable-next-line typescript-eslint/unbound-method -- called with the console as receiver below
  const originalError = console.error
  // oxlint-disable-next-line typescript-eslint/unbound-method -- called with the console as receiver below
  const originalWarn = console.warn
  // oxlint-disable-next-line typescript-eslint/unbound-method -- forwarded with the stream as receiver below
  const originalWrite: Write = process.stderr.write
  const forwardWrite = (...args: unknown[]): boolean => Boolean(Reflect.apply(originalWrite, process.stderr, args))

  console.error = (...args: unknown[]) => {
    record(args.map(describe).join(" "))
    if (!options.quiet) originalError.apply(console, args)
  }
  console.warn = (...args: unknown[]) => {
    record(args.map(describe).join(" "))
    if (!options.quiet) originalWarn.apply(console, args)
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stderr.write is overloaded; the wrapper forwards every argument untouched
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    record(describe(chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : chunk))
    if (options.quiet) return true
    return forwardWrite(chunk, ...rest)
  }) as Write

  let restored = false
  return {
    get hits() {
      return [...hits]
    },
    restore() {
      if (restored) return
      restored = true
      console.error = originalError
      console.warn = originalWarn
      process.stderr.write = originalWrite
    },
  }
}
