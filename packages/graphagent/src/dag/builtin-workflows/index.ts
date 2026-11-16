// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import stageUnderstandContent from "./stage-understand.yaml" with { type: "text" }
import stageDesignContent from "./stage-design.yaml" with { type: "text" }
import stageImplementContent from "./stage-implement.yaml" with { type: "text" }
import stageReviewContent from "./stage-review.yaml" with { type: "text" }

/**
 * Workflow specs that ship inside the runtime itself, keyed by library name.
 * They are the four stage templates of DAG mode (understand, design,
 * implement, review) and belong to the `builtin` scope of `DagWorkflows`. Each
 * declares `inputs` (at least `objective`), so a stage starts from
 * `run.start { spec_path, inputs }` without a copy of the file.
 * Text imports are inlined by `bun test`, `bun dev`, and the compiled binary
 * alike, so the specs resolve without a release snapshot. Add a spec by adding
 * the file and one entry here; names must be bare identifiers.
 */
export const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = {
  "stage-understand": stageUnderstandContent,
  "stage-design": stageDesignContent,
  "stage-implement": stageImplementContent,
  "stage-review": stageReviewContent,
}
