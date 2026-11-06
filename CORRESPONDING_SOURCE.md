# Corresponding source

Every GraphAgent binary release that contains AGPL-covered code is
paired with a source archive generated from the same Git commit by:

```sh
bun run ./script/corresponding-source.ts --version <release-version> --output <directory>
```

The archive contains all tracked source and build inputs, including
`package.json`, `bun.lock`, build scripts, `LICENSE`, `NOTICE`, and
`LICENSE-SCOPE.json`. The adjacent JSON manifest records the exact commit,
commit timestamp, required build inputs, archive filename, and SHA-256 digest.

Install the Bun version declared by the root `packageManager` field, restore
dependencies from `bun.lock`, and run the package-specific build documented in
the repository. External signing keys, certificates, credentials, and ordinary
system tools are not part of the source archive.

For an internal deployment, publish the archive, JSON manifest, and checksum
next to the binaries or at the source URL configured for that deployment.
