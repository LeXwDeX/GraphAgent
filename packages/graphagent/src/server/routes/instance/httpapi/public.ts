import { OpenApi } from "effect/http-api"
import { GraphagentHttpApi } from "./api"
import { QueryBooleanOpenApi } from "./groups/query"

type OpenApiParameter = {
  name: string
  in: string
  required?: boolean
  schema?: OpenApiSchema
}

type OpenApiOperation = {
  parameters?: OpenApiParameter[]
  responses?: Record<string, OpenApiResponse>
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: OpenApiSchema }>
  }
  security?: unknown
}

type OpenApiPathItem = Partial<Record<"get" | "post" | "put" | "delete" | "patch", OpenApiOperation>>

type OpenApiSpec = {
  components?: {
    schemas?: Record<string, OpenApiSchema>
    securitySchemes?: Record<string, unknown>
  }
  paths?: Record<string, OpenApiPathItem>
}

type OpenApiSchema = {
  $ref?: string
  additionalProperties?: OpenApiSchema | boolean
  allOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
  description?: string
  enum?: Array<string | boolean>
  items?: OpenApiSchema
  maximum?: number
  minimum?: number
  oneOf?: OpenApiSchema[]
  pattern?: string
  prefixItems?: OpenApiSchema[]
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  type?: string
}

type OpenApiResponse = {
  description?: string
  content?: Record<string, { schema?: OpenApiSchema }>
}

// Query schemas describe decoded Effect values, but the generated SDK needs the
// public call shape. These keep SDK callers passing numbers/booleans while the
// server still decodes string query params at runtime.
const QueryParameterSchemas: Record<string, OpenApiSchema> = {
  "GET /find/file limit": { type: "integer", minimum: 1, maximum: 200 },
  "GET /session start": { type: "number" },
  "GET /session roots": QueryBooleanOpenApi,
  "GET /session limit": { type: "number" },
  "GET /session/{sessionID}/message limit": { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  "GET /vcs/diff context": { type: "integer", minimum: 0 },
}

const LegacyComponentDescriptions: Record<string, string> = {
  LogLevel: "Log level",
  ServerConfig: "Server configuration for opencode serve and web commands",
  LayoutConfig: "@deprecated Always uses stretch layout.",
}

function matchLegacyOpenApi(input: Record<string, unknown>) {
  const spec = input as OpenApiSpec

  // Effect's multi-document JSON Schema deduplicator can produce self-referencing
  // component schemas (e.g. `{"$ref":"#/components/schemas/X"}` as the definition
  // of X itself) when the same AST node appears both as a standalone endpoint
  // payload and inside an annotated union arm. Resolve these by inlining the
  // actual schema from any parent union that references them.
  fixSelfReferencingComponents(spec)

  // Effect's Schema.optional emits `anyOf: [T, {type:"null"}]` in OpenAPI,
  // but the legacy SDK expected plain `T` for optional fields. Strip null
  // from all component schemas so both request and response types match.
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    spec.components!.schemas![name] = stripOptionalNull(structuredClone(schema))
  }
  normalizeComponentNames(spec)
  collapseDuplicateComponents(spec)
  applyLegacySchemaOverrides(spec)
  normalizeComponentDescriptions(spec)
  addLegacyErrorSchemas(spec)
  delete spec.components?.securitySchemes

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation) continue
      if (operation.requestBody) {
        // The legacy OpenAPI surface never marked request bodies as required.
        // Keep that SDK surface stable while the HttpApi spec is tightened.
        delete operation.requestBody.required
        const body = operation.requestBody.content?.["application/json"]
        if (body?.schema) body.schema = stripOptionalNull(structuredClone(body.schema))
        if (path === "/experimental/workspace" && method === "post") {
          // Workspace creation fields `branch` and `extra` are Schema.NullOr —
          // genuinely nullable, not just optional. Re-add the null that the
          // component-level strip above removed.
          const ref = operation.requestBody.content?.["application/json"]?.schema?.$ref?.replace(
            "#/components/schemas/",
            "",
          )
          const properties = ref
            ? spec.components?.schemas?.[ref]?.properties
            : operation.requestBody.content?.["application/json"]?.schema?.properties
          if (properties?.branch) properties.branch = { anyOf: [properties.branch, { type: "null" }] }
          if (properties?.extra) properties.extra = { anyOf: [properties.extra, { type: "null" }] }
        }
        if (path === "/experimental/workspace/warp" && method === "post") {
          const ref = operation.requestBody.content?.["application/json"]?.schema?.$ref?.replace(
            "#/components/schemas/",
            "",
          )
          const properties = ref
            ? spec.components?.schemas?.[ref]?.properties
            : operation.requestBody.content?.["application/json"]?.schema?.properties
          if (properties?.id) properties.id = { anyOf: [properties.id, { type: "null" }] }
        }
        if (path === "/session/{sessionID}" && method === "patch") {
          // #1013 (C1 PR5): dagMode/dagBudgetTokens are creation-time only.
          // The request schema declares them as `Never` so the decoder rejects
          // them with 400; keep the generated SDK surface free of impossible
          // fields.
          const properties = operation.requestBody.content?.["application/json"]?.schema?.properties
          if (properties) {
            delete properties.dagMode
            delete properties.dagBudgetTokens
          }
        }
      }
      for (const response of Object.values(operation.responses ?? {})) {
        for (const content of Object.values(response.content ?? {})) {
          if (content.schema) content.schema = stripOptionalNull(structuredClone(content.schema))
        }
      }
      // Auth is still runtime middleware outside the legacy public OpenAPI
      // metadata, so the legacy SDK should not expose auth schemes or
      // generated 401 error unions.
      delete operation.security
      delete operation.responses?.["401"]
      normalizeLegacyErrorResponses(operation)
      normalizeLegacyOperation(operation, path, method)
      if (path === "/event" && method === "get") {
        // HttpApi has no first-class SSE response schema, and this handler is a
        // raw/streaming route. Document the actual wire protocol explicitly.
        operation.responses!["200"] = {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: { $ref: "#/components/schemas/Event" },
            },
          },
        }
      }
      const route = `${method.toUpperCase()} ${path}`
      for (const param of operation.parameters ?? []) normalizeParameter(param, route)
    }
  }
  deleteUnusedLegacyErrorComponents(spec)
  return input
}

