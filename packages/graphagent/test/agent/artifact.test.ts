// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { AgentArtifact } from "@/agent/artifact"
import { DagBlocks } from "@/dag/blocks"
import { unsupportedSchemaKeywords, validateAgainstSchema } from "@/dag/runtime/schema-validator"
import {
  ARTIFACT_NAMES,
  REQUIRED_BODY,
  arr,
  obj,
  strs,
  valid,
  type ArtifactName,
  type Payload,
} from "./artifact-fixtures"

const body = (payload: Payload) => obj(payload.body)

function verdict(name: ArtifactName, payload: unknown) {
  return AgentArtifact.validate(name, payload)
}

function rejected(name: ArtifactName, payload: unknown): string {
  const result = verdict(name, payload)
  if (result.ok) throw new Error(`expected the ${name} schema to reject the payload`)
  return result.error
}

describe("artifact catalog", () => {
  it("lists exactly the six first-batch types", () => {
    expect([...AgentArtifact.names()].toSorted()).toEqual([...ARTIFACT_NAMES].toSorted())
    expect(ARTIFACT_NAMES).toHaveLength(6)
  })

  it("hands out a schema by type name and nothing for an unknown name", () => {
    for (const name of ARTIFACT_NAMES) {
      expect(AgentArtifact.has(name)).toBe(true)
      expect(AgentArtifact.schema(name)).toMatchObject({ type: "object" })
    }
    expect(AgentArtifact.has("report")).toBe(false)
    expect(AgentArtifact.schema("report")).toBeUndefined()
    expect(AgentArtifact.validate("report", {})).toEqual({ ok: false, error: expect.stringContaining('"report"') })
  })

  it("returns an independent copy, so a node that edits its output_schema cannot change the catalog", () => {
    const first = AgentArtifact.schema("code_findings")!
    obj(first.properties).extra = { type: "string" }
    delete first.required
    const second = AgentArtifact.schema("code_findings")!
    expect(second.required).toContain("not_examined")
    expect(second.properties).not.toHaveProperty("extra")
  })

  it("says in the schema what each type is, for the worker that has to produce it", () => {
    for (const name of ARTIFACT_NAMES) {
      const schema = AgentArtifact.schema(name)!
      expect(schema.description).toContain(`"${name}" artifact: `)
      const properties = obj(schema.properties)
      for (const field of ["summary", "body", "evidence", "not_examined"]) {
        expect(obj(properties[field]).description, `${name}.${field}`).toEqual(expect.any(String))
      }
    }
  })

  it("uses only keywords the DAG's subset validator enforces, so a node can adopt a schema as its output_schema", () => {
    for (const name of ARTIFACT_NAMES) {
      const schema = AgentArtifact.schema(name)!
      expect(unsupportedSchemaKeywords(schema)).toEqual([])
      // Persisted node definitions are JSON: the schema must survive a round trip unchanged.
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
    }
  })
})

