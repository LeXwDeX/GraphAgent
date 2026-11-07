import { describe, expect, test } from "bun:test"
import { detectUnsupportedFields, type Settings } from "@/hook/settings"

const hooks = (hook: Record<string, unknown>): Settings["hooks"] => ({
  SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "true", ...hook }] }],
})

describe("detectUnsupportedFields", () => {
  test("async / asyncRewake are NOT flagged (implemented)", () => {
    const unsupported = detectUnsupportedFields(hooks({ async: true, asyncRewake: true }))
    expect(unsupported).toEqual([])
  })

  test("if is NOT flagged (condition-filter implements it)", () => {
    const unsupported = detectUnsupportedFields(hooks({ if: "Bash(npm *)" }))
    expect(unsupported).toEqual([])
  })

  test("shell is supported by command hooks", () => {
    const unsupported = detectUnsupportedFields(hooks({ shell: "powershell" }))
    expect(unsupported).toEqual([])
  })

  test("command options compose without unsupported-field warnings", () => {
    const unsupported = detectUnsupportedFields(
      hooks({ if: "Edit(*.ts)", shell: "bash", async: true, asyncRewake: true }),
    )
    expect(unsupported).toEqual([])
  })

  test("undefined / empty hooks yield no flags", () => {
    expect(detectUnsupportedFields(undefined)).toEqual([])
    expect(detectUnsupportedFields({})).toEqual([])
  })

  test("allowedEnvVars is restricted to HTTP; statusMessage and once are supported", () => {
    const unsupported = detectUnsupportedFields(hooks({ allowedEnvVars: ["FOO"], statusMessage: "hi", once: true }))
    expect(unsupported.map((u) => u.field).sort()).toEqual(["allowedEnvVars"])
  })

  test("HTTP accepts environment interpolation and diagnoses an irrelevant shell", () => {
    expect(
      detectUnsupportedFields(
        hooks({ type: "http", url: "http://localhost", allowedEnvVars: ["TEST"], shell: "bash" }),
      ),
    ).toEqual([{ field: "shell", value: "bash", eventName: "SessionStart" }])
  })
})