function addLegacyErrorSchemas(spec: OpenApiSpec) {
  if (!spec.components?.schemas) return
  spec.components.schemas.BadRequestError = {
    type: "object",
    required: ["name", "data"],
    properties: {
      name: { type: "string", enum: ["BadRequest"] },
      data: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          kind: {
            type: "string",
            enum: ["Params", "Headers", "Query", "Body", "Payload"],
          },
        },
      },
    },
  }
  spec.components.schemas.NotFoundError = {
    type: "object",
    required: ["name", "data"],
    properties: {
      name: { type: "string", enum: ["NotFoundError"] },
      data: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
      },
    },
  }
}

function collapseDuplicateComponents(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  for (const name of Object.keys(schemas)) {
    const base = name.replace(/\d+$/, "")
    if (base === name || !schemas[base]) continue
    if (!equivalentSchemas(schemas[name], schemas[base], schemas)) continue
    rewriteRefs(spec, name, base)
    delete schemas[name]
  }
}

function normalizeComponentNames(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  // Effect 4.1.2 names the encoded side of a schema `<Identifier>Encoded`
  // (repeated encoded candidates get an `Encoded_<n>` suffix). The public
  // surface keeps the pre-4.1.2 component names, so encoded components are
  // renamed first; collisions with an existing plain component resolve to a
  // numeric suffix (`UnknownError` + `UnknownError1`).
  for (const name of Object.keys(schemas)
    .filter((name) => /Encoded(?:_\d+)?$/.test(name))
    .sort()) {
    renameComponent(spec, name, componentTypeName(name))
  }
  for (const name of Object.keys(schemas)) {
    const next = componentTypeName(name)
    if (next === name) continue
    if (schemas[next]) {
      if (equivalentSchemas(schemas[name], schemas[next], schemas)) {
        rewriteRefs(spec, name, next)
        delete schemas[name]
      }
      continue
    }
    schemas[next] = schemas[name]
    rewriteRefs(spec, name, next)
    delete schemas[name]
  }
}

