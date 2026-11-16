// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DagBlocks } from "@/dag/blocks"
import { validateAgainstSchema } from "@/dag/runtime/schema-validator"

/**
 * The artifact catalog (#1158): the structured results an agent can declare in
 * its contract (`contract.output.artifact`), by type name, with the JSON schema
 * each one is validated against.
 *
 * Every artifact is one JSON value with a fixed envelope:
 *
 *   { artifact, summary, body, evidence, not_examined }
 *
 * The envelope is strict: the five fields are required, typed, and nothing else
 * may sit beside them. The `body` is loose: it must carry the fields its type
 * needs and may carry more (D7). `not_examined` is the same field the review
 * lanes of #1031 use, so a reader finds what was left out in one place.
 *
 * A schema uses only the keywords the DAG's subset validator enforces, so the
 * same object serves as a node's `output_schema` and as the result contract of a
 * `task` call (`ResultContract`). Descriptions are part of the schema on
 * purpose: the schema is shown to the worker that has to produce it.
 */

const NAMES = [
  "code_findings",
  "research_findings",
  "architecture_proposal",
  "prototype",
  "survey_report",
  "project_map",
] as const
export type Name = (typeof NAMES)[number]

/** The initial cap on the envelope's `summary`, in characters; PR3 tunes it against measurements. */
export const SUMMARY_MAX = 1200

type Schema = Record<string, unknown>

const text = (description: string): Schema => ({ type: "string", description })
const list = (description: string, items?: Schema): Schema => ({
  type: "array",
  description,
  ...(items === undefined ? {} : { items }),
})
const strings = (description: string): Schema => list(description, { type: "string" })
const object = (description: string, required: string[], properties: Record<string, Schema>): Schema => ({
  type: "object",
  description,
  required,
  properties,
})

const EVIDENCE: Schema = list(
  "What the claims rest on: one entry per file, URL or command. Empty only when nothing was read or run.",
  {
    type: "object",
    required: ["kind", "ref"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["file", "url", "command"] },
      ref: {
        type: "string",
        minLength: 1,
        description: "The file path (with :line when it helps), the URL, or the command",
      },
      note: text("What the reference shows"),
    },
  },
)

const NOT_EXAMINED: Schema = strings(
  "What was not looked at or could not be verified, each with the reason. Empty only when nothing was left out.",
)

interface Definition {
  readonly description: string
  readonly body: Schema
}

