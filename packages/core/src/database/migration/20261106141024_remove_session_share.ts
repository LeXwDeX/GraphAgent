import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261106141024_remove_session_share",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`session_share\`;`)
      yield* tx.run(`ALTER TABLE \`session\` DROP COLUMN \`share_url\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
