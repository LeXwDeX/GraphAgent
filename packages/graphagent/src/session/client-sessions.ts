export * as ClientSessions from "./client-sessions"

/**
 * Sessions opened by the in-process client (TUI worker or `run`).
 *
 * The registry exists only so client shutdown can end those sessions' local
 * hooks. It is not consulted for authorization: `run` keeps its own
 * `localSessionIDs` set because authorization is decided before a request
 * reaches the handler that records the session here.
 */

export type Entry = {
  readonly sessionID: string
  readonly directory: string
}

const sessions = new Map<string, string>()

export function touch(input: Entry): void {
  sessions.set(input.sessionID, input.directory)
}

export function move(input: Entry): void {
  sessions.set(input.sessionID, input.directory)
}

export function list(): Entry[] {
  return [...sessions].map(([sessionID, directory]) => ({ sessionID, directory }))
}

export function clear(): void {
  sessions.clear()
}
