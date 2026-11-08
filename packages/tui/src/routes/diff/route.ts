import { snapshotRoute, useRoute, type DiffParams } from "../../context/route"

/**
 * Internal navigation for the diff route. The diff route is not addressable
 * from startup or plugins; it is opened by the app command and by the viewer's
 * own source switch.
 */
export function useDiffNavigation() {
  const route = useRoute()

  return {
    open(params: DiffParams) {
      const current = route.data
      // Reopening an already-open diff (source switch) keeps the original
      // return route so repeated switches never walk further back.
      const returnRoute = current.type === "diff" ? current.returnRoute : snapshotRoute(current)
      route.navigate({ type: "diff", params, returnRoute })
    },
    close() {
      const current = route.data
      route.navigate(current.type === "diff" ? snapshotRoute(current.returnRoute) : { type: "home" })
    },
  }
}
