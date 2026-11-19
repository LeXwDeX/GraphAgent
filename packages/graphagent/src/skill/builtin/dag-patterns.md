# DAG Patterns

These patterns are examples, not required templates or node minimums; combine or
simplify them. Save a YAML block, validate it with
`{ action: "spec", operation: "validate", spec_path }`, then start it with
`{ action: "run", operation: "start", spec_path }`. Load skill dag-blocks for
fields and skill dag-policy for gates and models.

Writers in `nodes` are unavailable in DAG mode (the strict gate takes read-only
workers only), so these examples use `explore`, `plan`, and `auditor`; edit
through `coding` blocks.

## Choosing a composition

- Two or three independent read-only jobs: `task` each; no workflow.
- Shape known when writing the graph (pipeline, generate then check): blocks or a template.
- Width known only after looking (research angles, exploring by module): a `compose` block with `worker_type: surveyor` (angles or candidates) or `mapper` (modules, split again when too big). It adds a plan and a join call; the engine expands it into read-only workers.
- Parallel writes: `coding` with `fan_out`.
- Several viewpoints or adversarial review: a review block's `lenses` and `skeptics`.

## 1. Staged pipeline with gate

Sequential phases; a gate blocks later work until quality is confirmed.

```yaml
config:
  name: staged-gate
  nodes:
    - { id: explore, name: explore, worker_type: explore, depends_on: [], prompt_template: { inline: "Explore the auth module and report findings." }, required: true }
    - id: gate
      name: gate
      worker_type: auditor
      depends_on: [explore]
      input_mapping: { findings: explore }
      required: true
      report_to_parent: true
      output_schema:
        { type: object, required: [verdict, summary], properties: { verdict: { type: string, enum: [ACCEPT, REVISE, REJECT, BLOCKED] }, summary: { type: string } } }
      prompt_template: { inline: "Review these findings and submit a structured verdict: {{findings}}" }
    - { id: design, name: design, worker_type: plan, depends_on: [gate], condition: 'gate.output.verdict == "ACCEPT"', prompt_template: { inline: "Design the change from the approved findings." } }
```

The `required: true` gate cancels the workflow on execution or output-contract
failure. A successful non-ACCEPT verdict does not fail the node; the condition
skips `design` and the parent decides whether to replan or stop.

## 2. Parallel fan-out

One preparatory node feeds N workers, which fan back into an assembler.

```yaml
config:
  name: parallel-fan-out
  nodes:
    - { id: discover, name: discover, worker_type: explore, depends_on: [], prompt_template: { inline: "List all packages that need the API migration." }, required: true }
    - { id: scan-auth, name: scan-auth, worker_type: explore, depends_on: [discover], prompt_template: { inline: "Assess the auth package's API migration." } }
    - { id: scan-server, name: scan-server, worker_type: explore, depends_on: [discover], prompt_template: { inline: "Assess the server package's API migration." } }
    - { id: assemble, name: assemble, worker_type: auditor, depends_on: [scan-auth, scan-server], prompt_template: { inline: "Merge both assessments into one summary." } }
```

`scan-*` run concurrently (bounded by `max_concurrency`); `assemble` waits for
both. Non-required worker failures do not cancel the workflow; `assemble` still
runs and reports them.

## 3. Adversarial review

Reviewers help when distinct expertise or independent scrutiny adds evidence.
An arbiter resolves conflicts; here its verdict gates follow-up, while a
read-only review can end with the parent's findings. See skill dag-recovery's
Verdict Disposal Contract.

```yaml
config:
  name: adversarial-review
  nodes:
    - { id: review-arch, name: review-arch, worker_type: auditor, depends_on: [], prompt_template: { inline: "Review the change's architecture. Report evidence-backed findings and unverified claims." } }
    - { id: review-logic, name: review-logic, worker_type: auditor, depends_on: [], prompt_template: { inline: "Review the change's logic. Report evidence-backed findings and unverified claims." } }
    - id: arbitrate
      name: arbitrate
      worker_type: auditor
      depends_on: [review-arch, review-logic]
      required: true
      report_to_parent: true
      output_schema:
        { type: object, required: [verdict, summary, findings, required_actions], properties: { verdict: { type: string, enum: [ACCEPT, REVISE, REJECT, BLOCKED] }, summary: { type: string }, findings: { type: array }, required_actions: { type: array } } }
      prompt_template: { inline: "Merge both reviews into one structured ACCEPT, REVISE, REJECT, or BLOCKED decision with deduplicated findings and required actions." }
    - { id: deep-dive, name: deep-dive, worker_type: auditor, depends_on: [arbitrate], condition: 'arbitrate.output.verdict != "ACCEPT"', report_to_parent: true, prompt_template: { inline: "Verify each required action against the code and produce a corrected action plan." } }
```

Auditors always take the `advanced` tier; `required` sets only failure
semantics. On ACCEPT `deep-dive` is skipped; otherwise it runs with the
arbiter's findings, so a non-ACCEPT outcome never silently ends the graph.

## 4. Diverge-converge

Independent generators propose candidates; a converger selects and refines.

```yaml
config:
  name: diverge-converge
  nodes:
    - { id: gen-a, name: gen-a, worker_type: plan, depends_on: [], prompt_template: { inline: "Propose a solution for X using microservices." } }
    - { id: gen-b, name: gen-b, worker_type: plan, depends_on: [], prompt_template: { inline: "Propose a solution for X using a modular monolith." } }
    - { id: converge, name: converge, worker_type: plan, depends_on: [gen-a, gen-b], required: true, prompt_template: { inline: "Compare the approaches and select the best fit for the constraints." } }
```

## Cross-domain composition

The Router and workflow library own route and execution choices. These examples
apply once a DAG is chosen and several domain references seem useful; domain
overlap does not itself require one.

Match examples to the artifact:

- Product decision: product planning is the backbone; technical feasibility is
  evidence, not a second route.
- Implementation-ready design: technical design is the backbone; product context
  supplies constraints.
- Changed code: project development is the backbone unless an unknown defect
  needs causal diagnosis first.
- Defect repair: debug and repair are the backbone; repair, regression proof,
  and review stay in that graph.
- Verdict: code review for a pinned change, security/performance audit for those
  domains, technical design for a proposed system or migration.

Security, performance, and review can add secondary assurance to implementation
or repair artifacts, often inside existing work rather than a separate workflow.
Address the evidence gap, not every domain's process. Add the smallest
assurance slice:

- One primary reference sets the objective; secondary ones suggest a focused
  evidence lane or gate. Retarget borrowed instructions; never copy wholesale.
- Security-sensitive feature: development backbone plus scoped threat,
  authorization, secret, or supply-chain checks before review.
- Security defect: debug backbone plus exploitability and boundary verification
  around the causal repair.
- Performance repair: debug or development backbone plus a repeatable baseline
  and before/after measurement.
- Dependency or release review: review backbone plus relevant provenance and
  reachability evidence.

Reuse evidence while valid. Extra review or synthesis nodes help when they
resolve uncertainty, not as ceremonial endpoints. Unordered writers share one
workspace: give them disjoint write sets or serialize them with real
dependencies. Compiler-bound reviews retain their fingerprint contracts.
Composition does not redefine block fields, verdicts, repair, or recovery; see
skill dag-blocks and skill dag-recovery. Interpret non-ACCEPT results against
the requested outcome (a report, follow-up, or graph adaptation). Changing
domains does not reset budgets or authorize new work.