for (const name of ARTIFACT_NAMES) {
  describe(`${name} artifact`, () => {
    it("accepts a complete artifact", () => {
      expect(verdict(name, valid(name))).toEqual({ ok: true })
    })

    it("rejects an artifact without not_examined", () => {
      const payload = valid(name)
      delete payload.not_examined
      expect(rejected(name, payload)).toContain('"not_examined"')
    })

    it("rejects an artifact without evidence", () => {
      const payload = valid(name)
      delete payload.evidence
      expect(rejected(name, payload)).toContain('"evidence"')
    })

    it("accepts empty evidence and an empty not_examined", () => {
      const payload = valid(name)
      payload.evidence = []
      payload.not_examined = []
      expect(verdict(name, payload)).toEqual({ ok: true })
    })

    it("rejects an artifact without a summary, or a body, or its own type name", () => {
      for (const field of ["summary", "body", "artifact"]) {
        const payload = valid(name)
        delete payload[field]
        expect(rejected(name, payload)).toContain(`"${field}"`)
      }
      const other = ARTIFACT_NAMES.find((candidate) => candidate !== name)!
      const mislabeled = valid(name)
      mislabeled.artifact = other
      expect(rejected(name, mislabeled)).toContain(`"${name}"`)
    })

    it("rejects each missing required body field", () => {
      for (const field of REQUIRED_BODY[name]) {
        const payload = valid(name)
        delete body(payload)[field]
        expect(rejected(name, payload)).toContain(`"${field}"`)
      }
    })

    it("requires exactly the body fields the Issue's table lists", () => {
      const schema = AgentArtifact.schema(name)!
      const bodySchema = obj(obj(schema.properties).body)
      expect(strs(bodySchema.required).toSorted()).toEqual([...REQUIRED_BODY[name]].toSorted())
    })

    it("keeps the envelope strict and the body loose", () => {
      const extraBody = valid(name)
      body(extraBody).anything_else = { nested: true }
      expect(verdict(name, extraBody)).toEqual({ ok: true })

      const extraEnvelope = valid(name)
      extraEnvelope.confidence = 0.9
      expect(rejected(name, extraEnvelope)).toContain('"confidence"')
    })

    it("bounds the summary at 1200 characters and refuses an empty one", () => {
      const atLimit = valid(name)
      atLimit.summary = "x".repeat(AgentArtifact.SUMMARY_MAX)
      expect(AgentArtifact.SUMMARY_MAX).toBe(1200)
      expect(verdict(name, atLimit)).toEqual({ ok: true })

      const over = valid(name)
      over.summary = "x".repeat(AgentArtifact.SUMMARY_MAX + 1)
      expect(rejected(name, over)).toContain("maxLength 1200")

      const empty = valid(name)
      empty.summary = ""
      expect(rejected(name, empty)).toContain("minLength")
    })

    it("types every evidence entry: kind file, url or command, a reference, an optional note, nothing else", () => {
      const bad: Array<[string, unknown]> = [
        ["an unknown kind", { kind: "screenshot", ref: "x.png" }],
        ["no reference", { kind: "file" }],
        ["an empty reference", { kind: "file", ref: "" }],
        ["a non-string note", { kind: "file", ref: "a.ts", note: 3 }],
        ["an extra key", { kind: "file", ref: "a.ts", lines: "1-2" }],
      ]
      for (const [label, entry] of bad) {
        const payload = valid(name)
        payload.evidence = [entry]
        expect(verdict(name, payload), label).toMatchObject({ ok: false })
      }
      const noNote = valid(name)
      noNote.evidence = [{ kind: "command", ref: "bun test" }]
      expect(verdict(name, noNote)).toEqual({ ok: true })
    })

    it("types not_examined as a list of strings", () => {
      for (const value of ["nothing", [1], { reason: "x" }, null]) {
        const payload = valid(name)
        payload.not_examined = value
        expect(verdict(name, payload), JSON.stringify(value)).toMatchObject({ ok: false })
      }
    })
  })
}

