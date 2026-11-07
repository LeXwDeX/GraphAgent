import { Schema } from "effect"

export const DagMode = Schema.Literals(["on", "off"])
export type DagMode = typeof DagMode.Type

/** Null means the session has no DAG budget. */
export const DagBudgetTokens = Schema.NullOr(Schema.Finite)
export type DagBudgetTokens = typeof DagBudgetTokens.Type
