import fs from "node:fs/promises"
import path from "node:path"

const distDir = process.argv[2]
const outArchive = process.argv[3]
if (!distDir || !outArchive) {
  console.error("usage: package-cli-artifact.ts <dist-dir> <out-archive.tar.gz|out-archive.zip>")
  process.exit(2)
}

const resolvedDist = path.resolve(distDir)
const resolvedArchive = path.resolve(outArchive)
const binDir = path.join(resolvedDist, "bin")
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const distributionFiles = [
  "NOTICE",
  "LICENSE",
  "packages/core/src/dag/LICENSE",
  "packages/graphagent/src/dag/LICENSE",
  "third_party/mattpocock-skills/LICENSE",
  "third_party/mattpocock-skills/SOURCE.md",
] as const

for (const name of distributionFiles) {
  await fs.mkdir(path.dirname(path.join(binDir, name)), { recursive: true })
  await fs.copyFile(path.join(repoRoot, name), path.join(binDir, name))
}

const archive = resolvedArchive.endsWith(".tar.gz")
  ? Bun.spawnSync({
      cmd: ["tar", "-czf", resolvedArchive, "-C", binDir, "."],
      stdout: "pipe",
      stderr: "pipe",
    })
  : packageZip(binDir, resolvedArchive)

if (archive.exitCode !== 0) {
  process.stderr.write(archive.stderr.toString())
  console.error(`CLI packaging failed: ${resolvedArchive}`)
  process.exit(1)
}

console.log(
  JSON.stringify({
    packager: "graphagent cli packager v1",
    archive: resolvedArchive,
    distribution_files: distributionFiles,
  }),
)

function packageZip(directory: string, archive: string) {
  const zip = Bun.which("zip")
  if (zip) {
    return Bun.spawnSync({ cmd: [zip, "-r", archive, "."], cwd: directory, stdout: "pipe", stderr: "pipe" })
  }
  const sevenZip = Bun.which("7z")
  if (sevenZip) {
    return Bun.spawnSync({ cmd: [sevenZip, "a", archive, "."], cwd: directory, stdout: "pipe", stderr: "pipe" })
  }
  const powershell = Bun.which("pwsh") ?? Bun.which("powershell")
  if (!powershell) throw new Error("CLI packaging requires zip, 7z, pwsh, or powershell")
  const destination = archive.replaceAll("'", "''")
  return Bun.spawnSync({
    cmd: [powershell, "-NoProfile", "-Command", `Compress-Archive -Path * -DestinationPath '${destination}' -Force`],
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
}
