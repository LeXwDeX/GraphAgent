/**
 * Maps a filesystem stat failure on a tool's search path to an actionable
 * diagnostic. Categories come from the Effect FileSystem abstraction's
 * normalized reason tags (PlatformError reason._tag), not from raw Node errno
 * fields. Known failures keep their category and resolved path; anything
 * unclassified keeps its actual cause so a filesystem problem is never
 * mislabeled as an agent-policy rejection.
 */
export function describeSearchPathFailure(
  searchPath: string,
  error: unknown,
  requested?: string,
  notFoundHint = "Verify the path with Glob.",
): string {
  const reason = (error as { reason?: { readonly _tag?: unknown } } | undefined)?.reason
  const category = typeof reason?._tag === "string" ? reason._tag : undefined
  const suffix = requested && requested !== searchPath ? ` (requested: ${requested})` : ""
  switch (category) {
    case "NotFound":
      return `Search path does not exist: ${searchPath}${suffix}. ${notFoundHint}`
    case "PermissionDenied":
      return `Filesystem permission denied for search path: ${searchPath}${suffix}. Check filesystem access permissions. This is an operating-system restriction, not an OpenCode permission policy rejection.`
    case "BadResource":
      return `Invalid search path: ${searchPath}${suffix}. A path component is not a directory or the path cannot be traversed.`
    default: {
      const detail = error instanceof Error && error.message ? error.message : String(error)
      return `Cannot access search path: ${searchPath}${suffix}. Reason: ${detail}`
    }
  }
}
