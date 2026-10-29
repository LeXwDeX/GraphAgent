# Release Notes Series Files

One markdown file per release series — `.github/releases/vX.Y.Z.md` — is the
source of truth for the GitHub Release body. New releases are stable `X.Y.Z`
builds dispatched from `main`. Historical `X.Y.Z-dev.N` tags and notes remain
valid records, but they no longer provide a release entry point or advance the
next stable version.

The read-only `prepare_release` job (`.azure-pipelines/release.yml`)
renders and validates the file, generates and verifies `SHA256SUMS`, and
uploads one release-candidate artifact on every manual run from `main`. A run
from another branch fails before building. The separate `publish_release` job
is the only one that reads the `GITHUB_RELEASE_TOKEN` secret and exists only
when `createRelease=true`. A missing or invalid notes
file therefore blocks both a non-publishing candidate and a real release.

## Lifecycle

1. **Series starts** — the latest stable `graphagent-v*` tag determines the next
   patch version. When `X.Y.Z` becomes the next version, the release job
   looks for `.github/releases/vX.Y.Z.md`. Until that file is committed, every
   release attempt of the series fails; the validator error names the exact
   expected path. This is intentional.
2. **Stable release** — the `main` release of `X.Y.Z` renders the series file;
   `{Prerelease/Stable}` becomes `Stable`. The compare range spans from the
   latest stable tag. Historical `-dev.N` tags are ignored for version selection.
3. **Series closes** — after the stable release ships, the file remains as the
   historical record. The next series needs its own new `vX.Y.(Z+1).md`.

## Placeholders

Five tokens are machine-substituted at render time:

| Token                 | Replaced with                                        |
| --------------------- | ---------------------------------------------------- |
| `{VERSION}`           | bare semver, e.g. `1.0.10` (no `v` prefix)           |
| `{Prerelease/Stable}` | `Stable`                                             |
| `{branch}`            | `main`                                               |
| `{previous_tag}`      | latest existing stable tag, e.g. `graphagent-v1.0.9` |
| `{current_tag}`       | the tag being released, e.g. `graphagent-v1.0.10`    |

The template also contains authoring-guidance braces (`{Feature name}`,
`{module}`, `{One-sentence summary …}`). These are **not** substituted —
replace every one of them with real content. The validator fails on any
residual `{` or `}` in the rendered notes.

## Authoring rules (enforced fail-closed)

- Start from `.github/RELEASE_NOTES_TEMPLATE.md` and keep the exact `### `
  emoji headings, their canonical order, and the `---` separators between
  sections. Omit sections that have no content — do not leave empty headers.
- Copy the emoji headings verbatim from the template; never retype them. The
  🏗️ (Architecture / Refactor) and ⚙️ (CI / Engineering) headings end with an
  invisible U+FE0F variation selector that editors and copy-paste can strip.
- Prose must be ASCII everywhere except the emoji headings themselves.
- `### 🧪 Test Summary` and `### 🔍 Verification` are mandatory in every
  release; the Test Summary body needs at least one fenced code block.
- The final line is the full-changelog compare link with the repository slug
  written out literally (`https://github.com/LeXwDeX/OpenCode-GraphAgent/compare/{previous_tag}...{current_tag}`).
  A repository rename fails validation on purpose — update the series file.

The grammar is implemented in `packages/opencode/script/release-notes.ts`
(rule errors are prefixed `[release-notes]`).
