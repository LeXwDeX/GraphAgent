import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv"
import { isRecord } from "@/util/record"

/** Use the installed MCP SDK's complete JSON Schema dialect support, without schema conversion. */
export function toolInputValidator(schema: unknown) {
  const provider = new AjvJsonSchemaValidator()
  let validate: ReturnType<AjvJsonSchemaValidator["getValidator"]> | undefined
  return (input: Record<string, unknown>) => {
    if (!isRecord(schema)) throw new Error("Tool input schema must be an object")
    validate ??= provider.getValidator(schema)
    const result = validate(input)
    if (!result.valid)
      throw new Error(`Hook replacement does not match tool input schema: ${result.errorMessage ?? "invalid input"}`)
  }
}
