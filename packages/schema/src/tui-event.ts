export * as TuiEvent from "./tui-event"

import { Effect, Schema } from "effect"
import { Event } from "./event"
import { PositiveInt } from "./schema"

const DEFAULT_TOAST_DURATION = 5000

export const ToastShow = Event.define({
  type: "tui.toast.show",
  schema: {
    title: Schema.optional(Schema.String),
    message: Schema.String,
    variant: Schema.Literals(["info", "success", "warning", "error"]),
    duration: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOAST_DURATION))).annotate({
      description: "Duration in milliseconds",
    }),
  },
})

export const Definitions = Event.inventory(ToastShow)
