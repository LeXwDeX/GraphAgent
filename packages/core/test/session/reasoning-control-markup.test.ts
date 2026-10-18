import { expect, test } from "bun:test"
import { detectToolCallEnvelope } from "../../src/session/reasoning-distillation/control-markup"

/**
 * False-positive boundary for provider control markup.
 *
 * A complete DSML tool-call envelope is three structurally nested opening tags: a calls wrapper, an invoke with a
 * name, and at least one named parameter. Closing tags are optional because long-context output drops them. Everything
 * else — a mention, a path, a command, a URL, a code span, an incomplete fragment, or a generic XML example without
 * DSML — is legitimate reasoning and must survive.
 */
const observed = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="bash">',
  '<｜｜DSML｜｜ parameter name="command" string="true">git status --short && git log --oneline -6</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="description" string="true">Check the worktree</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n")

const canonical = [
  "<｜DSML｜tool_calls>",
  '<｜DSML｜invoke name="bash">',
  '<｜DSML｜parameter name="command" string="true">git status --short</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜tool_calls>",
].join("\n")

const ascii = [
  "<||DSML||tool_calls>",
  '<||DSML||invoke name="read">',
  '<||DSML||parameter name="path" string="true">/tmp/a.md</||DSML||parameter>',
  "</||DSML||invoke>",
  "</||DSML||tool_calls>",
].join("\n")

const singleBar = [
  "<｜DSML｜ calls>",
  '<｜DSML｜ invoke name="bash">',
  '<｜DSML｜ parameter name="command" string="true">git branch --show-current</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>",
  "</｜DSML｜ calls>",
].join("\n")

const functionCalls = [
  "<｜DSML｜function_calls>",
  '<｜DSML｜invoke name="bash">',
  '<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜function_calls>",
].join("\n")

const positives: [string, string][] = [
  ["the observed doubled-bar rendering", observed],
  ["the canonical single-bar rendering", canonical],
  ["the ASCII-pipe proxy rendering", ascii],
  ["a lowercase proxy rendering", observed.replaceAll("DSML", "dsml")],
  ["the single-bar spaced rendering", singleBar],
  ["the function_calls wrapper", functionCalls],
  ["a truncated envelope without closing tags", observed.split("\n").slice(0, 3).join("\n")],
  ["an envelope inside a fenced code block", `\`\`\`\n${canonical}\n\`\`\``],
  ["an envelope embedded in prose", `I will inspect the worktree now.\n${observed}\nThen I will report.`],
]

for (const [name, text] of positives) {
  test(`rejects ${name}`, () => {
    expect(detectToolCallEnvelope(text)).toBe("tool-call-envelope")
  })
}

const negatives: [string, string][] = [
  ["a lone calls mention", "The provider uses <｜DSML｜tool_calls> as its wrapper."],
  ["a lone invoke mention", 'The next tag is <｜DSML｜invoke name="bash"> in the format.'],
  ["a lone parameter mention", 'A parameter tag looks like <｜DSML｜parameter name="command">.'],
  ["an orphan closing fragment", "The output ended with </｜DSML｜parameter> and nothing else."],
  ["calls plus invoke without a parameter", '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">'],
  [
    "tags listed in prose in the wrong structure",
    '标签依次是 <｜DSML｜tool_calls>、<｜DSML｜invoke name="x">、<｜DSML｜parameter name="y">。',
  ],
  ["prose between the calls and invoke tags", '<｜DSML｜tool_calls> 表示外层，然后才是 <｜DSML｜invoke name="bash">。'],
  ["a code constant holding one marker", 'const MARKER = "<｜DSML｜tool_calls>"'],
  [
    "a generic XML tool-call example without DSML",
    '<tool_calls>\n<invoke name="bash">\n<parameter name="command">pwd</parameter>\n</invoke>\n</tool_calls>',
  ],
  ["a path containing DSML", "Edit /tmp/dsml-parser.ts and packages/core/src/dsml.ts."],
  ["a command containing DSML", "Run `rg DSML packages/core` and then `git log --grep DSML`."],
  ["a URL containing DSML", "See https://example.com/DSML/docs for the format."],
  ["plain prose about DSML", "DSML 是 DeepSeek 的标记语言，这里只是在讨论它。"],
  ["an XML example mentioning DSML as text", "<note>DSML 格式见上</note>"],
  ["a fenced code snippet with one marker", "```ts\nconst wrapper = '<｜DSML｜tool_calls>'\nlet io = 0\n```"],
]

for (const [name, text] of negatives) {
  test(`allows ${name}`, () => {
    expect(detectToolCallEnvelope(text)).toBeUndefined()
  })
}
