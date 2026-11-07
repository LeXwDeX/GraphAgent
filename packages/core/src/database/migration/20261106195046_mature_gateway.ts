import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261106195046_mature_gateway",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`account_state\`;`)
      yield* tx.run(`DROP TABLE \`account\`;`)
      yield* tx.run(`DROP TABLE \`control_account\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
