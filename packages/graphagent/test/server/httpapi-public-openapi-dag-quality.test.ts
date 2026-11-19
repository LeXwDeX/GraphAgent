// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1027 D6b: review quality is a real null on the wire (a workflow outside the
// strict review gate, a session without one, a completeness verdict before its
// lane completes). The public spec strips the null arm that Effect adds to
// optional fields, so these three are re-added explicitly; without them the
// generated SDK types would claim a quality is always present.
import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type OpenApiSchema = {
  readonly $ref?: string
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly type?: string
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
  readonly enum?: readonly string[]
}

const schemas = () =>
  (OpenApi.fromApi(PublicApi) as { components: { schemas: Record<string, OpenApiSchema> } }).components.schemas

const arms = (schema: OpenApiSchema | undefined) =>
  (schema?.anyOf ?? []).map((arm) => (arm.$ref ? componentName(arm.$ref) : arm.type))

const componentName = (ref: string) => ref.replace("#/components/schemas/", "")

describe("public OpenAPI review quality (#1027 D6b)", () => {
  test("a session's DAG mode status and a workflow summary carry a nullable quality", () => {
    const all = schemas()
    expect(arms(all.SessionDagMode?.properties?.quality)).toEqual(["DagWorkflowQuality", "null"])
    expect(arms(all.DagWorkflowSummary?.properties?.quality)).toEqual(["DagWorkflowQuality", "null"])
    // The summary field is optional as well as nullable: an older server omits it.
    expect(all.DagWorkflowSummary?.required ?? []).not.toContain("quality")
  })

  test("a completeness verdict is null until a completeness lane completes", () => {
    const completeness = schemas().DagWorkflowQuality?.properties?.completeness
    expect(arms(completeness)).toContain("null")
    expect(completeness?.anyOf?.find((arm) => arm.type === "object")?.required).toEqual([
      "covered",
      "total",
      "unlisted",
    ])
    // Every counter stays required and non-null.
    const required = schemas().DagWorkflowQuality?.required ?? []
    expect(required).toEqual(
      expect.arrayContaining([
        "reviewBound",
        "reviews",
        "raised",
        "fixed",
        "refuted",
        "stillOpen",
        "skepticRefutations",
        "rounds",
        "quietRounds",
        "completeness",
      ]),
    )
  })
})

describe("public OpenAPI workflow worktree (#1618)", () => {
  // The field is optional, so a server without it and a client from before it keep decoding each other's summaries.
  test("a workflow summary may carry a worktree of directory, an optional branch and a state", () => {
    const summary = schemas().DagWorkflowSummary
    expect(summary?.required ?? []).not.toContain("worktree")
    const worktree = summary?.properties?.worktree
    expect(worktree?.type).toBe("object")
    expect(Object.keys(worktree?.properties ?? {}).toSorted()).toEqual(["branch", "directory", "state"])
    expect(worktree?.required?.toSorted()).toEqual(["directory", "state"])
    expect(worktree?.properties?.state?.enum).toEqual(["active", "removed", "kept"])
  })
})
