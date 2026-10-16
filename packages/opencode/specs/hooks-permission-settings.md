# Hook permission settings

PermissionRequest `updatedPermissions` persists in OpenCode-owned settings only. Session updates remain in memory; project updates use `opencode.jsonc`; local updates use `.opencode/permissions.local.json` (ignored by `.opencode/.gitignore`); user updates use the existing global OpenCode configuration resolver.

The canonical format is an ordered `permissions` array of `{ action, resource, effect }` rules. The last matching rule wins within each policy source. This preserves cross-action wildcards, including a broad deny followed by a narrow allow. Within one document this array supersedes the older `permission` map; the original map and unrelated settings are retained. Documents without the array continue to load their legacy map. Sources concatenate in the existing configuration precedence order; local permission settings follow project settings. Existing native agent restrictions remain independently enforced and cannot be overridden by hook session allowances.

The writer validates the complete existing document and requested updates before writing. Invalid JSON/schema leaves the original bytes unchanged. Native V2 documents keep their `providers` and `permissions` format, avoiding legacy migration. V1 migration carries the ordered rules forward. A successful persistent update refreshes the active policy; a refresh failure is reported rather than treated as successful authorization. `auto` has no local classifier equivalent and is rejected; hooks cannot grant themselves bypass authority.

## Local instruction mapping

GraphAgent reports `InstructionsLoaded` for the instruction files its own context loader actually admits, including `AGENTS.md`. This is an explicit local-product extension: Claude Code does not emit this event for direct `AGENTS.md` project-instruction reads. GraphAgent does not scan or load extra Claude-specific files merely to generate hook events. V2 notification deduplication is scoped to the session, actual file path and admitted content version; successful compaction receives its own internal load batch and `compact` reason; a second session receives its own notification. Directory descriptions in ReferenceGuidance are not instruction-file loads.

## Explicit local startup capability

The existing local CLI `--dangerously-skip-permissions` flag supplies a private, single-use Request identity at session startup. It may enable a subsequent Hook-requested `bypassPermissions` mode for that session only. Hook JSON, HTTP headers, persisted settings and nested/plugin session creation cannot grant this authority. Configured/native deny checks still run. SessionEnd and deletion clear the capability. Resume requires the explicit flag again. Attach/remote clients do not receive this new Hook capability; their existing CLI permission-reply behavior is unchanged.

For GraphAgent's `updatedPermissions.addDirectories`, `DirectoryAdded.source` is `register_repo_root`, representing programmatic registration in the existing external-directory permission whitelist. This local mapping does not create a Git repository or expand the product's directory-management behavior.
