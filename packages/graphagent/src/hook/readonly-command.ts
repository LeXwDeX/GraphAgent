import { existsSync } from "node:fs"

// This is an argument parser, never a shell. Expansion and command composition
// are deliberately unavailable, even inside quotes.
export const FORBIDDEN_META = /[\x00-\x1f\x7f|;&`$<>]/

function tokens(command: string): string[] {
  if (FORBIDDEN_META.test(command)) throw new Error("shell syntax and control characters are not allowed")
  const result: string[] = []
  let token = ""
  let quote = ""
  let started = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "\\" && quote !== "'") {
      if (++i === command.length) throw new Error("unfinished escape")
      token += command[i]
      started = true
    } else if (quote) {
      if (c === quote) quote = ""
      else token += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === " ") {
      if (started) result.push(token)
      token = ""
      started = false
    } else {
      token += c
      started = true
    }
  }
  if (quote) throw new Error("unfinished quote")
  if (started) result.push(token)
  if (!result.length) throw new Error("empty command")
  return result
}

// Only known read-only options are accepted. A command-name allowlist alone
// admits output files, interpreters, external diff drivers and find actions.
const flags: Record<string, RegExp> = {
  ls: /^(-[aAbBcCdDfFgGhHiIlLmMnNoOpPqQrRsStTuUvVwWxX1]+|--(all|almost-all|directory|human-readable|recursive))$/,
  cat: /^(-[benstuvET]+|--(number|number-nonblank|show-ends|show-tabs|squeeze-blank))$/,
  grep: /^(-[EFGivwxcLlnHhroqsaIR]+|--(line-number|ignore-case|files-with-matches|files-without-match|fixed-strings|extended-regexp))$/,
  wc: /^(-[clmwL]+|--(bytes|chars|lines|words|max-line-length))$/,
  head: /^(-[qv]+|-[0-9]+)$/,
  tail: /^(-[qvfF]+|-[0-9]+)$/,
  sort: /^(-[bdfghinMrsuV]+|--(numeric-sort|reverse|unique|ignore-case|stable|check))$/,
  uniq: /^(-[cdiu]+|--(count|repeated|unique|ignore-case))$/,
  echo: /^-[neE]+$/,
  pwd: /^-[LP]+$/,
  which: /^-a$/,
  file: /^(-[bhiL]+|--(brief|mime|mime-type|mime-encoding))$/,
  stat: /^(-[Lf]+|--(dereference|file-system|terse))$/,
  du: /^(-[achHkLmsx]+|--(summarize|human-readable|total))$/,
  test: /^(-[abcdefghkLmnoprSstuvwxzOGN]+|-eq|-ne|-gt|-ge|-lt|-le)$/,
}

function simple(name: string, args: string[]) {
  const pattern = flags[name]
  if (!pattern) throw new Error(`command "${name}" not in read-only whitelist`)
  let positional = 0
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (literal || !arg.startsWith("-") || arg === "-") {
      positional++
      continue
    }
    if (arg === "--") {
      literal = true
      continue
    }
    if ((name === "head" || name === "tail") && /^-(n|c)$/.test(arg)) {
      if (!/^[+-]?\d+$/.test(args[++i] ?? "")) throw new Error("line/byte count must be numeric")
      continue
    }
    if (!pattern.test(arg)) throw new Error(`option "${arg}" is not allowed for ${name}`)
  }
  // uniq's SECOND positional argument is an output file.
  if (name === "uniq" && positional > 1) throw new Error("uniq output files are not allowed")
}

function find(args: string[]) {
  const predicates = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth"])
  const operators = new Set(["-print", "-print0", "-empty", "-not", "!", "-a", "-and", "-o", "-or", "(", ")"])
  let expression = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (predicates.has(arg)) {
      expression = true
      if (args[++i] === undefined) throw new Error(`missing argument for ${arg}`)
    } else if (operators.has(arg)) {
      expression = true
    } else if (expression || arg.startsWith("-")) {
      throw new Error(`find action "${arg}" is not allowed`)
    }
  }
}

function git(args: string[]) {
  const sub = args[0]
  if (!["status", "log", "diff", "show"].includes(sub)) throw new Error("git subcommand is not read-only")
  const safe =
    /^(--(short|branch|porcelain(?:=v?[12])?|oneline|stat|numstat|shortstat|summary|name-only|name-status|check|cached|staged|no-color|no-renames|no-patch|patch|reverse|all|first-parent|no-merges|merges|follow|graph|abbrev-commit|date-order|topo-order|full-history|relative|binary)|-[sbpwu]|-U\d+|-\d+|--(max-count|skip|unified)=\d+|--(format|pretty|date|since|until|author|grep|untracked-files|ignore-submodules)=[^-].*)$/
  let literal = false
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (literal) continue
    if (arg === "--") {
      literal = true
      continue
    }
    if (arg === "-n") {
      if (!/^\d+$/.test(args[++i] ?? "")) throw new Error("git count must be numeric")
      continue
    }
    if (arg.startsWith("-") && !safe.test(arg)) throw new Error(`git option "${arg}" is not allowed`)
  }
  return [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    sub,
    ...(sub === "status" ? [] : ["--no-ext-diff", "--no-textconv"]),
    ...args.slice(1),
  ]
}

export function parseReadonlyCommand(command: string): { name: string; args: string[] } {
  const [name, ...args] = tokens(command)
  if (name === "git") return { name, args: git(args) }
  if (name === "find") find(args)
  else if (name === "sed") {
    // Arbitrary sed programs can write files or execute commands on GNU sed.
    if (args[0] !== "-n" || !/^\d+(,\d+)?p$/.test(args[1] ?? "") || args.slice(2).some((s) => s.startsWith("-")))
      throw new Error("sed only supports -n '<line>[,<line>]p' <files>")
  } else simple(name, args)
  return { name, args }
}

export function readonlyExecutable(name: string): string {
  if (process.platform === "win32")
    throw new Error("Use read_file, list_dir or grep on Windows; bash requires POSIX utilities")
  // Never resolve an executable from a project-controlled PATH entry.
  const executable = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync)
  if (!executable) throw new Error(`system utility ${name} is unavailable`)
  return executable
}

export function whitelistReject(command: string): string | null {
  try {
    parseReadonlyCommand(command)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
