const tagPrefix = "graphagent-v"
const stableTag = /^graphagent-v(\d+)\.(\d+)\.(\d+)$/

type Version = readonly [major: number, minor: number, patch: number]

export function resolveReleaseVersion(input: { branch: string; tags: string[] }) {
  const channel = input.branch
  if (channel !== "main") {
    throw new Error(`GraphAgent releases require main, received: ${channel || "(empty)"}`)
  }

  const latest = input.tags
    .flatMap((tag) => {
      const version = parseStableTag(tag)
      return version ? [{ tag, version }] : []
    })
    .toSorted((left, right) => compareVersion(left.version, right.version))
    .at(-1)
  const target = nextVersion(latest?.version)
  const base = target.join(".")
  const previousTag = latest?.tag ?? ""

  return {
    channel,
    version: base,
    tag: `${tagPrefix}${base}`,
    prerelease: false,
    latest: true,
    previous_tag: previousTag,
  }
}

function parseStableTag(tag: string): Version | undefined {
  const match = stableTag.exec(tag)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function nextVersion(version: Version | undefined): Version {
  if (!version) return [1, 0, 0]
  return [version[0], version[1], version[2] + 1]
}

function compareVersion(left: Version, right: Version) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

async function readTags() {
  const child = Bun.spawn(["git", "tag", "--list", `${tagPrefix}*`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Unable to list GraphAgent tags: ${stderr.trim()}`)
  return stdout.split(/\r?\n/).filter(Boolean)
}

async function main() {
  const output = process.env.GITHUB_OUTPUT
  if (!output) throw new Error("GITHUB_OUTPUT is required")

  const release = resolveReleaseVersion({
    branch: process.env.GITHUB_REF_NAME ?? "",
    tags: await readTags(),
  })
  const { appendFile } = await import("node:fs/promises")
  await appendFile(
    output,
    [
      `channel=${release.channel}`,
      `version=${release.version}`,
      `tag=${release.tag}`,
      `prerelease=${release.prerelease}`,
      `latest=${release.latest}`,
      `previous_tag=${release.previous_tag}`,
      "",
    ].join("\n"),
  )
  console.log(`GraphAgent release: ${release.tag} (channel=${release.channel}, latest=${release.latest})`)
}

if (import.meta.main) await main()
