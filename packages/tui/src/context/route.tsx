import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type DiffMode = "git" | "branch" | "last-turn"

export type DiffParams = {
  mode?: DiffMode
  sessionID?: string
  messageID?: string
}

export type DiffRoute = {
  type: "diff"
  params: DiffParams
  returnRoute: Route
}

export type Route = HomeRoute | SessionRoute | DiffRoute

/**
 * Copy a route before it is stored back into the route store. Solid store
 * proxies must not be nested inside the same store; the diff route also
 * carries a return route, so copy that chain recursively.
 */
export function snapshotRoute(route: Route): Route {
  if (route.type !== "diff") return { ...route }
  return {
    type: "diff",
    params: { ...route.params },
    returnRoute: snapshotRoute(route.returnRoute),
  }
}

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

/**
 * Deep links only address home and session. The diff route is internal and
 * cannot be opened from startup; plugin routes no longer exist.
 */
function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