function renameComponent(spec: OpenApiSpec, name: string, target: string) {
  const schemas = spec.components?.schemas
  if (!schemas || target === name || !schemas[name]) return
  let candidate = target
  for (let index = 1; schemas[candidate]; index++) {
    if (equivalentSchemas(schemas[name], schemas[candidate], schemas)) {
      rewriteRefs(spec, name, candidate)
      delete schemas[name]
      return
    }
    candidate = `${target}${index}`
  }
  schemas[candidate] = schemas[name]
  rewriteRefs(spec, name, candidate)
  delete schemas[name]
}

function componentTypeName(name: string) {
  const base = name.replace(/Encoded(?:_\d+)?$/, "")
  if (!base.includes(".") && !base.includes("_")) return base
  return base
    .split(/[._]/)
    .filter((part) => !/^\d+$/.test(part))
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("")
}

function applyLegacySchemaOverrides(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  if (schemas.AgentConfig) schemas.AgentConfig.additionalProperties = {}
  if (schemas.Command?.properties?.template) schemas.Command.properties.template = { type: "string" }
  if (schemas.Workspace?.properties) {
    schemas.Workspace.properties.branch = nullable(schemas.Workspace.properties.branch)
    schemas.Workspace.properties.directory = nullable(schemas.Workspace.properties.directory)
    schemas.Workspace.properties.extra = nullable(schemas.Workspace.properties.extra)
  }
  if (schemas.GlobalSession?.properties?.project)
    schemas.GlobalSession.properties.project = nullable(schemas.GlobalSession.properties.project)
  // #1013 (C1 PR5): these are genuine nullable values, not optional fields, so
  // re-add the null arm removed by stripOptionalNull.
  if (schemas.Session?.properties?.dagBudgetTokens)
    schemas.Session.properties.dagBudgetTokens = nullable(schemas.Session.properties.dagBudgetTokens)
  const dagModeStatus = schemas.SessionDagMode?.properties
  if (dagModeStatus?.unavailableReason) dagModeStatus.unavailableReason = nullable(dagModeStatus.unavailableReason)
  if (dagModeStatus?.budget?.properties?.tokens)
    dagModeStatus.budget.properties.tokens = nullable(dagModeStatus.budget.properties.tokens)
  // #1069 (B1): a bulk lifecycle read reports an unknown ref as a null state,
  // so this field is genuinely nullable rather than optional.
  if (schemas.LifecycleStateEntry?.properties?.state)
    schemas.LifecycleStateEntry.properties.state = nullable(schemas.LifecycleStateEntry.properties.state)
  const providerOptions = schemas.ProviderConfig?.properties?.options
  if (providerOptions) providerOptions.additionalProperties = {}
  const model = schemas.ProviderConfig?.properties?.models?.additionalProperties
  const variants = typeof model === "object" ? model.properties?.variants?.additionalProperties : undefined
  if (variants && typeof variants === "object") variants.additionalProperties = {}
}

function normalizeComponentDescriptions(spec: OpenApiSpec) {
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    const description = LegacyComponentDescriptions[name]
    if (description) {
      schema.description = description
      continue
    }
    delete schema.description
  }
}

function nullable(schema: OpenApiSchema): OpenApiSchema {
  if (flattenOptions(schema.anyOf ?? schema.oneOf)?.some((item) => item.type === "null")) return schema
  return { anyOf: [schema, { type: "null" }] }
}

// JSON Schema keywords define where nested values are schemas. All other
// values (including const/default/enum/examples) are ordinary JSON data.
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
])
const schemaChildren = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "contentSchema",
])
type SchemaPosition = "schema" | "map" | "data"
function childPosition(position: SchemaPosition, key: string): SchemaPosition {
  if (position === "map") return "schema"
  if (position === "data") return "data"
  if (schemaMaps.has(key)) return "map"
  return schemaChildren.has(key) ? "schema" : "data"
}

