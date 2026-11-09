import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Credential } from "@graphagent/schema/credential"
import type { Integration } from "@graphagent/schema/integration"
import { Timestamps } from "../database/schema.sql"

export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Integration.ID>(),
  label: text().notNull(),
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})
