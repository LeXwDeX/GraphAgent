// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RuntimeAsset {
  export const sources = ["system", "packaged", "cache", "mirror", "public"] as const

  export type Source = (typeof sources)[number]
  export type Platform = {
    readonly os: NodeJS.Platform
    readonly arch: string
  }
  export type Target = Platform & {
    readonly executable: string
    readonly artifact?: string
    readonly entry?: string
    readonly sha256?: string
    readonly executableSha256?: string
    readonly archive?: "raw" | "tar.gz" | "zip"
    readonly mirror?: string
    readonly public?: string
  }
  export type Descriptor = {
    readonly id: string
    readonly version: string
    readonly required: boolean
    readonly targets: readonly Target[]
  }
  export type Policy = {
    readonly sources?: readonly Source[]
  }
  export type Attempt = {
    readonly source: Source
    readonly reason: string
  }
  export type Available = {
    readonly _tag: "Available"
    readonly id: string
    readonly version: string
    readonly path: string
    readonly source: Source
    readonly platform: Platform
    readonly sha256?: string
  }
  export type Unavailable = {
    readonly _tag: "Unavailable"
    readonly id: string
    readonly version: string
    readonly required: false
    readonly platform: Platform
    readonly reason: "unsupported-platform" | "sources-exhausted"
    readonly attempts: readonly Attempt[]
  }
  export type Resolution = Available | Unavailable
  export type CandidateRequest = {
    readonly descriptor: Descriptor
    readonly target: Target
    readonly source: Source
  }
  export type CandidateResult = {
    readonly path: string
  }
  export type Candidate = (request: CandidateRequest) => Effect.Effect<CandidateResult, CandidateUnavailable>
  export type Candidates = Record<Source, Candidate>
  export type Fetch = (url: string, init: RequestInit) => Promise<Response>
  export type ManagedInput = {
    readonly platform: Platform
    readonly cacheDirectory: string
    readonly packagedDirectory?: string
    readonly mirrorBaseURL?: string
    readonly timeoutMs?: number
    readonly fetch?: Fetch
  }
  export type Interface = {
    readonly resolve: (descriptor: Descriptor, policy?: Policy) => Effect.Effect<Resolution, RequiredAssetUnavailable>
  }

  export class CandidateUnavailable extends Error {
    readonly _tag = "CandidateUnavailable"
    readonly reason: string

    constructor(input: { readonly reason: string }) {
      super(input.reason)
      this.reason = input.reason
    }
  }

  export class RequiredAssetUnavailable extends Error {
    readonly _tag = "RequiredAssetUnavailable"
    readonly id: string
    readonly version: string
    readonly platform: Platform
    readonly reason: "unsupported-platform" | "sources-exhausted"
    readonly attempts: readonly Attempt[]

    constructor(input: {
      readonly id: string
      readonly version: string
      readonly platform: Platform
      readonly reason: "unsupported-platform" | "sources-exhausted"
      readonly attempts: readonly Attempt[]
    }) {
      super(`Required runtime asset is unavailable: ${input.id}@${input.version} (${input.reason})`)
      this.id = input.id
      this.version = input.version
      this.platform = input.platform
      this.reason = input.reason
      this.attempts = input.attempts
    }
  }

  export class Service extends Context.Service<Service, Interface>()("@graphagent/RuntimeAsset") {}

  export function make(input: { readonly platform: Platform; readonly candidates: Candidates }): Interface {
    const finish = (
      descriptor: Descriptor,
      reason: "unsupported-platform" | "sources-exhausted",
      attempts: readonly Attempt[],
    ): Effect.Effect<Resolution, RequiredAssetUnavailable> => {
      if (descriptor.required) {
        return Effect.fail(
          new RequiredAssetUnavailable({
            id: descriptor.id,
            version: descriptor.version,
            platform: input.platform,
            reason,
            attempts,
          }),
        )
      }
      return Effect.succeed({
        _tag: "Unavailable",
        id: descriptor.id,
        version: descriptor.version,
        required: false,
        platform: input.platform,
        reason,
        attempts,
      })
    }

    const resolve = (descriptor: Descriptor, policy?: Policy) => {
      const target = descriptor.targets.find(
        (candidate) => candidate.os === input.platform.os && candidate.arch === input.platform.arch,
      )
      if (!target) return finish(descriptor, "unsupported-platform", [])

      const attempt = (
        pending: readonly Source[],
        attempts: readonly Attempt[],
      ): Effect.Effect<Resolution, RequiredAssetUnavailable> => {
        const source = pending[0]
        if (!source) return finish(descriptor, "sources-exhausted", attempts)
        return input.candidates[source]({ descriptor, target, source }).pipe(
          Effect.map(
            (result): Available => ({
              _tag: "Available",
              id: descriptor.id,
              version: descriptor.version,
              path: result.path,
              source,
              platform: input.platform,
              ...(target.sha256 ? { sha256: target.sha256 } : {}),
            }),
          ),
          Effect.catchTag("CandidateUnavailable", (error) =>
            Effect.suspend(() => attempt(pending.slice(1), [...attempts, { source, reason: redact(error.reason) }])),
          ),
        )
      }

      return attempt(policy?.sources ?? sources, [])
    }

    return { resolve }
  }

  export function managed(input: ManagedInput) {
    return make({ platform: input.platform, candidates: managedCandidates(input) })
  }

  export const layer = (input: { readonly platform: Platform; readonly candidates: Candidates }) =>
    Layer.succeed(Service, Service.of(make(input)))

  export const defaultLayer = Layer.succeed(
    Service,
    Service.of(
      managed({
        platform: { os: process.platform, arch: process.arch },
        cacheDirectory: process.env.GRAPHAGENT_RUNTIME_ASSET_CACHE ?? path.join(Global.Path.bin, "runtime-assets"),
        packagedDirectory: process.env.GRAPHAGENT_RUNTIME_ASSETS_DIR,
        mirrorBaseURL: process.env.GRAPHAGENT_RUNTIME_ASSET_MIRROR,
      }),
    ),
  )

  export const node = LayerNode.make(defaultLayer, [])

  function redact(reason: string) {
    return reason.replace(/https?:\/\/[^\s)\]}]+/g, (value) => {
      if (!URL.canParse(value)) return value
      const url = new URL(value)
      url.username = ""
      url.password = ""
      Array.from(url.searchParams.keys())
        .filter((key) =>
          /^(?:api[_-]?key|access[_-]?token|authorization|password|secret|sig(?:nature)?|token)$/i.test(key),
        )
        .forEach((key) => url.searchParams.set(key, "REDACTED"))
      return url.toString()
    })
  }
}

