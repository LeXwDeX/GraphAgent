import { expect, test } from "bun:test"
import { splitAddedPatch } from "../../src/util/added-patch"

test("splits complete additions without losing empty lines or the no-newline marker", () => {
  const patch =
    "--- /dev/null\n+++ b/file.ts\n@@ -0,0 +1,5 @@\n+first\n+\n+third\n+fourth\n+last\n\\ No newline at end of file\n"
  const chunks = splitAddedPatch(patch, 2)!
  expect(chunks.map((chunk) => chunk.content).join("\n")).toBe("first\n\nthird\nfourth\nlast")
  expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 7, 20])
  expect(chunks.map((chunk) => chunk.rows)).toEqual([2, 2, 1])
  expect(chunks[0].patch).toContain("@@ -0,0 +1,2 @@")
  expect(chunks[1].patch).toContain("@@ -0,0 +3,2 @@")
  expect(chunks[2].patch).toEndWith("+last\n\\ No newline at end of file")
})

test("leaves partial, mixed and malformed patches on the existing renderer", () => {
  for (const body of [
    "@@ -1,1 +1,2 @@\n context\n+new",
    "@@ -0,0 +2,2 @@\n+second\n+third",
    "@@ -0,0 +1,2 @@\n+only",
    "@@ -0,0 +1,2 @@\n+new\n-old",
    "@@ -0,0 +1,1 @@\n+one\n@@ -0,0 +2,1 @@\n+two",
  ]) {
    expect(splitAddedPatch(body, 128)).toBeUndefined()
  }
  expect(splitAddedPatch("@@ -0,0 +1,1 @@\n+one", 0)).toBeUndefined()
})

test("normalizes CRLF patch records for measurement and whole-file highlighting", () => {
  const chunks = splitAddedPatch(
    "--- /dev/null\r\n+++ b/file.ts\r\n@@ -0,0 +1,2 @@\r\n+first\r\n+last\r\n\\ No newline at end of file\r\n",
    1,
  )!
  expect(chunks.map((chunk) => chunk.content)).toEqual(["first", "last"])
  expect(chunks[1].offset).toBe(6)
  expect(chunks[1].patch).toEndWith("+last\n\\ No newline at end of file")
})
