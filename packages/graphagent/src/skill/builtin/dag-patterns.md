# DAG Patterns

These patterns illustrate common cases; none is a required template or node
minimum, and workflows can combine or simplify them. Every YAML block is start
content: save, validate with
`{ action: "spec", operation: "validate", spec_path: "<file>.yaml" }`, then start with
`{ action: "run", operation: "start", spec_path: "<file>.yaml" }`. Load skill dag-blocks for
fields and skill dag-policy for gates and models.

## 1. Staged pipeline with gate

Sequential phases; a gate blocks downstream work until quality is confirmed.

```yaml
config:
  name: staged-gate
  nodes:
    - { id: explore, name: explore, worker_type: explore, depends_on: [], prompt_template: { inline: "Explore the auth module and report findings." }, required: true }
    - id: gate
      name: gate
      worker_type: general
      depends_on: [explore]
      input_mapping: { findings: explore }
      required: true
      report_to_parent: true
      output_schema:
        { type: object, required: [verdict, summary], properties: { verdict: { type: string, enum: [ACCEPT, REVISE, REJECT, BLOCKED] }, summary: { type: string } } }
      prompt_template: { inline: "Review these findings and submit a structured verdict: {{findings}}" }
    - { id: implement, name: implement, worker_type: build, depends_on: [gate], condition: 'gate.output.verdict == "ACCEPT"', prompt_template: { inline: "Implement based on approved findings." } }
```

The gate is `required: true`, so execution or output-contract failure cancels
the workflow. A successful non-ACCEPT verdict does not fail the node; the
condition skips `implement`, and the verdict gives the parent a
replan or stop decision.

## 2. Parallel fan-out

One preparatory node feeds N workers, which fan back into an assembler.

```yaml
config:
  name: parallel-fan-out
  nodes:
    - { id: discover, name: discover, worker_type: explore, depends_on: [], prompt_template: { inline: "List all packages that need the API migration." }, required: true }
    - { id: migrate-auth, name: migrate-auth, worker_type: build, depends_on: [discover], prompt_template: { inline: "Migrate the auth package to the new API." } }
    - { id: migrate-server, name: migrate-server, worker_type: build, depends_on: [discover], prompt_template: { inline: "Migrate the server package to the new API." } }
    - { id: assemble, name: assemble, worker_type: build, depends_on: [migrate-auth, migrate-server], prompt_template: { inline: "Run integration tests and assemble a summary." } }
```

`migrate-*` nodes run concurrently, bounded by `max_concurrency`; `assemble`
waits for both. Non-required worker failures do not cancel the workflow —
`assemble` still runs and reports which migrations failed.

## 3. Adversarial review

Multiple reviewers help when distinct expertise or independent scrutiny adds
evidence. An arbiter resolves conflicts; this example gates follow-up on its
verdict, while a read-only review can finish with the parent's findings.
See the Verdict Disposal Contract in skill dag-recovery.

```yaml
config:
  name: adversarial-review
  nodes:
    - { id: implement, name: implement, worker_type: build, depends_on: [], prompt_template: { inline: "Implement the requested change per the task description." }, required: true }
    - { id: review-arch, name: review-arch, worker_type: general, depends_on: [implement], prompt_template: { inline: "Review architecture. Report evidence-backed findings and unverified claims." } }
    - { id: review-logic, name: review-logic, worker_type: general, depends_on: [implement], prompt_template: { inline: "Review logic. Report evidence-backed findings and unverified claims." } }
    - id: arbitrate
      name: arbitrate
      worker_type: general
      depends_on: [review-arch, review-logic]
      required: true
      report_to_parent: true
      output_schema:
        { type: object, required: [verdict, summary, findings, required_actions], properties: { verdict: { type: string, enum: [ACCEPT, REVISE, REJECT, BLOCKED] }, summary: { type: string }, findings: { type: array }, required_actions: { type: array } } }
      prompt_template: { inline: "Two reviewers produced findings. Submit one structured ACCEPT, REVISE, REJECT, or BLOCKED decision with deduplicated findings and required actions." }
    - { id: deep-dive, name: deep-dive, worker_type: general, depends_on: [arbitrate], condition: 'arbitrate.output.verdict != "ACCEPT"', report_to_parent: true, prompt_template: { inline: "The arbiter did not accept. Verify each required action against the code and produce a corrected, evidence-backed action plan." } }
```

The reviewers are optional `general` workers, so they prefer `standard`. The
arbiter prefers `advanced` because it is `required: true`: execution failure
means the artifact could not be confidently accepted, while a successful
business verdict must still be interpreted. On ACCEPT the conditioned
`deep-dive` is skipped; otherwise it runs with the arbiter's findings, so a
non-ACCEPT outcome never silently terminalizes the graph.

## 4. Diverge-converge

Independent generators propose candidates; a converger selects and refines.

```yaml
config:
  name: diverge-converge
  nodes:
    - { id: gen-a, name: gen-a, worker_type: general, depends_on: [], prompt_template: { inline: "Propose a solution for X using microservices." } }
    - { id: gen-b, name: gen-b, worker_type: general, depends_on: [], prompt_template: { inline: "Propose a solution for X using a modular monolith." } }
    - { id: converge, name: converge, worker_type: general, depends_on: [gen-a, gen-b], required: true, prompt_template: { inline: "Compare the approaches and select the best fit for the constraints." } }
```

## Cross-domain composition

The Router and workflow library own route and execution choices. These examples
apply when several domain references seem useful after choosing a DAG; domain
overlap does not itself require one.

Match examples to the final artifact:

- Product decision: keep product planning as the backbone; technical
  feasibility is evidence, not a second route.
- Implementation-ready design: keep technical design as the backbone; product
  context supplies constraints.
- Changed code: keep project development as the backbone unless an unknown
  defect first requires causal diagnosis.
- Defect repair: keep debug and repair as the backbone; repair, regression
  proof, and review stay in that graph.
- Verdict: code review for a pinned change, security/performance audit for
  those evidence domains, technical design for a proposed system or migration.

Security, performance, and review can add secondary assurance to
implementation or repair artifacts; their checks may fit existing work without a
separate workflow. Address the evidence gap rather than attach every domain's
process.

Add the smallest assurance slice:

- Keep a primary reference for objective clarity; secondary references
  suggest a focused evidence lane or gate. Retarget borrowed instructions;
  never copy wholesale.
- A security-sensitive feature keeps the development backbone and adds scoped
  threat, authorization, secret, or supply-chain checks before review.
- A security defect keeps the debug backbone and adds exploitability and
  boundary verification around the causal repair.
- A performance repair keeps the debug or development backbone and adds a
  repeatable baseline plus before/after measurement.
- A dependency or release review keeps the review backbone and adds only
  relevant provenance and reachability evidence.

Reuse evidence while valid. Extra review or synthesis nodes help when they
resolve uncertainty, not as ceremonial endpoints. Unordered writers share one
workspace: give them disjoint write sets or serialize them with real
dependencies. Compiler-bound reviews retain their fingerprint contracts.
Composition does not redefine block fields, verdicts, repair, or recovery; load
skill dag-blocks and skill dag-recovery. Interpret non-ACCEPT results against
the requested outcome: a report, direct follow-up, or graph adaptation may be
appropriate. Changing domains does not reset budgets or authorize new work.