import { describe, expect, test } from "bun:test"
import { GraphAgentPrompt } from "@opencode-ai/core/system-context/graphagent"

describe("GraphAgentPrompt", () => {
  test("renders one identity with the hooks and DAG entry points", () => {
    const prompt = GraphAgentPrompt.render(["edit", "write"])
    expect(prompt).toContain("You are graphagent")
    expect(prompt).toContain("graphagent uses the OpenCode kernel")
    expect(prompt).toContain("# Hooks")
    expect(prompt).toContain("# DAG workflows")
    expect(prompt).not.toContain("${")
  })

  test("names the editing tools exposed to the request", () => {
    expect(GraphAgentPrompt.render(["apply_patch"])).toContain("Use apply_patch for manual file edits.")
    expect(GraphAgentPrompt.render(["edit", "write"])).toContain("Use edit and write for manual file edits.")
    expect(GraphAgentPrompt.render(["write"])).toContain("Use write for manual file edits.")
    // V2 exposes both families to every model; edit/write are self-describing.
    expect(GraphAgentPrompt.render(["apply_patch", "edit", "write"])).toContain(
      "Use edit and write for manual file edits.",
    )
    expect(GraphAgentPrompt.render([])).toContain("No file-editing tool is available in this request")
  })

  test("keeps the identity outside the variable editing line", () => {
    const withTools = GraphAgentPrompt.render(["edit"])
    const withoutTools = GraphAgentPrompt.render([])
    expect(withTools.replace("Use edit for manual file edits.", "")).toBe(
      withoutTools.replace(
        "No file-editing tool is available in this request. Do not use shell commands to bypass this restriction.",
        "",
      ),
    )
  })
})