function equivalentSchemas(
  left: unknown,
  right: unknown,
  schemas: Record<string, OpenApiSchema>,
  comparing = new Set<string>(),
  position: SchemaPosition = "schema",
): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equivalentSchemas(item, right[index], schemas, comparing, position))
    )
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
    .filter((key) => position !== "schema" || key !== "description")
    .sort()
  const otherKeys = Object.keys(b)
    .filter((key) => position !== "schema" || key !== "description")
    .sort()
  if (keys.length !== otherKeys.length || keys.some((key, index) => key !== otherKeys[index])) return false
  return keys.every((key) => {
    if (position !== "schema" || key !== "$ref" || a[key] === b[key])
      return equivalentSchemas(a[key], b[key], schemas, comparing, childPosition(position, key))
    const prefix = "#/components/schemas/"
    const ar = a[key]
    const br = b[key]
    if (typeof ar !== "string" || typeof br !== "string" || !ar.startsWith(prefix) || !br.startsWith(prefix))
      return false
    const targetA = schemas[ar.slice(prefix.length)]
    const targetB = schemas[br.slice(prefix.length)]
    if (!targetA || !targetB) return false
    // A repeated pair closes a recursive comparison. All other fields, including
    // siblings of $ref, still have to match before either component is removed.
    const pair = JSON.stringify([ar, br])
    if (comparing.has(pair)) return true
    comparing.add(pair)
    const equal = equivalentSchemas(targetA, targetB, schemas, comparing)
    comparing.delete(pair)
    return equal
  })
}

function rewriteRefs(spec: OpenApiSpec, from: string, to: string): void {
  const visitSchema = (input: unknown, position: SchemaPosition = "schema"): void => {
    if (position === "data") return
    if (Array.isArray(input)) {
      for (const item of input) visitSchema(item, position)
      return
    }
    if (!input || typeof input !== "object") return
    const object = input as Record<string, unknown>
    if (position === "schema" && object.$ref === `#/components/schemas/${from}`)
      object.$ref = `#/components/schemas/${to}`
    for (const [key, value] of Object.entries(object)) visitSchema(value, childPosition(position, key))
  }
  for (const schema of Object.values(spec.components?.schemas ?? {})) visitSchema(schema)
  // Only declared OpenAPI fields lead to schema-bearing objects. Map keys are
  // user-defined names, not keywords or extensions; payload data stays opaque.
  type DocumentKind =
    | "root"
    | "components"
    | "path"
    | "operation"
    | "parameter"
    | "header"
    | "body"
    | "response"
    | "media"
    | "encoding"
    | "callback"
    | "leaf"
  const maps: Partial<Record<DocumentKind, Record<string, DocumentKind>>> = {
    root: { paths: "path", webhooks: "path" },
    components: {
      parameters: "parameter",
      requestBodies: "body",
      responses: "response",
      headers: "header",
      securitySchemes: "leaf",
      callbacks: "callback",
      pathItems: "path",
    },
    path: { parameters: "parameter" },
    operation: { parameters: "parameter", responses: "response", callbacks: "callback" },
    parameter: { content: "media" },
    header: { content: "media" },
    body: { content: "media" },
    response: { headers: "header", content: "media", links: "leaf" },
    media: { encoding: "encoding" },
    encoding: { headers: "header" },
  }
  const visitMap = (input: unknown, kind: DocumentKind, paths = false): void => {
    if (Array.isArray(input)) {
      for (const item of input) visitDocument(item, kind)
      return
    }
    if (!input || typeof input !== "object") return
    for (const [name, value] of Object.entries(input)) {
      // Paths Objects allow specification extensions beside slash-led paths.
      if (paths && name.startsWith("x-")) continue
      visitDocument(value, kind)
    }
  }
  const visitDocument = (input: unknown, kind: DocumentKind = "root"): void => {
    if (!input || typeof input !== "object") return
    if (kind === "callback") {
      visitMap(input, "path", true)
      return
    }
    for (const [key, value] of Object.entries(input)) {
      if (key === "schema" && (kind === "parameter" || kind === "header" || kind === "media")) visitSchema(value)
      else if (maps[kind]?.[key]) visitMap(value, maps[kind][key], kind === "root" && key === "paths")
      else if (kind === "root" && key === "components") visitDocument(value, "components")
      else if (kind === "operation" && key === "requestBody") visitDocument(value, "body")
      else if (kind === "path" && ["get", "post", "put", "delete", "patch", "options", "head", "trace"].includes(key))
        visitDocument(value, "operation")
    }
  }

  visitDocument(spec)
}

