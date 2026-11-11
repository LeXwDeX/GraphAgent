// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { RGBA, SyntaxStyle } from "@opentui/core"
import { Show } from "solid-js"

/**
 * While a message streams, every appended chunk reparses the trailing markdown
 * block. Above this size the plain-text fallback is cheaper and stays readable;
 * the body upgrades to markdown once `time.end` arrives.
 */
export const STREAM_MARKDOWN_MAX = 4 * 1024

/** Completed bodies above this size stay plain text for good. */
export const FINAL_MARKDOWN_MAX = 64 * 1024

export type MarkdownMode = "markdown" | "plain"

/**
 * Chooses how a message body is rendered. Lengths are UTF-8 bytes because the
 * markdown parser's cost tracks the encoded size, not the character count.
 */
export function markdownMode(content: string, streaming: boolean): MarkdownMode {
  const bytes = Buffer.byteLength(content, "utf8")
  if (streaming) return bytes > STREAM_MARKDOWN_MAX ? "plain" : "markdown"
  return bytes > FINAL_MARKDOWN_MAX ? "plain" : "markdown"
}

export interface AdaptiveMarkdownProps {
  content: string
  streaming: boolean
  syntaxStyle: SyntaxStyle
  conceal: boolean
  fg: RGBA
  bg?: RGBA
  tableOptions?: { style?: "grid" | "columns" }
}

/**
 * Single entry point for message markdown. Streaming and oversized bodies fall
 * back to plain text so appending a chunk never reparses a huge block.
 */
export function AdaptiveMarkdown(props: AdaptiveMarkdownProps) {
  return (
    <Show
      when={markdownMode(props.content, props.streaming) === "markdown"}
      fallback={
        <text fg={props.fg} wrapMode="word">
          {props.content}
        </text>
      }
    >
      <markdown
        syntaxStyle={props.syntaxStyle}
        streaming={props.streaming}
        internalBlockMode="top-level"
        content={props.content}
        tableOptions={props.tableOptions}
        conceal={props.conceal}
        fg={props.fg}
        bg={props.bg}
      />
    </Show>
  )
}