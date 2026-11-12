import type { DatabaseMigration } from "./migration"

export const baseline = { id: "baseline-df24d71935409bfb" } as const

export const migrations: DatabaseMigration.Migration[] = []
