import { describe, expect, it } from "bun:test"
import { assertCoverage, parseLcov } from "../../script/dag-core-coverage"

describe("DAG core coverage gate", () => {
  it("rejects a critical public module below its line floor", () => {
    const report = parseLcov(`
SF:src/dag/runtime/loop.ts
FNF:10
FNH:9
LF:100
LH:89
end_of_record
`)

    expect(() => assertCoverage(report, [{ file: "src/dag/runtime/loop.ts", lines: 90, functions: 80 }])).toThrow(
      "src/dag/runtime/loop.ts: lines 89.00% < 90.00%",
    )
  })
})
