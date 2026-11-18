// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema } from "effect"

/**
 * What a session is to the conversation it belongs to (Issue #1288).
 *
 * `root` is the conversation the user drives. Every other session is delegated
 * work: `task_child` is the subagent of a task tool call, `dag_node` the worker
 * of one DAG node. A session row's `parentID` only tells a root from a child;
 * the kind of child comes from its `child_binding`, so the role is derived on
 * read and is not a column of its own.
 */
export const SessionRole = Schema.Literals(["root", "task_child", "dag_node"])
export type SessionRole = typeof SessionRole.Type
