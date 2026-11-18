import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@graphagent/core/database/database"
import { SessionTable } from "@graphagent/core/session/sql"
import { rootUsage } from "@graphagent/core/session/usage"
import { costLabel, formatCost, unpriced } from "@graphagent/core/util/cost"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"
import { t } from "@graphagent/tui/i18n"
import { outcomeLimit, printOutcomes } from "./stats-outcomes"

/** One root session with the usage of its whole tree (`--roots`). */
export interface RootUsageRow {
  title: string
  sessions: number
  tokens: number
  cost: number
  costUnknown: boolean
}

export interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  /** A session recorded tokens at zero cost, so the total leaves its price out. */
  costUnknown: boolean
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  /** Only with `--roots`: the most recently updated root sessions, each with its tree's usage. */
  roots?: RootUsageRow[]
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const StatsCommand = effectCmd({
  command: "stats",
  describe: t("cli.stats.describe"),
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: t("cli.stats.option.days"),
        type: "number",
      })
      .option("tools", {
        describe: t("cli.stats.option.tools"),
        type: "number",
      })
      .option("models", {
        describe: t("cli.stats.option.models"),
      })
      .option("outcomes", {
        describe: t("cli.stats.option.outcomes"),
      })
      .option("project", {
        describe: t("cli.stats.option.project"),
        type: "string",
      })
      .option("roots", {
        describe: t("cli.stats.option.roots"),
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const stats = yield* aggregateSessionStats(args.days, args.project, ctx.project, rootLimitOf(args.roots))
    let modelLimit: number | undefined
    if (args.models === true) {
      modelLimit = Infinity
    } else if (typeof args.models === "number") {
      modelLimit = args.models
    }
    displayStats(stats, args.tools, modelLimit)
    const outcomes = outcomeLimit(args.outcomes)
    if (outcomes !== undefined) {
      yield* printOutcomes(outcomes, { days: args.days, project: args.project, currentProject: ctx.project })
    }
  }),
})

const getAllSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  // The statistics read costs, tokens, times and the project, which a row alone holds, so the binding's owner kind
  // is not joined: a child here is `task_child` whatever owns it, and no `Info` leaves this command.
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => Session.fromRow(row, undefined))
})

const DEFAULT_ROOTS = 10

/** `--roots` alone shows the default count, `--roots N` shows N; absent, or not a positive count, shows none. */
export function rootLimitOf(value: unknown): number | undefined {
  if (value === true) return DEFAULT_ROOTS
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value)
  return undefined
}

/** The `limit` most recently updated sessions that have no parent. */
export function latestRoots<T extends { parentID?: string; time: { updated: number } }>(
  sessions: readonly T[],
  limit: number,
): T[] {
  return sessions
    .filter((session) => !session.parentID)
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, limit)
}

/** Each root with the usage of its whole tree: task children, their descendants and DAG node sessions. */
const rootUsageRows = Effect.fnUntraced(function* (sessions: readonly Session.Info[], limit: number) {
  const { db } = yield* Database.Service
  return yield* Effect.forEach(latestRoots(sessions, limit), (session) =>
    rootUsage(db, session.id).pipe(
      Effect.map((usage): RootUsageRow => ({
        title: session.title,
        sessions: usage.sessions,
        tokens:
          usage.tokens.input +
          usage.tokens.output +
          usage.tokens.reasoning +
          usage.tokens.cache.read +
          usage.tokens.cache.write,
        cost: usage.cost,
        costUnknown: usage.costUnknown,
      })),
    ),
  )
})

