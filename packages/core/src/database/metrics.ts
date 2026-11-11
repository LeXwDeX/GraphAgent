// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-wide database work counters for the per-step observability added by
 * #1028 (HS14).
 *
 * The session processor snapshots these counters around one model step and
 * reports the difference. They are monotonic and never reset: the difference
 * is meaningful within a single process only, and concurrent sessions share
 * the same counter. The metric is a diagnostic, not an accounting boundary.
 */
export namespace DatabaseMetrics {
  let sqlCount = 0
  let commits = 0

  /** One executed statement. Explicit transaction commits are counted too. */
  export function recordSql(query: string): void {
    sqlCount += 1
    // SQLite commits arrive as COMMIT or (for nested transactions) a
    // savepoint release. Both end an explicit write transaction.
    const head = query.trimStart().slice(0, 16).toUpperCase()
    if (head.startsWith("COMMIT") || head.startsWith("RELEASE")) commits += 1
  }

  export function snapshot(): { readonly sqlCount: number; readonly commits: number } {
    return { sqlCount, commits }
  }
}
