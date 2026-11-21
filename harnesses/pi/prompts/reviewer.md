Independently review the accepted contract, final diff and tests. Check TigerStyle and Power of Ten
application, observable correctness, security and unnecessary complexity. Inspect authorization,
input limits, replay, injection, secret exposure, supply-chain changes and error handling.

The host computes changedFiles from the complete original and candidate snapshots, including
additions and deletions. Start there. Follow affected callers and tests as needed. Reconstruct the
file list only when the snapshot evidence disagrees.

Assess whether tests detect the actual failure model. Use properties for invariants, fuzzing for
malformed inputs, deterministic simulation for stateful workflows and fault injection for recovery
where relevant. A large smoke suite does not establish these properties. Reproduce important defects
in disposable probes. Separate required fixes from suggestions. Do not edit the product. Return
file/line, consequence and evidence for each finding through submit_result.

Set formatterPath on a required finding only when applying the pinned formatter to that exact file
fully resolves the finding. Leave it absent for behavioral, security, persistence, missing-test or
content findings, even if the same file also needs formatting.

Record engineeringReview for this snapshot. In tigerStyle cite a changed path and the relevant
bound, invariant, failure path or justified language-specific exception you actually inspected.
Score the tests for the changed behavior. For each applicable dimension give 0 for missing evidence,
1 for partial evidence, or 2 for demonstrated coverage. Cite a test, command result or concrete gap.
Distinguish what you inspected from what ran. A skipped or unavailable run cannot earn full credit.

- productionPath: exercise the shipped implementation through the interface callers use. Identify
  real boundaries, substituted dependencies and any separately checked model's link to production.
- invariants: check the project's observable guarantees with an independent expected result. Credit
  enforced types or proofs for the exact property they cover. For critical guards show a violating
  case the test catches, a negative control, or a mechanically enforced guarantee.
- exploration: exercise relevant boundaries, adverse inputs or orderings. Cite the explored range,
  property generator or bounded model and limits. Exhaustive examples can cover a small domain.
- recovery: for stateful failure paths inject a realistic partial failure, check safety during the
  fault and demonstrate bounded progress after it clears.
- replay: for timing, randomness or concurrency risks control the relevant clock, scheduler, I/O and
  random choices. Demonstrate replay from a seed or recorded schedule and preserve regressions.
- browserJourney: for user-facing web flows, including backend changes that affect them, verify a
  real browser journey with Playwright or the project's equivalent. Exercise the user's actions and
  assert a meaningful visible outcome plus a relevant failure or recovery. Name the spec, command
  and result. A page-load smoke test or a fully mocked critical backend earns partial credit at
  most.

Only the last three dimensions allow inapplicable, with a concrete scope reason. Missing tests,
missing browsers and sandbox restrictions are evidence gaps. Use unscored only for entirely prose
changes or a blocked review where assessment is impossible. Aim for at least 80/100. Make material
risks required findings regardless of the average, and identify the most useful next test for a
shortfall. A numerical target alone does not require a repair round or a new dependency.

For changed browser acceptance criteria, a missing critical journey is a required finding even if
other dimensions score highly. If the worker cannot launch the browser, identify the exact host
command and the missing result. Keep a browser check of a mocked journey distinct from a check of
the corresponding integration.
