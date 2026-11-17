// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3a: the composer catalog, the limits, the plan schema and its check,
// and the prompts, all pure. What a plan is allowed to say is decided here; what
// the engine does with one is the scheduler's.
import { describe, expect, it } from "bun:test"
import { DagCompose } from "@/dag/compose"
import { validateAgainstSchema, unsupportedSchemaKeywords } from "@/dag/runtime/schema-validator"
import { placeholderKeys } from "@/dag/templates/resolve"
import { isRecord } from "@/util/record"
import { agent, agents, catalog, compose, composerOf, writerRules } from "./compose-fixtures"

const limits = DagCompose.DEFAULT_LIMITS
const item = (id: string, extra: Partial<DagCompose.PlanItem> = {}): DagCompose.PlanItem => ({
  id,
  agent: "researcher",
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: DagCompose.PlanItem[], extra: Partial<DagCompose.Plan> = {}): DagCompose.Plan => ({
  rationale: "Three angles cover the question",
  items,
  not_planned: [],
  ...extra,
})
// Shapes the plan types forbid, built on purpose to see the schema refuse them.
const loose = (value: Record<string, unknown>): unknown => value
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("expected an object")
  return value
}

describe("limits", () => {
  it("falls back to 6, 2 and 40 when dag.compose sets nothing", () => {
    expect(DagCompose.DEFAULT_LIMITS).toEqual({ maxChildren: 6, maxDepth: 2, maxSubtreeNodes: 40 })
    expect(DagCompose.limits(undefined)).toEqual(DagCompose.DEFAULT_LIMITS)
    expect(DagCompose.limits({})).toEqual(DagCompose.DEFAULT_LIMITS)
    expect(DagCompose.limits({ compose: {} })).toEqual(DagCompose.DEFAULT_LIMITS)
  })

  it("takes each key independently", () => {
    expect(DagCompose.limits({ compose: { max_children: 12 } })).toEqual({ ...limits, maxChildren: 12 })
    expect(DagCompose.limits({ compose: { max_depth: 3 } })).toEqual({ ...limits, maxDepth: 3 })
    expect(DagCompose.limits({ compose: { max_subtree_nodes: 80 } })).toEqual({ ...limits, maxSubtreeNodes: 80 })
    expect(DagCompose.limits({ compose: { max_children: 2, max_depth: 1, max_subtree_nodes: 10 } })).toEqual({
      maxChildren: 2,
      maxDepth: 1,
      maxSubtreeNodes: 10,
    })
  })
})

describe("the composer catalog", () => {
  it("lists only the dispatch agents that exist now, are public and are read-only, in the declared order", () => {
    const surveyor = composerOf("surveyor")
    // secret is private, prototyper writes, ghost does not exist.
    expect(surveyor.dispatch.map((worker) => worker.name)).toEqual(["researcher", "explore", "auditor"])
    expect(surveyor).toMatchObject({ name: "surveyor", pattern: "fan_out", fallback: "researcher" })
    expect(surveyor.artifact).toBe("survey_report")
    expect(composerOf("mapper")).toMatchObject({ pattern: "recursive_split", fallback: "explore" })
  })

  it("carries each worker's artifact and what its failure means for a plan", () => {
    const workers = Object.fromEntries(composerOf("surveyor").dispatch.map((worker) => [worker.name, worker]))
    expect(workers.researcher).toMatchObject({ artifact: "research_findings", failure: "skip" })
    expect(workers.explore).toMatchObject({ artifact: "code_findings", failure: "skip" })
    // An explicit `fail` contract, and no artifact.
    expect(workers.auditor).toEqual({ name: "auditor", failure: "fail" })
    expect(workers.explore.description).toBe("Reads the code and reports what it finds.")
  })

  it("drops an agent that stopped being expandable when the catalog is rebuilt", () => {
    const reopened = agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
    expect(composerOf("surveyor", reopened).dispatch.map((worker) => worker.name)).toEqual(["researcher", "auditor"])
  })

  it("reports why a composer is unavailable, naming the agent", () => {
    const reopened = agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
    const resolution = DagCompose.resolve(catalog(reopened), "mapper")
    expect(resolution.available).toBe(false)
    if (resolution.available) return
    expect(resolution.reason).toContain('composer "mapper" is unavailable')
    expect(resolution.reason).toContain('agent "explore"')
    expect(resolution.reason).toContain("can write files")
  })

  it("reports an unusable fallback", () => {
    const list = [
      ...agents().filter((entry) => entry.name !== "surveyor"),
      agent("surveyor", {
        contract: { role: "composer", compose: compose("fan_out", ["explore", "secret"], "secret") },
      }),
    ]
    const resolution = DagCompose.resolve(catalog(list), "surveyor")
    expect(resolution.available).toBe(false)
    if (!resolution.available) expect(resolution.reason).toContain('fallback "secret" cannot be expanded')
  })

  it("tells an agent that is not a composer, a name that is not an agent, and a composer apart", () => {
    const found = catalog()
    expect(DagCompose.resolve(found, "researcher")).toEqual({
      available: false,
      reason: 'agent "researcher" is not a composer',
    })
    expect(DagCompose.resolve(found, "ghost")).toEqual({ available: false, reason: 'agent "ghost" does not exist' })
    expect(DagCompose.resolve(found, "surveyor").available).toBe(true)
    expect(DagCompose.isComposer(found, "surveyor")).toBe(true)
    expect(DagCompose.isComposer(found, "researcher")).toBe(false)
    expect(DagCompose.isComposer(found, "ghost")).toBe(false)
    expect(DagCompose.isComposer(undefined, "surveyor")).toBe(false)
  })

  it("keeps an unusable composer in the catalog so a node naming it can be explained", () => {
    const list = agents().filter((entry) => entry.name !== "explore")
    const found = catalog(list)
    // mapper's only dispatch agent is gone, but it is still a composer.
    expect(DagCompose.isComposer(found, "mapper")).toBe(true)
    expect(DagCompose.resolve(found, "mapper").available).toBe(false)
  })
})

