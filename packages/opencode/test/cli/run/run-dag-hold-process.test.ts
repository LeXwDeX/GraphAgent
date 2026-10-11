// Subprocess integration tests for the consumer-only DAG hold (issue 614).
// Each test drives the real `opencode run` CLI binary against the in-process
// TestLLMServer (same harness as run-process.test.ts): a scripted provider
// plays the parent model, workflow children, and wake turns; assertions cover
// the child process exit code and stdout ordering. The DAG engine itself is
// production code here — workflows are started through the real `workflow`
// tool from YAML specs written into the isolated test home.
//
// Stdout carries ONLY assistant text parts of the target session (tool lines
// and headers go to stderr), so each case can assert exact stdout: the turn-1
// continuation line proves the loop survived the first idle, and the final
// wake line proves the hold kept the process alive for the wake turn.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { reply } from "../../lib/llm-server"
import {
  artifactCliTarget,
  cliIt as sourceCliIt,
  cliItFor,
  type ResolvedCliTarget,
  type RunResult,
} from "../../lib/cli-process"

const artifactExecutable = process.env.OPENCODE_TEST_ARTIFACT_EXECUTABLE
const artifactEvidenceDir = process.env.OPENCODE_TEST_ARTIFACT_EVIDENCE_DIR
if (artifactEvidenceDir && !path.isAbsolute(artifactEvidenceDir)) {
  throw new Error(`artifact CLI evidence directory must be an absolute path: ${artifactEvidenceDir}`)
}
const cliIt = artifactExecutable ? cliItFor(artifactCliTarget(artifactExecutable)) : sourceCliIt

function recordArtifactEvidence(
  name: string,
  inputs: readonly unknown[],
  target: ResolvedCliTarget,
  result: RunResult,
) {
  if (!artifactExecutable || !artifactEvidenceDir) return Effect.void
  return Effect.promise(async () => {
    await mkdir(artifactEvidenceDir, { recursive: true, mode: 0o700 })
    await Bun.write(
      path.join(artifactEvidenceDir, `${name}.json`),
      JSON.stringify({ target, result, requests: inputs }, null, 2) + "\n",
    )
  })
}

const SKIP_PERMISSIONS = ["--dangerously-skip-permissions"]

function bodyIncludes(marker: string) {
  return (hit: { body: unknown }) => JSON.stringify(hit.body).includes(marker)
}

const wakeCompleted = bodyIncludes("[DAG Workflow completed]")

// Two-node chain, the last node reporting to the parent: the s4 shape —
// workflow started in turn one, children complete, the workflow terminalizes
// and wakes the parent.
const chainSpec = `title: cli-hold-chain
config:
  name: cli-hold-chain
  result_protocol: submit_result
  nodes:
    - id: first
      name: first
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "S4-FIRST marker: do the first unit of work."
    - id: final
      name: final
      worker_type: general
      depends_on: [first]
      prompt_template:
        inline: "S4-FINAL marker: summarize the work."
      report_to_parent: true
`

// Single schemaless node that settles from its plain text reply.
const singleSpec = `title: cli-hold-single
config:
  name: cli-hold-single
  result_protocol: submit_result
  nodes:
    - id: only
      name: only
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "EARLY-SINGLE marker: do the work."
      report_to_parent: true
`

