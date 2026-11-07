import { makeDefaultApi } from "@opencode-ai/protocol/api"
import { LocationMiddleware } from "./location"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
})
