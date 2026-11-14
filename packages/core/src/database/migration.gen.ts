import type { DatabaseMigration } from "./migration"

export const baseline = { id: "baseline-50502be9fc516494" } as const

export const migrations: DatabaseMigration.Migration[] = []
