// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { CommandPlugin } from "@graphagent/core/plugin/command"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { BUILTIN_SKILLS } from "../../../src/skill/builtin"
import { reply } from "../../lib/llm-server"
import {
  artifactCliTarget,
  cliItFor,
  sourceCliTarget,
  type ResolvedCliTarget,
  type RunResult,
} from "../../lib/cli-process"

const artifactExecutable = process.env.GRAPHAGENT_TEST_ARTIFACT_EXECUTABLE
const sourceEnabled = process.env.GRAPHAGENT_TEST_DAG_PROMPTS_SOURCE === "1"
const evidenceDir = process.env.GRAPHAGENT_TEST_DAG_PROMPTS_EVIDENCE_DIR
const enabled = !!artifactExecutable || sourceEnabled
const target = artifactExecutable ? artifactCliTarget(artifactExecutable) : sourceCliTarget
const cliIt = cliItFor(target)

if (evidenceDir && !path.isAbsolute(evidenceDir)) {
  throw new Error(`DAG prompt evidence directory must be absolute: ${evidenceDir}`)
}
if (artifactExecutable && !evidenceDir) {
  throw new Error("artifact DAG prompt checks require GRAPHAGENT_TEST_DAG_PROMPTS_EVIDENCE_DIR")
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(strings)
}

function workflowDescriptions(inputs: readonly Record<string, unknown>[]) {
  const descriptions: string[] = []
  for (const input of inputs) {
    if (!Array.isArray(input.tools)) continue
    for (const tool of input.tools) {
      if (!tool || typeof tool !== "object") continue
      const fn = Reflect.get(tool, "function")
      if (!fn || typeof fn !== "object") continue
      if (Reflect.get(fn, "name") !== "workflow") continue
      const description = Reflect.get(fn, "description")
      if (typeof description === "string") descriptions.push(description)
    }
  }
  return descriptions
}

function turnIncludes(value: string) {
  return (hit: { body: unknown }) => {
    const body = JSON.stringify(hit.body)
    return body.includes(value) && !body.includes("Generate a title for this conversation")
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

const DAG_SKILLS = ["dag-auto", "dag-blocks", "dag-nodes", "dag-recovery", "dag-patterns", "dag-policy"] as const
const dagSkills = DAG_SKILLS.map((name) => {
  const item = BUILTIN_SKILLS.find((skill) => skill.name === name)
  if (!item) throw new Error(`missing built-in skill ${name}`)
  return item
})
const dagAuto = dagSkills[0]!

function recordEvidence(
  name: string,
  input: {
    readonly target: ResolvedCliTarget
    readonly result: RunResult
    readonly requests: readonly Record<string, unknown>[]
    readonly expected: Record<string, string>
  },
) {
  if (!evidenceDir) return Effect.void
  return Effect.promise(async () => {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    await Bun.write(path.join(evidenceDir, `${name}.json`), JSON.stringify(input, null, 2) + "\n")
  })
}

describe.skipIf(!enabled)("DAG resident prompts in a CLI target", () => {
  cliIt.concurrent(
    "dispatches dag-auto and sends the exact expanded resident prompt",
    ({ llm, opencode, target: resolvedTarget }) =>
      Effect.gen(function* () {
        const argumentsText = "DAG_PROMPT_ROUTE_SENTINEL inspect this bounded request"
        // The skill body has no $ARGUMENTS placeholder; expandCommandTemplate
        // appends the invocation arguments after the body and trims.
        const expanded = `${dagAuto.content}\n\n${argumentsText}`.trim()
        yield* llm.text("dag-auto prompt loaded")

        const result = yield* opencode.run(argumentsText, { command: "dag-auto" })
        const requests = yield* llm.inputs

        yield* recordEvidence("dag-auto-dispatch", {
          target: resolvedTarget,
          result,
          requests,
          expected: { dagAutoSha256: sha256(dagAuto.content), argumentsText },
        })
        opencode.expectExit(result, 0)
        expect(result.target).toEqual(resolvedTarget)
        expect(result.stdout).toBe("dag-auto prompt loaded\n")
        expect(strings(requests).some((value) => value.includes(expanded))).toBe(true)
      }),
    120_000,
  )

  cliIt.concurrent(
    "loads all six dag skills through the skill tool with exact content",
    ({ llm, opencode, target: resolvedTarget }) =>
      Effect.gen(function* () {
        const marker = "DAG_SKILLS_LOAD_SENTINEL"
        const escaped = (value: string) => JSON.stringify(value.trim()).slice(1, -1)
        const call = dagSkills.reduce((item, skill, index) => item.toolAt(index, "skill", { name: skill.name }), reply())
        yield* llm.pushMatch(turnIncludes(marker), call.item())
        yield* llm.pushMatch(
          (hit) => {
            const body = JSON.stringify(hit.body)
            return dagSkills.every(
              (skill) =>
                body.includes(`<skill_content name=\\"${skill.name}\\">`) && body.includes(escaped(skill.content)),
            )
          },
          reply().text("skills loaded").stop().item(),
        )

        const result = yield* opencode.run(marker, { extraArgs: ["--dangerously-skip-permissions"] })
        const requests = yield* llm.inputs
        const serialized = JSON.stringify(requests)

        yield* recordEvidence("dag-skills-load", {
          target: resolvedTarget,
          result,
          requests,
          expected: Object.fromEntries(dagSkills.map((skill) => [`${skill.name}Sha256`, sha256(skill.content)])),
        })
        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("skills loaded\n")
        for (const skill of dagSkills) {
          expect(serialized).toContain(escaped(skill.content))
        }
      }),
    180_000,
  )

  cliIt.concurrent(
    "sends the exact workflow routing description and the converged action schema",
    ({ llm, opencode, target: resolvedTarget }) =>
      Effect.gen(function* () {
        const marker = "DAG_GUIDES_ROUTE_SENTINEL"

        // The guide action is gone: the resident routing description alone
        // carries the four action groups, and the tool schema carries the
        // per-operation branches.
        yield* llm.pushMatch(turnIncludes(marker), reply().text("workflow routing loaded").stop().item())

        const result = yield* opencode.run(marker, { extraArgs: ["--dangerously-skip-permissions"] })
        const requests = yield* llm.inputs
        const serialized = JSON.stringify(requests)

        yield* recordEvidence("workflow-routing", {
          target: resolvedTarget,
          result,
          requests,
          expected: { workflowRoutingSha256: sha256(CommandPlugin.WorkflowContent) },
        })
        opencode.expectExit(result, 0)
        expect(result.target).toEqual(resolvedTarget)
        expect(result.stdout).toBe("workflow routing loaded\n")
        expect(
          workflowDescriptions(requests).some((description) => {
            if (!description.startsWith(CommandPlugin.WorkflowContent)) return false
            const suffix = description.slice(CommandPlugin.WorkflowContent.length)
            const separator = CommandPlugin.WorkflowContent.endsWith("\n") ? "\n" : "\n\n"
            return suffix === "" || suffix.startsWith(`${separator}Available workflow worker_type values:\n`)
          }),
        ).toBe(true)
        for (const action of ["spec", "run", "inspect", "control"]) {
          expect(serialized).toContain(`"enum":["${action}"]`)
        }
        expect(serialized).toContain('"operation"')
        expect(serialized).not.toContain('"enum":["guide"]')
      }),
    180_000,
  )
})