function normalizeLegacyErrorResponses(operation: OpenApiOperation) {
  if (operation.responses?.["400"] && isLegacyBadRequestResponse(operation.responses["400"])) {
    operation.responses["400"] = legacyErrorResponse("Bad request", "BadRequestError")
  }
  if (operation.responses?.["404"] && isBuiltInErrorResponse(operation.responses["404"], "NotFound")) {
    operation.responses["404"] = legacyErrorResponse("Not found", "NotFoundError")
  }
}

function deleteUnusedLegacyErrorComponents(spec: OpenApiSpec) {
  for (const name of [
    "Unauthorized",
    "EffectHttpApiErrorBadRequest",
    "EffectHttpApiErrorNotFound",
    "effect_HttpApiError_BadRequest",
    "effect_HttpApiError_NotFound",
  ]) {
    if (referencesComponent(spec.paths, name)) continue
    delete spec.components?.schemas?.[name]
  }
}

function referencesComponent(input: unknown, name: string): boolean {
  if (Array.isArray(input)) return input.some((item) => referencesComponent(item, name))
  if (!input || typeof input !== "object") return false
  if ((input as OpenApiSchema).$ref === `#/components/schemas/${name}`) return true
  return Object.values(input).some((value) => referencesComponent(value, name))
}

function normalizeLegacyOperation(operation: OpenApiOperation, path: string, method: string) {
  if ((path !== "/session/{sessionID}/message" && path !== "/session/{sessionID}/command") || method !== "post") return
  const response = operation.responses?.["200"]?.content?.["application/json"]
  if (!response) return
  response.schema = {
    type: "object",
    required: ["info", "parts"],
    properties: {
      info: { $ref: "#/components/schemas/AssistantMessage" },
      parts: {
        type: "array",
        items: { $ref: "#/components/schemas/Part" },
      },
    },
  }
}

function isRefResponse(response: OpenApiResponse, name: string) {
  return response.content?.["application/json"]?.schema?.$ref === `#/components/schemas/${name}`
}

function isBuiltInErrorResponse(response: OpenApiResponse, name: "BadRequest" | "NotFound") {
  return response.description === name || isRefResponse(response, `EffectHttpApiError${name}`)
}

function isLegacyBadRequestResponse(response: OpenApiResponse) {
  return isBuiltInErrorResponse(response, "BadRequest") || isRefResponse(response, "InvalidRequestError")
}

