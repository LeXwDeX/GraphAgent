import { basename, join } from "node:path"

const tagPrefix = "graphagent-v"
const versionPattern = /^(\d+\.\d+\.\d+)(?:-dev\.\d+)?$/
const channelLinePattern = /^(Prerelease|Stable) release from `(dev|main)` branch\. \S/
const asciiLinePattern = /^[\x00-\x7F]*$/

// Headings must equal .github/RELEASE_NOTES_TEMPLATE.md codepoint-for-codepoint:
// 🏗️ and ⚙️ carry a U+FE0F variation selector that plain-text editing strips.
export const canonicalHeadings: readonly string[] = [
  "### 🎯 Features",
  "### 🐛 Bug Fixes",
  "### 🏗️ Architecture / Refactor",
  "### ⚙️ CI / Engineering",
  "### 📦 Dependencies / Tooling",
  "### 🧪 Test Summary",
  "### 🔍 Verification",
]
const changeHeadings = canonicalHeadings.slice(0, 5)
const testSummaryHeading = canonicalHeadings[5]
const verificationHeading = canonicalHeadings[6]

export type ReleaseNotesInput = {
  version: string
  channel: "main" | "dev"
  branch: string
  tag: string
  previousTag: string
  repo: string
}

export class ReleaseNotesError extends Error {
  constructor(message: string) {
    super(`[release-notes] ${message}`)
    this.name = "ReleaseNotesError"
  }
}

export function seriesFor(version: string): string {
  const match = versionPattern.exec(version)
  if (!match) throw new ReleaseNotesError(`malformed version "${version}" (expected X.Y.Z or X.Y.Z-dev.N)`)
  return match[1]
}

export function seriesFileFor(version: string): string {
  return `.github/releases/v${seriesFor(version)}.md`
}

function channelWord(channel: "main" | "dev") {
  return channel === "main" ? "Stable" : "Prerelease"
}

export function renderPlaceholders(source: string, input: ReleaseNotesInput): string {
  return source
    .replaceAll("{VERSION}", input.version)
    .replaceAll("{Prerelease/Stable}", channelWord(input.channel))
    .replaceAll("{branch}", input.branch)
    .replaceAll("{previous_tag}", input.previousTag)
    .replaceAll("{current_tag}", input.tag)
}

export function expectedFinalLine(input: ReleaseNotesInput): string {
  return `**Full changelog:** [\`${input.previousTag}\`...\`${input.tag}\`](https://github.com/${input.repo}/compare/${input.previousTag}...${input.tag})`
}

export function validateAndRender(source: string, input: ReleaseNotesInput): string {
  const rendered = renderPlaceholders(source, input)
  const lines = rendered.split(/\r?\n/)
  const nonBlank = lines.filter((line) => line.trim().length > 0)

  if (nonBlank[0] !== `## opencode ${input.version}`)
    throw new ReleaseNotesError(`first line must be "## opencode ${input.version}", found ${quote(nonBlank[0])}`)

  const channelMatch = channelLinePattern.exec(nonBlank[1] ?? "")
  if (!channelMatch || channelMatch[1] !== channelWord(input.channel) || channelMatch[2] !== input.branch)
    throw new ReleaseNotesError(
      `second line must be "${channelWord(input.channel)} release from \`${input.branch}\` branch. <summary>", found ${quote(nonBlank[1])}`,
    )

  const headings = lines.filter((line) => line.startsWith("### "))
  for (const heading of headings) {
    if (!canonicalHeadings.includes(heading))
      throw new ReleaseNotesError(`unknown section heading ${quote(heading)} — must equal a template heading codepoint-for-codepoint`)
  }
  let previousIndex = -1
  for (const heading of headings) {
    const index = canonicalHeadings.indexOf(heading)
    if (index <= previousIndex)
      throw new ReleaseNotesError(`section headings must follow template order without duplicates, violated at ${quote(heading)}`)
    previousIndex = index
  }

  if (!headings.includes(testSummaryHeading)) throw new ReleaseNotesError(`missing required section ${quote(testSummaryHeading)}`)
  if (!headings.includes(verificationHeading)) throw new ReleaseNotesError(`missing required section ${quote(verificationHeading)}`)

  const blocks = splitBlocks(lines)
  const sections = blocks.slice(1, -1).map((block) => {
    const content = block.filter((line) => line.trim().length > 0)
    return { heading: content[0], body: content.slice(1) }
  })

  if (!sections.some((section) => changeHeadings.includes(section.heading ?? "") && section.body.length > 0))
    throw new ReleaseNotesError(
      "no change section with content — at least one of Features, Bug Fixes, Architecture / Refactor, CI / Engineering, Dependencies / Tooling must have a non-empty body",
    )

  for (const section of sections) {
    if ((section.heading ?? "").startsWith("### ") && section.body.length === 0)
      throw new ReleaseNotesError(`empty section ${quote(section.heading)}`)
  }

  const testSection = sections.find((section) => section.heading === testSummaryHeading)
  if (testSection && !hasNonEmptyFence(testSection.body))
    throw new ReleaseNotesError("Test Summary must contain at least one fenced code block with non-empty content")

  for (const section of sections) {
    if (!section.heading?.startsWith("### "))
      throw new ReleaseNotesError('invalid "---" separator structure: every block between separators must start with a "### " heading')
  }
  const blockStarts = sections.filter((section) => section.heading?.startsWith("### ")).length
  if (blockStarts !== headings.length)
    throw new ReleaseNotesError(
      `invalid "---" separator structure: ${headings.length} section headings but only ${blockStarts} start their own block — exactly one "---" is required between the intro, between consecutive sections, and before the final changelog line`,
    )

  if (input.tag !== `${tagPrefix}${input.version}`)
    throw new ReleaseNotesError(`tag must be "${tagPrefix}${input.version}" for version ${input.version}, received "${input.tag}"`)
  if (input.previousTag.length === 0)
    throw new ReleaseNotesError("previousTag is empty — no stable graphagent-v* tag exists, so no changelog range can be rendered")
  const expected = expectedFinalLine(input)
  const finalLines = (blocks[blocks.length - 1] ?? []).filter((line) => line.trim().length > 0)
  if (finalLines.length !== 1 || finalLines[0] !== expected)
    throw new ReleaseNotesError(`final line must be ${quote(expected)}, alone after the last "---" separator`)

  if (rendered.includes("{") || rendered.includes("}")) {
    const residual = nonBlank.filter((line) => line.includes("{") || line.includes("}")).slice(0, 3)
    throw new ReleaseNotesError(`unresolved "{" or "}" placeholders remain: ${residual.map(quote).join(" ")}`)
  }

  for (const line of lines) {
    if (!asciiLinePattern.test(line) && !canonicalHeadings.includes(line))
      throw new ReleaseNotesError(`non-ASCII line outside the canonical emoji headings: ${quote(line)}`)
  }

  return rendered
}

