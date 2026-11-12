import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

/** Connected once the server lists at least one usable provider. */
export function useConnected() {
  const sync = useSync()
  return createMemo(() => sync.data.provider.length > 0)
}