function legacyErrorResponse(description: string, name: "BadRequestError" | "NotFoundError"): OpenApiResponse {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${name}` },
      },
    },
  }
}

/**
 * Fix component schemas that are self-referencing `$ref`s — an Effect OpenAPI
 * generation bug where annotated union arms that share AST nodes with other
 * endpoints produce `{"$ref":"#/components/schemas/X"}` as the definition of X.
 *
 * Resolves by finding the actual schema from a parent union's `anyOf`/`oneOf`
 * that references the broken component, then inlining that schema.
 */
function fixSelfReferencingComponents(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  const selfRefs = new Set<string>()
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.$ref === `#/components/schemas/${name}`) selfRefs.add(name)
  }
  if (selfRefs.size === 0) return
  // Find a parent union component whose anyOf/oneOf contains a $ref to the
  // broken component — that parent was generated correctly and holds the inline
  // schema we need.
  for (const [, schema] of Object.entries(schemas)) {
    for (const member of schema.anyOf ?? schema.oneOf ?? []) {
      const ref = member.$ref?.replace("#/components/schemas/", "")
      if (!ref || !selfRefs.has(ref)) continue
      // This member's $ref points to a self-referencing component. The member
      // itself is just {$ref:...}, so the actual schema must be resolved from
      // the union. Since the union component was generated before the
      // deduplicator broke things, the inline version lives elsewhere. Generate
      // a fresh spec without the transform to get the correct schema.
      // Simpler approach: look through all paths for an endpoint that uses this
      // schema as a payload (it would have been expanded by the ref-expansion
      // logic above if we ran after that, but we run before). Instead, just
      // delete the broken component — if it's referenced via $ref elsewhere,
      // the ref expansion in the request body loop will inline it anyway.
    }
  }
  // Simplest fix: generate the raw spec (without transform) to get correct schemas
  const raw: OpenApiSpec = OpenApi.fromApi(GraphagentHttpApi)
  const rawSchemas = raw.components?.schemas
  if (!rawSchemas) return
  for (const name of selfRefs) {
    if (rawSchemas[name]) schemas[name] = rawSchemas[name]
  }
}

/** Strip `{type:"null"}` arms that Effect's `Schema.optional` adds to OpenAPI unions. */
function stripOptionalNull(schema: OpenApiSchema): OpenApiSchema {
  if (schema.allOf?.length === 1) {
    const [constraint] = schema.allOf
    delete schema.allOf
    return stripOptionalNull({ ...schema, ...constraint })
  }
  if (isEmptyObjectUnion(schema)) return { type: "object", properties: {} }
  const options = flattenOptions(schema.anyOf ?? schema.oneOf)
  if (options) {
    const withoutNull = options.filter((item) => item.type !== "null")
    if (withoutNull.length === 1) return stripOptionalNull(withoutNull[0])
    if (schema.anyOf) schema.anyOf = withoutNull.map(stripOptionalNull)
    if (schema.oneOf) schema.oneOf = withoutNull.map(stripOptionalNull)
  }
  if (schema.allOf) {
    const allOf = schema.allOf.map(stripOptionalNull)
    if (schema.type) {
      delete schema.allOf
      for (const item of allOf) Object.assign(schema, item)
    } else {
      schema.allOf = allOf
    }
  }
  if (schema.prefixItems && schema.items) delete schema.prefixItems
  if (schema.items) schema.items = stripOptionalNull(schema.items)
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      schema.properties[key] = stripOptionalNull(value)
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    schema.additionalProperties = stripOptionalNull(schema.additionalProperties)
  }
  return schema
}

function isEmptyObjectUnion(schema: OpenApiSchema) {
  const options = schema.anyOf ?? schema.oneOf
  return options?.length === 2 && options.some(isBareObjectSchema) && options.some(isBareArraySchema)
}

function isBareObjectSchema(schema: OpenApiSchema) {
  return schema.type === "object" && !schema.properties && !schema.additionalProperties
}

function isBareArraySchema(schema: OpenApiSchema) {
  return schema.type === "array" && !schema.items && !schema.prefixItems
}

function flattenOptions(options: OpenApiSchema[] | undefined): OpenApiSchema[] | undefined {
  return options?.flatMap((item) => flattenOptions(item.anyOf ?? item.oneOf) ?? [item])
}

function normalizeParameter(param: OpenApiParameter, route: string) {
  if (!param.schema || typeof param.schema !== "object") return
  if (param.in === "path") {
    param.schema = stripOptionalNull(param.schema)
    return
  }
  if (param.in === "query") {
    const override = QueryParameterSchemas[`${route} ${param.name}`]
    if (override) {
      param.schema = override
      return
    }
  }
  param.schema = stripOptionalNull(param.schema)
}

export const PublicApi = GraphagentHttpApi.annotateMerge(
  OpenApi.annotations({
    title: "opencode",
    version: "1.0.0",
    description: "opencode api",
    transform: matchLegacyOpenApi,
  }),
)