describe("type-specific shapes", () => {
  it("code_findings: each finding is a claim with refs", () => {
    const payload = valid("code_findings")
    body(payload).findings = [{ claim: "no refs given" }]
    expect(rejected("code_findings", payload)).toContain('"refs"')
    body(payload).findings = "SessionStore owns writes"
    expect(rejected("code_findings", payload)).toContain("array")
    body(payload).findings = [{ claim: "an inference with nothing to cite", refs: [] }]
    expect(verdict("code_findings", payload)).toEqual({ ok: true })
  })

  it("research_findings: every answer carries at least one source", () => {
    const payload = valid("research_findings")
    body(payload).answers = [{ claim: "unsourced", sources: [] }]
    expect(rejected("research_findings", payload)).toContain("minItems")
    body(payload).answers = [{ claim: "no sources field" }]
    expect(rejected("research_findings", payload)).toContain('"sources"')
    body(payload).answers = [{ sources: ["https://example.com"] }]
    expect(rejected("research_findings", payload)).toContain('"claim"')
  })

  it("research_findings: sources that disagree go in conflicts, which may be empty but not absent", () => {
    const payload = valid("research_findings")
    body(payload).conflicts = [
      { topic: "default policy", positions: [{ claim: "LRU", sources: ["https://a.example"] }, { claim: "LFU" }] },
    ]
    expect(verdict("research_findings", payload)).toEqual({ ok: true })
  })

  it("architecture_proposal: an option is a name with its trade-offs, as text or a list", () => {
    const payload = valid("architecture_proposal")
    body(payload).options = [{ name: "single writer" }]
    expect(rejected("architecture_proposal", payload)).toContain('"tradeoffs"')
    body(payload).options = [{ tradeoffs: "cheap" }]
    expect(rejected("architecture_proposal", payload)).toContain('"name"')
    body(payload).options = [{ name: "single writer", tradeoffs: 3 }]
    expect(verdict("architecture_proposal", payload)).toMatchObject({ ok: false })
    body(payload).open_questions = [{ question: "not text" }]
    body(payload).options = [{ name: "single writer", tradeoffs: "cheap" }]
    expect(verdict("architecture_proposal", payload)).toMatchObject({ ok: false })
  })

  it("prototype: the decision is text and the file list is a list of paths", () => {
    const payload = valid("prototype")
    body(payload).changed_files = "prototypes/lru-cache/replay.ts"
    expect(rejected("prototype", payload)).toContain("array")
    body(payload).changed_files = [1]
    expect(verdict("prototype", payload)).toMatchObject({ ok: false })
    body(payload).changed_files = []
    body(payload).fingerprint = 42
    expect(verdict("prototype", payload)).toMatchObject({ ok: false })
  })

  it("prototype: carries the fields of the implementation record, with the same shapes", () => {
    const schema = AgentArtifact.schema("prototype")!
    const bodySchema = obj(obj(schema.properties).body)
    const properties = obj(bodySchema.properties)
    for (const field of ["changed_files", "fingerprint"] as const) {
      expect(bodySchema.required).toContain(field)
      expect(properties[field]).toEqual(DagBlocks.IMPLEMENTATION_SCHEMA.properties[field])
    }
    // The summary lives in the envelope, so envelope plus body hold all three fields.
    expect(DagBlocks.IMPLEMENTATION_SCHEMA.required).toEqual(["summary", "changed_files", "fingerprint"])
    const payload = valid("prototype")
    const implementation = {
      summary: payload.summary,
      changed_files: body(payload).changed_files,
      fingerprint: body(payload).fingerprint,
    }
    expect(validateAgainstSchema(implementation, DagBlocks.IMPLEMENTATION_SCHEMA)).toEqual({ ok: true })
  })

  it("survey_report: a question, a comparison and a recommendation", () => {
    const payload = valid("survey_report")
    body(payload).recommendation = ["sqlite"]
    expect(verdict("survey_report", payload)).toMatchObject({ ok: false })
    body(payload).recommendation = "sqlite"
    body(payload).comparison = "a table in prose"
    expect(rejected("survey_report", payload)).toContain("array")
  })

  it("project_map: every module names its path, purpose, entry points and dependencies", () => {
    for (const field of ["path", "purpose", "entry_points", "depends_on"]) {
      const payload = valid("project_map")
      const modules = arr(body(payload).modules).map(obj)
      delete modules[0][field]
      expect(rejected("project_map", payload)).toContain(`"${field}"`)
    }
    const payload = valid("project_map")
    arr(body(payload).modules).map(obj)[0].depends_on = "packages/core"
    expect(verdict("project_map", payload)).toMatchObject({ ok: false })
    body(payload).modules = []
    expect(verdict("project_map", payload)).toEqual({ ok: true })
  })
})
