// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "@/util/record"

/**
 * One well-formed artifact per catalog type (#1158), shared by the catalog,
 * task and permission-parity tests. Each is a complete envelope: the five
 * envelope fields and a body that carries every field the Issue's table makes
 * required for the type.
 */

export type ArtifactName =
  "code_findings" | "research_findings" | "architecture_proposal" | "prototype" | "survey_report" | "project_map"

export type Payload = Record<string, unknown>

/** `value` as an object; the test fails when it is not one. A narrowing, not an assertion. */
export function obj(value: unknown): Payload {
  if (!isRecord(value)) throw new Error("expected an object")
  return value
}

/** `value` as a list; the test fails when it is not one. */
export function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array")
  return value
}

/** `value` as a list of strings; the test fails when it is not one. */
export function strs(value: unknown): string[] {
  return arr(value).map((item) => {
    if (typeof item !== "string") throw new Error("expected a string")
    return item
  })
}

export const EVIDENCE = [
  { kind: "file", ref: "/repo/src/session/store.ts:42", note: "the only insert" },
  { kind: "url", ref: "https://example.com/docs/sessions" },
  { kind: "command", ref: "rg -n SessionStore src" },
]

/** The body fields the Issue's table requires, by artifact type: the oracle the schemas are held to. */
export const REQUIRED_BODY: Record<ArtifactName, readonly string[]> = {
  code_findings: ["scope", "findings"],
  research_findings: ["question", "answers", "conflicts"],
  architecture_proposal: ["options", "decision", "components", "risks", "open_questions"],
  prototype: ["hypothesis", "success_signal", "location", "how_to_run", "observations", "changed_files", "fingerprint"],
  survey_report: ["question", "comparison", "recommendation"],
  project_map: ["modules", "cross_cutting"],
}

const BODIES: Record<ArtifactName, Payload> = {
  code_findings: {
    scope: "packages/graphagent/src/session",
    findings: [{ claim: "SessionStore owns every session write", refs: ["/repo/src/session/store.ts:42"] }],
  },
  research_findings: {
    question: "Which cache eviction policy does the library default to?",
    answers: [{ claim: "It defaults to least recently used", sources: ["https://example.com/docs/cache"] }],
    conflicts: [],
  },
  architecture_proposal: {
    options: [
      { name: "single writer", tradeoffs: "simple, but a bottleneck under load" },
      { name: "sharded writers", tradeoffs: ["parallel", "needs a routing key"] },
    ],
    decision: "single writer, revisit when the write rate passes 1k/s",
    components: [{ name: "SessionStore", responsibility: "owns writes" }],
    risks: ["a long transaction blocks every reader"],
    open_questions: ["Is eventual consistency acceptable for the title index?"],
  },
  prototype: {
    hypothesis: "An LRU of 64 entries keeps the hit rate above 90 percent on the sample trace",
    success_signal: "The replay prints a hit rate of at least 0.9",
    location: "prototypes/lru-cache/",
    how_to_run: "bun run prototypes/lru-cache/replay.ts",
    observations: ["hit rate 0.93 on the 10k-line trace"],
    changed_files: ["prototypes/lru-cache/replay.ts", "prototypes/lru-cache/trace.json"],
    fingerprint: "sha256:5d41402abc4b2a76b9719d911017c592",
  },
  survey_report: {
    question: "Which persistence design fits session history?",
    comparison: [
      { candidate: "sqlite", strengths: ["transactions"], weaknesses: ["single writer"] },
      { candidate: "append-only log", strengths: ["fast writes"], weaknesses: ["compaction"] },
    ],
    recommendation: "sqlite, behind the existing store interface",
  },
  project_map: {
    modules: [
      {
        path: "packages/core",
        purpose: "DAG primitives and the database schema",
        entry_points: ["src/dag/core/scheduling.ts"],
        depends_on: [],
      },
    ],
    cross_cutting: ["Effect layers compose in AppLayer"],
  },
}

/** A complete, valid artifact of `name`. A fresh object on every call, so a test may edit it. */
export function valid(name: ArtifactName): Payload {
  return structuredClone({
    artifact: name,
    summary: `A ${name} summary the downstream reader can act on.`,
    body: BODIES[name],
    evidence: EVIDENCE,
    not_examined: ["packages/tui: out of scope for this question"],
  })
}

export const ARTIFACT_NAMES: ArtifactName[] = [
  "code_findings",
  "research_findings",
  "architecture_proposal",
  "prototype",
  "survey_report",
  "project_map",
]

/** `valid(name)` as the one JSON value a worker's final answer carries. */
export function answer(name: ArtifactName, edit: (payload: Payload) => void = () => {}): string {
  const payload = valid(name)
  edit(payload)
  return JSON.stringify(payload)
}
