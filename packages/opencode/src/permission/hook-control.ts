import { Cause, Effect, Schema } from "effect"

export class HookPermissionInterrupt extends Schema.TaggedErrorClass<HookPermissionInterrupt>()(
  "HookPermissionInterrupt",
  { message: Schema.String },
) {}

export class ToolInputUpdated extends Error {
  readonly _tag = "ToolInputUpdated"
  constructor(readonly input: Record<string, unknown>) {
    super("Permission hook replaced tool input")
  }
}

/** Restart only explicitly audited permission-before-side-effect tools. */
export function executeWithPermissionInput<A, E, R>(
  input: Record<string, unknown>,
  execute: (input: Record<string, unknown>) => Effect.Effect<A, E, R>,
  options: { canRestart: boolean; validate: (input: Record<string, unknown>) => void },
): Effect.Effect<{ value: A; input: Record<string, unknown> }, E, R> {
  const attempt = (
    args: Record<string, unknown>,
    count: number,
  ): Effect.Effect<{ value: A; input: Record<string, unknown> }, E, R> =>
    execute(args).pipe(
      Effect.map((value) => ({ value, input: args })),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
        const error = Cause.squash(cause)
        if (!(error instanceof ToolInputUpdated)) return Effect.failCause(cause)
        if (!options.canRestart || count >= 8)
          return Effect.die(new Error("Permission input replacement cannot safely restart this tool"))
        return Effect.sync(() => options.validate(error.input)).pipe(
          Effect.andThen(() => attempt(error.input, count + 1)),
        )
      }),
    )
  return attempt(input, 0)
}

/** Permission-only rewrite loop: no business tool execution can repeat here. */
export function confirmPermissionInput<E, R>(
  input: Record<string, unknown>,
  ask: (input: Record<string, unknown>) => Effect.Effect<void | { updatedInput: Record<string, unknown> }, E, R>,
  validate: (input: Record<string, unknown>) => void,
) {
  return executeWithPermissionInput(
    input,
    (args) =>
      ask(args).pipe(
        Effect.map((result) => {
          if (result?.updatedInput !== undefined) throw new ToolInputUpdated(result.updatedInput)
        }),
      ),
    { canRestart: true, validate },
  )
}
