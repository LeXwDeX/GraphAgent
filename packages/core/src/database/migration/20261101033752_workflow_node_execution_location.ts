import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101033752_workflow_node_execution_location",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`directory\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`base_head\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
