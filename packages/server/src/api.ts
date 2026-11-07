import { makeDefaultApi } from "@graphagent/protocol/api"
import { LocationMiddleware } from "./location"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
})
