// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Split a shell command line into words.
 *
 * Used only to find path-shaped tokens for fingerprint file references and to
 * inspect `rm` targets for the risk rules. It is deliberately not a shell
 * parser: quoting is honored, expansions and substitutions are not.
 */
export function shellTokens(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  const flush = () => {
    if (!current) return
    tokens.push(current)
    current = ""
  }

  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char) || ";|&<>()`".includes(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}