export const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
  rootLimit?: number,
) {
  const svc = yield* Session.Service
  const sessions = yield* getAllSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  let filteredSessions = cutoffTime > 0 ? sessions.filter((session) => session.time.updated >= cutoffTime) : sessions

  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
      filteredSessions = filteredSessions.filter((session) => session.projectID === currentProject.id)
    } else {
      filteredSessions = filteredSessions.filter((session) => session.projectID === projectFilter)
    }
  }

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    costUnknown: false,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(t("cli.stats.largeDataset", { count: filteredSessions.length }))
  }

  if (rootLimit !== undefined) stats.roots = yield* rootUsageRows(filteredSessions, rootLimit)

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []

  const results = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        const messages = yield* svc
          .messages({ sessionID: session.id })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))

        const sessionCost = session.cost ?? 0
        const sessionTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let sessionToolUsage: Record<string, number> = {}
        let sessionModelUsage: Record<
          string,
          {
            messages: number
            tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
            cost: number
          }
        > = {}

        for (const message of messages) {
          if (message.info.role === "assistant") {
            const modelKey = `${message.info.providerID}/${message.info.modelID}`
            if (!sessionModelUsage[modelKey]) {
              sessionModelUsage[modelKey] = {
                messages: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              }
            }
            sessionModelUsage[modelKey].messages++
            sessionModelUsage[modelKey].cost += message.info.cost || 0

            if (message.info.tokens) {
              sessionModelUsage[modelKey].tokens.input += message.info.tokens.input || 0
              sessionModelUsage[modelKey].tokens.output += message.info.tokens.output || 0
              sessionModelUsage[modelKey].tokens.reasoning += message.info.tokens.reasoning || 0
              sessionModelUsage[modelKey].tokens.cache.read += message.info.tokens.cache?.read || 0
              sessionModelUsage[modelKey].tokens.cache.write += message.info.tokens.cache?.write || 0
            }
          }

          for (const part of message.parts) {
            if (part.type === "tool" && part.tool) {
              sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
            }
          }
        }

        return {
          messageCount: messages.length,
          sessionCost,
          sessionTokens,
          sessionTotalTokens:
            sessionTokens.input +
            sessionTokens.output +
            sessionTokens.reasoning +
            sessionTokens.cache.read +
            sessionTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
          latestTime: session.time.updated,
        }
      }),
    { concurrency: 20 },
  )

  for (const result of results) {
    earliestTime = Math.min(earliestTime, result.earliestTime)
    latestTime = Math.max(latestTime, result.latestTime)
    sessionTotalTokens.push(result.sessionTotalTokens)

    stats.totalMessages += result.messageCount
    stats.totalCost += result.sessionCost
    if (unpriced(result.sessionCost, result.sessionTotalTokens)) stats.costUnknown = true
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.reasoning += usage.tokens.reasoning
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

export function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56

  // Labels are translated, so measure by display width (CJK is two columns).
  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - Bun.stringWidth(label) - Bun.stringWidth(value)
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // The English titles were centred by hand, one column left of the true centre
  // (MODEL USAGE excepted). `lean` keeps that output byte-identical.
  function renderTitle(title: string, lean = 1): string {
    const free = Math.max(0, width - Bun.stringWidth(title))
    const left = Math.max(0, Math.floor(free / 2) - lean)
    return `│${" ".repeat(left)}${title}${" ".repeat(free - left)}│`
  }

  // Overview section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log(renderTitle(t("cli.stats.title.overview")))
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow(t("cli.stats.row.sessions"), stats.totalSessions.toLocaleString()))
  console.log(renderRow(t("cli.stats.row.messages"), stats.totalMessages.toLocaleString()))
  console.log(renderRow(t("cli.stats.row.days"), stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log(renderTitle(t("cli.stats.title.costTokens")))
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  console.log(renderRow(t("cli.stats.row.totalCost"), costLabel(cost, stats.costUnknown, t("cli.stats.unknown"))))
  console.log(renderRow(t("cli.stats.row.avgCostPerDay"), formatCost(costPerDay)))
  console.log(renderRow(t("cli.stats.row.avgTokensPerSession"), formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(renderRow(t("cli.stats.row.medianTokensPerSession"), formatNumber(Math.round(medianTokensPerSession))))
  console.log(renderRow(t("cli.stats.row.input"), formatNumber(stats.totalTokens.input)))
  console.log(renderRow(t("cli.stats.row.output"), formatNumber(stats.totalTokens.output)))
  console.log(renderRow(t("cli.stats.row.reasoning"), formatNumber(stats.totalTokens.reasoning)))
  console.log(renderRow(t("cli.stats.row.cacheRead"), formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow(t("cli.stats.row.cacheWrite"), formatNumber(stats.totalTokens.cache.write)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Root Sessions section (--roots)
  if (stats.roots && stats.roots.length > 0) {
    console.log("┌────────────────────────────────────────────────────────┐")
    console.log(renderTitle(t("cli.stats.title.roots"), 0))
    console.log("├────────────────────────────────────────────────────────┤")
    for (const root of stats.roots) console.log(renderRootRow(root, width))
    console.log("└────────────────────────────────────────────────────────┘")
    console.log()
  }

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log(renderTitle(t("cli.stats.title.modelUsage"), 0))
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
      console.log(`│ ${model.padEnd(54)} │`)
      console.log(renderRow("  " + t("cli.stats.row.messages"), usage.messages.toLocaleString()))
      console.log(renderRow("  " + t("cli.stats.row.inputTokens"), formatNumber(usage.tokens.input)))
      console.log(renderRow("  " + t("cli.stats.row.outputTokens"), formatNumber(usage.tokens.output)))
      console.log(renderRow("  " + t("cli.stats.row.reasoning"), formatNumber(usage.tokens.reasoning)))
      console.log(renderRow("  " + t("cli.stats.row.cacheRead"), formatNumber(usage.tokens.cache.read)))
      console.log(renderRow("  " + t("cli.stats.row.cacheWrite"), formatNumber(usage.tokens.cache.write)))
      console.log(renderRow("  " + t("cli.stats.row.cost"), modelCostText(usage)))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log(renderTitle(t("cli.stats.title.toolUsage")))
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

/** A model's cost, or the word when it recorded tokens with no price. */
function modelCostText(usage: SessionStats["modelUsage"][string]): string {
  const { input, output, reasoning, cache } = usage.tokens
  return unpriced(usage.cost, input + output + reasoning + cache.read + cache.write)
    ? t("cli.stats.unknown")
    : formatCost(usage.cost)
}

const ROOT_TITLE_CELLS = 24
const ROOT_SESSIONS_CELLS = 4
const ROOT_TOKENS_CELLS = 7
const ROOT_COST_CELLS = 11

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** `text` cut to at most `cells` display columns, a trailing `…` marking the cut. */
function cutCells(text: string, cells: number): string {
  if (cells <= 0) return ""
  if (Bun.stringWidth(text) <= cells) return text
  let result = ""
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const next = Bun.stringWidth(segment)
    if (used + next + 1 > cells) break
    result += segment
    used += next
  }
  return `${result}…`
}

const padEndCells = (text: string, cells: number) => text + " ".repeat(Math.max(0, cells - Bun.stringWidth(text)))
const padStartCells = (text: string, cells: number) => " ".repeat(Math.max(0, cells - Bun.stringWidth(text))) + text

/**
 * One `--roots` line in a box `width` columns wide inside its borders: the session title (24 columns, cut by
 * display width), the number of sessions in the tree (4), its tokens (7) and its cost (11), one space apart. A
 * column grows when its text does not fit (`$12.34 + unknown`), at the title's expense, so a row never outgrows
 * the box.
 */
function renderRootRow(row: RootUsageRow, width: number): string {
  const sessions = String(row.sessions)
  const tokens = formatNumber(row.tokens)
  const cost = costLabel(row.cost, row.costUnknown, t("cli.stats.unknown"))
  const sessionsCells = Math.max(ROOT_SESSIONS_CELLS, Bun.stringWidth(sessions))
  const tokensCells = Math.max(ROOT_TOKENS_CELLS, Bun.stringWidth(tokens))
  const costCells = Math.max(ROOT_COST_CELLS, Bun.stringWidth(cost))
  // A space against each border, one between the four columns.
  const room = width - 2 - 3 - sessionsCells - tokensCells - costCells
  const titleCells = Math.max(0, Math.min(ROOT_TITLE_CELLS, room))
  const title = padEndCells(cutCells(row.title.replace(/\s+/g, " ").trim(), titleCells), titleCells)
  const columns = [
    title,
    padStartCells(sessions, sessionsCells),
    padStartCells(tokens, tokensCells),
    padStartCells(cost, costCells),
  ]
  return `│ ${padEndCells(columns.join(" "), width - 2)} │`
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