const parentPlanMarker = "DAG_FINAL_RESPONSE_PARENT_PLAN"
const childFinalMarker = "DAG_FINAL_RESPONSE_CHILD"
const childFinalText = "DAG_FINAL_RESPONSE_RAW_ONCE_52AF"
const parentPlanText = "The implementation plan is ready."
const finalResponseSpec = `title: cli-final-response
config:
  name: cli-final-response
  result_protocol: final_response
  delivery_node: final
  max_concurrency: 1
  nodes:
    - id: final
      name: final
      worker_type: general
      depends_on: []
      report_to_parent: false
      prompt_template:
        inline: "${childFinalMarker}: return the requested final response."
`
const multiParentMarker = "DAG_MULTI_FINAL_RESPONSE_PARENT"
const multiPlanText = "Both workflow plans are ready."
const multiFinals = [
  { name: "alpha", marker: "DAG_MULTI_FINAL_ALPHA", answer: "DAG_MULTI_FINAL_ALPHA_RAW_03A1" },
  { name: "beta", marker: "DAG_MULTI_FINAL_BETA", answer: "DAG_MULTI_FINAL_BETA_RAW_94BC" },
] as const
const mixedParentMarker = "DAG_MIXED_FINAL_RESPONSE_PARENT"
const mixedPlanText = "The workflows are underway."
const mixedDecisionText = "The checkpoint remains paused pending human approval."
const mixedFinalMarker = "DAG_MIXED_FINAL_REPORT"
const mixedFinalAnswer = "DAG_MIXED_FINAL_REPORT_RAW_779D"
const policyGuideMarker = "blocks: compose explore/plan/prototype/debug/coding/verify/review/synthesize blocks"
const mixedFinalSpec = `title: cli-mixed-final-report
config:
  name: cli-mixed-final-report
  result_protocol: final_response
  delivery_node: final
  max_concurrency: 1
  nodes:
    - id: final
      name: final
      worker_type: general
      depends_on: []
      report_to_parent: false
      prompt_template:
        inline: "${mixedFinalMarker}: return the final report."
`
const mixedDecisionSpec = `title: cli-mixed-decision
config:
  name: cli-mixed-decision
  result_protocol: submit_result
  nodes:
    - id: gate
      name: gate
      worker_type: general
      depends_on: []
      report_to_parent: true
      output_schema:
        type: object
        properties:
          verdict:
            type: string
            enum: [replan]
        required: [verdict]
        additionalProperties: false
      prompt_template:
        inline: "MIXED-DECISION-GATE: return the replan verdict."
    - id: waiting
      name: waiting
      worker_type: general
      depends_on: [gate]
      condition: 'gate.output.verdict == "replan"'
      prompt_template:
        inline: "MIXED-DECISION-WAITING: this node should remain paused."
`

function finalResponseSpecFor(name: string, marker: string) {
  return `title: cli-multi-final-${name}
config:
  name: cli-multi-final-${name}
  result_protocol: final_response
  delivery_node: final
  max_concurrency: 1
  nodes:
    - id: final
      name: final
      worker_type: general
      depends_on: []
      report_to_parent: false
      prompt_template:
        inline: "${marker}: return the final report."
`
}

function emittedText(
  result: RunResult,
  opencode: { parseJsonEvents(stdout: string): Array<Record<string, unknown>> },
  format: "default" | "json",
) {
  if (format === "default") return result.stdout.trimEnd().split("\n")
  return opencode
    .parseJsonEvents(result.stdout)
    .filter((event) => event.type === "text")
    .map((event) => event.part)
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") {
        throw new Error("JSON run emitted a text event without a text part")
      }
      return part.text
    })
}

// Required node declaring an output_schema the child never satisfies (the
// auto-reply never calls submit_result): deterministic verdict_fail bound.
const failSpec = `title: cli-hold-failure
config:
  name: cli-hold-failure
  nodes:
    - id: must
      name: must
      worker_type: general
      depends_on: []
      required: true
      prompt_template:
        inline: "FAIL-BOUND marker: produce the structured verdict."
      output_schema:
        type: object
        properties:
          verdict:
            type: string
            enum: [GO]
        required: [verdict]
        additionalProperties: false
`

// Reporting checkpoint with a gated dependent: the gate child submits a
// "replan" verdict, the workflow pauses at the checkpoint (durable, survives
// the process), and the dependent only runs after an explicit resume.
const checkpointSpec = `title: cli-hold-checkpoint
config:
  name: cli-hold-checkpoint
  result_protocol: submit_result
  nodes:
    - id: gate
      name: gate
      worker_type: general
      depends_on: []
      report_to_parent: true
      output_schema:
        type: object
        properties:
          verdict:
            type: string
            enum: [replan]
        required: [verdict]
        additionalProperties: false
      prompt_template:
        inline: "ADOPT-GATE marker: adjudicate the plan."
    - id: final
      name: final
      worker_type: general
      depends_on: [gate]
      condition: 'gate.output.verdict == "replan"'
      prompt_template:
        inline: "ADOPT-FINAL marker: finish the work."
`

function writeSpec(home: string, name: string, content: string) {
  return Effect.promise(() => Bun.write(path.join(home, name), content))
}

