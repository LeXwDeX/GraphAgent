// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Lifecycle } from "@/lifecycle/service"
import type { Domain } from "@graphagent/schema/lifecycle-status"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { notFound, UnknownError } from "../errors"
import { LifecycleStatesPayload } from "../groups/lifecycle"

const readError = (error: Lifecycle.LifecycleReadError) =>
  new UnknownError({
    name: "UnknownError",
    data: { message: error.message, ref: `${error.domain}/${error.id}` },
  })

export const lifecycleHandlers = HttpApiBuilder.group(InstanceHttpApi, "lifecycle", (handlers) =>
  Effect.gen(function* () {
    const lifecycle = yield* Lifecycle.Service

    const get = Effect.fn("LifecycleHttpApi.get")(function* (ctx: {
      params: { domain: Domain; id: string }
    }) {
      const observed = yield* lifecycle.get(ctx.params).pipe(Effect.mapError(readError))
      if (Option.isNone(observed))
        return yield* Effect.fail(notFound(`No lifecycle state for ${ctx.params.domain}/${ctx.params.id}`))
      return observed.value
    })

    const states = Effect.fn("LifecycleHttpApi.states")(function* (ctx: {
      payload: typeof LifecycleStatesPayload.Type
    }) {
      return yield* Effect.forEach(
        ctx.payload.refs,
        (stateRef) =>
          lifecycle.get(stateRef).pipe(
            Effect.map((observed) => ({
              domain: stateRef.domain,
              id: stateRef.id,
              state: Option.getOrNull(observed),
            })),
          ),
        { concurrency: 1 },
      ).pipe(Effect.mapError(readError))
    })

    return handlers.handle("get", get).handle("states", states)
  }),
)
