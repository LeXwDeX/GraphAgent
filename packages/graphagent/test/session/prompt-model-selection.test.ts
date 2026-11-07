import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { selectPromptModel } from "../../src/session/prompt"

const providerID = ProviderV2.ID.make("test")
const saved = { providerID, id: ModelV2.ID.make("saved-model"), variant: "high" }
const agent = { providerID, modelID: ModelV2.ID.make("agent-model") }
const requested = { providerID, modelID: ModelV2.ID.make("requested-model") }

describe("selectPromptModel", () => {
  test("keeps the session model when the caller omits a model", () => {
    expect(selectPromptModel({ saved, agent })).toEqual({
      providerID,
      modelID: saved.id,
      variant: "high",
    })
  })

  test("falls back to the agent model without a session model", () => {
    expect(selectPromptModel({ agent })).toEqual(agent)
  })

  test("prefers an explicit request model over the session and agent models", () => {
    expect(selectPromptModel({ requested, saved, agent })).toEqual(requested)
  })

  test("omits the variant when the saved model has none", () => {
    expect(selectPromptModel({ saved: { providerID, id: saved.id } })).toEqual({
      providerID,
      modelID: saved.id,
    })
  })
})
