// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process startup authorisation rules for `run`.
 *
 * `LocalPermissionStartup` only accepts the original `Request` object marked
 * inside this process; nothing crosses headers or bodies. The rules below
 * decide which requests that process may mark, and the two modes stay
 * separate so `--mini` cannot widen the non-interactive scope.
 */

/** `{ sessionID?: string } | undefined`, matching `LocalPermissionStartup.mark`. */
export type LocalFetchMark = { readonly sessionID?: string } | undefined

export type ResumeSelection = {
  readonly session?: string
  readonly continue?: boolean
  readonly fork?: boolean
}

/** Write routes that belong to the resumed session selected by this process. */
const RESUMED_SESSION_ROUTE = /^\/session\/([^/]+)\/(message|prompt|prompt_async|command|resume)$/

/**
 * Interactive local runs only authorise session creation. Resumed-session
 * message routes stay unmarked: the TUI session was not selected through
 * `--session`/`--continue`/`--fork`, so it has no startup grant to inherit.
 */
export function interactiveMarkable(method: string, pathname: string): LocalFetchMark {
  return method === "POST" && pathname === "/session" ? {} : undefined
}

/**
 * Non-interactive runs authorise session creation and the write routes of a
 * resumed session this process selected. The id in the path must be one the
 * run already knows about; an arbitrary path never grants the startup bypass.
 */
export function nonInteractiveMarkable(
  selection: ResumeSelection,
  localSessionIDs: ReadonlySet<string>,
): (method: string, pathname: string) => LocalFetchMark {
  return (method, pathname) => {
    if (method !== "POST") return undefined
    if (pathname === "/session") return {}
    if (!(selection.session || selection.continue || selection.fork)) return undefined
    const selected = RESUMED_SESSION_ROUTE.exec(pathname)?.[1]
    return selected && localSessionIDs.has(selected) ? { sessionID: selected } : undefined
  }
}
