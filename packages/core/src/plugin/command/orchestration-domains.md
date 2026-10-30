# Cross-domain Workflow Composition

The resident Orchestration Router and the live workflow library own route and
execution choices. This guide offers examples when several domain references
seem useful after choosing a DAG. Domain overlap does not itself require one.

## Match examples to the final artifact

- The requested deliverable is a product decision: keep product planning as
  the backbone; technical feasibility is evidence, not a second design route.
- The requested deliverable is an implementation-ready design: keep technical
  design as the backbone; product context supplies constraints.
- The requested deliverable is changed code: keep project development as the
  backbone unless an unknown defect first requires causal diagnosis.
- The requested deliverable is a defect repair: keep debug and repair as the
  backbone; the repair, regression proof, and review stay in that graph.
- The requested deliverable is a verdict: use code review for a pinned
  implementation change, security audit or performance audit for those evidence
  domains, and technical design when the object is a proposed system or
  migration.

Security, performance, and review can provide secondary assurance when the
requested artifact remains implementation or repair. Their checks may fit the
existing work without a separate workflow. Choose what addresses the evidence
gap rather than attaching every plausible domain's full process.

## Add the smallest assurance slice

A primary reference can keep the objective clear. Secondary references can
suggest a focused evidence lane or gate. Retarget borrowed instructions to the
same scope and acceptance; a reference need not be copied wholesale.

- A security-sensitive feature keeps the development backbone and adds scoped
  threat, authorization, secret, or supply-chain checks before final review.
- A security defect keeps the debug backbone and adds exploitability and
  boundary verification around the causal repair.
- A performance repair keeps the debug or development backbone and adds a
  repeatable baseline plus before/after measurement.
- A review of a dependency or release change keeps the review backbone and adds
  only the relevant upstream provenance and reachability evidence.

Reuse exploration and verification evidence while it remains valid. Extra
review or synthesis nodes are useful when they resolve uncertainty, not as
ceremonial endpoints. Unordered writers still share one workspace, so give
them disjoint write sets or serialize them with real dependencies. Compiler-bound
implementation reviews retain their fingerprint and verification contracts.

## Preserve lifecycle contracts

Composition does not redefine block fields, verdicts, repair, or recovery.
Load `guide(topic="blocks")` for YAML shapes and block semantics, and
`guide(topic="policy")` for admission, verdict disposal, pause-first replan,
and bounded repair. Interpret non-ACCEPT results against the user's requested
outcome: a report, direct follow-up, or graph adaptation may be appropriate.
Changing domains does not reset runtime budgets or authorize new work.
