export * as ConfigCommandV1 from "./command"

import { Schema, SchemaGetter } from "effect"
import { ConfigExecutionV1 } from "./execution"

const CommandSchema = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  execution: Schema.optional(ConfigExecutionV1.Mode).annotate({
    description:
      'How the subtask this command starts runs when the user issues it: "foreground" waits for the result, "background" detaches the run and delivers the result later, "auto" (default) leaves it to the agent the command runs. Only meaningful with subtask; a non-interactive turn or a hook follow-up always runs the command in the foreground.',
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: '@deprecated Use the execution field instead: true is "background", false is "foreground".',
  }),
})

// #1357: `execution` replaces the boolean `background` of #1057, and keeps its meaning: `background: true` is read as
// `execution: "background"` and `background: false` as `execution: "foreground"` (it always asked to be waited for).
// An explicit `execution` wins. The legacy field is consumed here, so nothing downstream sees it.
const normalize = (command: Schema.Schema.Type<typeof CommandSchema>): Schema.Schema.Type<typeof CommandSchema> => {
  const { background, ...rest } = command
  if (rest.execution !== undefined || background === undefined) return rest
  return { ...rest, execution: background ? "background" : "foreground" }
}

export const Info = CommandSchema.pipe(
  Schema.decodeTo(CommandSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)
export type Info = Schema.Schema.Type<typeof Info>
