import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261103002352_workflow_node_worktree_history",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_history\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
