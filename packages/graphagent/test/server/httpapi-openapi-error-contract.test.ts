// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type OpenApiSchema = {
  readonly $ref?: string
  readonly type?: string
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly oneOf?: ReadonlyArray<OpenApiSchema>
  readonly allOf?: ReadonlyArray<OpenApiSchema>
  readonly enum?: ReadonlyArray<unknown>
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: ReadonlyArray<string>
}
type OpenApiResponse = {
  readonly description?: string
  readonly content?: Record<string, { readonly schema?: OpenApiSchema }>
}
type OpenApiOperation = {
  readonly responses?: Record<string, OpenApiResponse>
}
type OpenApiPathItem = Partial<Record<"get" | "post" | "put" | "delete" | "patch", OpenApiOperation>>
type OpenApiSpec = {
  readonly paths: Record<string, OpenApiPathItem>
  readonly components: { readonly schemas: Record<string, OpenApiSchema> }
}

const METHODS = ["get", "post", "put", "delete", "patch"] as const

function componentName(ref: string) {
  return ref.replace("#/components/schemas/", "")
}

function resolveSchema(schema: OpenApiSchema | undefined, spec: OpenApiSpec): OpenApiSchema | undefined {
  if (!schema?.$ref) return schema
  return spec.components.schemas[componentName(schema.$ref)]
}

/** Merge an intersection so the shape checks see every member's properties. */
function mergeAllOf(schema: OpenApiSchema, spec: OpenApiSpec): OpenApiSchema {
  const resolved = resolveSchema(schema, spec) ?? schema
  if (!resolved.allOf) return resolved
  const merged: {
    type?: string
    properties: Record<string, OpenApiSchema>
    required: string[]
  } = { type: "object", properties: {}, required: [] }
  for (const member of resolved.allOf) {
    const part = mergeAllOf(member, spec)
    Object.assign(merged.properties, part.properties ?? {})
    merged.required.push(...(part.required ?? []))
  }
  return merged
}

/** Every concrete response shape, flattening documented unions. */
function variants(schema: OpenApiSchema | undefined, spec: OpenApiSpec): OpenApiSchema[] {
  const resolved = resolveSchema(schema, spec)
  if (!resolved) return []
  const union = resolved.anyOf ?? resolved.oneOf
  if (union) return union.flatMap((item) => variants(item, spec))
  return [mergeAllOf(resolved, spec)]
}

function isStringSchema(schema: OpenApiSchema | undefined) {
  return (
    schema?.type === "string" ||
    (Array.isArray(schema?.enum) && schema.enum.every((value) => typeof value === "string"))
  )
}

/**
 * The public API documents every failure as the NamedError envelope
 * `{ name, data: { message, ... } }`. The TUI and the SDK error interceptor read
 * `error.data.message`, so a route that documents a bare `_tag`, an `{error}`
 * body, or no schema at all is a contract break even when its handler happens
 * to match today.
 */
describe("OpenAPI error response contract", () => {
  test("every 4xx/5xx response documents the {name, data:{message}} envelope", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const failures: string[] = []
    let responses = 0
    let shapes = 0

    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const operation = item[method]
        if (!operation?.responses) continue
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue
          responses++
          const route = `${method.toUpperCase()} ${path} ${status}`
          const schema = response.content?.["application/json"]?.schema
          if (!schema) {
            failures.push(`${route}: no application/json error schema`)
            continue
          }
          for (const shape of variants(schema, spec)) {
            shapes++
            const name = shape.properties?.name
            const data = shape.properties?.data
            const message = data?.properties?.message
            const required = shape.required ?? []
            if (!required.includes("name") || !required.includes("data")) {
              failures.push(`${route}: error shape does not require name and data`)
              continue
            }
            if (!isStringSchema(name)) {
              failures.push(`${route}: error shape is missing a string name`)
              continue
            }
            if (data?.type !== "object" || !isStringSchema(message)) {
              failures.push(`${route}: error shape is missing data.message`)
            }
          }
        }
      }
    }

    expect(responses).toBeGreaterThan(0)
    expect(shapes).toBeGreaterThanOrEqual(responses)
    expect(failures).toEqual([])
  })
})
