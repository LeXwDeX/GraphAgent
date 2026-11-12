// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DOMAINS, PHASES } from "@graphagent/schema/lifecycle-status"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/http-api"
import { ApiNotFoundError, UnknownError } from "../errors"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/lifecycle"

/** Wire projection of one `Lifecycle.get` observation (#1069 scope 3). */
export const LifecycleDomain = Schema.Literals(DOMAINS).annotate({ identifier: "LifecycleDomain" })
export const LifecyclePhase = Schema.Literals(PHASES).annotate({ identifier: "LifecyclePhase" })

export const LifecycleStateRef = Schema.Struct({
  domain: LifecycleDomain,
  id: Schema.String,
}).annotate({ identifier: "LifecycleStateRef" })

export const LifecycleStateInfo = Schema.Struct({
  domain: LifecycleDomain,
  id: Schema.String,
  value: Schema.String,
  phase: LifecyclePhase,
  terminal: Schema.Boolean,
  settled: Schema.Boolean,
  source: Schema.Literals(["live", "persisted", "derived"]),
  observedAt: Schema.Number,
}).annotate({ identifier: "LifecycleState" })

export const LifecycleStatesPayload = Schema.Struct({
  refs: Schema.Array(LifecycleStateRef),
})

/**
 * Bulk-read entry. `state: null` means the ref is unknown to this instance —
 * no resolver, out of scope for the calling directory, or already gone — so
 * clients drop their mirror entry instead of guessing.
 */
export const LifecycleStateEntry = Schema.Struct({
  domain: LifecycleDomain,
  id: Schema.String,
  state: Schema.NullOr(LifecycleStateInfo),
}).annotate({ identifier: "LifecycleStateEntry" })

export const LifecyclePaths = {
  get: `${root}/state/:domain/:id`,
  states: `${root}/states`,
} as const

export const LifecycleApi = HttpApi.make("lifecycle")
  .add(
    HttpApiGroup.make("lifecycle")
      .add(
        HttpApiEndpoint.get("get", LifecyclePaths.get, {
          params: { domain: LifecycleDomain, id: Schema.String },
          success: described(LifecycleStateInfo, "Observed lifecycle state"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, UnknownError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lifecycle.get",
            summary: "Get lifecycle state",
            description:
              "Read a live lifecycle observation for one state reference. Returns 404 when the ref is unknown to this instance or belongs to another directory.",
          }),
        ),
        HttpApiEndpoint.post("states", LifecyclePaths.states, {
          payload: LifecycleStatesPayload,
          success: described(Schema.Array(LifecycleStateEntry), "Observed lifecycle states"),
          error: [HttpApiError.BadRequest, UnknownError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lifecycle.states",
            summary: "Get lifecycle states",
            description:
              "Batch-read lifecycle observations for a set of state references. Entries whose ref is unknown to this instance carry a null state.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "lifecycle",
          description: "Cross-domain runtime lifecycle observations (#1069).",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode lifecycle HttpApi",
      version: "0.0.1",
      description: "Read-only cross-domain lifecycle state for live clients.",
    }),
  )
