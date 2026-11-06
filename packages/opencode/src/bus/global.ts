import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  // @types/node 26 types EventEmitter.emit generically; the second overload keeps
  // this override assignable to it while callers still see the typed "event" form.
  override emit(eventName: "event", event: GlobalEvent): boolean
  override emit(eventName: string | symbol, ...args: any[]): boolean
  override emit(eventName: string | symbol, ...args: any[]): boolean {
    const event = args[0] as GlobalEvent | undefined
    if (eventName === "event" && event?.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, ...args)
  }
}

export const GlobalBus = new GlobalBusEmitter()