function managedCandidates(input: RuntimeAsset.ManagedInput): RuntimeAsset.Candidates {
  const inFlight = new Map<string, Promise<RuntimeAsset.CandidateResult>>()
  const local =
    (root: string | undefined, source: "packaged" | "cache"): RuntimeAsset.Candidate =>
    (request) =>
      Effect.tryPromise({
        try: () => {
          if (!root) throw new Error(`${source} runtime asset directory is not configured`)
          return source === "cache" ? verifiedCache(root, request) : verifiedPackaged(root, request)
        },
        catch: unavailable,
      })
  const network =
    (source: "mirror" | "public"): RuntimeAsset.Candidate =>
    (request) =>
      Effect.tryPromise({
        try: () => {
          const key = assetDirectory(input.cacheDirectory, request)
          const active = inFlight.get(key)
          if (active) return active
          const pending = download(input, request, sourceURL(input, request, source)).finally(() =>
            inFlight.delete(key),
          )
          inFlight.set(key, pending)
          return pending
        },
        catch: unavailable,
      })

  return {
    system: (request) =>
      Effect.tryPromise({
        try: async () => {
          const found = which(request.target.executable)
          if (!found || !(await Bun.file(found).exists())) {
            throw new Error(`system executable is unavailable: ${request.target.executable}`)
          }
          return { path: found }
        },
        catch: unavailable,
      }),
    packaged: local(input.packagedDirectory, "packaged"),
    cache: local(input.cacheDirectory, "cache"),
    mirror: network("mirror"),
    public: network("public"),
  }
}

async function verifiedPackaged(root: string, request: RuntimeAsset.CandidateRequest) {
  const executable = assetPath(root, request)
  if (!(await Bun.file(executable).exists())) throw new Error(`packaged executable is unavailable: ${executable}`)
  if (request.target.executableSha256 && (await digestFile(executable)) !== request.target.executableSha256) {
    throw new Error(`packaged executable digest mismatch: ${executable}`)
  }
  return { path: executable }
}

async function verifiedCache(root: string, request: RuntimeAsset.CandidateRequest) {
  const executable = assetPath(root, request)
  const metadataFile = path.join(path.dirname(executable), "metadata.json")
  if (!(await Bun.file(executable).exists()) || !(await Bun.file(metadataFile).exists())) {
    throw new Error(`verified cache entry is unavailable: ${executable}`)
  }
  const value: unknown = await Bun.file(metadataFile).json()
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error(`cache metadata is invalid: ${metadataFile}`)
  if (request.target.sha256 && value.archiveSha256 !== request.target.sha256) {
    throw new Error(`cache archive digest mismatch: ${executable}`)
  }
  if (typeof value.executableSha256 !== "string" || (await digestFile(executable)) !== value.executableSha256) {
    throw new Error(`cache executable digest mismatch: ${executable}`)
  }
  return { path: executable }
}