describe("the plan schema", () => {
  const schemaOf = (name: string, override: Partial<DagCompose.Limits> = {}) =>
    DagCompose.planSchema(composerOf(name), { ...limits, ...override })
  const itemProperties = (schema: Record<string, unknown>) =>
    record(record(record(record(schema.properties).items).items).properties)

  it("uses only keywords the DAG's subset validator enforces", () => {
    expect(unsupportedSchemaKeywords(schemaOf("surveyor"))).toEqual([])
    expect(unsupportedSchemaKeywords(schemaOf("mapper"))).toEqual([])
  })

  it("makes agent an enum of the dispatchable agents only", () => {
    expect(record(itemProperties(schemaOf("surveyor")).agent).enum).toEqual(["researcher", "explore", "auditor"])
    expect(record(itemProperties(schemaOf("mapper")).agent).enum).toEqual(["explore"])
  })

  it("accepts a plan that names dispatchable agents", () => {
    const valid = plan([item("official"), item("code", { agent: "explore" }), item("gate", { agent: "auditor" })])
    expect(validateAgainstSchema(valid, schemaOf("surveyor"))).toEqual({ ok: true })
  })

  it.each([
    ["a private agent", "secret"],
    ["a writer", "prototyper"],
    ["an agent that does not exist", "ghost"],
    ["another composer", "mapper"],
    ["an agent that is not in this composer's dispatch list", "build"],
  ])("rejects an item that names %s, and says what the choices are", (_label, name) => {
    const result = validateAgainstSchema(plan([item("a", { agent: name })]), schemaOf("surveyor"))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('"agent"')
    expect(result.error).toContain('["researcher","explore","auditor"]')
  })

  it("derives the enum from the catalog as it is now, so an old plan is checked against what changed", () => {
    const reopened = agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
    const schema = DagCompose.planSchema(composerOf("surveyor", reopened), limits)
    expect(validateAgainstSchema(plan([item("code", { agent: "explore" })]), schema).ok).toBe(false)
    expect(validateAgainstSchema(plan([item("web")]), schema).ok).toBe(true)
  })

  it("caps the items at max_children", () => {
    const items = (count: number) => Array.from({ length: count }, (_, index) => item(`i${index}`))
    expect(schemaOf("surveyor").properties).toMatchObject({ items: { maxItems: 6 } })
    expect(validateAgainstSchema(plan(items(6)), schemaOf("surveyor")).ok).toBe(true)
    const tooMany = validateAgainstSchema(plan(items(7)), schemaOf("surveyor"))
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error).toContain("expected maxItems 6, got 7")
    // The cap is the limit given, not a constant.
    expect(validateAgainstSchema(plan(items(7)), schemaOf("surveyor", { maxChildren: 12 })).ok).toBe(true)
    expect(validateAgainstSchema(plan(items(3)), schemaOf("surveyor", { maxChildren: 2 })).ok).toBe(false)
  })

  it("lets a plan hold no items: the runtime degrades that, the schema does not call it malformed", () => {
    expect(validateAgainstSchema(plan([]), schemaOf("surveyor")).ok).toBe(true)
  })

  it("has split only for a recursive_split composer", () => {
    expect(itemProperties(schemaOf("surveyor")).split).toBeUndefined()
    expect(record(itemProperties(schemaOf("mapper")).split)).toMatchObject({ type: "boolean" })
    const splitting = plan([item("big", { agent: "explore", split: true })])
    expect(validateAgainstSchema(splitting, schemaOf("mapper")).ok).toBe(true)
    const refused = validateAgainstSchema(plan([item("big", { split: true })]), schemaOf("surveyor"))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('unexpected additional property: "split"')
  })

  it.each([
    ["no rationale", { rationale: undefined }],
    ["no items list", { items: undefined }],
    ["no not_planned", { not_planned: undefined }],
    ["an empty rationale", { rationale: "" }],
    ["an unknown field", { priority: "high" }],
  ])("rejects a plan with %s", (_label, change) => {
    expect(validateAgainstSchema(loose({ ...plan([item("a")]), ...change }), schemaOf("surveyor")).ok).toBe(false)
  })

  it.each([
    ["no instruction", { instruction: undefined }],
    ["an empty instruction", { instruction: "" }],
    ["no id", { id: undefined }],
    ["an id with a space", { id: "two words" }],
    ["an id that starts with a hyphen", { id: "-a" }],
    ["an id with a slash", { id: "a/b" }],
    ["a required that is not a boolean", { required: "yes" }],
    ["a scope that is not a list of strings", { scope: [1] }],
    ["an unknown field", { weight: 3 }],
  ])("rejects an item with %s", (_label, change) => {
    const broken = loose({ ...plan([]), items: [{ ...item("a"), ...change }] })
    expect(validateAgainstSchema(broken, schemaOf("surveyor")).ok).toBe(false)
  })

  it("accepts every optional field an item has", () => {
    const full = item("a", { scope: ["src/session", "docs"], required: false })
    expect(
      validateAgainstSchema(plan([full], { not_planned: ["mobile clients: out of scope"] }), schemaOf("surveyor")),
    ).toEqual({ ok: true })
  })

  it("is a pure function of the composer and the limits", () => {
    expect(schemaOf("surveyor")).toEqual(schemaOf("surveyor"))
    expect(DagCompose.planSchema(composerOf("surveyor"), limits)).not.toBe(
      DagCompose.planSchema(composerOf("surveyor"), limits),
    )
  })

  it("tells the composer which agents count as required in the description", () => {
    const description = String(record(itemProperties(schemaOf("surveyor")).required).description)
    expect(description).toContain("auditor always count as required")
    expect(String(record(itemProperties(schemaOf("mapper")).required).description)).not.toContain("always count")
  })
})

