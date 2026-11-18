import { test, expect } from "bun:test"
import { formatImportFileError, importedSessionInfo } from "../../src/cli/cmd/import"
import { FSUtil } from "@graphagent/core/fs-util"
import { PlatformError } from "effect"

test("formats import file errors", () => {
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("File not found: test.json")
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("Failed to read file: Permission denied")
  expect(
    formatImportFileError(
      "test.json",
      new FSUtil.FileSystemError({ method: "readJson", cause: new SyntaxError("Unexpected token") }),
    ),
  ).toBe("Invalid JSON in test.json: Unexpected token")
})

// #1288: an export file written before `Session.Info.role` has none.
test("imports an export with no role by its parent, and keeps one that has it", () => {
  const exported = {
    id: "ses_import_role",
    slug: "import-role",
    projectID: "proj_elsewhere",
    directory: "/elsewhere",
    title: "Imported",
    version: "0.0.0",
    time: { created: 1, updated: 2 },
  }
  const place = { projectID: "proj_here", directory: "/here", path: "sub" }

  const root = importedSessionInfo(exported, place)
  expect(root.role).toBe("root")
  expect([root.projectID, root.directory, root.path]).toEqual(["proj_here", "/here", "sub"])
  expect(importedSessionInfo({ ...exported, parentID: "ses_import_parent" }, place).role).toBe("task_child")
  expect(importedSessionInfo({ ...exported, parentID: "ses_import_parent", role: "dag_node" }, place).role).toBe(
    "dag_node",
  )
})
