# ADR-0007: Template inputs, live-graph extend, and the constraint summary

- Status: Accepted
- Date: 2026-11-16

## Context

Local usage data (28 sessions, 1,247 `workflow` calls, 121 starts) showed that a
first start is rarely wrong: the common path `draft → validate → start` took a
median of two calls, and only 5 of 120 successful starts had failed before. The
cost was volume. 116 of 121 starts came from a freshly written draft, no start
from a template, and a draft input has a median of 3.9 KB. What did go wrong was
`extend`: 7 of 60 were rejected, for reasons the model could not derive itself
(a reporting checkpoint whose dependents were not gated on its output, the node
ceiling, an extend of a terminal workflow, and a document that mixed `blocks`
and `nodes`).

Templates did not help. The builtin stage specs (ADR-0006) were references: the
parent copied one and rewrote its objective, instructions, and acceptance items,
which is the same drafting cost with extra reading.

## Decision

**1. A start document declares `inputs`, and `run.start` fills them.**
`inputs` maps a name to `{ type?, description?, default? }` with the types
`string` (default), `number`, `boolean`, and `array`. An input without a
`default` is required. The call is `run.start { spec_path, inputs }`. A template
is a saved workflow, so it is named by the same `spec_path` that every other
spec uses (ADR-0001: graph actions accept only `spec_path`); there is no second
field for it. `spec validate` takes the same `inputs`. On the wire `inputs` is an
open object, about 60 bytes per action; the authoring boundary checks it against
the declarations.

**2. Substitution is a step of the Workflow Authoring Check.** It runs on the
parsed document, before strict decoding, so the instantiated document meets
every rule any start document meets. It walks parsed values, never YAML text, so
a value can neither break the syntax nor add structure. `{{name}}` is replaced
only when `name` is a declared input; every other `{{name}}` stays for the
runtime's `{{node-id}}` bindings. A string that is exactly one placeholder takes
the input's own type, which lets an `array` input fill `acceptance`; a decode
failure under such a field names the input. Inside longer text a value is
rendered as plain text and is never scanned again. A document that declares
`inputs` is always instantiated: a missing required input is an error, never a
start from placeholders, and inputs passed to a document that declares none are
an error too.

**3. A template is judged with sample values where no call exists.** `spec list`,
`spec read`, and the template CI (`script/dag-template-validation.ts`) stand a
sample in for each required input. A sample follows the field it fills
(`template-sample.ts` reads the start document's own schema and takes the
smallest value that field accepts: one `{ id, text }` element for `acceptance`,
an allowed string for `review_gate`), so a constraint on an input's value, such
as the acceptance items a strict writer needs, is not taken for a defect of the
template. A list of plain strings stays empty, since any element would name
something that is not there, and what no schema states (an absolute path) needs
a default on the input to be judged. The CI additionally requires a template that
declares inputs to start from `objective` alone, which is what "every curated
template starts from the request" means; a template with no inputs gets a
warning, not a failure, so the curated set can adopt `inputs` without blocking a
release. `spec list` prints each template's inputs and how to start it.

**4. The four stage specs declare inputs.** All take `objective` (required);
`stage-implement` and `stage-review` take `acceptance` (an array, defaulting to
their single generic item); `stage-implement` takes `verify_command` and
`stage-review` takes `review_focus`.

**5. An extend is authored against the live graph.** `prepareMutation` hands the
workflow's current nodes, each marked settled or not, to the authoring check.
A block that depends on a reporting checkpoint that enumerates a "carry on"
verdict and has not settled (a Live Gate: `ACCEPT` for a review decision, `PASS`
for a verification) is compiled with the same condition, `skip_ok`, and review
binding as a dependent of an in-document review block. A checkpoint that has
settled is never gated: the parent has read its verdict, and gating the repair
wave on `ACCEPT` would skip it after a `REVISE`, which breaks the reopen-extend
flow (ADR-0003). A block that depends on two gates is refused (one condition
reads one dependency). A condition reads direct dependencies only, so the
arbitration node of a review block lists the gate its condition reads among its
dependencies, as its lanes do through the block's own `depends_on`; this also
lets a review follow another review inside one start document, which used to be
an authoring error.

