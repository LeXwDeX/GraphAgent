import path from "node:path"
import { isRecord } from "@/util/record"

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit", "patch"])

/** Prefer actual result metadata; input paths are a fallback for compatible tools. */
export function toolFileChanges(tool: string, args: Record<string, unknown>, metadata: unknown, cwd: string) {
  const changes = new Map<string, { path: string; changeType: "add" | "change" | "delete" }>()
  if (!FILE_TOOLS.has(tool)) return []
  const add = (file: unknown, changeType: "add" | "change" | "delete") => {
    if (typeof file !== "string" || !file.trim()) return
    const resolved = path.resolve(cwd, file)
    changes.set(resolved, { path: resolved, changeType })
  }
  const data = isRecord(metadata) ? metadata : {}
  if (Array.isArray(data.files)) {
    for (const file of data.files) {
      if (!isRecord(file)) continue
      if (file.type === "move" && typeof file.movePath === "string") {
        add(file.filePath, "delete")
        add(file.movePath, "add")
      } else {
        add(file.filePath, file.type === "add" ? "add" : file.type === "delete" ? "delete" : "change")
      }
    }
  } else {
    const diff = isRecord(data.filediff) ? data.filediff : {}
    const file = data.filepath ?? diff.file ?? args.filePath ?? args.file_path ?? args.path
    add(file, tool === "write" && data.exists === false ? "add" : "change")
    if (tool === "multiedit" && Array.isArray(args.edits)) {
      for (const edit of args.edits) {
        if (isRecord(edit)) add(edit.filePath ?? edit.file_path ?? edit.path, "change")
      }
    }
  }
  return [...changes.values()]
}

/** Patch header paths only: ignore body lines and preserve move source/destination order. */
export function patchFilePaths(patch: unknown): string[] {
  if (typeof patch !== "string") return []
  return [
    ...new Set(
      [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)]
        .map((match) => match[1].trim())
        .filter(Boolean),
    ),
  ]
}
