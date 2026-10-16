export interface AddedPatchChunk {
  readonly patch: string
  readonly content: string
  readonly rows: number
  readonly offset: number
}

// Only complete, single-hunk additions are safe to split without reconstructing old-file context.
export function splitAddedPatch(patch: string, size: number): AddedPatchChunk[] | undefined {
  if (!Number.isSafeInteger(size) || size < 1) return undefined
  const normalized = patch.replaceAll("\r\n", "\n")
  const header = /^@@ -0,0 \+1,(\d+) @@[^\n]*\n/m.exec(normalized)
  if (!header) return undefined
  const count = Number(header[1])
  const lines = normalized
    .slice(header.index + header[0].length)
    .replace(/\n$/, "")
    .split("\n")
  const marker = lines.at(-1) === "\\ No newline at end of file" ? lines.pop() : undefined
  if (lines.length !== count || lines.some((line) => !line.startsWith("+"))) return undefined
  const prefix = normalized.slice(0, header.index)
  if (/^@@ /m.test(prefix)) return undefined
  let offset = 0
  return Array.from({ length: Math.ceil(count / size) }, (_, index) => {
    const start = index * size
    const slice = lines.slice(start, start + size)
    const content = slice.map((line) => line.slice(1)).join("\n")
    const result = {
      patch: `${prefix}@@ -0,0 +${start + 1},${slice.length} @@\n${slice.join("\n")}${marker && start + size >= count ? `\n${marker}` : ""}`,
      content,
      rows: slice.length,
      offset,
    }
    offset += content.length + 1
    return result
  })
}
