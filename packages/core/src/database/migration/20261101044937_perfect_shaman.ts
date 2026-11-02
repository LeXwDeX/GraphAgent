import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101044937_perfect_shaman",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow\` ADD \`execution_directory\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
