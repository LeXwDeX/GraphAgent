// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-export of the job session-identity reader (#1069 P9). The implementation
 * lives in core so the registry's own transitions (`runtime_job`,
 * `lifecycle.transitioned`) read the same keys as every graphagent reader:
 * the current `sessionID` / `parentSessionID` win, the pre-rename keys are
 * only a compatibility fallback.
 */
export { parentSessionIDOf, sessionIDOf } from "@graphagent/core/background-session-metadata"
