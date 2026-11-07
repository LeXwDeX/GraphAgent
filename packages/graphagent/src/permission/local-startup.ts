export * as LocalPermissionStartup from "./local-startup"
import { Context, Effect } from "effect"

// Only the in-process CLI can mark the original Request. Nothing crosses JSON/headers.
const requests = new WeakMap<object, { readonly sessionID?: string }>()
export function mark(request: Request, sessionID?: string): Request {
  requests.set(request, { sessionID })
  return request
}
export function take(source: unknown, sessionID?: string): boolean {
  if ((typeof source !== "object" && typeof source !== "function") || source === null) return false
  const entry = requests.get(source)
  if (!entry || entry.sessionID !== sessionID) return false
  requests.delete(source)
  return true
}
export const Grant = Context.Reference<((sessionID: string) => Effect.Effect<void>) | undefined>(
  "@opencode/LocalPermissionStartup",
  { defaultValue: () => undefined },
)
export function once(grant: (sessionID: string) => Effect.Effect<void>) {
  let available = true
  return (sessionID: string) =>
    Effect.suspend(() => {
      if (!available) return Effect.void
      available = false
      return grant(sessionID)
    })
}
