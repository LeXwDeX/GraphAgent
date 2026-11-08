export * as ProjectCopy from "./copy"

import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Slug } from "@graphagent/core/util/slug"
import { LLMEvent } from "@graphagent/llm"
import { Context, Effect, Layer, Stream } from "effect"

const COPY_NAME_AGENT: Agent.Info = {
  name: "project-copy-name",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

export interface Interface {
  /** Generates a short slug for a project copy, falling back to a random slug when no model is usable. */
  readonly generateName: (context: string | undefined) => Effect.Effect<string, unknown>
}

// Tag intentionally differs from @graphagent/core/project/copy ("@graphagent/ProjectCopy"):
// both services can be present in the same app graph and context keys are tag-based.
export class Service extends Context.Service<Service, Interface>()("@graphagent/ProjectCopyName") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service

    const generateName = Effect.fn("ProjectCopy.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const model =
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      const sessionID = SessionID.descending()
      const result = yield* llm
        .stream({
          agent: COPY_NAME_AGENT,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: COPY_NAME_AGENT.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: `Generate a short 2-3 word name that describes this task:\n${text}` }],
          purpose: "auxiliary",
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
        )
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    return Service.of({ generateName })
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

export const defaultLayer = layer.pipe(Layer.provide(LLM.defaultLayer), Layer.provide(Provider.defaultLayer))

export const node = LayerNode.make(layer, [LLM.node, Provider.node])