const DEFINITIONS: Record<Name, Definition> = {
  code_findings: {
    description:
      "what was found in the code: the scope examined, and one claim per finding tied to the files that show it",
    body: object("The findings", ["scope", "findings"], {
      scope: text("What was searched or read: the boundary of the question"),
      findings: list("One entry per finding", {
        type: "object",
        required: ["claim", "refs"],
        properties: {
          claim: text("What is true of the code"),
          refs: strings("Absolute file paths, with :line, that show it"),
        },
      }),
    }),
  },
  research_findings: {
    description: "what outside sources say about a question: sourced answers, and where the sources disagree",
    body: object("The research", ["question", "answers", "conflicts"], {
      question: text("The question that was researched"),
      answers: list("One entry per conclusion; each names the sources it rests on", {
        type: "object",
        required: ["claim", "sources"],
        properties: {
          claim: text("The conclusion"),
          sources: { ...strings("URLs of the sources the conclusion rests on"), minItems: 1 },
        },
      }),
      conflicts: list(
        "Where sources disagree: the point at issue and the sources on each side. Empty when they agree.",
      ),
    }),
  },
  architecture_proposal: {
    description:
      "a design recommendation: the options considered with their trade-offs, the decision, the components of the chosen design, its risks and what is still open",
    body: object("The proposal", ["options", "decision", "components", "risks", "open_questions"], {
      options: list("The options that are really different, each with its trade-offs", {
        type: "object",
        required: ["name", "tradeoffs"],
        properties: {
          name: text("A short name for the option"),
          tradeoffs: { type: ["string", "array"], description: "What the option costs, risks and leaves open" },
        },
      }),
      decision: text("The option recommended, why, and what would change the recommendation"),
      components: list("The parts of the chosen design: what each is responsible for and where it meets existing code"),
      risks: list("What could go wrong with the chosen design"),
      open_questions: strings("Questions that need an answer from the user or from more work, not guessed"),
    }),
  },
  prototype: {
    description:
      "the result of one disposable experiment: hypothesis and success signal, where the prototype lives and how to run it, what was observed, and the files it changed with a fingerprint",
    body: object(
      "The prototype",
      ["hypothesis", "success_signal", "location", "how_to_run", "observations", "changed_files", "fingerprint"],
      {
        hypothesis: text("The falsifiable claim the experiment tests, stated before it was built"),
        success_signal: text(
          "The observation that would show the hypothesis holds, and the one that would show it does not",
        ),
        location: text("Where the prototype lives in the workspace, under prototypes/"),
        how_to_run: text("The exact commands that repeat the run from the workspace root"),
        observations: list("What was observed when it ran, kept apart from what is inferred from it"),
        // The implementation record every writer submits (DagBlocks.IMPLEMENTATION_SCHEMA): the artifact's own
        // summary is that record's `summary`, and these are its other two fields, with the shapes the writer
        // contract gives them, so verification and diff review keep binding to `changed_files` and `fingerprint`.
        changed_files: DagBlocks.IMPLEMENTATION_SCHEMA.properties.changed_files,
        fingerprint: DagBlocks.IMPLEMENTATION_SCHEMA.properties.fingerprint,
      },
    ),
  },
  survey_report: {
    description: "a comparison of angles or candidates on one question, with a recommendation",
    body: object("The survey", ["question", "comparison", "recommendation"], {
      question: text("The question that was surveyed"),
      comparison: list("One entry per angle or candidate: what was found, and how it compares with the others"),
      recommendation: text("What to do, and why"),
    }),
  },
  project_map: {
    description:
      "a map of a codebase: its modules with their purpose, entry points and dependencies, and the concerns that span them",
    body: object("The map", ["modules", "cross_cutting"], {
      modules: list("One entry per module", {
        type: "object",
        required: ["path", "purpose", "entry_points", "depends_on"],
        properties: {
          path: text("The module's directory, relative to the repository root"),
          purpose: text("What the module is for"),
          entry_points: strings("The files or symbols other code enters the module through"),
          depends_on: strings("The other modules (by path) this one uses"),
        },
      }),
      cross_cutting: list("Concerns that span modules: build, configuration, error handling, testing and the like"),
    }),
  },
}

function envelope(name: Name, definition: Definition): Schema {
  return {
    type: "object",
    description: `A "${name}" artifact: ${definition.description}`,
    required: ["artifact", "summary", "body", "evidence", "not_examined"],
    additionalProperties: false,
    properties: {
      artifact: { type: "string", const: name },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: SUMMARY_MAX,
        description: `What a reader who stops here needs to know, at most ${SUMMARY_MAX} characters`,
      },
      body: definition.body,
      evidence: EVIDENCE,
      not_examined: NOT_EXAMINED,
    },
  }
}

const SCHEMAS = new Map<string, Schema>(NAMES.map((name) => [name, envelope(name, DEFINITIONS[name])]))

export type Validation = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** The artifact types the catalog holds, in catalog order. */
export function names(): readonly Name[] {
  return NAMES
}

export function has(name: string): name is Name {
  return SCHEMAS.has(name)
}

/**
 * The JSON schema of the artifact `name`, or undefined for a name the catalog
 * does not hold. A copy: the caller may edit it (a node's `output_schema` is
 * persisted and cloned) without touching the catalog.
 */
export function schema(name: string): Schema | undefined {
  const found = SCHEMAS.get(name)
  return found === undefined ? undefined : structuredClone(found)
}

/**
 * Checks `payload` against the artifact `name` with the DAG's subset validator.
 * The schemas are this catalog's own (no patterns, no unbounded scans), so the
 * check runs in place rather than in the validator's bounded worker.
 */
export function validate(name: string, payload: unknown): Validation {
  const found = SCHEMAS.get(name)
  if (found === undefined) return { ok: false, error: `unknown artifact type "${name}" (known: ${NAMES.join(", ")})` }
  const result = validateAgainstSchema(payload, found)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export * as AgentArtifact from "./artifact"