async function download(
  input: RuntimeAsset.ManagedInput,
  request: RuntimeAsset.CandidateRequest,
  url: string,
): Promise<RuntimeAsset.CandidateResult> {
  if (!request.target.sha256 || !/^[a-f0-9]{64}$/i.test(request.target.sha256)) {
    throw new Error(`network runtime asset requires a SHA-256 digest: ${request.descriptor.id}`)
  }
  const archiveSha256 = request.target.sha256.toLowerCase()
  await mkdir(input.cacheDirectory, { recursive: true })
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
  })
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength) throw new Error(`download returned an empty asset: ${url}`)
  if (digestBytes(bytes) !== archiveSha256) {
    throw new Error(`download digest mismatch: ${url}`)
  }

  const destination = assetDirectory(input.cacheDirectory, request)
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}-`))
  return (async () => {
    const executable = path.join(temporary, executableName(request.target.executable))
    await materialize(bytes, request.target, temporary, executable)
    if (process.platform !== "win32") await chmod(executable, 0o755)
    const executableSha256 = await digestFile(executable)
    if (request.target.executableSha256 && request.target.executableSha256 !== executableSha256) {
      throw new Error(`downloaded executable digest mismatch: ${url}`)
    }
    await Bun.write(
      path.join(temporary, "metadata.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: request.descriptor.id,
          version: request.descriptor.version,
          platform: request.target.os,
          arch: request.target.arch,
          archiveSha256,
          executableSha256,
        },
        null,
        2,
      ) + "\n",
    )
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
    return { path: path.join(destination, executableName(request.target.executable)) }
  })().finally(() => rm(temporary, { recursive: true, force: true }))
}

async function materialize(bytes: Uint8Array, target: RuntimeAsset.Target, temporary: string, executable: string) {
  if ((target.archive ?? "raw") === "raw") {
    await Bun.write(executable, bytes)
    return
  }
  if (!target.entry) throw new Error(`archive entry is required for ${target.artifact ?? target.executable}`)
  const entry = safeRelative(target.entry, "archive entry")
  const archive = path.join(temporary, artifactName(target))
  const extracted = path.join(temporary, "extracted")
  await mkdir(extracted, { recursive: true })
  await Bun.write(archive, bytes)
  await command(
    process.platform === "win32" && process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "tar.exe")
      : "tar",
    [target.archive === "tar.gz" ? "-xzf" : "-xf", archive, "-C", extracted],
  )
  const source = path.resolve(extracted, entry)
  if (source !== extracted && !source.startsWith(`${extracted}${path.sep}`))
    throw new Error(`archive entry escapes root: ${entry}`)
  if (!(await Bun.file(source).exists())) throw new Error(`archive entry is missing: ${entry}`)
  await copyFile(source, executable)
}

function sourceURL(
  input: RuntimeAsset.ManagedInput,
  request: RuntimeAsset.CandidateRequest,
  source: "mirror" | "public",
) {
  const direct = request.target[source]
  if (direct) return direct
  if (source === "public" || !input.mirrorBaseURL) throw new Error(`${source} URL is not configured`)
  if (!URL.canParse(input.mirrorBaseURL)) throw new Error(`runtime asset mirror URL is invalid: ${input.mirrorBaseURL}`)
  const url = new URL(input.mirrorBaseURL)
  url.pathname = [
    url.pathname.replace(/\/$/, ""),
    request.descriptor.id,
    request.descriptor.version,
    `${request.target.os}-${request.target.arch}`,
    artifactName(request.target),
  ]
    .map((segment) => segment.split("/").map(encodeURIComponent).join("/"))
    .join("/")
  return url.toString()
}

function assetPath(root: string, request: RuntimeAsset.CandidateRequest) {
  return path.join(assetDirectory(root, request), executableName(request.target.executable))
}

function assetDirectory(root: string, request: RuntimeAsset.CandidateRequest) {
  const id = safeSegment(request.descriptor.id, "asset id")
  const version = safeSegment(request.descriptor.version, "asset version")
  const platform = safeSegment(`${request.target.os}-${request.target.arch}`, "asset platform")
  const digest = request.target.sha256?.slice(0, 16).toLowerCase() ?? "unverified"
  return path.join(root, id, version, `${platform}-${digest}`)
}

function artifactName(target: RuntimeAsset.Target) {
  return safeSegment(target.artifact ?? target.executable, "artifact filename")
}

function executableName(executable: string) {
  return safeSegment(executable, "executable filename")
}

function safeSegment(value: string, name: string) {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) {
    throw new Error(`${name} must be one path segment: ${value}`)
  }
  return value
}

function safeRelative(value: string, name: string) {
  const normalized = path.normalize(value)
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${name} must stay inside the archive: ${value}`)
  }
  return normalized
}

async function command(executable: string, args: string[]) {
  const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
  }
}

function unavailable(error: unknown) {
  return new RuntimeAsset.CandidateUnavailable({ reason: error instanceof Error ? error.message : String(error) })
}

async function digestFile(file: string) {
  return digestBytes(new Uint8Array(await Bun.file(file).arrayBuffer()))
}

function digestBytes(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
