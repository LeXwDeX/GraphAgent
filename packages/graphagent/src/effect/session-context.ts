import { LocalContext } from "@/util/local-context"

/**
 * Best-effort session routing for server-initiated MCP reverse requests
 * (elicitation). MCP clients are shared per-server, not per-session, so the
 * `elicitation/create` handler has no ambient session. Tool execution sets the
 * active session via `SessionContext.run(sessionID, fn)` around the MCP
 * `callTool` invocation; the elicitation handler reads `SessionContext.sessionID`
 * to surface the Question in the right session.
 *
 * This is best-effort: if the MCP SDK dispatches the reverse-request outside the
 * callTool's async context, `sessionID` is `undefined` and the handler declines
 * immediately (never hangs the server). Verified by the elicitation integration
 * test; the safe-decline fallback is the hard guarantee.
 */
const context = LocalContext.create<string>("session")

export const SessionContext = {
  /** Run `fn` with `sessionID` as the active session (synchronous ALS run). */
  run<R>(sessionID: string, fn: () => R): R {
    return context.provide(sessionID, fn)
  },
  /** The active session ID, or `undefined` when no session context is present. */
  get sessionID(): string | undefined {
    try {
      return context.use()
    } catch {
      return undefined
    }
  },
}
