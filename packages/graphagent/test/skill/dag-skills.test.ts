// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { BUILTIN_SKILLS } from "@/skill/builtin"

// The dag-* skills replaced the removed workflow guide topics. These tests pin
// the behavioral contracts that used to live in workflow.md,
// workflow-blocks.md, orchestration-policy.md, orchestration-domains.md, and
// the /dag-auto prompt, plus the per-file byte budgets that keep the always-on
// skill list and on-demand loads bounded.

const DAG_SKILLS = ["dag-auto", "dag-blocks", "dag-nodes", "dag-recovery", "dag-patterns", "dag-policy"] as const

const BUDGETS: Record<(typeof DAG_SKILLS)[number], number> = {
  "dag-auto": 8 * 1024,
  "dag-blocks": 8 * 1024,
  "dag-nodes": 10 * 1024,
  "dag-recovery": 12 * 1024,
  "dag-patterns": 8 * 1024,
  "dag-policy": 10 * 1024,
}

function content(name: (typeof DAG_SKILLS)[number]) {
  const item = BUILTIN_SKILLS.find((skill) => skill.name === name)
  if (!item) throw new Error(`missing builtin skill ${name}`)
  return item.content
}

const flat = (value: string) => value.replace(/\s+/g, " ")

describe("dag built-in skills", () => {
  test("registers six dag skills with five hidden reference skills", () => {
    const dag = BUILTIN_SKILLS.filter((skill) => skill.name.startsWith("dag-"))
    expect(dag.map((skill) => skill.name)).toEqual([...DAG_SKILLS])
    expect(dag.filter((skill) => skill.hidden).map((skill) => skill.name)).toEqual([
      "dag-blocks",
      "dag-nodes",
      "dag-recovery",
      "dag-patterns",
      "dag-policy",
    ])
    const auto = dag.find((skill) => skill.name === "dag-auto")
    expect(auto?.hidden).toBeUndefined()
    expect(auto?.description).toBe(
      "Assess useful DAG orchestration for a request and adapt the graph to its evidence and dependencies",
    )
    for (const skill of dag) expect(skill.description?.length ?? 0).toBeGreaterThan(0)
  })

  test("keeps every skill inside its byte budget and the total under 56 KB", () => {
    for (const name of DAG_SKILLS) {
      expect(Buffer.byteLength(content(name))).toBeLessThanOrEqual(BUDGETS[name])
    }
    const total = DAG_SKILLS.reduce((sum, name) => sum + Buffer.byteLength(content(name)), 0)
    expect(total).toBeLessThanOrEqual(56 * 1024)
  })

  test("names skills instead of the removed guide topics", () => {
    for (const name of DAG_SKILLS) {
      expect(content(name)).not.toMatch(/guide\s*\(\s*topic/i)
      expect(content(name)).not.toContain("workflow guide")
    }
    const all = flat(DAG_SKILLS.map((name) => content(name)).join("\n"))
    for (const reference of [
      "skill dag-blocks",
      "skill dag-nodes",
      "skill dag-recovery",
      "skill dag-patterns",
      "skill dag-policy",
    ]) {
      expect(all).toContain(reference)
    }
  })

  test("keeps connected DAG guidance free of mandatory routing and depth quotas", () => {
    const all = flat(DAG_SKILLS.map((name) => content(name)).join("\n"))
    for (const rule of [
      "even one project file",
      "Use `lite` only when all",
      "the correction wave MUST be full-shaped",
      "Hard minimums by target size",
      "four waves minimum",
      "at least two independent viewpoint nodes",
      "at least two deep-complexity signals",
      "at least two substantial complexity signals",
      "MUST NOT perform executable leaf work",
      "The advanced tier MUST NOT do bulk work",
      "The standard tier MUST NOT render a final verdict",
      "Template-first for every route",
      "3 back-edges",
    ]) {
      expect(all).not.toContain(rule)
    }
  })
})

describe("dag-auto", () => {
  test("carries the routing contract, references, and workflow-artifacts path", () => {
    const auto = flat(content("dag-auto"))
    expect(auto).toContain("explicit request for direct work or no DAG takes precedence")
    expect(auto).toContain('workflow({params:{action:"spec",operation:"list"}})')
    expect(auto).toContain("`ultra-flow-route`, when available")
    expect(auto).toContain("not the default")
    expect(auto).toContain("respect budgets")
    expect(auto).toContain("Product decision checkpoint")
    expect(auto).toContain("XDG workflow-artifacts")
    expect(auto).not.toContain("${dag_specs}")
    expect(auto).not.toContain("$ARGUMENTS")
    expect(auto).toContain("the request is appended after this body")
  })

  test("keeps platform-delivery mechanics out of the command", () => {
    const auto = content("dag-auto")
    expect(auto).toContain("Platform delivery")
    expect(auto).not.toContain("dag-init")
    expect(auto).not.toContain("issue number")
    expect(auto).not.toContain("gh pr")
    expect(auto).not.toContain("pr checks")
    expect(auto).not.toContain("Ordered merge")
    expect(auto).not.toContain("rebase")
    expect(auto).not.toContain("release brief")
  })

  test("merges saved-workflow authoring with current paths and rules", () => {
    const auto = flat(content("dag-auto"))
    expect(auto).toContain(".agents/workflows/<name>.yaml")
    expect(auto).toContain("workflows/<name>.yaml")
    expect(auto).toContain(".agents/workflows/prompts/")
    expect(auto).toContain("A project file shadows a global file")
    expect(auto).toContain("Never write `model` on a node")
    expect(auto).toContain("never invent one")
    expect(auto).toContain("No cycles or dangling `depends_on` IDs")
    expect(auto).toContain("Terminal nodes are immutable")
    expect(auto).toContain("`spec(list)`")
    expect(auto).toContain("`run(start)`")
  })
})

describe("dag-blocks", () => {
  test("publishes the start, extend, and replan envelopes with executable YAML", () => {
    const blocks = content("dag-blocks")
    expect(blocks).toContain("Never infer or invent a YAML field")
    expect(blocks).toContain("### Start file")
    expect(blocks).toContain("### Extend file")
    expect(blocks).toContain("### Replan file")
    expect(blocks).toContain("`objective` lives INSIDE `config`")
    expect(blocks).toContain("`blocks` or `nodes`, never both")
    expect(blocks).toContain("graph budgets")
    expect(blocks).toContain("never both")
  })

  test("publishes the exact block field contract", () => {
    const blocks = content("dag-blocks")
    expect(blocks).toMatch(
      /`id`, `kind`, `depends_on`, `instruction`,\s+`worker_type`, `worker_config`, `required`, and `report_to_parent`/,
    )
    expect(blocks).toContain("overrides `node_defaults.worker_config`")
    expect(blocks).toMatch(/`action`, `workflow_id`, `operation`, `spec_path`, and `profile`/)
    expect(blocks).toContain("These YAML fields are exhaustive")
    expect(blocks).toContain(
      '{ action: "control", operation: "replan", workflow_id: "dag_...", spec_path: "replan.yaml" }',
    )
    expect(blocks).toContain("`validate` decodes start only")
    expect(blocks).toContain("`fan_out: <plan-block-id>`")
    expect(blocks).toContain("triple-disjoint")
  })

  test("teaches declared structure up front and checkpoint-driven per-item expansion", () => {
    const blocks = flat(content("dag-blocks"))
    expect(blocks).toContain("Every live `extend` or `control(replan)` costs a parent turn")
    expect(blocks).toContain("mutate at runtime only for structure that depends on results")
  })
})

describe("dag-nodes", () => {
  test("documents saved-workflow resolution and reuse", () => {
    const nodes = flat(content("dag-nodes"))
    expect(nodes).toContain("is a **name** resolved against the workflow library")
    expect(nodes).toContain("Project shadows global, and both shadow builtin")
    expect(nodes).toContain("never infer one")
    expect(nodes).toContain("a small task-local graph needs no library search")
    expect(nodes).toContain("`lite` and `full` are reference shapes, not mandatory tiers")
    expect(nodes).toContain("upstream executable dependencies")
    expect(nodes).toContain("Retarget a matching custom workflow and reuse valid results")
    expect(nodes).toContain("rather than concatenating whole workflows")
    expect(nodes).toContain("never requires a full graph or a fixed reviewer count")
  })

  test("documents node inputs, model selection, and prompt templates", () => {
    const nodes = flat(content("dag-nodes"))
    expect(nodes).toContain("resultA: node-a")
    expect(nodes).toContain("count: node-c.output.count")
    expect(nodes).toContain("template variable → upstream source")
    expect(nodes).toContain("workflow YAML has no model-selection field")
    expect(nodes).toMatch(/`dag` section of `settings\.json`.*selected agent model.*parent-session model/)
    expect(nodes).toContain("blocked diagnostic")
    expect(nodes).toContain("Static `prompt_template.input`")
    expect(nodes).toContain("never appear as `[object Object]`")
    expect(nodes).toContain("unverified_claims")
    expect(nodes).toContain("workflows/prompts/")
  })

  test("documents budgets, workspace discipline, and node fields", () => {
    const nodes = flat(content("dag-nodes"))
    expect(nodes).toContain("max_concurrency`: default 5")
    expect(nodes).toContain("max_node_replan_attempts`: default 5")
    expect(nodes).toContain("max_total_nodes`: default and minimum 100")
    expect(nodes).toContain("timeout_ms`: default 10 minutes")
    expect(nodes).toContain("Propose-then-assemble")
    expect(nodes).toContain("Tier A — Disjoint write sets")
    expect(nodes).toContain("Tier B — Propose-then-assemble")
    for (const field of [
      "`id`",
      "`name`",
      "`worker_type`",
      "`depends_on`",
      "`required`",
      "`prompt_template`",
      "`condition`",
      "`input_mapping`",
      "`report_to_parent`",
      "`worker_config`",
      "`output_schema`",
      "`restart`",
      "`cancel`",
      "`review`",
    ]) {
      expect(nodes).toContain(`| ${field}`)
    }
    expect(nodes).toContain("`==`, `!=`, `>`, `<`, `>=`, or `<=`")
    expect(nodes).toContain("implementation_fingerprint")
    expect(nodes).toContain("delivery_node")
  })
})

describe("dag-policy", () => {
  test("separates mechanical model selection from discretionary division of work", () => {
    const policy = flat(content("dag-policy"))
    expect(policy).toContain("Model tiers and evidence")
    expect(policy).toContain("Either tier's claims need evidence")
    expect(policy).toContain("whether execution failure should stop the workflow")
    expect(policy).toContain("`review`/`review-*` workers prefer the advanced tier")
    expect(policy).toContain("Choosing depth")
    expect(policy).toContain("not to meet a phase count")
  })

  test("defines parent ownership, communication, and confirmation", () => {
    const policy = flat(content("dag-policy"))
    expect(policy).toContain("The parent owns user interaction")
    expect(policy).toContain("Do not duplicate active child work")
    expect(policy).toContain("never the user")
    expect(policy).toContain("Workflow Brief")
    expect(policy).toContain("one combined confirmation")
    expect(policy).toContain("never expand scope alone")
  })

  test("defines deep admission fixtures for standard, deep, and GRILL requests", () => {
    const policy = flat(content("dag-policy"))
    for (const expected of [
      "`standard` remains the compatibility default",
      "there is no signal quota",
      "Explicit `deep` intent still requires admission",
      "Do NOT create an admission child node",
      "`GRILL-ME` selects `GRILL`",
      "goal; scope; constraints and assumptions; acceptance criteria; evidence and review; risks and failure modes",
      "`LIGHT`",
      "`GRILL`",
      "READY | NOT_READY | WAIVED",
      "continue QA, reduce scope, use `standard`, or waive",
      "waiver_reason",
      "acknowledged_risks",
      "invalidate the prior admission record",
    ]) {
      expect(policy).toContain(expected)
    }
    for (const field of [
      "acceptance_criteria",
      "evidence_required",
      "review_plan",
      "open_questions",
      "blocking_questions",
    ]) {
      expect(policy).toContain(field)
    }
    expect(policy).toContain('"in": []')
    expect(policy).toContain('"out": []')
    expect(policy).not.toContain("in_scope")
    expect(policy).not.toContain("out_of_scope")
    expect(policy).toContain("brief_revision")
    expect(policy).toContain("qa_mode")
  })

  test("resolves roles and models without invented identifiers", () => {
    const policy = flat(content("dag-policy"))
    expect(policy).toContain("explicit `@agent` assignment")
    expect(policy).toContain("Do NOT invent a `worker_type`")
    expect(policy).toContain("`dag` tier in `settings.json` → configured agent model → parent session model")
    expect(policy).toContain("do NOT invent a model identifier")
    expect(policy).toContain("blocked diagnostic and creates no workflow")
  })

  test("documents truthful design and diff review topologies", () => {
    const policy = flat(content("dag-policy"))
    expect(policy).toContain("design review → implementation")
    expect(policy).toContain("implementation → verification(PASS) → diff review → final gate/audit")
    expect(policy).toContain("REJECT → corrected implementation → verification(PASS) → new diff review")
    expect(policy).toContain("Synthetic stress-test graphs")
    expect(policy).toContain("must NOT claim implementation-diff assurance")
  })

  test("distinguishes required-node failure from business verdicts", () => {
    const policy = flat(content("dag-policy"))
    expect(policy).toContain("`required: true` handles execution failure")
    expect(policy).toContain("does not interpret a successful business verdict")
    expect(policy).toContain("`REVISE` or `REJECT` is a completed node")
    for (const verdict of ["ACCEPT", "REVISE", "REJECT", "BLOCKED"]) {
      expect(policy).toContain(verdict)
    }
    expect(policy).toContain("output_schema")
    expect(policy).toContain("condition")
  })
})

describe("dag-recovery", () => {
  test("binds verdict disposal at the terminal boundary", () => {
    const recovery = flat(content("dag-recovery"))
    expect(recovery).toContain("Verdict Disposal Contract")
    expect(recovery).toContain("not permission to expand")
    expect(recovery).toContain("reporting findings may complete a review")
    expect(recovery).toContain("direct bounded repair")
    expect(recovery).toContain("does not mandate more agents")
    expect(recovery).toContain("never claim rejected work passed")
    expect(recovery).toContain("Settle live scheduling")
    expect(recovery).toContain("Keep Going Past a Terminal Graph")
    expect(recovery).toContain("the original request is the authorization")
  })

  test("defines failure triage, crash recovery, and bounded repair", () => {
    const recovery = flat(content("dag-recovery"))
    expect(recovery).toContain("Node failure triage")
    for (const errorClass of ["timeout", "exec_failed", "verdict_fail", "workflow_failed", "error_class"]) {
      expect(recovery).toContain(errorClass)
    }
    expect(recovery).toContain("cancelled via replan")
    expect(recovery).toContain("Crash recovery")
    expect(recovery).toContain("execution ownership lost on recovery")
    expect(recovery).toContain("resume_cancelled: true")
    expect(recovery).toContain("control(recover)")
    expect(recovery).toContain("Do not create cyclic `depends_on`")
    expect(recovery).toContain("max_node_replan_attempts")
    expect(recovery).toContain("stop with `BLOCKED`")
    expect(recovery).toContain("do not retry the identical plan")
  })

  test("defines actionable checkpoint gating and the pause reminder invariant", () => {
    const recovery = flat(content("dag-recovery"))
    expect(recovery).toContain("A `report_to_parent` node with dependents is a reporting checkpoint")
    expect(recovery).toContain("A gated checkpoint must declare `output_schema`")
    expect(recovery).toContain("A paused workflow gets one durable, delayed reminder per pause episode")
    expect(recovery).toContain("a reminder never resumes, completes, or fails the workflow")
    expect(recovery).toContain("`fan_out` only expands writers from a plan's `packages`")
    expect(recovery).toContain("Do not poll `status` to wait")
    expect(recovery).toContain("required_actions")
  })

  test("defines the pause-first replan protocol", () => {
    const recovery = flat(content("dag-recovery"))
    expect(recovery).toContain("Replan Protocol (pause-first)")
    expect(recovery).toContain("pause before composing the fragment")
    expect(recovery).toContain("explicit cancellation, use `control(cancel)`")
    expect(recovery).toContain("valid while paused")
    expect(recovery).toContain("Pause does not interrupt running nodes")
    expect(recovery).toContain("restart: true")
    expect(recovery).toContain("control(resume)")
  })

  test("separates graph acceptance from execution", () => {
    const recovery = flat(content("dag-recovery"))
    expect(recovery).toContain("accepted")
    expect(recovery).toContain("not that its nodes **execute**")
    expect(recovery).toContain("an acceptance receipt cannot")
    expect(recovery).toContain("repeating unchanged invalid input is not recovery")
  })
})

describe("dag-patterns", () => {
  test("documents the four structural patterns", () => {
    const patterns = flat(content("dag-patterns"))
    expect(patterns).toContain("Staged pipeline with gate")
    expect(patterns).toContain("Parallel fan-out")
    expect(patterns).toContain("Adversarial review")
    expect(patterns).toContain("Diverge-converge")
    expect(patterns).toContain("A successful non-ACCEPT verdict does not fail the node")
    expect(patterns).toContain("Non-required worker failures do not cancel the workflow")
    expect(patterns).toContain("condition: 'arbitrate.output.verdict != \"ACCEPT\"'")
    expect(patterns).toContain("never silently terminalizes the graph")
  })

  test("keeps cross-domain composition separate from route selection", () => {
    const patterns = flat(content("dag-patterns"))
    expect(patterns).toContain("The Router and workflow library own route and execution choices")
    for (const outcome of [
      "Product decision",
      "Implementation-ready design",
      "Changed code",
      "Defect repair",
      "Verdict",
    ]) {
      expect(patterns).toContain(outcome)
    }
    expect(patterns).toContain("secondary assurance")
    expect(patterns).toContain("domain overlap does not itself require one")
    expect(patterns).toContain("not as ceremonial endpoints")
    expect(patterns).not.toContain("## Playbook:")
    expect(patterns).toContain("does not reset budgets or authorize new work")
  })
})