describe("itemRequired", () => {
  const surveyor = composerOf("surveyor")

  it("takes the agent's contract when the item leaves required out", () => {
    expect(DagCompose.itemRequired({ agent: "researcher" }, surveyor)).toBe(false)
    expect(DagCompose.itemRequired({ agent: "auditor" }, surveyor)).toBe(true)
  })

  it("lets a plan mark a skippable item as required", () => {
    expect(DagCompose.itemRequired({ agent: "researcher", required: true }, surveyor)).toBe(true)
    expect(DagCompose.itemRequired({ agent: "researcher", required: false }, surveyor)).toBe(false)
  })

  it("never lets a plan skip the work of a fail agent", () => {
    expect(DagCompose.itemRequired({ agent: "auditor", required: false }, surveyor)).toBe(true)
  })

  it("treats an agent the composer cannot dispatch as not required", () => {
    expect(DagCompose.itemRequired({ agent: "ghost" }, surveyor)).toBe(false)
  })
})

describe("checkPlan", () => {
  const surveyor = composerOf("surveyor")
  const mapper = composerOf("mapper")

  it("accepts a plan and returns it typed, from an object or from the node's JSON text", () => {
    const valid = plan([item("official", { scope: ["docs"] }), item("code", { agent: "explore", required: true })], {
      not_planned: ["pricing"],
    })
    const checked = DagCompose.checkPlan(valid, surveyor, limits)
    expect(checked).toEqual({ ok: true, plan: valid })
    expect(DagCompose.checkPlan(JSON.stringify(valid), surveyor, limits)).toEqual({ ok: true, plan: valid })
  })

  it("refuses a fail agent's item marked required: false, and says why", () => {
    const checked = DagCompose.checkPlan(plan([item("gate", { agent: "auditor", required: false })]), surveyor, limits)
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.error).toContain('item "gate" names "auditor"')
    expect(checked.error).toContain("cannot be marked required: false")
  })

  it("accepts a fail agent's item that says required: true or nothing, and a skippable item marked false", () => {
    for (const extra of [{ required: true }, {}]) {
      expect(DagCompose.checkPlan(plan([item("gate", { agent: "auditor", ...extra })]), surveyor, limits).ok).toBe(true)
    }
    expect(DagCompose.checkPlan(plan([item("web", { required: false })]), surveyor, limits).ok).toBe(true)
  })

  it("refuses a plan that is not JSON, and one that breaks the schema", () => {
    expect(DagCompose.checkPlan("not json", surveyor, limits)).toEqual({
      ok: false,
      error: "the plan is not one JSON value",
    })
    const wrongAgent = DagCompose.checkPlan(plan([item("a", { agent: "secret" })]), surveyor, limits)
    expect(wrongAgent.ok).toBe(false)
    if (!wrongAgent.ok) expect(wrongAgent.error).toContain("expected one of")
    const tooMany = DagCompose.checkPlan(
      plan(Array.from({ length: 7 }, (_, index) => item(`i${index}`))),
      surveyor,
      limits,
    )
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error).toContain("maxItems 6")
  })

  it("refuses two items with the same id", () => {
    const checked = DagCompose.checkPlan(plan([item("a"), item("a", { agent: "explore" })]), surveyor, limits)
    expect(checked).toEqual({ ok: false, error: 'item id "a" is used twice' })
  })

  it("refuses an item whose split node would take another item's id", () => {
    const checked = DagCompose.checkPlan(
      plan([item("a", { agent: "explore", split: true }), item("a--split", { agent: "explore" })]),
      mapper,
      limits,
    )
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error).toContain('produces the node id "a--split"')
  })

  it("checks a plan again against the catalog as it is now", () => {
    const valid = plan([item("code", { agent: "explore" })])
    expect(DagCompose.checkPlan(valid, surveyor, limits).ok).toBe(true)
    const reopened = agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
    // The same output no longer passes: the composer's enum lost explore.
    expect(DagCompose.checkPlan(valid, composerOf("surveyor", reopened), limits).ok).toBe(false)
  })

  it("checks a plan against the limits it is given", () => {
    const three = plan([item("a"), item("b"), item("c")])
    expect(DagCompose.checkPlan(three, surveyor, limits).ok).toBe(true)
    expect(DagCompose.checkPlan(three, surveyor, { ...limits, maxChildren: 2 }).ok).toBe(false)
  })
})

