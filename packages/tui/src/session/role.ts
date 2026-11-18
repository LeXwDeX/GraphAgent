// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "@graphagent/sdk"

/**
 * Who a session is to its conversation, as the server derives it (`Session.role`, #1288): `root` is the one the user
 * drives, every other role is delegated work. The TUI asks here where it decides by that, in place of testing
 * `parentID`. Reading `parentID` to show the relation, to walk the tree or to navigate to the parent stays with the
 * callers: it names a session, which the role does not.
 */
type Roled = Pick<Session, "role">

/** Whether the session is a root; false when there is no session. */
export const isRoot = (session: Roled | undefined): boolean => session?.role === "root"

/**
 * Whether the session is delegated work, a sub-agent or a DAG node; false when there is no session. Anything but a
 * root counts, so a role the TUI does not know yet is read-only like a sub-agent's, the way the server treats a child
 * it cannot place.
 */
export const isSubagent = (session: Roled | undefined): boolean => session !== undefined && session.role !== "root"
