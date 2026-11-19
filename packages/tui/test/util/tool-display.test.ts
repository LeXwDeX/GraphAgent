import { describe, expect, test } from "bun:test"
import {
  DIAGNOSTIC_LINES,
  parseApplyPatchFiles,
  parseDiagnostics,
  toolDisplayMetadata,
  toolRowName,
  webSearchProviderLabel,
  webSearchProviderName,
} from "../../src/util/tool-display"

describe("webSearchProviderName", () => {
  test("names the providers this build knows, by the name alone", () => {
    expect(webSearchProviderName("parallel")).toBe("Parallel")
    expect(webSearchProviderName("exa")).toBe("Exa")
  })

  test("names no provider the call does not say, or says as something else", () => {
    for (const provider of [undefined, null, {}, [], 1, "other", ""]) {
      expect(webSearchProviderName(provider)).toBeUndefined()
    }
  })

  test("the label of a provider is its name and the tool it went through", () => {
    for (const provider of ["parallel", "exa"]) {
      expect(webSearchProviderLabel(provider)).toBe(`${webSearchProviderName(provider)} Web Search`)
    }
  })
})

describe("toolRowName", () => {
  test("leads the row of a write, an edit and a patch with the name of the tool", () => {
    expect(toolRowName("write")).toBe("Write")
    expect(toolRowName("edit")).toBe("Edit")
    expect(toolRowName("apply_patch")).toBe("Patch")
  })
})

describe("parseApplyPatchFiles", () => {
  const file = { type: "update", relativePath: "a.ts", filePath: "/w/a.ts", patch: "@@ -1 +1 @@", deletions: 2 }

  test("carries the lines each file added and removed", () => {
    expect(parseApplyPatchFiles([{ ...file, additions: 5 }])).toEqual([{ ...file, additions: 5, movePath: undefined }])
    // A file that added nothing has the count 0, which is not a count that is missing.
    expect(parseApplyPatchFiles([{ ...file, additions: 0 }])[0].additions).toBe(0)
  })

  test("leaves the added lines out when the server did not count them, and keeps the file", () => {
    for (const additions of [undefined, "5", null, Number.NaN, {}]) {
      const files = parseApplyPatchFiles([{ ...file, additions }])
      expect(files).toHaveLength(1)
      expect(files[0].additions).toBeUndefined()
      expect(files[0].deletions).toBe(2)
    }
  })

  test("drops a file without the removed lines, and keeps the destination of a move", () => {
    expect(parseApplyPatchFiles([{ ...file, deletions: undefined, additions: 1 }])).toEqual([])
    expect(parseApplyPatchFiles([{ ...file, type: "move", additions: 1, movePath: "/w/b.ts" }])[0].movePath).toBe(
      "/w/b.ts",
    )
  })
})

describe("parseDiagnostics", () => {
  const error = (line: number) => ({
    severity: 1,
    message: `error ${line}`,
    range: { start: { line, character: 0 } },
  })
  const value = {
    "a.ts": [error(0), { ...error(1), severity: 2 }, error(2), error(3), error(4), error(5)],
  }

  test("lists the first errors, which is what a row shows", () => {
    expect(DIAGNOSTIC_LINES).toBe(3)
    expect(parseDiagnostics(value, "a.ts").map((item) => item.message)).toEqual(["error 0", "error 2", "error 3"])
  })

  test("lists all of them for the count a summary gives, and none of a file it has no errors for", () => {
    expect(parseDiagnostics(value, "a.ts", Infinity)).toHaveLength(5)
    expect(parseDiagnostics(value, "b.ts", Infinity)).toEqual([])
  })
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an unexpected string", "other"],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns structured metadata for non-pending states", () => {
    const structured = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "completed", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "error", structured })).toBe(structured)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "pending", structured: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
