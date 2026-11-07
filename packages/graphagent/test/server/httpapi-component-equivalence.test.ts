import { describe, expect, test } from "bun:test"
import { Context } from "effect"
import { OpenApi } from "effect/http-api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

const transform = Context.getUnsafe(PublicApi.annotations, OpenApi.Transform)

function fixture(schemas: Record<string, unknown>, response = "Envelope2") {
  return transform({
    components: { schemas },
    paths: {
      "/api/fixture": {
        get: {
          responses: {
            "200": {
              description: "fixture",
              content: { "application/json": { schema: { $ref: `#/components/schemas/${response}` } } },
            },
          },
        },
      },
    },
  })
}

const wrapper = (target: string) => ({
  type: "object",
  properties: { value: { $ref: `#/components/schemas/${target}` } },
})

describe("PublicApi component equivalence", () => {
  test("rewrites schemas inside named OpenAPI maps without interpreting entry names", () => {
    const ref = () => ({ $ref: "#/components/schemas/Value2" })
    const literal = { schema: ref(), $ref: "#/components/schemas/Value2" }
    const media = () => ({ schema: ref(), example: literal, "x-extension": literal })
    const response = () => ({ description: "fixture", content: { "application/json": media() } })
    const pathItem = () => ({ get: { responses: { "200": response() } } })
    const names = ["x-trace-id", "schema", "example", "examples"]
    const headers = () => Object.fromEntries(names.map((name) => [name, { schema: ref(), "x-extension": literal }]))
    const spec = transform({
      "x-extension": literal,
      components: {
        schemas: { Value: { type: "string" }, Value2: { type: "string" } },
        headers: headers(),
        parameters: Object.fromEntries(names.map((name) => [name, { name, in: "header", schema: ref() }])),
        requestBodies: { "x-body": { content: { "application/json": media() } } },
        responses: { "x-response": response() },
        callbacks: { "x-callback": { "{$request.query.callback}": pathItem() } },
        pathItems: { "x-path": pathItem() },
        securitySchemes: { "x-security": { type: "http", scheme: "bearer", "x-extension": literal } },
      },
      webhooks: { examples: pathItem() },
      paths: {
        "x-extension": literal,
        "/api/fixture": {
          post: {
            requestBody: { content: { "application/json": media() } },
            responses: { "200": { ...response(), headers: headers() } },
          },
        },
      },
    })
    const canonical = "#/components/schemas/Value"
    expect(spec.components.schemas.Value2).toBeUndefined()
    for (const name of names) {
      expect(spec.components.headers[name].schema.$ref).toBe(canonical)
      expect(spec.components.parameters[name].schema.$ref).toBe(canonical)
      expect(spec.paths["/api/fixture"].post.responses["200"].headers[name].schema.$ref).toBe(canonical)
      expect(spec.components.headers[name]["x-extension"]).toEqual(literal)
    }
    const contents = [
      spec.components.requestBodies["x-body"].content,
      spec.components.responses["x-response"].content,
      spec.paths["/api/fixture"].post.requestBody.content,
      spec.components.callbacks["x-callback"]["{$request.query.callback}"].get.responses["200"].content,
      spec.components.pathItems["x-path"].get.responses["200"].content,
      spec.webhooks.examples.get.responses["200"].content,
    ]
    for (const content of contents) {
      expect(content["application/json"].schema.$ref).toBe(canonical)
      expect(content["application/json"].example).toEqual(literal)
      expect(content["application/json"]["x-extension"]).toEqual(literal)
    }
    expect(spec["x-extension"]).toEqual(literal)
    expect(spec.paths["x-extension"]).toEqual(literal)
    // The legacy public transform intentionally removes security schemes.
    expect(spec.components.securitySchemes).toBeUndefined()
  })

  for (const key of ["description", "$ref"] as const) {
    for (const different of ["type", "presence"] as const) {
      test(`retains business property ${key} with different ${different}`, () => {
        const spec = fixture({
          Envelope: { type: "object", properties: { [key]: { type: "string" } } },
          Envelope2: { type: "object", properties: different === "type" ? { [key]: { type: "number" } } : {} },
        })
        expect(spec.components.schemas.Envelope2).toBeDefined()
        expect(spec.paths["/api/fixture"].get.responses["200"].content["application/json"].schema.$ref).toBe(
          "#/components/schemas/Envelope2",
        )
      })
    }
  }

  for (const keyword of ["const", "default", "enum", "examples"] as const) {
    for (const key of ["description", "$ref"] as const) {
      test(`retains different ${keyword} data containing ${key}`, () => {
        const value = (suffix: string) => {
          const data = { [key]: key === "$ref" ? `#/components/schemas/Value${suffix}` : suffix }
          return keyword === "enum" || keyword === "examples" ? [data] : data
        }
        const spec = fixture({
          Envelope: { type: "object", [keyword]: value("") },
          Envelope2: { type: "object", [keyword]: value("2") },
          Value: { type: "string" },
          Value2: { type: "string" },
        })
        expect(spec.components.schemas.Envelope2).toBeDefined()
        expect(spec.components.schemas.Envelope2[keyword]).toEqual(value("2"))
      })
    }
  }

  test("rewrites schema refs while preserving literal refs during alias collapse", () => {
    const literal = { $ref: "#/components/schemas/Value2", description: "business data" }
    const spec = fixture(
      {
        Envelope: {
          type: "object",
          properties: { description: { $ref: "#/components/schemas/Value2" }, $ref: { type: "string" } },
          const: literal,
          default: literal,
          enum: [literal],
          examples: [literal],
        },
        Value: { type: "string" },
        Value2: { type: "string" },
      },
      "Envelope",
    )
    expect(spec.components.schemas.Value2).toBeUndefined()
    expect(spec.components.schemas.Envelope.properties.description.$ref).toBe("#/components/schemas/Value")
    for (const key of ["const", "default"]) expect(spec.components.schemas.Envelope[key]).toEqual(literal)
    for (const key of ["enum", "examples"]) expect(spec.components.schemas.Envelope[key]).toEqual([literal])
  })

  test("preserves OpenAPI media examples when rewriting schema references", () => {
    const literal = { $ref: "#/components/schemas/Value2", schema: { $ref: "#/components/schemas/Value2" } }
    const spec = transform({
      components: { schemas: { Value: { type: "string" }, Value2: { type: "string" } } },
      paths: {
        "/api/fixture": {
          get: {
            responses: {
              "200": {
                description: "fixture",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Value2" }, example: literal },
                },
              },
            },
          },
        },
      },
    })
    const media = spec.paths["/api/fixture"].get.responses["200"].content["application/json"]
    expect(media.schema.$ref).toBe("#/components/schemas/Value")
    expect(media.example).toEqual(literal)
  })

  test("retains wrappers referencing different component types", () => {
    const spec = fixture({
      Envelope: wrapper("Payload"),
      Envelope2: wrapper("Payload2"),
      Payload: { type: "string", enum: ["fixture"] },
      Payload2: { type: "integer", minimum: 7 },
    })
    expect(spec.components.schemas.Envelope2).toBeDefined()
    expect(spec.paths["/api/fixture"].get.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/Envelope2",
    )
  })

  test("collapses equivalent aliases even when wrappers precede their targets", () => {
    const spec = fixture({
      Envelope: wrapper("Payload"),
      Envelope2: wrapper("Payload2"),
      Payload: { type: "string", description: "first" },
      Payload2: { description: "second", type: "string" },
    })
    expect(spec.components.schemas.Envelope2).toBeUndefined()
    expect(spec.components.schemas.Payload2).toBeUndefined()
  })

  test("terminates and collapses equivalent recursive components", () => {
    const spec = fixture({ Envelope: wrapper("Envelope"), Envelope2: wrapper("Envelope2") })
    expect(spec.components.schemas.Envelope2).toBeUndefined()
    expect(spec.components.schemas.Envelope.properties.value.$ref).toBe("#/components/schemas/Envelope")
  })

  test("retains different recursive components", () => {
    const spec = fixture({
      Envelope: { ...wrapper("Envelope"), required: ["value"] },
      Envelope2: wrapper("Envelope2"),
    })
    expect(spec.components.schemas.Envelope2).toBeDefined()
  })

  test("retains differing reference siblings and unresolved targets", () => {
    const spec = fixture({
      Envelope: { $ref: "#/components/schemas/Payload", maxLength: 1 },
      Envelope2: { $ref: "#/components/schemas/Payload", maxLength: 2 },
      Payload: { type: "string" },
      Missing: wrapper("Absent"),
      Missing2: wrapper("Absent2"),
    })
    expect(spec.components.schemas.Envelope2).toBeDefined()
    expect(spec.components.schemas.Missing2).toBeDefined()
  })
})
