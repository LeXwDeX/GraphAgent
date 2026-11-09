<!-- SPDX-FileCopyrightText: 2026 LeXwDeX -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# RuntimeAsset modifications

This module is self-developed for the GraphAgent fork and is licensed
under Apache-2.0. Its full license text is `LICENSE-APACHE` at the repository
root.

Every TypeScript source file in this directory starts with the two lines from
`SPDX-HEADER.txt`. Code copied or adapted from an upstream MIT file must retain
the upstream copyright and MIT permission notice; it must not be relabeled as
Apache-2.0 without a provenance review, and it belongs in
`LICENSE-UPSTREAM.txt`.

Substantial changes are traceable through Git history and release metadata.
Each release source archive records the exact commit and build inputs. When a
change cannot be understood from its commit and path history, add a dated entry
below with the affected paths and a factual summary.

## Entries

- 2026-08-09: Reserved the module boundary for portable runtime asset
  resolution, integrity verification, caching, and source selection.
- 2026-08-09: Added the public descriptor, policy, provenance, typed failure,
  candidate resolution, Effect service, self-contained default layer, and
  LayerNode interfaces.
- 2026-08-09: Added managed system/package/cache/mirror/public candidates,
  pinned download verification, archive extraction, immutable cache metadata,
  atomic publication, and process-local concurrent download deduplication.
- 2026-08-09: Added the pinned ripgrep 15.1.0 seven-platform catalog and
  migrated the legacy binary service to the RuntimeAsset interface.
- 2026-08-09: Added desktop prebuild preparation, package verification,
  electron-builder resource embedding, and packaged sidecar asset discovery.
