// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Schema, Struct } from "effect"
import { MessageID, PartID, SessionID } from "./schema"

/**
 * Input schemas of the session prompt service (Issue #1019, PR-b).
 *
 * Moved verbatim out of `prompt.ts`, which re-exports every name below, so the
 * `SessionPrompt.*` surface (and the generated SDK schemas) stay unchanged.
 */

export const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export const SummarizeInput = Schema.Struct({
  sessionID: SessionID,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export type SummarizeInput = typeof SummarizeInput.Type

export const SetModelInput = Schema.Struct({
  sessionID: SessionID,
  model: Schema.optional(ModelRef),
  variant: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "picker", "sdk"])),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
})
export type SetModelInput = typeof SetModelInput.Type

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

export const HookFollowupInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prompt"), ...Struct.omit(PromptInput.fields, ["sessionID"]) }),
  Schema.Struct({ kind: Schema.Literal("command"), ...Struct.omit(CommandInput.fields, ["sessionID"]) }),
])
export const HookPendingInput = Schema.Struct({
  version: Schema.Literal(1),
  messageID: MessageID,
  phase: Schema.Literals(["pending", "started"]),
  input: HookFollowupInput,
  /** Runtime-delegated child input skips UserPromptSubmit when replayed. Records without it replay as user input. */
  internalDelegation: Schema.optional(Schema.Boolean),
})

export const ResumeInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  hookMode: Schema.optional(Schema.Literals(["interactive", "noninteractive"])),
  initialOnly: Schema.optional(Schema.Boolean),
  followup: Schema.optional(HookFollowupInput),
})
export type ResumeInput = typeof ResumeInput.Type
