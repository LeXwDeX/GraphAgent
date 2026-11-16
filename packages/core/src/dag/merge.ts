// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side merge rules for `dag.workflow.nodes.updated` (`Feed`, `push`,
 * `receive`, `needsFetch`). The rules live in `@graphagent/schema`; this
 * module hands them to consumers that only depend on core, such as the TUI.
 * The schema module has no runtime imports, so this pulls in no Effect code.
 */
export { DagMerge } from "@graphagent/schema/dag-merge"