**6. A rejected nodes fragment says how to fix it, when the fix is simple.** The
merged-graph checkpoint gate that `Dag.extend` enforces at the runtime seam is
also run at authoring, on the fragment's own dependents, so the rejection arrives
before anything is parked. A grouped gate diagnostic carries `suggested_fragment`:
node patches merged by id (`condition`, and `skip_ok` where the gated node is
required, for the dependents; `output_schema` for a checkpoint with no contract).
The tool renders it as a structured retry signal.

**`suggested_fragment` covers only simple repairs: it edits the checkpoint and the
nodes it gates, and changes the meaning of no other node.** It is offered only
when all of these hold:

1. A condition can do the gating. It reads exactly one direct dependency, so a
   dependent that already has a condition, or that depends on a second reporting
   checkpoint, gets no patch, and a blocks document (no `condition` field) is told
   its block-level choices instead.
2. The verdict it gates on exists: the "carry on" verdict the checkpoint already
   enumerates, or else the documented verdict schema, which is offered as a
   missing contract only when it provides what the gates already on the
   checkpoint read (`verdict`, compared with `==` or `!=` to `ACCEPT`, `REVISE`,
   `REJECT`, or `BLOCKED`). Otherwise the hint names the fields the gates read, so
   the caller declares a schema that provides them.
3. A rejected verdict then fails nothing. A gate makes the gated nodes skippable,
   and the scheduler skips every node whose dependencies are all skipped, so a
   required node behind a gated one that is not `skip_ok` would fail the workflow
   on the rejected branch. The patch is offered only when every node a rejected
   verdict would skip, directly or through that cascade, is already optional or
   `skip_ok`. The nodes are judged for all checkpoints of the graph together,
   since the patches are applied together and each checkpoint may reject. A
   condition that already exists below a gated node is not assumed false: any
   required node downstream of a gated node that some outcome of those conditions
   lets the rejection skip withholds the patch. Only a hazard outside that
   downstream, which the repair cannot touch, is not charged to it. A gated node
   that says `skip_ok: false` is left to the caller too.

When (3) fails no patch is given, and the hint lists the nodes to make
`skip_ok: true` or `required: false`. Giving other nodes `skip_ok` would change
what they mean, so that stays the caller's decision. The retry signal carries a
fragment only when every gate diagnostic has one; otherwise it says that no
mechanical fix applies.

**7. One mistake, one correction.** A graph that defines both `blocks` and
`nodes` is reported once. The empty key is deleted; when both hold entries, the
form the live workflow uses is kept (`blocks` for a start), and the other form
goes into a second document.

**8. `inspect status` states the constraints** (`constraints`): node usage and
the remaining quota against the effective ceiling, whether the workflow is
terminal (with what `extend` does for it), and whether its graph is `blocks`,
`nodes`, or `mixed`.

## Consequences

- A stage starts from one short call. The curated templates in
  `opencode-dag-config` still declare no inputs; they start as written until
  that repository adds `inputs`, and the template CI says so.
- `spec read` of a template returns the document as written, so the parent sees
  the declarations and the placeholders, not a sample.
- An extend that attaches a nodes-form dependent to a live checkpoint is refused
  at authoring (and still at the runtime seam). The workflow is parked as for
  every rejected extend; the signal is what makes the next attempt succeed.
- The blocks compiler decides gating from node output contracts, not from block
  kinds, so a hand-written live checkpoint with a `verdict` enum that includes
  `ACCEPT` or `PASS` is a Live Gate too.
- A generic reporting block (an `explore` with `report_to_parent: true`, a
  `synthesize`) that has dependents still cannot be gated in blocks form: it
  declares no verdict contract. The hint now says so and names what to do.

## Alternatives Considered

- A separate `template` field on `run.start`: rejected. It would make `spec_path`
  optional, need an exclusivity rule the schema cannot state without a
  combinator, and cost bytes in a tool definition that is near its budget, for a
  name that means the same thing as a saved workflow's.
- Substituting into the YAML text: rejected. A value with a colon, a quote, or a
  newline would break the document or add keys.
- Gating dependents of a settled checkpoint on its verdict: rejected for the
  reopen-extend reason above.
- Merging draft, validate, and start into one call: not done. #1030 keeps the
  three steps, and validation rework was 11 of 127.

## Deferred

- `inputs` on the curated templates of `opencode-dag-config`, and promoting the
  missing-inputs warning to a failure once they have them.
- A structured record of the template and inputs a workflow started from (the
  start result names them; the durable config does not).