describe("the prompts", () => {
  const surveyor = composerOf("surveyor")
  const mapper = composerOf("mapper")
  const top = DagCompose.topPosition(limits)

  it("starts at depth 1 with the whole subtree quota", () => {
    expect(top).toEqual({ depth: 1, remainingNodes: 40 })
    expect(DagCompose.topPosition({ maxChildren: 4, maxDepth: 3, maxSubtreeNodes: 25 })).toEqual({
      depth: 1,
      remainingNodes: 25,
    })
  })

  it("lists each agent with the artifact it produces and whether its work is required", () => {
    const text = DagCompose.splitContract(surveyor, limits, top)
    expect(text).toContain("- researcher: produces research_findings; the plan can go on without it")
    expect(text).toContain("- explore: produces code_findings; the plan can go on without it")
    expect(text).toContain("- auditor: answers in free text; its work is required")
    expect(text).toContain("Researches outside sources.")
    for (const hidden of ["secret", "prototyper", "ghost"]) expect(text).not.toContain(`- ${hidden}:`)
  })

  it("states the item cap, the depth and the node quota it was given", () => {
    const text = DagCompose.splitContract(surveyor, { maxChildren: 9, maxDepth: 3, maxSubtreeNodes: 55 }, top)
    expect(text).toContain("At most 9 items")
    expect(text).toContain("Depth 1 of 3")
    expect(text).toContain("at most 40 more nodes")
    // A nested plan is told its own position.
    const nested = DagCompose.splitContract(mapper, limits, { depth: 2, remainingNodes: 17 })
    expect(nested).toContain("Depth 2 of 2")
    expect(nested).toContain("at most 17 more nodes")
  })

  it("mentions split only for a recursive_split composer", () => {
    expect(DagCompose.splitContract(surveyor, limits, top)).not.toContain("split:")
    expect(DagCompose.splitContract(mapper, limits, top)).toContain("split: set true")
  })

  it("keeps an agent description from reading as a placeholder", () => {
    const list = agents().map((entry) =>
      entry.name === "researcher"
        ? agent("researcher", { description: "Fills {{objective}}\n  and more", contract: entry.contract })
        : entry,
    )
    const text = DagCompose.splitContract(composerOf("surveyor", list), limits, top)
    expect(text).toContain("Fills objective and more")
    expect(placeholderKeys(text)).toEqual([])
  })

  it("never carries a template placeholder of its own", () => {
    for (const composer of [surveyor, mapper]) {
      expect(placeholderKeys(DagCompose.splitContract(composer, limits, top))).toEqual([])
      expect(placeholderKeys(DagCompose.joinContract(composer))).toEqual([])
    }
  })

  it("asks the join for the composer's artifact and for the missing results in not_examined", () => {
    expect(DagCompose.joinContract(surveyor)).toContain("Return the survey_report artifact")
    expect(DagCompose.joinContract(mapper)).toContain("Return the project_map artifact")
    expect(DagCompose.joinContract(surveyor)).toContain("not_examined")
    expect(DagCompose.joinContract({ ...surveyor, artifact: undefined })).not.toContain("artifact.")
  })
})