function splitBlocks(lines: readonly string[]) {
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === "---") {
      blocks.push(current)
      current = []
    } else {
      current.push(line)
    }
  }
  blocks.push(current)
  return blocks
}

function hasNonEmptyFence(body: readonly string[]) {
  let open = false
  let content = false
  for (const line of body) {
    if (line.trim().startsWith("```")) {
      if (open && content) return true
      open = !open
      content = false
    } else if (open && line.trim().length > 0) {
      content = true
    }
  }
  return false
}

function quote(value: string | undefined) {
  return JSON.stringify(value ?? "(empty)")
}

function readArgs(argv: readonly string[]) {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (key === undefined || !key.startsWith("--")) throw new ReleaseNotesError(`unexpected argument "${key}" (expected --key value pairs)`)
    const value = argv[i + 1]
    if (value === undefined) throw new ReleaseNotesError(`missing value for ${key}`)
    args[key.slice(2)] = value
  }
  return args
}

function requireArg(args: Record<string, string>, name: string) {
  const value = args[name]
  if (value === undefined) throw new ReleaseNotesError(`--${name} is required`)
  return value
}

function resolveFile(args: Record<string, string>, version: string) {
  const fileName = `v${seriesFor(version)}.md`
  if (args.file !== undefined && args["notes-dir"] !== undefined)
    throw new ReleaseNotesError("pass either --file or --notes-dir, not both")
  if (args.file !== undefined) {
    if (basename(args.file) !== fileName)
      throw new ReleaseNotesError(`series mismatch: --file ${args.file} must be named ${fileName} for version ${version}`)
    return args.file
  }
  if (args["notes-dir"] !== undefined) return join(args["notes-dir"], fileName)
  throw new ReleaseNotesError(`--file or --notes-dir is required (expected series file ${seriesFileFor(version)})`)
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  const version = requireArg(args, "version")
  const channel = requireArg(args, "channel")
  if (channel !== "main" && channel !== "dev")
    throw new ReleaseNotesError(`--channel must be "main" or "dev", received "${channel}"`)
  const file = resolveFile(args, version)
  if (!(await Bun.file(file).exists()))
    throw new ReleaseNotesError(
      `missing series file ${file} — create ${seriesFileFor(version)} (relative to the repo root) for this release series`,
    )
  const input: ReleaseNotesInput = {
    version,
    channel,
    branch: requireArg(args, "branch"),
    tag: requireArg(args, "tag"),
    previousTag: requireArg(args, "previous-tag"),
    repo: requireArg(args, "repo"),
  }
  const rendered = validateAndRender(await Bun.file(file).text(), input)
  const out = requireArg(args, "out")
  await Bun.write(out, rendered)
  console.log(`Release notes rendered for ${input.tag} -> ${out}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
