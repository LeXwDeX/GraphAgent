/**
 * S09 task fixture v3.
 *
 * This is a new qualification candidate. The historical v2 task spec remains
 * byte-for-byte unchanged. Tool groups describe the provider responses that a
 * zero-model host qualification test must drive; tools in one group are issued
 * together, and the next group is not issued until their results are visible.
 */

export const V3_SEED = 20260918
export const V3_WINDOW = { contextLimit: 81_920, outputReserve: 4_096, targetTokens: 54_476 } as const
export const V3_MAX_PROVIDER_REQUESTS = 12

const WORDS =
  "the system keeps a record of every request and each tool result so the model can look back at what happened earlier in the same session when files stay unchanged reading them again returns exactly the same text and the planner can fold the older copy while keeping the newest witness intact for verification tasks answers must rely on the latest state of the workspace files".split(
    " ",
  )

export const mulberry32V3 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}

export function makeBodyV3(random: () => number, bytes: number, inject?: string) {
  const lines: string[] = []
  let length = 0
  while (length < bytes) {
    const words: string[] = []
    for (let index = 0; index < 12; index++) words.push(WORDS[Math.floor(random() * WORDS.length)]!)
    const line = words.join(" ")
    lines.push(line)
    length += line.length + 1
  }
  const body = lines.join("\n").slice(0, Math.max(1, bytes))
  if (inject === undefined) return body
  const at = Math.floor(body.length / 2)
  return `${body.slice(0, at)} ${inject} ${body.slice(at + 1)}`
}

export type V3TaskID = "t1-read-then-edit" | "t2-repeated-search" | "t3-aba" | "t4-return-earlier"
export type V3File = Readonly<{ path: string; bytes: number; inject?: string; copyOf?: string }>
export type V3ToolOperation =
  | Readonly<{ kind: "read"; path: string; role?: "source" | "witness" }>
  | Readonly<{ kind: "edit"; path: string; oldString: string; newString: string }>
  | Readonly<{ kind: "grep"; path: string; pattern: string }>
  | Readonly<{ kind: "bash"; command: string }>
export type V3ToolGroup = readonly V3ToolOperation[]
export type V3Prompt = Readonly<{ text: string; groups: readonly V3ToolGroup[]; answer: string }>
export type V3Task = Readonly<{
  order: number
  files: readonly V3File[]
  prompts: readonly V3Prompt[]
  allowedChanges: readonly string[]
  expectedProviderRequests: number
  sourcePath: string
  witnessPath: string
}>

const grouped =
  "Issue every call in a bracketed group together in one assistant tool-call response. Wait for all results before the next group. Do not merge or split groups."