describe("opencode run DAG hold (issue 614)", () => {
  for (const format of ["default", "json"] as const) {
    cliIt.concurrent(
      `prints the final_response delivery node exactly once and exits (${format})`,
      ({ home, llm, opencode, target }) =>
        Effect.gen(function* () {
          const spec = path.join(home, "wf-final-response.yaml")
          yield* writeSpec(home, "wf-final-response.yaml", finalResponseSpec)
          yield* llm.pushMatch(
            bodyIncludes(parentPlanMarker),
            reply()
              .tool("workflow", { params: { action: "start", spec_path: spec } })
              .item(),
          )
          yield* llm.pushMatch(bodyIncludes(parentPlanMarker), reply().text(parentPlanText).stop().item())
          yield* llm.pushMatch(bodyIncludes(childFinalMarker), reply().text(childFinalText).stop().item())

          const result = yield* opencode.run(`${parentPlanMarker}: start the workflow and report the plan`, {
            format,
            extraArgs: SKIP_PERMISSIONS,
          })
          opencode.expectExit(result, 0)
          expect(result.target).toEqual(target)

          if (format === "default") {
            const lines = result.stdout.trimEnd().split("\n")
            expect(lines.filter((line) => line === parentPlanText)).toHaveLength(1)
            expect(lines.filter((line) => line === childFinalText)).toHaveLength(1)
            expect(lines.at(-1)).toBe(childFinalText)
          } else {
            const events = opencode.parseJsonEvents(result.stdout)
            const text = events
              .filter((event) => event.type === "text")
              .map((event) => event.part)
              .map((part) => {
                if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") {
                  throw new Error("JSON run emitted a text event without a text part")
                }
                return part.text
              })
            expect(text.filter((value) => value === parentPlanText)).toHaveLength(1)
            expect(text.filter((value) => value === childFinalText)).toHaveLength(1)
            expect(text.at(-1)).toBe(childFinalText)
          }

          const requests = (yield* llm.inputs).filter(
            (request) => !JSON.stringify(request).includes("Generate a title for this conversation"),
          )
          const parentRequests = requests.filter((request) => JSON.stringify(request).includes(parentPlanMarker))
          expect(parentRequests).toHaveLength(2)
          expect(requests.some((request) => JSON.stringify(request).includes(childFinalText))).toBe(false)
          expect(requests.some((request) => JSON.stringify(request).includes("[DAG Workflow completed]"))).toBe(false)
        }),
      180_000,
    )
  }

  for (const format of ["default", "json"] as const) {
    cliIt.concurrent(
      `waits for both completed final_response workflows and emits each answer once (${format})`,
      ({ home, llm, opencode }) =>
        Effect.gen(function* () {
          const specs = multiFinals.map((workflow) => ({
            ...workflow,
            path: path.join(home, `wf-multi-final-${workflow.name}.yaml`),
          }))
          for (const workflow of specs) {
            yield* writeSpec(home, path.basename(workflow.path), finalResponseSpecFor(workflow.name, workflow.marker))
            yield* llm.pushMatch(
              bodyIncludes(multiParentMarker),
              reply()
                .tool("workflow", { params: { action: "start", spec_path: workflow.path } })
                .item(),
            )
          }
          yield* llm.pushMatch(bodyIncludes(multiParentMarker), reply().text(multiPlanText).stop().item())
          for (const workflow of specs) {
            yield* llm.pushMatch(bodyIncludes(workflow.marker), reply().text(workflow.answer).stop().item())
          }

          const result = yield* opencode.run(`${multiParentMarker}: start both workflows`, {
            format,
            extraArgs: SKIP_PERMISSIONS,
          })
          opencode.expectExit(result, 0)
          const text = emittedText(result, opencode, format)
          expect(text.filter((value) => value === multiPlanText)).toHaveLength(1)
          for (const workflow of specs) expect(text.filter((value) => value === workflow.answer)).toHaveLength(1)
          expect(new Set<string>(specs.map((workflow) => workflow.answer)).has(text.at(-1) ?? "")).toBe(true)

          const requests = (yield* llm.inputs).filter(
            (request) => !JSON.stringify(request).includes("Generate a title for this conversation"),
          )
          expect(requests.filter((request) => JSON.stringify(request).includes(multiParentMarker))).toHaveLength(3)
          for (const workflow of specs) {
            expect(requests.some((request) => JSON.stringify(request).includes(workflow.answer))).toBe(false)
          }
          expect(requests.some((request) => JSON.stringify(request).includes("[DAG Workflow completed]"))).toBe(false)
        }),
      180_000,
    )
  }

  cliIt.concurrent(
    "finishes the parent decision turn and then emits the completed mixed-batch report once",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const finalPath = path.join(home, "wf-mixed-final.yaml")
        const decisionPath = path.join(home, "wf-mixed-decision.yaml")
        yield* writeSpec(home, path.basename(finalPath), mixedFinalSpec)
        yield* writeSpec(home, path.basename(decisionPath), mixedDecisionSpec)
        yield* llm.pushMatch(
          bodyIncludes(mixedParentMarker),
          reply()
            .tool("workflow", { params: { action: "start", spec_path: finalPath } })
            .item(),
        )
        yield* llm.pushMatch(
          bodyIncludes(mixedParentMarker),
          reply()
            .tool("workflow", { params: { action: "start", spec_path: decisionPath } })
            .item(),
        )
        yield* llm.pushMatch((hit) => {
          const body = JSON.stringify(hit.body)
          return body.includes(mixedParentMarker) && !body.includes("[DAG Node Result")
        }, reply().text(mixedPlanText).stop().item())
        yield* llm.pushMatch(
          bodyIncludes("[DAG Node Result"),
          reply()
            .tool("workflow", { params: { action: "guide" } })
            .item(),
        )
        let releaseFinal = () => {}
        const finalRelease = new Promise<void>((resolve) => {
          releaseFinal = resolve
        })
        yield* llm.pushMatch((hit) => {
          const body = JSON.stringify(hit.body)
          if (!body.includes(policyGuideMarker)) return false
          releaseFinal()
          return true
        }, reply().text(mixedDecisionText).stop().item())
        yield* llm.pushMatch(
          bodyIncludes(mixedFinalMarker),
          reply().wait(finalRelease).text(mixedFinalAnswer).stop().item(),
        )
        yield* llm.pushMatch(
          bodyIncludes("MIXED-DECISION-GATE"),
          reply()
            .tool("submit_result", { payload: { verdict: "replan" } })
            .item(),
        )

        const result = yield* opencode.run(`${mixedParentMarker}: start report and checkpoint workflows`, {
          extraArgs: SKIP_PERMISSIONS,
        })
        opencode.expectExit(result, 0)
        const lines = emittedText(result, opencode, "default")
        expect(lines.filter((line) => line === mixedPlanText)).toHaveLength(1)
        expect(lines).toContain(mixedDecisionText)
        expect(lines.filter((line) => line === mixedFinalAnswer)).toHaveLength(1)
        expect(lines.at(-1)).toBe(mixedFinalAnswer)

        const requests = (yield* llm.inputs).filter(
          (request) => !JSON.stringify(request).includes("Generate a title for this conversation"),
        )
        expect(requests.some((request) => JSON.stringify(request).includes("[DAG Node Result"))).toBe(true)
        expect(requests.some((request) => JSON.stringify(request).includes(mixedFinalAnswer))).toBe(false)
        expect(requests.some((request) => JSON.stringify(request).includes("[DAG Workflow completed]"))).toBe(false)
      }),
    180_000,
  )

  cliIt.concurrent(
    "no-DAG single-turn prompt exits with the exact reply",
    ({ llm, opencode, target }) =>
      Effect.gen(function* () {
        yield* llm.text("plain exact reply")
        const result = yield* opencode.run("just talk, start no workflow")
        opencode.expectExit(result, 0)
        expect(result.target).toEqual(target)
        expect(result.stdout).toBe("plain exact reply\n")
        yield* recordArtifactEvidence("no-dag", yield* llm.inputs, target, result)
      }),
    60_000,
  )

  // s4-style regression: the pre-hold CLI broke on the first idle while the
  // workflow was still running, losing the wake reply. Two busy->idle cycles
  // are observable here as the two stdout lines: turn one's continuation
  // ("ok" from the unmatched auto-reply) and the wake turn's reply, last.
  cliIt.concurrent(
    "holds through a running workflow and prints the final wake reply last",
    ({ home, llm, opencode, target }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-s4.yaml")
        yield* writeSpec(home, "wf-s4.yaml", chainSpec)
        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(wakeCompleted, reply().text("wake handled").stop().item())

        const result = yield* opencode.run("S4 run the two node chain", { extraArgs: SKIP_PERMISSIONS })

        opencode.expectExit(result, 0)
        expect(result.target).toEqual(target)
        expect(result.stdout).toBe("ok\nwake handled\n")
        yield* recordArtifactEvidence("dag-hold", yield* llm.inputs, target, result)
      }),
    180_000,
  )

  // The workflow terminalizes inside turn one (single fast child). The
  // parent's continuation is held on a promise released after a fixed grace so
  // the first idle poll observes an already-terminal-but-never-seen workflow —
  // the first-sighted-id condition must still hold for its wake turn. A slower
  // host only shifts which hold condition fires; the assertions hold either
  // way (the grace is a race boundary, not a readiness signal).
  cliIt.concurrent(
    "holds when the workflow terminalizes within turn one",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-early.yaml")
        yield* writeSpec(home, "wf-early.yaml", singleSpec)
        let release: () => void = () => {}
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(bodyIncludes("EARLY-TOKEN"), reply().wait(released).text("turn one done").stop().item())
        yield* llm.pushMatch(wakeCompleted, reply().text("wake handled").stop().item())

        const run = yield* opencode.startRun("EARLY-TOKEN start the single node workflow", {
          extraArgs: SKIP_PERMISSIONS,
        })
        yield* Effect.sleep("3 seconds")
        release()
        const result = yield* run.result

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("turn one done\nwake handled\n")
      }),
    150_000,
  )

  // Failure bound: the required node fails its output contract (verdict_fail),
  // the workflow terminalizes as failed, and the wake turn prints the failure
  // summary reply before a clean exit.
  cliIt.concurrent(
    "bounds failures: failed workflow delivers its wake summary and exits 0",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-fail.yaml")
        yield* writeSpec(home, "wf-fail.yaml", failSpec)
        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(bodyIncludes("[DAG Workflow failed]"), reply().text("failure acknowledged").stop().item())

        const result = yield* opencode.run("FAIL-BOUND start the required verdict node", {
          extraArgs: SKIP_PERMISSIONS,
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("ok\nfailure acknowledged\n")
      }),
    180_000,
  )

  // Adoption via --continue, in two real CLI runs over one durable project:
  //   run 1 starts a gated workflow; the gate child submits a "replan" verdict
  //   and the workflow PAUSES at the checkpoint. The CLI must exit 0 after the
  //   pause wake turn (paused keeps today's exit semantics — this is also the
  //   subprocess paused bound).
  //   run 2 (--continue) adopts the paused workflow at boot, resumes it by id,
  //   and must hold through the resumed running phase to the completion wake.
  // The package test preload forces OPENCODE_DB=":memory:" and the CLI harness
  // leaks it into every subprocess (each run would see a fresh database), so
  // both runs pin a file DB inside the isolated home through the harness env
  // override — the only way a durable workflow can cross process boundaries
  // under this harness. A crash-orphaned RUNNING node can never stay running
  // across processes (recovery reconciles it to a pause by engine design), so
  // deterministic adoption necessarily goes through pause + explicit resume;
  // the running-at-adoption decision path is covered in the unit table.
  cliIt.concurrent(
    "adopts a checkpoint-paused workflow via --continue and holds through its resumed run",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-adopt.yaml")
        yield* writeSpec(home, "wf-adopt.yaml", checkpointSpec)
        const dbEnv = { OPENCODE_DB: path.join(home, "opencode-adopt-test.db") }

        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("ADOPT-GATE"),
          reply()
            .tool("submit_result", { payload: { verdict: "replan" } })
            .item(),
        )
        yield* llm.pushMatch(bodyIncludes("[DAG Node Result"), reply().text("checkpoint seen").stop().item())

        const first = yield* opencode.run("ADOPT run the gated workflow", { extraArgs: SKIP_PERMISSIONS, env: dbEnv })
        opencode.expectExit(first, 0)
        expect(first.stdout).toBe("ok\ncheckpoint seen\n")

        // The durable workflow id appears in the recorded request bodies (the
        // start tool result and the wake summary both embed it) — exactly one
        // workflow exists in this project.
        const inputs = yield* llm.inputs
        const ids = new Set(JSON.stringify(inputs).match(/dag_[a-z0-9]+/gi) ?? [])
        expect(ids.size).toBe(1)
        const workflowID = [...ids][0]

        yield* llm.tool("workflow", {
          params: { action: "control", operation: "resume", workflow_id: workflowID },
        })
        yield* llm.pushMatch(wakeCompleted, reply().text("adopted complete").stop().item())

        const second = yield* opencode.run("ADOPT resume and finish the workflow", {
          extraArgs: ["--continue", ...SKIP_PERMISSIONS],
          env: dbEnv,
        })

        opencode.expectExit(second, 0)
        expect(second.stdout).toBe("ok\nadopted complete\n")
      }),
    240_000,
  )
})
