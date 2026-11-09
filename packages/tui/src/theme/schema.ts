// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ThemeConfig from "./schema"

import { Schema } from "effect"

// Editor-facing JSON schema for theme files. Runtime loading is unchanged:
// `isTheme` accepts any object with a theme object, and `resolveTheme` resolves
// references. This schema documents the shape of the bundled and custom files
// generated into `schema/theme.json`.
const Color = Schema.Union([
  Schema.String.annotate({ description: "Hex color (#rrggbb / #rrggbbaa) or a defs reference name" }),
  Schema.Struct({
    dark: Schema.String.annotate({ description: "Color or reference used in dark mode" }),
    light: Schema.String.annotate({ description: "Color or reference used in light mode" }),
  }).annotate({ description: "Dark/light pair for the same role" }),
])

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for theme validation",
  }),
  defs: Schema.optional(Schema.Record(Schema.String, Color)).annotate({
    description: "Named colors that theme entries can reference",
  }),
  theme: Schema.Struct({
    primary: Color,
    secondary: Color,
    accent: Color,
    error: Color,
    warning: Color,
    success: Color,
    info: Color,
    text: Color,
    textMuted: Color,
    textDim: Schema.optional(Color).annotate({
      description: "Weakest text (hints, separators, queued); defaults to a 50% tint of textMuted over background",
    }),
    selectedListItemText: Schema.optional(Color).annotate({
      description: "Foreground for the selected list item; defaults to the background color",
    }),
    background: Color,
    backgroundPanel: Color,
    backgroundElement: Color,
    backgroundMenu: Schema.optional(Color).annotate({
      description: "Menu background; defaults to backgroundElement",
    }),
    backgroundSelected: Schema.optional(Color).annotate({
      description: "Selected list/panel row; defaults to a 12% tint of primary over backgroundPanel",
    }),
    backgroundUser: Schema.optional(Color).annotate({
      description: "User message block background; defaults to backgroundElement",
    }),
    border: Color,
    borderActive: Color,
    borderSubtle: Color,
    borderWarning: Schema.optional(Color).annotate({
      description: "Warning panel border; defaults to a 40% tint of warning over border",
    }),
    logoFace: Schema.optional(Color).annotate({
      description: "GraphAgent logo GRAPH face; defaults to textMuted",
    }),
    logoAccent: Schema.optional(Color).annotate({
      description: "GraphAgent logo AGENT face; defaults to primary",
    }),
    logoShadow: Schema.optional(Color).annotate({
      description: "GraphAgent logo outline shadow; defaults to a 25% tint of textMuted over background",
    }),
    statusRunning: Schema.optional(Color).annotate({
      description: "Running DAG segments and spinners; defaults to primary",
    }),
    statusQueued: Schema.optional(Color).annotate({
      description: "Queued or skipped states; defaults to textDim",
    }),
    statusPaused: Schema.optional(Color).annotate({
      description: "Paused or waiting states; defaults to warning",
    }),
    diffAdded: Color,
    diffRemoved: Color,
    diffContext: Color,
    diffHunkHeader: Color,
    diffHighlightAdded: Color,
    diffHighlightRemoved: Color,
    diffAddedBg: Color,
    diffRemovedBg: Color,
    diffContextBg: Color,
    diffLineNumber: Color,
    diffAddedLineNumberBg: Color,
    diffRemovedLineNumberBg: Color,
    markdownText: Color,
    markdownHeading: Color,
    markdownLink: Color,
    markdownLinkText: Color,
    markdownCode: Color,
    markdownBlockQuote: Color,
    markdownEmph: Color,
    markdownStrong: Color,
    markdownHorizontalRule: Color,
    markdownListItem: Color,
    markdownListEnumeration: Color,
    markdownImage: Color,
    markdownImageText: Color,
    markdownCodeBlock: Color,
    syntaxComment: Color,
    syntaxKeyword: Color,
    syntaxFunction: Color,
    syntaxVariable: Color,
    syntaxString: Color,
    syntaxNumber: Color,
    syntaxType: Color,
    syntaxOperator: Color,
    syntaxPunctuation: Color,
    thinkingOpacity: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))).annotate({
      description: "Opacity applied to thinking text (default: 0.6)",
    }),
  }).annotate({ description: "Theme colors; values are resolved through defs" }),
}).annotate({ identifier: "Theme" })