export const V3_TASKS: Readonly<Record<V3TaskID, V3Task>> = {
  "t1-read-then-edit": {
    order: 0,
    files: [
      { path: "config/settings.ini", bytes: 6_000, inject: "retries = 3" },
      { path: "notes/bigfact.txt", bytes: 44_000 },
      { path: "filler/f01.txt", bytes: 13_000 },
      { path: "filler/f02.txt", bytes: 13_000 },
    ],
    prompts: [
      {
        text: `${grouped} In this order: [read config/settings.ini], [read notes/bigfact.txt], [read filler/f01.txt], [read filler/f02.txt]. Read each file fully using one read call per file. Then report the current retries value in one line.`,
        groups: [
          [{ kind: "read", path: "config/settings.ini" }],
          [{ kind: "read", path: "notes/bigfact.txt", role: "source" }],
          [{ kind: "read", path: "filler/f01.txt" }],
          [{ kind: "read", path: "filler/f02.txt" }],
        ],
        answer: "retries = 3",
      },
      {
        text: `${grouped} In this order: [edit config/settings.ini from retries = 3 to retries = 7 exactly], [re-read config/settings.ini, notes/bigfact.txt, filler/f01.txt and filler/f02.txt together]. Use one read call per file and change nothing else. Then answer exactly one line in this form: retries=7; <last word of filler/f02.txt>.`,
        groups: [
          [{ kind: "edit", path: "config/settings.ini", oldString: "retries = 3", newString: "retries = 7" }],
          [
            { kind: "read", path: "config/settings.ini" },
            { kind: "read", path: "notes/bigfact.txt", role: "witness" },
            { kind: "read", path: "filler/f01.txt" },
            { kind: "read", path: "filler/f02.txt" },
          ],
        ],
        answer: "retries=7; <last word of filler/f02.txt>",
      },
    ],
    allowedChanges: ["config/settings.ini"],
    expectedProviderRequests: 8,
    sourcePath: "notes/bigfact.txt",
    witnessPath: "notes/bigfact.txt",
  },
  "t2-repeated-search": {
    order: 1,
    files: [
      { path: "src/m01.md", bytes: 44_000, inject: "NEEDLE-7 marker" },
      { path: "src/m02.md", bytes: 6_000, inject: "NEEDLE-3 here" },
      { path: "src/m03.md", bytes: 6_000 },
      { path: "src/m04.md", bytes: 6_000, inject: "NEEDLE-7 marker" },
      { path: "src/m05.md", bytes: 6_000 },
      { path: "src/m06.md", bytes: 6_000 },
      { path: "data/d1.txt", bytes: 6_000 },
    ],
    prompts: [
      {
        text: `${grouped} In this order: [read src/m01.md], [read src/m02.md through src/m06.md and data/d1.txt together], [grep NEEDLE-7 under src/]. Read every file fully using one read call per file. Then report every matching file and line.`,
        groups: [
          [{ kind: "read", path: "src/m01.md", role: "source" }],
          ["src/m02.md", "src/m03.md", "src/m04.md", "src/m05.md", "src/m06.md", "data/d1.txt"].map((path) => ({
            kind: "read" as const,
            path,
          })),
          [{ kind: "grep", path: "src", pattern: "NEEDLE-7" }],
        ],
        answer: "NEEDLE-7 appears in src/m01.md and src/m04.md",
      },
      {
        text: `${grouped} In this order: [grep NEEDLE-7 under src/], [re-read src/m01.md through src/m06.md together]. Read every file fully using one read call per file. Then answer exactly one line using values you computed: NEEDLE-7 count=<integer>; NEEDLE-3 file=<relative-path>`,
        groups: [
          [{ kind: "grep", path: "src", pattern: "NEEDLE-7" }],
          [
            { kind: "read", path: "src/m01.md", role: "witness" },
            ...["src/m02.md", "src/m03.md", "src/m04.md", "src/m05.md", "src/m06.md"].map((path) => ({
              kind: "read" as const,
              path,
            })),
          ],
        ],
        answer: "NEEDLE-7 count=2; NEEDLE-3 file=src/m02.md",
      },
    ],
    allowedChanges: [],
    expectedProviderRequests: 7,
    sourcePath: "src/m01.md",
    witnessPath: "src/m01.md",
  },
  "t3-aba": {
    order: 2,
    files: [
      { path: "app/version.txt", bytes: 44_000, inject: "release = alpha" },
      { path: "backup/version.orig.txt", bytes: 0, copyOf: "app/version.txt" },
      { path: "filler/t01.txt", bytes: 4_000 },
      { path: "filler/t02.txt", bytes: 4_000 },
    ],
    prompts: [
      {
        text: `${grouped} [Read app/version.txt, filler/t01.txt and filler/t02.txt together] fully, with one read call per file.`,
        groups: [
          [
            { kind: "read", path: "app/version.txt", role: "source" },
            { kind: "read", path: "filler/t01.txt" },
            { kind: "read", path: "filler/t02.txt" },
          ],
        ],
        answer: "alpha snapshot read",
      },
      {
        text: `${grouped} In this order: [edit app/version.txt from release = alpha to release = beta exactly], [read app/version.txt, filler/t01.txt and filler/t02.txt together]. Use one read call per file and change nothing else.`,
        groups: [
          [{ kind: "edit", path: "app/version.txt", oldString: "release = alpha", newString: "release = beta" }],
          ["app/version.txt", "filler/t01.txt", "filler/t02.txt"].map((path) => ({ kind: "read" as const, path })),
        ],
        answer: "beta snapshot read",
      },
      {
        text: `${grouped} In this order: [restore backup/version.orig.txt over app/version.txt by running exactly the single shell command cp backup/version.orig.txt app/version.txt, with no appended shell subcommand], [read app/version.txt and filler/t01.txt together]. Use one read call per file, then state release = alpha in one line.`,
        groups: [
          [{ kind: "bash", command: "cp backup/version.orig.txt app/version.txt" }],
          [
            { kind: "read", path: "app/version.txt", role: "witness" },
            { kind: "read", path: "filler/t01.txt" },
          ],
        ],
        answer: "release = alpha",
      },
    ],
    allowedChanges: ["app/version.txt"],
    expectedProviderRequests: 8,
    sourcePath: "app/version.txt",
    witnessPath: "app/version.txt",
  },
  "t4-return-earlier": {
    order: 3,
    files: [
      { path: "p1/a.txt", bytes: 47_000, inject: "GATE-CODE-5521" },
      { path: "p1/b.txt", bytes: 10_000 },
      { path: "p1/c.txt", bytes: 6_000 },
      { path: "p1/d.txt", bytes: 6_000 },
      { path: "p2/x.txt", bytes: 10_000 },
      { path: "p2/y.txt", bytes: 10_000 },
    ],
    prompts: [
      {
        text: `${grouped} In this order: [read p1/a.txt], [read p1/b.txt, p1/c.txt, p1/d.txt, p2/x.txt and p2/y.txt together]. Read each file fully using one read call per file, then report GATE-CODE-5521 and the total p2 line count.`,
        groups: [
          [{ kind: "read", path: "p1/a.txt", role: "source" }],
          ["p1/b.txt", "p1/c.txt", "p1/d.txt", "p2/x.txt", "p2/y.txt"].map((path) => ({
            kind: "read" as const,
            path,
          })),
        ],
        answer: "GATE-CODE-5521; p2 line count recorded",
      },
      {
        text: `${grouped} In this order: [re-read p1/a.txt], [re-read p1/b.txt, p2/x.txt and p2/y.txt together]. Read each file fully using one read call per file, then report GATE-CODE-5521 and the same p2 line count.`,
        groups: [
          [{ kind: "read", path: "p1/a.txt", role: "witness" }],
          ["p1/b.txt", "p2/x.txt", "p2/y.txt"].map((path) => ({ kind: "read" as const, path })),
        ],
        answer: "GATE-CODE-5521; p2 line count unchanged",
      },
    ],
    allowedChanges: [],
    expectedProviderRequests: 6,
    sourcePath: "p1/a.txt",
    witnessPath: "p1/a.txt",
  },
}

export const V3_TASK_IDS: readonly V3TaskID[] = [
  "t1-read-then-edit",
  "t2-repeated-search",
  "t3-aba",
  "t4-return-earlier",
]

export function materializeBodiesV3(task: V3TaskID) {
  const spec = V3_TASKS[task]
  const random = mulberry32V3(V3_SEED + spec.order * 7_919 + 17)
  const bodies = new Map<string, string>()
  for (const file of spec.files) {
    const copied = file.copyOf === undefined ? undefined : bodies.get(file.copyOf)
    if (file.copyOf !== undefined && copied === undefined)
      throw new Error(`copy source not materialized: ${file.copyOf}`)
    bodies.set(file.path, copied ?? makeBodyV3(random, file.bytes, file.inject))
  }
  return bodies
}
