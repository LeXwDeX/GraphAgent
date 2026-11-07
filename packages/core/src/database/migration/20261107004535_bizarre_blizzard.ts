import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261107004535_bizarre_blizzard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_input_session_pending_delivery_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_input_session_admitted_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_input_session_promoted_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_type_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_time_created_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_time_created_idx\`;`)
      yield* tx.run(`DROP TABLE \`session_context_epoch\`;`)
      yield* tx.run(`DROP TABLE \`session_input\`;`)
      yield* tx.run(`DROP TABLE \`session_message\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
