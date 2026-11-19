// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const RequestCommand = effectCmd({
  command: "request <session>",
  describe: "show a captured model request (GRAPHAGENT_DEBUG_REQUESTS=1)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("session", {
        type: "string",
        demandOption: true,
        description: "Session ID",
      })
      .option("step", {
        type: "number",
        description: "Step number (default: the last captured step)",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const { debugRequest } = yield* Effect.promise(() => import("./request.handler"))
      return yield* debugRequest(args)
    }),
})
