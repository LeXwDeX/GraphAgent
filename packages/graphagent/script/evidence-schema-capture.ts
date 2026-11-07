/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- This one-shot evidence script intentionally traverses provider-transformed recursive JSON Schema values. */
// One-shot evidence capture for change repair-workflow-authoring-validation
// (task 1.4, recaptured after the review-remediation admission change):
// records the POST-change provider-facing workflow schema so provider-shape
// regressions surface as fixture diffs. The PRE-change fixture
// (workflow-parameters-pre-change.json) is immutable red evidence — never
// regenerate it; it documents the failure mode the switch fixed.
import path from "node:path"
import { Parameters } from "../src/tool/workflow"
import { ToolJsonSchema } from "../src/tool/json-schema"
import { ProviderTransform } from "../src/provider/transform"

const schema = ToolJsonSchema.fromSchema(Parameters as never) as JsonSchemaNode
const flat = JSON.stringify(schema)

const providers: Record<string, { providerID: string; api: { id: string; npm?: string } }> = {
  openai: { providerID: "openai", api: { id: "gpt-4.1", npm: "@ai-sdk/openai" } },
  azure: { providerID: "azure", api: { id: "gpt-4.1", npm: "@ai-sdk/azure" } },
  gemini: { providerID: "google", api: { id: "gemini-3-pro", npm: "@ai-sdk/google" } },
}

type JsonSchemaNode = {
  anyOf?: JsonSchemaNode[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  [key: string]: unknown
}

const evidence: Record<string, unknown> = {
  captured_from: "packages/opencode/src/tool/workflow.ts (discriminated-union Parameters)",
  schema_bytes: Buffer.byteLength(flat, "utf8"),
  branch_count: (schema.anyOf ?? []).length,
  session_id_exposed: flat.includes('"session_id"'),
  project_id_exposed: flat.includes('"project_id"'),
  transformed: {} as Record<string, unknown>,
}

for (const [name, model] of Object.entries(providers)) {
  const transformed = ProviderTransform.schema(model as never, JSON.parse(flat)) as JsonSchemaNode
  const branches = transformed.anyOf ?? []
  const startInline = branches.find(
    (branch) => {
      const actions = branch.properties?.action?.enum
      return Array.isArray(actions) && actions.includes("start") && branch.properties?.["spec"] !== undefined
    },
  )
  const config = startInline?.properties?.["spec"]?.properties?.["config"]
  const configBranches = config?.anyOf ?? []
  const blocksBranch = configBranches.find((branch) => branch.properties?.["blocks"] !== undefined)
  const nodesBranch = configBranches.find((branch) => branch.properties?.["nodes"] !== undefined)
  ;(evidence.transformed as Record<string, unknown>)[name] = {
    bytes: Buffer.byteLength(JSON.stringify(transformed), "utf8"),
    branch_count: branches.length,
    start_inline_spec_config_present: config !== undefined,
    blocks_branch_fields: Object.keys(blocksBranch?.properties ?? {}),
    block_item_fields: Object.keys(blocksBranch?.properties?.["blocks"]?.items?.properties ?? {}),
    node_item_fields: Object.keys(nodesBranch?.properties?.["nodes"]?.items?.properties ?? {}),
  }
}

const out = path.join(import.meta.dir, "..", "test", "tool", "fixtures", "workflow-parameters-post-change.json")
await Bun.file(out).write(JSON.stringify(evidence, null, 2) + "\n")
console.log(JSON.stringify(evidence, null, 2))
