import * as prompts from "@clack/prompts"
import { Effect, Option } from "effect"

export const intro = (msg: string) => Effect.sync(() => prompts.intro(msg))
export const outro = (msg: string) => Effect.sync(() => prompts.outro(msg))

export const log = {
  info: (msg: string) => Effect.sync(() => prompts.log.info(msg)),
  error: (msg: string) => Effect.sync(() => prompts.log.error(msg)),
  warn: (msg: string) => Effect.sync(() => prompts.log.warn(msg)),
  success: (msg: string) => Effect.sync(() => prompts.log.success(msg)),
}

const optional = <Value>(result: Value | symbol): Option.Option<Value> => {
  // Clack returns its cancel symbol for Ctrl-C; no prompt value is a symbol.
  if (typeof result === "symbol") return Option.none<Value>()
  return Option.some(result)
}

export const select = <Value>(opts: prompts.SelectOptions<Value>): Effect.Effect<Option.Option<Value>> =>
  Effect.promise(() => prompts.select(opts)).pipe(Effect.map((result) => optional<Value>(result)))

export const autocomplete = <Value>(
  opts: prompts.AutocompleteOptions<Value>,
): Effect.Effect<Option.Option<Value>> => Effect.promise(() => prompts.autocomplete(opts)).pipe(Effect.map((result) => optional<Value>(result)))

export const text = (opts: prompts.TextOptions): Effect.Effect<Option.Option<string>> =>
  Effect.promise(() => prompts.text(opts)).pipe(Effect.map((result) => optional<string>(result)))

export const password = (opts: prompts.PasswordOptions): Effect.Effect<Option.Option<string>> =>
  Effect.promise(() => prompts.password(opts)).pipe(Effect.map((result) => optional<string>(result)))

export const spinner = () => {
  const s = prompts.spinner()
  return {
    start: (msg: string) => Effect.sync(() => s.start(msg)),
    stop: (msg: string, code?: number) =>
      Effect.sync(() => {
        if (code && code !== 0) return s.error(msg)
        return s.stop(msg)
      }),
  }
}
