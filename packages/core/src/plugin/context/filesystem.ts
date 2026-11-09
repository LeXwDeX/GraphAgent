import type { FileSystem as SchemaFileSystem } from "@graphagent/schema/filesystem"
import type { Effect } from "effect"

export interface FileSystem {
  read(input: { readonly path: string }): Effect.Effect<{ readonly content: Uint8Array; readonly mime: string }>
  list(input?: { readonly path?: string }): Effect.Effect<SchemaFileSystem.Entry[]>
  find(input: {
    readonly query: string
    readonly type?: "file" | "directory"
    readonly limit?: number
  }): Effect.Effect<SchemaFileSystem.Entry[]>
  glob(input: {
    readonly pattern: string
    readonly path?: string
    readonly limit?: number
  }): Effect.Effect<readonly SchemaFileSystem.Entry[]>
}
