export * as LegacyEvent from "./legacy-event"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"
import { SessionV1 } from "./session-v1"

export const CommandExecuted = define({
  type: "command.executed",
  schema: {
    name: Schema.String,
    sessionID: SessionID,
    arguments: Schema.String,
    messageID: SessionV1.MessageID,
  },
})

export const HookStatus = define({
  type: "session.hook.status",
  schema: {
    sessionID: SessionID,
    hookID: Schema.String,
    statusMessage: Schema.String,
    phase: Schema.Literals(["started", "finished"]),
  },
})

export const HookTerminal = define({
  type: "session.hook.terminal",
  schema: {
    sessionID: SessionID,
    sequence: Schema.String,
  },
})

export const HookMessage = define({
  type: "session.hook.message",
  schema: {
    sessionID: SessionID,
    message: Schema.String,
  },
})

export const Definitions = inventory(CommandExecuted, HookStatus, HookTerminal, HookMessage)
