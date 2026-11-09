// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import * as InstanceState from "@/effect/instance-state"
import { Location } from "@graphagent/core/location"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Reference } from "@graphagent/core/reference"
import { AbsolutePath } from "@graphagent/core/schema"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"

export const referenceHandlers = HttpApiBuilder.group(InstanceHttpApi, "reference", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap

    return handlers.handle("list", () =>
      Effect.gen(function* () {
        const directory = AbsolutePath.make((yield* InstanceState.context).directory)
        return yield* Reference.Service.use((reference) => reference.list()).pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory }))),
        )
      }),
    )
  }),
).pipe(Layer.provide(LocationServiceMap.layer))
