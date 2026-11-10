// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ProjectTrust from "./project-trust"

import { Schema } from "effect"
import { define, inventory } from "./event"

/**
 * Published after project-trust decisions are written. `projectID` is the
 * project identity hash used as the `trust.json` key; `entries` names the
 * locations that were decided and `removed` the records cleared because the
 * entries no longer exist.
 */
const Updated = define({
  type: "project.trust.updated",
  schema: {
    projectID: Schema.String,
    entries: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
