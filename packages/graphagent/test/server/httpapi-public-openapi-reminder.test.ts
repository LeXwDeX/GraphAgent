// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1036: `GET /session/:sessionID/reminder` returns `everyMs: null` for every
// one-shot reminder. The public spec strips the null arm Effect adds to
// optional fields, so it is re-added for this genuinely nullable field; without
// it the generated SDK type would claim every reminder repeats.
import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type OpenApiSchema = {
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly type?: string
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
}

const schemas = () =>
  (OpenApi.fromApi(PublicApi) as { components: { schemas: Record<string, OpenApiSchema> } }).components.schemas

describe("public OpenAPI reminder list (#1036)", () => {
  test("everyMs is a required, nullable number and the times are plain numbers", () => {
    const reminder = schemas().SessionReminder
    expect(reminder?.required ?? []).toEqual(expect.arrayContaining(["everyMs", "fireAt", "createdAt"]))
    expect((reminder?.properties?.everyMs?.anyOf ?? []).map((arm) => arm.type)).toEqual(["number", "null"])
    expect(reminder?.properties?.fireAt).toMatchObject({ type: "number" })
    expect(reminder?.properties?.fireAt?.anyOf).toBeUndefined()
  })
})
