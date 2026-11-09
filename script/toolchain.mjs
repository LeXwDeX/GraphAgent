// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function exact(name, value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${name} must pin an exact major.minor.patch version; got ${JSON.stringify(value)}`)
  }
  return value
}

function dependencyVersion(pkg, name, spec) {
  const catalog = spec?.startsWith("catalog:") ? spec.slice("catalog:".length) : undefined
  return exact(
    `dependency ${name}`,
    catalog === undefined
      ? spec
      : catalog === ""
        ? pkg.workspaces?.catalog?.[name]
        : pkg.workspaces?.catalogs?.[catalog]?.[name],
  )
}

export function resolveDependencyVersion(name, spec, directory = root) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  return dependencyVersion(pkg, name, spec)
}

export function readToolchain(directory = root) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  const bun = exact("packageManager (bun@version)", pkg.packageManager?.match(/^bun@(.+)$/)?.[1])
  const node = exact(".node-version", readFileSync(join(directory, ".node-version"), "utf8").trim())
  const mod = readFileSync(join(directory, "config_assistant/go.mod"), "utf8")
  const go = exact("go.mod go directive", mod.match(/^go\s+(\S+)\s*$/m)?.[1])
  const toolchain = mod.match(/^toolchain\s+(\S+)\s*$/m)?.[1]
  if (toolchain !== undefined && toolchain !== `go${go}`) {
    throw new Error(`go.mod toolchain must match go${go}; got ${toolchain}`)
  }
  const rustConfig = readFileSync(join(directory, "packages/containers/rust-toolchain.toml"), "utf8")
  const rust = exact("container rust-toolchain.toml channel", rustConfig.match(/^channel\s*=\s*"([^"]+)"\s*$/m)?.[1])
  const turbo = dependencyVersion(pkg, "turbo", pkg.devDependencies?.turbo)
  return { bun, node, go, turbo, rust }
}

export function assertRuntimeVersions(expected, actual) {
  const errors = Object.entries(actual).flatMap(([name, version]) =>
    expected[name] === version
      ? []
      : [
          `requires ${name}@${expected[name]}, found ${typeof version === "string" ? `${name}@${version}` : `${name} unavailable`}`,
        ],
  )
  if (errors.length) throw new Error(`Toolchain mismatch: ${errors.join("; ")}`)
}

function commandVersion(command, args, pattern) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim()
      .match(pattern)?.[1]
  } catch {
    return undefined
  }
}

export function checkToolchain({ go = false, rust = false, bunOnly = false } = {}) {
  if ((go || rust) && bunOnly) throw new Error("--go/--rust and --bun-only cannot be combined")
  const expected = readToolchain()
  const actual = {
    bun: process.versions.bun ?? commandVersion("bun", ["--version"], /^(\d+\.\d+\.\d+)$/),
    ...(bunOnly
      ? {}
      : {
          // Bun exposes a Node compatibility version; check the actual Node executable instead.
          node: process.versions.bun
            ? commandVersion("node", ["--version"], /^v(\d+\.\d+\.\d+)$/)
            : process.versions.node,
        }),
    ...(go ? { go: commandVersion("go", ["version"], /^go version go(\d+\.\d+\.\d+)\s/) } : {}),
    ...(rust ? { rust: commandVersion("rustc", ["--version"], /^rustc (\d+\.\d+\.\d+)\s/) } : {}),
  }
  assertRuntimeVersions(expected, actual)
  return actual
}

function isEntryPoint() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === "get" && args.length === 1 && ["bun", "node", "go", "turbo", "rust"].includes(args[0])) {
      console.log(readToolchain()[args[0]])
    } else if (command === "check" && args.every((arg) => ["--go", "--rust", "--bun-only"].includes(arg))) {
      const versions = checkToolchain({
        go: args.includes("--go"),
        rust: args.includes("--rust"),
        bunOnly: args.includes("--bun-only"),
      })
      console.log(
        `Toolchain verified: ${Object.entries(versions)
          .map(([name, version]) => `${name}@${version}`)
          .join(", ")}`,
      )
    } else {
      throw new Error("Usage: toolchain.mjs get <bun|node|go|turbo|rust> | check [--go] [--rust] | check --bun-only")
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
