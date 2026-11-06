import { existsSync } from "fs"
import { mkdir } from "fs/promises"
import path from "path"

export const requiredSourceFiles = [
  "LICENSE",
  "NOTICE",
  "LICENSE-SCOPE.json",
  "LICENSE-SCOPE.schema.json",
  "CORRESPONDING_SOURCE.md",
  "package.json",
  "bun.lock",
  "script/corresponding-source.ts",
  "packages/opencode/script/build.ts",
] as const

export type CorrespondingSourceInput = {
  root: string
  output: string
  version: string
  ref?: string
  allowDirty?: boolean
  requiredFiles?: readonly string[]
}

export async function createCorrespondingSource(input: CorrespondingSourceInput) {
  if (!input.version.trim()) throw new Error("Corresponding source version is required")

  const root = path.resolve(input.root)
  const requiredFiles = input.requiredFiles ?? requiredSourceFiles
  if (requiredFiles.some((file) => path.isAbsolute(file) || file.split("/").includes(".."))) {
    throw new Error("Corresponding source paths must be repository-relative")
  }

  const commit = await git(root, ["rev-parse", "--verify", `${input.ref ?? "HEAD"}^{commit}`])
  if (!input.allowDirty && (await git(root, ["status", "--porcelain", "--untracked-files=no"]))) {
    throw new Error("Tracked working tree changes must be committed before creating corresponding source")
  }
  await Promise.all(requiredFiles.map((file) => git(root, ["cat-file", "-e", `${commit}:${file}`])))

  const output = path.resolve(input.output)
  const version = input.version.replace(/[^0-9A-Za-z._-]/g, "-")
  const base = `opencode-graphagent-${version}-source-${commit.slice(0, 12)}`
  const archive = path.join(output, `${base}.tar.gz`)
  await mkdir(output, { recursive: true })
  await command(root, ["git", "archive", "--format=tar.gz", `--prefix=${base}/`, `--output=${archive}`, commit])

  const sha256 = await digest(archive)
  const sourceDateEpoch = Number(await git(root, ["show", "-s", "--format=%ct", commit]))
  const manifest = path.join(output, `${base}.source.json`)
  await Bun.write(
    manifest,
    JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "agpl-corresponding-source",
        project: "OpenCode-GraphAgent",
        version: input.version,
        commit,
        generatedAt: new Date(sourceDateEpoch * 1000).toISOString(),
        sourceDateEpoch,
        archive: {
          file: path.basename(archive),
          sha256,
        },
        requiredFiles,
        dependencyLocks: ["bun.lock"],
        licenseScope: "LICENSE-SCOPE.json",
        rebuildInstructions: "CORRESPONDING_SOURCE.md",
      },
      null,
      2,
    ) + "\n",
  )
  const checksum = path.join(output, `${base}.sha256`)
  await Bun.write(checksum, `${sha256}  ${path.basename(archive)}\n`)

  return { archive, manifest, checksum, commit, sha256 }
}

export async function verifyCorrespondingSourceArtifacts(directory: string) {
  const root = path.resolve(directory)
  const manifests = await Array.fromAsync(
    new Bun.Glob("*-source-*.source.json").scan({ cwd: root, absolute: true, onlyFiles: true }),
  )
  if (manifests.length !== 1) {
    throw new Error(`Expected exactly one corresponding source manifest in ${root}, found ${manifests.length}`)
  }

  const value: unknown = await Bun.file(manifests[0]).json()
  if (!isRecord(value) || !isRecord(value.archive)) throw new Error("Corresponding source manifest is malformed")
  if (typeof value.archive.file !== "string" || path.basename(value.archive.file) !== value.archive.file) {
    throw new Error("Corresponding source archive filename is invalid")
  }
  if (typeof value.archive.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.archive.sha256)) {
    throw new Error("Corresponding source SHA-256 is invalid")
  }

  const archive = path.join(root, value.archive.file)
  const checksum = manifests[0].replace(/\.source\.json$/, ".sha256")
  if (!existsSync(archive)) throw new Error(`Corresponding source archive is missing: ${value.archive.file}`)
  if (!existsSync(checksum)) throw new Error(`Corresponding source checksum is missing: ${path.basename(checksum)}`)
  const actual = await digest(archive)
  if (actual !== value.archive.sha256) throw new Error(`Corresponding source digest mismatch for ${value.archive.file}`)
  if ((await Bun.file(checksum).text()) !== `${actual}  ${value.archive.file}\n`) {
    throw new Error(`Corresponding source checksum file does not match ${value.archive.file}`)
  }
  return { manifest: manifests[0], archive, checksum, sha256: actual }
}

async function git(root: string, args: string[]) {
  return command(root, ["git", ...args])
}

async function command(root: string, args: string[]) {
  const child = Bun.spawn(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
  return stdout.trim()
}

async function digest(file: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function main() {
  const verifyIndex = Bun.argv.indexOf("--verify")
  if (verifyIndex !== -1) {
    const directory = Bun.argv[verifyIndex + 1]
    if (!directory) throw new Error("Usage: corresponding-source.ts --verify <directory>")
    console.log(JSON.stringify(await verifyCorrespondingSourceArtifacts(directory), null, 2))
    return
  }

  const versionIndex = Bun.argv.indexOf("--version")
  const outputIndex = Bun.argv.indexOf("--output")
  const version = versionIndex === -1 ? undefined : Bun.argv[versionIndex + 1]
  if (!version) throw new Error("Usage: corresponding-source.ts --version <version> [--output <directory>]")
  const output =
    outputIndex === -1 ? path.join(import.meta.dir, "..", "dist", "corresponding-source") : Bun.argv[outputIndex + 1]
  if (!output) throw new Error("--output requires a directory")

  const result = await createCorrespondingSource({
    root: path.join(import.meta.dir, ".."),
    output,
    version,
    allowDirty: Bun.argv.includes("--allow-dirty"),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) await main()
