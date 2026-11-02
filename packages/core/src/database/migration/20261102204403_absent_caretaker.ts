import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261102204403_absent_caretaker",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`target_fingerprint\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`stale_target\` integer;`)
      yield* tx.run(`ALTER TABLE \`workflow\` ADD \`target_fingerprint\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
