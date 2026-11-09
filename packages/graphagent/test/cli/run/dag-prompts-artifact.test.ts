// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { CommandPlugin } from "@graphagent/core/plugin/command"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
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

function includesExactContent(value: string) {
  return (hit: { body: unknown }) => strings(hit.body).some((item) => item.includes(value))
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
        const commandArguments = `"${argumentsText}"`
        const expanded = CommandPlugin.DagAutoContent.replaceAll("$ARGUMENTS", commandArguments).trim()
        yield* llm.text("dag-auto prompt loaded")

        const result = yield* opencode.run(argumentsText, { command: "dag-auto" })
        const requests = yield* llm.inputs

        yield* recordEvidence("dag-auto-dispatch", {
          target: resolvedTarget,
          result,
          requests,
          expected: { dagAutoSha256: sha256(CommandPlugin.DagAutoContent), argumentsText, commandArguments },
        })
        opencode.expectExit(result, 0)
        expect(result.target).toEqual(resolvedTarget)
        expect(result.stdout).toBe("dag-auto prompt loaded\n")
        expect(strings(requests).some((value) => value.includes(expanded))).toBe(true)
      }),
    120_000,
  )

  cliIt.concurrent(
    "loads the exact workflow routing description and all resident guides",
    ({ llm, opencode, target: resolvedTarget }) =>
      Effect.gen(function* () {
        const marker = "DAG_GUIDES_ROUTE_SENTINEL"
        const guides = [
          ["blocks", CommandPlugin.WorkflowBlocksContent],
          ["interface", CommandPlugin.WorkflowFactsContent],
          ["policy", CommandPlugin.OrchestrationPolicyContent],
          ["patterns", CommandPlugin.OrchestrationDomainsContent],
        ] as const

        yield* llm.pushMatch(
          turnIncludes(marker),
          reply()
            .tool("workflow", { params: { action: "guide", topic: "blocks" } })
            .item(),
        )
        yield* llm.pushMatch(
          includesExactContent(CommandPlugin.WorkflowBlocksContent),
          reply()
            .tool("workflow", { params: { action: "guide", topic: "interface" } })
            .item(),
        )
        yield* llm.pushMatch(
          includesExactContent(CommandPlugin.WorkflowFactsContent),
          reply()
            .tool("workflow", { params: { action: "guide", topic: "policy" } })
            .item(),
        )
        yield* llm.pushMatch(
          includesExactContent(CommandPlugin.OrchestrationPolicyContent),
          reply()
            .tool("workflow", { params: { action: "guide", topic: "patterns" } })
            .item(),
        )
        yield* llm.pushMatch(
          includesExactContent(CommandPlugin.OrchestrationDomainsContent),
          reply().text("workflow guides loaded").stop().item(),
        )

        const result = yield* opencode.run(marker, { extraArgs: ["--dangerously-skip-permissions"] })
        const requests = yield* llm.inputs
        const requestStrings = strings(requests)

        yield* recordEvidence("workflow-guides", {
          target: resolvedTarget,
          result,
          requests,
          expected: {
            workflowRoutingSha256: sha256(CommandPlugin.WorkflowContent),
            workflowBlocksSha256: sha256(CommandPlugin.WorkflowBlocksContent),
            workflowInterfaceSha256: sha256(CommandPlugin.WorkflowFactsContent),
            orchestrationPolicySha256: sha256(CommandPlugin.OrchestrationPolicyContent),
            orchestrationDomainsSha256: sha256(CommandPlugin.OrchestrationDomainsContent),
          },
        })
        opencode.expectExit(result, 0)
        expect(result.target).toEqual(resolvedTarget)
        expect(result.stdout).toBe("workflow guides loaded\n")
        expect(
          workflowDescriptions(requests).some((description) => {
            if (!description.startsWith(CommandPlugin.WorkflowContent)) return false
            const suffix = description.slice(CommandPlugin.WorkflowContent.length)
            const separator = CommandPlugin.WorkflowContent.endsWith("\n") ? "\n" : "\n\n"
            return suffix === "" || suffix.startsWith(`${separator}Available workflow worker_type values:\n`)
          }),
        ).toBe(true)
        for (const [, content] of guides) {
          expect(requestStrings.some((value) => value.includes(content))).toBe(true)
        }
      }),
    180_000,
  )
})
