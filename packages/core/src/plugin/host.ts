export * as PluginHost from "./host"

import type { PluginContext as Interface } from "./context"
import { Effect, Schema } from "effect"
import { Reference } from "../reference"

export const make = Effect.fn("PluginHost.make")(function* () {
  const reference = yield* Reference.Service

  return {
    options: {},
    reference: {
      reload: reference.reload,
      transform: (callback) =>
        reference.transform((draft) =>
          callback({
            add: (name, source) => draft.add(name, Schema.decodeUnknownSync(Reference.Source)(source)),
            remove: draft.remove,
            list: draft.list,
          }),
        ),
    },
  } satisfies Interface
})
