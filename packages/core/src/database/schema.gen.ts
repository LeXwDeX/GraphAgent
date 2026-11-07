import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_input_snapshot\` (
          \`id\` text PRIMARY KEY,
          \`mailbox_id\` text NOT NULL,
          \`logical_turn_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`message_ids\` text NOT NULL,
          \`associated\` integer DEFAULT false NOT NULL,
          \`stop_reason\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_mailbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`workflow_id\` text,
          \`node_id\` text,
          \`attempt_id\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`result_nudge_revision\` integer DEFAULT -1 NOT NULL,
          \`closed_reason\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_message\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`recipient_id\` text NOT NULL,
          \`recipient_session_id\` text NOT NULL,
          \`sender\` text NOT NULL,
          \`recipient\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`request\` text NOT NULL,
          \`content\` text NOT NULL,
          \`reply_to\` text,
          \`recipient_sequence\` integer NOT NULL,
          \`accepted_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`reason\` text,
          \`snapshot_id\` text,
          \`transcript_id\` text NOT NULL,
          \`part_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_delivered\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_node\` (
          \`id\` text NOT NULL,
          \`workflow_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`worker_type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`required\` integer DEFAULT true NOT NULL,
          \`depends_on\` text NOT NULL,
          \`model_id\` text,
          \`model_provider_id\` text,
          \`child_session_id\` text,
          \`directory\` text,
          \`base_head\` text,
          \`target_fingerprint\` text,
          \`stale_target\` integer,
          \`worktree_directory\` text,
          \`worktree_branch\` text,
          \`worktree_commit\` text,
          \`worktree_patch_path\` text,
          \`worktree_patch_sha256\` text,
          \`worktree_state\` text,
          \`worktree_conflicts_with\` text,
          \`worktree_history\` text,
          \`touched_paths\` text,
          \`output\` text,
          \`error_reason\` text,
          \`error_class\` text,
          \`captured_output\` text,
          \`captured_output_present\` integer DEFAULT false NOT NULL,
          \`captured_snapshot_id\` text,
          \`deadline_ms\` integer,
          \`wake_eligible\` integer DEFAULT false NOT NULL,
          \`wake_reported\` integer DEFAULT false NOT NULL,
          \`replan_attempts\` integer DEFAULT 0 NOT NULL,
          \`timeout_extensions\` integer DEFAULT 0 NOT NULL,
          \`escalation_pending\` integer DEFAULT false NOT NULL,
          \`superseded\` integer DEFAULT false NOT NULL,
          \`seq\` integer NOT NULL,
          \`started_at\` integer,
          \`completed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`workflow_node_pk\` PRIMARY KEY(\`workflow_id\`, \`id\`),
          CONSTRAINT \`fk_workflow_node_workflow_id_workflow_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`directory\` text,
          \`execution_directory\` text,
          \`target_fingerprint\` text,
          \`title\` text NOT NULL,
          \`status\` text NOT NULL,
          \`config\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`wake_reported\` integer DEFAULT false NOT NULL,
          \`graph_rev\` integer DEFAULT 1 NOT NULL,
          \`started_at\` integer,
          \`completed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_workflow_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_violation\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`node_id\` text,
          \`type\` text NOT NULL,
          \`severity\` text NOT NULL,
          \`message\` text NOT NULL,
          \`details\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_violation_workflow_id_workflow_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`data_hash\` text,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_outcome\` (
          \`goal_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`completed_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_state\` (
          \`session_id\` text PRIMARY KEY,
          \`payload\` text NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_input_snapshot_turn_idx\` ON \`agent_input_snapshot\` (\`mailbox_id\`,\`logical_turn_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`agent_mailbox_session_idx\` ON \`agent_mailbox\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_message_sender_key_idx\` ON \`agent_message\` (\`sender_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_message_recipient_sequence_idx\` ON \`agent_message\` (\`recipient_id\`,\`recipient_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`agent_message_recipient_state_idx\` ON \`agent_message\` (\`recipient_id\`,\`state\`,\`recipient_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`agent_message_session_idx\` ON \`agent_message\` (\`recipient_session_id\`,\`state\`);`,
      )
      yield* tx.run(`CREATE INDEX \`workflow_node_workflow_idx\` ON \`workflow_node\` (\`workflow_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`workflow_node_workflow_status_idx\` ON \`workflow_node\` (\`workflow_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workflow_node_workflow_id_seq_idx\` ON \`workflow_node\` (\`workflow_id\`,\`id\`,\`seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`workflow_project_idx\` ON \`workflow\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`workflow_session_idx\` ON \`workflow\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`workflow_status_idx\` ON \`workflow\` (\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`workflow_id_seq_idx\` ON \`workflow\` (\`id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`workflow_violation_workflow_idx\` ON \`workflow_violation\` (\`workflow_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`workflow_violation_severity_idx\` ON \`workflow_violation\` (\`workflow_id\`,\`severity\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`goal_outcome_session_completed_idx\` ON \`goal_outcome\` (\`session_id\`,\`completed_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_state_updated_at_idx\` ON \`goal_state\` (\`updated_at\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_directory_idx\` ON \`session\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
