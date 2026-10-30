import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { Location } from "@opencode-ai/core/location"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const it = testEffect(
  CommandV2.locationLayer.pipe(
    Layer.provide(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory }, { projectDirectory: project }))),
    ),
  ),
)

describe("CommandPlugin.Plugin", () => {
  it.effect("lets the model choose orchestration by benefit rather than task category", () =>
    Effect.sync(() => {
      const content = CommandPlugin.WorkflowContent.replace(/\s+/g, " ")
      expect(content).toContain("Choose direct execution, a `task` child, or a `workflow` DAG")
      expect(content).toContain("Small edits, bounded debugging, and read-only questions")
      expect(content).toContain("coordination cost")
      expect(content).toContain("Explicit user instructions take precedence")
      expect(content).toContain("No routing checklist is needed for routine direct work")
      expect(content).toContain("Promote to a DAG on your own judgment; the user need not ask.")
    }),
  )

  it.effect("teaches declared structure up front and checkpoint-driven per-item expansion", () =>
    Effect.sync(() => {
      const blocks = CommandPlugin.WorkflowBlocksContent.replace(/\s+/g, " ")
      expect(blocks).toContain("Every live `extend` or `control(replan)` costs a parent turn")
      expect(blocks).toContain("mutate at runtime only for structure that depends on results")
      const policy = CommandPlugin.OrchestrationPolicyContent.replace(/\s+/g, " ")
      expect(policy).toContain("add the item nodes with a bounded `extend`")
      expect(policy).toContain("`fan_out` only expands writers from a plan's `packages`")
    }),
  )

  it.effect("keeps connected DAG guidance free of mandatory routing and depth quotas", () =>
    Effect.sync(() => {
      const content = [
        CommandPlugin.WorkflowContent,
        CommandPlugin.WorkflowFactsContent,
        CommandPlugin.WorkflowBlocksContent,
        CommandPlugin.OrchestrationPolicyContent,
        CommandPlugin.OrchestrationDomainsContent,
        CommandPlugin.DagAutoContent,
      ]
        .join("\n")
        .replace(/\s+/g, " ")
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
      ])
        expect(content).not.toContain(rule)
    }),
  )

  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* CommandPlugin.Plugin.effect(
        host({
          command: { transform: command.transform, reload: command.reload },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect((yield* command.get("init"))?.template).toContain("`/repo`")
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        subtask: true,
      })
      expect(yield* command.get("dag-auto")).toMatchObject({
        name: "dag-auto",
        description: CommandPlugin.DagAutoDescription,
        template: CommandPlugin.DagAutoContent,
      })
      expect(CommandPlugin.DagAutoContent).toContain("$ARGUMENTS")
      expect(CommandPlugin.DagAutoContent).toContain("ultra-flow-route")
      expect(CommandPlugin.DagAutoContent).toContain("not the default")
      expect(CommandPlugin.DagAutoContent).toContain("Respect configured budgets")
      expect(CommandPlugin.DagAutoContent).toContain("explicit request for direct work or no DAG takes precedence")
      expect(CommandPlugin.DagAutoContent).toContain("Product decision checkpoint")
    }),
  )

  it.effect("retires the platform-delivery commands", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* CommandPlugin.Plugin.effect(
        host({
          command: { transform: command.transform, reload: command.reload },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("dag-init")).toBeUndefined()
      expect(yield* command.get("dag-flow")).toBeUndefined()
      expect(yield* command.get("dag-template-update")).toBeUndefined()
    }),
  )

  it.effect("keeps /dag-auto free of platform-delivery vocabulary", () =>
    Effect.sync(() => {
      const content = CommandPlugin.DagAutoContent
      expect(content).not.toContain("dag-init")
      // The intro/Rules name the boundary in the negative ("no issues, no
      // PRs"); actionable delivery mechanics must stay absent.
      expect(content).not.toContain("issue number")
      expect(content).not.toContain("gh pr")
      expect(content).not.toContain("pr checks")
      expect(content).not.toContain("Ordered merge")
      expect(content).not.toContain("rebase")
      expect(content).not.toContain("release brief")
      expect(content).toContain("routing and workflow-composition")
      expect(content).toContain('workflow(action="list")')
      expect(content).toContain('workflow(action="validate")')
      expect(content).toContain('workflow(action="start")')
    }),
  )

  it.effect("documents the smallest child execution mode", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("## Execution mode")
      expect(CommandPlugin.WorkflowContent).toContain("Direct execution:")
      expect(CommandPlugin.WorkflowContent).toContain("One `task` child")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Related work can usually")
      expect(CommandPlugin.WorkflowContent).toContain("including project source and tests")
      expect(CommandPlugin.WorkflowContent).toContain("not a task-category rule")
      expect(CommandPlugin.WorkflowFactsContent).toContain("resident\nOrchestration Router owns execution-mode")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("## When to start a workflow")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("when ANY")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("- **Multi-model**:")
      expect(CommandPlugin.DagAutoContent).toContain('workflow(action="start")')
    }),
  )

  it.effect("keeps always-on guidance small and loads detailed topics progressively", () =>
    Effect.sync(() => {
      // Entry form only: routing keeps when to promote and how to start. YAML,
      // references and risk tiers live in the on-demand guides.
      expect(Buffer.byteLength(CommandPlugin.WorkflowContent)).toBeLessThan(3_500)
      expect(CommandPlugin.WorkflowContent).toContain("including project source and tests")
      expect(CommandPlugin.WorkflowFactsContent).toContain("A small\ntask-local graph")
      expect(CommandPlugin.WorkflowContent).toContain("# Orchestration Router")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Workflow Brief")
      expect(CommandPlugin.WorkflowContent).toContain("smallest justified graph")
      expect(CommandPlugin.WorkflowContent).not.toMatch(/load (?:the )?[`"']?orchestration-router/i)
      expect(CommandPlugin.WorkflowContent).not.toContain("Do not discover, load, or apply an external Skill")
      expect(CommandPlugin.WorkflowContent).toContain('guide(topic="blocks")')
      expect(CommandPlugin.WorkflowContent).not.toContain("# Orchestration Domains")
      expect(CommandPlugin.WorkflowContent).not.toContain("```yaml")
      expect(CommandPlugin.WorkflowContent).not.toContain("Verdict Disposal Contract")
      expect(CommandPlugin.WorkflowContent).not.toContain("`lite` and `full`")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("# Composable Workflow Blocks")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("combined confirmation")
      expect(CommandPlugin.WorkflowBlocksContent).not.toContain("combined confirmation")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("product or architecture decision")
      expect(CommandPlugin.WorkflowBlocksContent).not.toContain("product or architecture decision")
      expect(CommandPlugin.WorkflowFactsContent.length).toBeGreaterThan(CommandPlugin.WorkflowContent.length)
    }),
  )

  it.effect("offers references after DAG selection without mandatory risk tiers", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("After choosing a DAG")
      expect(CommandPlugin.WorkflowContent).toContain('`workflow(action="list")`')
      expect(CommandPlugin.WorkflowContent).toContain("never guess a route name")
      expect(CommandPlugin.WorkflowContent).toContain("needs no library search")
      ;[
        "product planning",
        "technical design",
        "project development",
        "debug and repair",
        "code review",
        "security audit",
        "performance audit",
      ].forEach((domain) => expect(CommandPlugin.OrchestrationDomainsContent).toContain(domain))
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "`lite` and `full` are reference shapes, not mandatory tiers",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("upstream executable dependencies")
      expect(CommandPlugin.WorkflowFactsContent).toMatch(/Retarget a\s+matching custom workflow to the task/)
      expect(CommandPlugin.WorkflowFactsContent).toContain("rather than concatenating whole workflows")
      expect(CommandPlugin.WorkflowFactsContent).toMatch(/never\s+requires a full graph or a fixed reviewer count/)
      expect(CommandPlugin.WorkflowFactsContent).toContain("Verdict Disposal Contract")
      expect(CommandPlugin.OrchestrationPolicyContent).toMatch(/cannot be paused or replanned/)
    }),
  )

  it.effect("allows direct parent work without duplicating active children", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The parent conversation owns")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The parent may execute work directly")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Do not duplicate active child work")
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain("## Execution Mode Selection")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not prove acceptance")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("user's requested outcome")
      expect(CommandPlugin.WorkflowContent).toContain("One `task` child")
      expect(CommandPlugin.WorkflowContent).toContain("One `workflow` DAG")
      expect(CommandPlugin.DagAutoContent).toContain("one concise summary")
    }),
  )

  it.effect("uses file-backed specs for one-off and saved workflows", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowFactsContent).toContain("write the graph to a")
      expect(CommandPlugin.WorkflowFactsContent).toContain("task-local file")
      // The resident description keeps tool selection and the progressive
      // guide index only; per-action field semantics live in the parameter
      // schema (change repair-workflow-authoring-validation).
      expect(CommandPlugin.WorkflowContent).not.toContain("## Actions")
      expect(CommandPlugin.WorkflowContent).toContain("parameter schema")
      expect(CommandPlugin.WorkflowFactsContent).toContain('{ action: "read", spec_path: "<name-returned-by-list>" }')
      expect(CommandPlugin.WorkflowFactsContent).toContain("use only an exact returned name")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain('spec_path: "code-review"')
      expect(CommandPlugin.WorkflowFactsContent).toMatch(/Retarget its\s+objective and block instructions/)
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("pass `spec` inline")
      expect(CommandPlugin.DagAutoContent).toContain(".opencode/.dag-specs/")
      expect(CommandPlugin.DagAutoContent).toContain("retarget")
    }),
  )

  it.effect("scopes standalone validation to start envelopes", () =>
    Effect.sync(() => {
      const facts = CommandPlugin.WorkflowFactsContent.replace(/\s+/g, " ")
      const blocks = CommandPlugin.WorkflowBlocksContent.replace(/\s+/g, " ")
      expect(facts).toContain("Standalone `validate` accepts start files only")
      expect(facts).toContain("validate their own strict envelopes before any workflow mutation")
      expect(blocks).toContain("`validate` decodes a start envelope only")
      expect(blocks).toContain("standalone preflight for those envelopes is not supported")
    }),
  )

  it.effect("publishes an exact block YAML authoring contract", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowBlocksContent).toContain("Never infer or invent a YAML field")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("### Start file")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("### Extend file")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("### Replan file")
      expect(CommandPlugin.WorkflowBlocksContent).toMatch(
        /`id`, `kind`, `depends_on`, `instruction`,\s+`worker_type`, `worker_config`, `required`, and `report_to_parent`/,
      )
      expect(CommandPlugin.WorkflowBlocksContent).toContain("overrides `node_defaults.worker_config`")
      expect(CommandPlugin.WorkflowBlocksContent).toMatch(
        /`action`, `workflow_id`, `operation`, and `spec_path` are tool-call fields/,
      )
      const authoringContract = CommandPlugin.WorkflowBlocksContent.slice(
        CommandPlugin.WorkflowBlocksContent.indexOf("## Authoring contract"),
        CommandPlugin.WorkflowBlocksContent.indexOf("This guide owns"),
      )
      expect(authoringContract).toMatch(/[Tt]he\s+listed YAML fields are exhaustive/)
      expect(authoringContract).not.toMatch(
        /session_id|project_id|protocol_version|fingerprint|node_defaults\.model|node\.model/,
      )
      expect(CommandPlugin.WorkflowBlocksContent).toContain(
        '{ action: "control", operation: "replan", workflow_id: "dag_...", spec_path: "replan.yaml" }',
      )
    }),
  )

  it.effect("preserves opt-outs read-only scope and explicit role assignments", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("one agent, direct work, or no DAG")
      expect(CommandPlugin.WorkflowContent).toContain("A read-only request")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("explicit `@agent` assignment")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT invent a `worker_type`")
    }),
  )

  it.effect("documents config-first model fallback without invented identifiers", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Workflow YAML has no model-selection field")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "`dag.jsonc` tier → configured agent model → parent session model",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("workflow tool returns a blocked diagnostic")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not create the\nworkflow")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT invent a model identifier")
    }),
  )

  it.effect("defines adaptive brainstorm review and develop profiles", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Profile: Brainstorm")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("One analysis or a direct conversation can be")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("use only those that contribute")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Profile: Review")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("need not be separate agents or waves")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("An\narbiter helps when reports disagree")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Profile: Develop")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("interface and TDD")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Omit phases whose evidence is already satisfied")
    }),
  )

  it.effect("separates mechanical model selection from discretionary division of work", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Model Tiers and Evidence")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Either tier's claims need evidence")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("whether execution failure should stop the workflow")
      // Tier placement is the mechanical lever (config.ts tierModel): required/review prefer advanced.
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "`review`/`review-*` workers prefer the advanced model tier",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Choosing Depth")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("not to meet a phase count")
      expect(CommandPlugin.WorkflowFactsContent).toContain("not minimum phases")
    }),
  )

  it.effect("requires evidence for findings without requiring more review nodes", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "a concrete trigger, impact, and source or runtime evidence",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("unverified_claims")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("check directly or delegate it")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not automatically authorize repair")
    }),
  )

  it.effect("binds verdict disposal at the terminal boundary", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Verdict Disposal Contract")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("not automatic permission")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("reporting\nfindings may complete a review")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("direct bounded repair")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not mandate more agents")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Do not claim rejected work passed")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("settle live scheduling")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Verdict Disposal Contract")
    }),
  )

  it.effect("distinguishes required-node failure from business verdicts", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`required: true` handles execution failure")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not interpret a successful business verdict")
      for (const verdict of ["ACCEPT", "REVISE", "REJECT", "BLOCKED"]) {
        expect(CommandPlugin.OrchestrationPolicyContent).toContain(verdict)
      }
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("output_schema")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("condition")
    }),
  )

  it.effect("defines actionable checkpoints and bounded acyclic repair", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("report_to_parent: false")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("report_to_parent: true")
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain('"next_action"')
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The child reports evidence and required actions only")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Do not poll")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`extend` or `control(replan)`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT create cyclic `depends_on`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("max_node_replan_attempts")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("stop with `BLOCKED`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("do not retry the identical plan")
    }),
  )

  it.effect("defines the pause-first replan protocol", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Replan Protocol (pause-first)")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("pause scheduling before composing")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("explicit cancellation, use `control(cancel)`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("replan is valid while paused")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "Pause does not interrupt nodes that are already running",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("pause before composing a replan")
      expect(CommandPlugin.WorkflowFactsContent).toContain("explicit cancellation, use `cancel` directly")
    }),
  )

  it.effect("keeps cross-domain composition separate from route selection", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).not.toContain("# Orchestration Domains")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("# Cross-domain Workflow Composition")
      for (const outcome of [
        "The requested deliverable is a product decision",
        "The requested deliverable is an implementation-ready design",
        "The requested deliverable is changed code",
        "The requested deliverable is a defect repair",
        "The requested deliverable is a verdict",
      ]) {
        expect(CommandPlugin.OrchestrationDomainsContent).toContain(outcome)
      }
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("secondary assurance")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("Domain overlap does not itself require one")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("not as\nceremonial endpoints")
      expect(CommandPlugin.OrchestrationDomainsContent).not.toContain("## Playbook:")
    }),
  )

  it.effect("defines parent-session admission fixtures for standard deep and GRILL requests", () =>
    Effect.sync(() => {
      const fixtures = [
        {
          name: "simple request remains standard",
          expected: "`standard` remains the compatibility default",
        },
        {
          name: "qualified complex request recommends deep",
          expected: "There is no complexity-signal quota",
        },
        {
          name: "explicit deep enters admission",
          expected: "Explicit `deep` intent still requires admission",
        },
        {
          name: "questions stay in the parent session",
          expected: "MUST NOT create an admission child node",
        },
        {
          name: "explicit GRILL-ME selects adversarial QA",
          expected: "`GRILL-ME` selects `GRILL`",
        },
      ]

      for (const fixture of fixtures) {
        expect(CommandPlugin.OrchestrationPolicyContent, fixture.name).toContain(fixture.expected)
      }
    }),
  )

  it.effect("defines bounded Requirement Brief verdict and recovery contracts", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Deep Admission QA")
      for (const dimension of [
        "goal",
        "scope",
        "constraints and assumptions",
        "acceptance criteria",
        "evidence and review",
        "risks and failure modes",
      ]) {
        expect(CommandPlugin.OrchestrationPolicyContent).toContain(dimension)
      }
      for (const field of [
        "acceptance_criteria",
        "evidence_required",
        "review_plan",
        "open_questions",
        "blocking_questions",
      ]) {
        expect(CommandPlugin.OrchestrationPolicyContent).toContain(field)
      }
      expect(CommandPlugin.OrchestrationPolicyContent).toContain('"in": []')
      expect(CommandPlugin.OrchestrationPolicyContent).toContain('"out": []')
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain("in_scope")
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain("out_of_scope")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("combined confirmation")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The modes control challenge depth")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`LIGHT`: validate a nearly complete brief")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`GRILL`: additionally probe contradictions")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("recommending an answer")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("READY | NOT_READY | WAIVED")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "continue QA, reduce scope, use `standard`, or explicitly waive",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("waiver_reason")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("acknowledged_risks")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Material changes")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("invalidate the prior admission record")
      const admissionPolicy = CommandPlugin.OrchestrationPolicyContent.slice(
        CommandPlugin.OrchestrationPolicyContent.indexOf("## Deep Admission QA"),
        CommandPlugin.OrchestrationPolicyContent.indexOf("## Role Resolution"),
      )
      expect(admissionPolicy).not.toMatch(/protocol_version|fingerprint/)
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "The start spec places `mode: deep`, a versioned `READY` or informed `WAIVED`",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("The admission input accepts\nonly `brief_revision`")
      expect(CommandPlugin.WorkflowFactsContent).not.toMatch(/protocol_version|node_defaults\.model|node\.model/)
      expect(CommandPlugin.WorkflowFactsContent).toContain("A one-off graph may use a")
      expect(CommandPlugin.WorkflowFactsContent).toContain("task-local file")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("`config.mode`")
    }),
  )

  it.effect("documents truthful design and diff review production topologies", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("design review → implementation")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "implementation → verification(PASS) → diff review → final gate/audit",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "REJECT → corrected implementation → verification(PASS) → new diff review",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Synthetic stress-test graphs")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT claim implementation-diff assurance")
    }),
  )

  it.effect("keeps workflow examples aligned with runtime data flow and safety", () =>
    Effect.sync(() => {
      const graphExamples = [...CommandPlugin.WorkflowFactsContent.matchAll(/```yaml\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? "")
        .filter((example) => example.includes("nodes:"))

      expect(graphExamples.length).toBeGreaterThan(0)
      for (const example of graphExamples) {
        expect(example).toMatch(/^config:/m)
        expect(example).not.toMatch(/^action:/m)
        expect(example).toMatch(/\n  nodes:/)
        expect(example).not.toMatch(/^nodes:/m)
        expect(example.match(/^\s+- id:/gm)?.length).toBe(example.match(/^ {6}name:/gm)?.length)
        expect(example.match(/^\s+- id:/gm)?.length).toBe(example.match(/^ {6}depends_on:/gm)?.length)
      }
      expect(CommandPlugin.WorkflowFactsContent).toContain("input_mapping:")
      expect(CommandPlugin.WorkflowFactsContent).toContain("findings: explore")
      expect(CommandPlugin.WorkflowFactsContent).toContain("condition: 'gate.output.verdict == \"ACCEPT\"'")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain('input: { findings: "from explore" }')
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("Gate failure cancels the workflow automatically")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Static `prompt_template.input`")
      expect(CommandPlugin.WorkflowFactsContent).toContain("it must\nnever appear as `[object Object]`")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Workflow YAML has no model-selection field")
      expect(CommandPlugin.WorkflowFactsContent).toMatch(
        /`dag\.jsonc`\s+tier, then the\s+configured agent model, then the parent-session model/,
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("Propose-then-assemble")
      const reviewExample = CommandPlugin.WorkflowFactsContent.slice(
        CommandPlugin.WorkflowFactsContent.indexOf("### 3. Adversarial Review"),
        CommandPlugin.WorkflowFactsContent.indexOf("### 4. Diverge-Converge"),
      )
      expect(reviewExample).toContain("report_to_parent: true")
      expect(reviewExample).toContain("output_schema:")
      expect(reviewExample).toContain("required: [verdict, summary, findings, required_actions]")
      expect(reviewExample).not.toContain("next_action")
      expect(reviewExample).toContain("The parent chooses any workflow control action")
      // The arbiter must not be a silent terminal leaf: a conditioned
      // continuation node keeps non-ACCEPT verdicts from dead-ending the graph.
      expect(reviewExample).toContain("condition: 'arbitrate.output.verdict != \"ACCEPT\"'")
      expect(CommandPlugin.WorkflowFactsContent).toContain("an early\n`control(complete)` workflow remains terminal")
      expect(CommandPlugin.WorkflowFactsContent).toContain("project, global, and builtin scopes")
      expect(CommandPlugin.WorkflowFactsContent).toContain("bounded objectives")
      expect(CommandPlugin.WorkflowFactsContent).toContain("validation status")
    }),
  )
})
