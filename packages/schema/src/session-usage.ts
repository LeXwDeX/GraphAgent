// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as SessionUsage from "./session-usage"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

/**
 * `GET /session/:sessionID/usage` (#1475): the usage of one whole task tree,
 * read from the root session down through task children, grandchildren and DAG
 * attempt sessions. Display only: nothing here limits or blocks a session.
 */
export const Info = Schema.Struct({
  // The root of the tree the requested session belongs to.
  rootID: SessionID,
  sessions: NonNegativeInt.annotate({ description: "Sessions in the tree, the root included" }),
  cost: Schema.Finite.annotate({ description: "Σ cost over the tree, in dollars; never negative" }),
  costUnknown: Schema.Boolean.annotate({
    description: "A session in the tree recorded tokens at zero cost, so its price is unknown and not counted in cost",
  }),
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
}).annotate({ identifier: "SessionUsage" })
export type Info = typeof Info.Type
