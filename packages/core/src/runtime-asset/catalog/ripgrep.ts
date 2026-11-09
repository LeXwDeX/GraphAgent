// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { RuntimeAsset } from "../index"

export namespace RipgrepAsset {
  export const version = "15.1.0"
  const release = `https://github.com/BurntSushi/ripgrep/releases/download/${version}`

  const target = (input: {
    os: NodeJS.Platform
    arch: string
    platform: string
    archive: "tar.gz" | "zip"
    sha256: string
  }): RuntimeAsset.Target => {
    const executable = input.os === "win32" ? "rg.exe" : "rg"
    const artifact = `ripgrep-${version}-${input.platform}.${input.archive}`
    return {
      os: input.os,
      arch: input.arch,
      executable,
      artifact,
      archive: input.archive,
      entry: `ripgrep-${version}-${input.platform}/${executable}`,
      sha256: input.sha256,
      public: `${release}/${artifact}`,
    }
  }

  // Digests are the SHA-256 values published on the official GitHub 15.1.0
  // release assets. Keep the version, filename, entry, and digest together.
  export const descriptor: RuntimeAsset.Descriptor = {
    id: "ripgrep",
    version,
    required: true,
    targets: [
      target({
        os: "darwin",
        arch: "arm64",
        platform: "aarch64-apple-darwin",
        archive: "tar.gz",
        sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
      }),
      target({
        os: "darwin",
        arch: "x64",
        platform: "x86_64-apple-darwin",
        archive: "tar.gz",
        sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
      }),
      target({
        os: "linux",
        arch: "arm64",
        platform: "aarch64-unknown-linux-gnu",
        archive: "tar.gz",
        sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
      }),
      target({
        os: "linux",
        arch: "x64",
        platform: "x86_64-unknown-linux-musl",
        archive: "tar.gz",
        sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
      }),
      target({
        os: "win32",
        arch: "arm64",
        platform: "aarch64-pc-windows-msvc",
        archive: "zip",
        sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
      }),
      target({
        os: "win32",
        arch: "ia32",
        platform: "i686-pc-windows-msvc",
        archive: "zip",
        sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
      }),
      target({
        os: "win32",
        arch: "x64",
        platform: "x86_64-pc-windows-msvc",
        archive: "zip",
        sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
      }),
    ],
  }
}
