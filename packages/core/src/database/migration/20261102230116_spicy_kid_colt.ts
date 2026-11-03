import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261102230116_spicy_kid_colt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_directory\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_branch\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_commit\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_patch_path\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_patch_sha256\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_state\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`worktree_conflicts_with\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`touched_paths\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
