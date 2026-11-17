// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ConfigExecutionV1 from "./execution"

import { Schema } from "effect"

// How a task call runs (#1357, Appendix A of #1057), declared by an agent or by a command.
//   foreground: the caller waits for the result in the same turn.
//   background: the run is detached and its result comes back as a later message.
//   auto: the declaration says nothing; the call's own `background` argument and the delegation criteria in the
//         task tool description decide. The default.
// The runtime resolves the declarations (`TaskExecution.resolve` in graphagent): hard constraints, then the call's
// argument, then the command, then the agent, then the foreground.
export const Mode = Schema.Literals(["foreground", "background", "auto"])
export type Mode = Schema.Schema.Type<typeof Mode>
