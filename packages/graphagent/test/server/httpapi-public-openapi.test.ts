import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type OpenApiSchema = {
  readonly $ref?: string
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly type?: string
  readonly enum?: readonly unknown[]
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
}
type OpenApiResponse = {
  readonly description?: string
  readonly content?: Record<string, { readonly schema?: OpenApiSchema }>
}
type OpenApiOperation = {
  readonly parameters?: ReadonlyArray<{
    readonly name: string
    readonly in: string
    readonly required?: boolean
    readonly schema?: { readonly type?: string }
  }>
  readonly responses?: Record<string, OpenApiResponse>
  readonly requestBody?: { readonly required?: boolean }
  readonly security?: unknown
}
type OpenApiPathItem = Partial<Record<"get" | "post" | "put" | "delete" | "patch", OpenApiOperation>>
type OpenApiSpec = {
  readonly paths: Record<string, OpenApiPathItem>
  readonly components: { readonly schemas: Record<string, OpenApiSchema> }
}

function responseRef(response: OpenApiResponse | undefined) {
  return response?.content?.["application/json"]?.schema?.$ref
}

function componentName(ref: string) {
  return ref.replace("#/components/schemas/", "")
}

describe("PublicApi OpenAPI errors", () => {
  test("merges the former v2 routes into the instance API", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(Object.keys(spec.paths).filter((path) => path.startsWith("/api/"))).toEqual([])
    expect(spec.paths["/reference"]?.get).toBeDefined()
    expect(spec.paths["/find/file"]?.get).toBeDefined()
    expect(spec.paths["/experimental/project/{projectID}/copy"]?.post).toBeDefined()
    expect(spec.paths["/experimental/project/{projectID}/copy"]?.delete).toBeDefined()
    expect(spec.paths["/experimental/project/{projectID}/copy/refresh"]?.post).toBeDefined()
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(["ReferenceInfo", "FileSystemEntry", "ProjectCopyCopy"]),
    )
  })

  test("does not document removed global event and sync components", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const names = Object.keys(spec.components.schemas)

    expect(spec.paths["/global/event"]).toBeUndefined()
    expect(names.filter((name) => name === "GlobalEvent" || name === "EventConfigUpdated")).toEqual([])
    expect(names.filter((name) => name.startsWith("SyncEvent"))).toEqual([])
  })

  test("documents session busy errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/session/{sessionID}/shell"],
      ["post", "/session/{sessionID}/revert"],
      ["post", "/session/{sessionID}/unrevert"],
      ["delete", "/session/{sessionID}/message/{messageID}"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["409"]) ?? "")).toBe(
        "SessionBusyError",
      )
    }
  })

  test("documents permission and question not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(
      componentName(responseRef(spec.paths["/permission/{requestID}/reply"]?.post?.responses?.["404"]) ?? ""),
    ).toBe("PermissionNotFoundError")
    for (const route of [
      ["post", "/question/{requestID}/reply"],
      ["post", "/question/{requestID}/reject"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "QuestionNotFoundError",
      )
    }
  })

  test("documents MCP server not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/mcp/{name}/auth"],
      ["post", "/mcp/{name}/auth/authenticate"],
      ["post", "/mcp/{name}/auth/callback"],
      ["delete", "/mcp/{name}/auth"],
      ["post", "/mcp/{name}/connect"],
      ["post", "/mcp/{name}/disconnect"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "McpServerNotFoundError",
      )
    }
  })

  test("documents project not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(componentName(responseRef(spec.paths["/project/{projectID}"]?.patch?.responses?.["404"]) ?? "")).toBe(
      "ProjectNotFoundError",
    )
  })
})
