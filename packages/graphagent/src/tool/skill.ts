import path from "path"
import { Effect, Option, Schema } from "effect"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Hash } from "@graphagent/core/util/hash"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Agent } from "@/agent/agent"
import { isReplayableAssistantMessage } from "@/session/message-replay"
import { Skill } from "../skill"
import { SettingsHook } from "@/hook"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

/**
 * True when an earlier call of this skill tool put the same body into the
 * history and the model can still read it there: the message holding the call
 * is replayed to the model (one that ended with a provider error keeps only
 * its settled tool calls), the call finished, its output was neither pruned nor
 * truncated, and it was a real load rather than a receipt.
 * The history is the turn's snapshot, already cut at the compaction boundary.
 */
export function alreadyLoaded(
  messages: readonly SessionV1.WithParts[],
  callID: string | undefined,
  name: string,
  hash: string,
) {
  return messages.some(
    (message) =>
      isReplayableAssistantMessage(message) &&
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "skill" &&
          part.callID !== callID &&
          part.state.status === "completed" &&
          part.state.time.compacted === undefined &&
          part.state.metadata.name === name &&
          part.state.metadata.hash === hash &&
          part.state.metadata.alreadyLoaded !== true &&
          part.state.metadata.truncated !== true,
      ),
  )
}

function receipt(info: Skill.Info, bytes: number, hash: string) {
  return {
    title: `Skill already loaded: ${info.name}`,
    output: `Skill "${info.name}" is already loaded in this conversation (${bytes} bytes). Its instructions are earlier in the conversation; do not load it again.`,
    metadata: { name: info.name, dir: path.dirname(info.location), bytes, hash, alreadyLoaded: true },
  }
}

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const agents = yield* Agent.Service

    // An unknown name lists what the system prompt could list for this agent:
    // skills its own permission rules deny stay out of the message.
    const notFound = (error: Skill.NotFoundError, agentName: string) =>
      Effect.gen(function* () {
        const agent = yield* agents.get(agentName)
        const available =
          agent === undefined ? error.available : (yield* skill.available(agent)).map((item) => item.name)
        return yield* Effect.die(new Error(new Skill.NotFoundError({ name: error.name, available }).message))
      })

    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => notFound(error, ctx.agent)))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const body = info.content.trim()
          const bytes = Buffer.byteLength(body)
          const hash = Hash.sha256(info.content).slice(0, 16)
          const loaded = alreadyLoaded(ctx.messages, ctx.callID, info.name, hash)

          // Built-in skills have no directory on disk: `/builtin/<name>.md` is
          // a synthetic location, so skip the file listing.
          const builtin = info.location.startsWith("/builtin/")
          const dir = path.dirname(info.location)
          const base = dir
          const files =
            builtin || loaded
              ? []
              : yield* ripgrep.find({
                  cwd: dir,
                  pattern: "!**/SKILL.md",
                  hidden: true,
                  follow: false,
                  signal: ctx.abort,
                  limit: 10,
                })

          // A skill's frontmatter hooks become active only when the skill tool
          // actually loads it. The stable path origin makes repeated loads in
          // this session idempotent; SessionEnd owns eventual cleanup.
          if (info.hooks !== undefined && info.hookOrigin) {
            const settings = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
            if (settings?.registerScoped)
              yield* settings.registerScoped(ctx.sessionID, {
                kind: "skill",
                origin: info.hookOrigin,
                source: info.hookSource ?? "project",
                hooks: info.hooks,
              })
          }

          if (loaded) return receipt(info, bytes, hash)

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name} (${bytes} bytes)`,
              "",
              body,
              "",
              ...(builtin
                ? []
                : [
                    `Base directory for this skill: ${base}`,
                    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
                    "Note: file list is sampled.",
                    "",
                    "<skill_files>",
                    files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
                    "</skill_files>",
                  ]),
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              bytes,
              hash,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
