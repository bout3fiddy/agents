# Benchmarking

Benchmarks are evidence only when they compare the same work. Name the boundary, preserve correctness, and run the optimized mode that matches the claim.

## Same-Boundary Rule

Before comparing timings, make these identical:

- workload size and generated data;
- warmup;
- iteration count;
- build mode;
- worker count or thread count;
- setup included or excluded;
- checksum, invariant, residual, or output check.

Compare matching optimized timing boundaries: `ReleaseFast` with `ReleaseFast`, warmed multi-iteration runs with warmed multi-iteration runs.

Keep units comparable across before/after and alternative implementations. If you add a derived metric, still report the original raw elapsed time, boundary name, item count, and checksum. Do not replace `ns/item` with a narrower denominator such as `ns/accepted_item`, `ns/scored_item`, or `ns/output` unless the old denominator is still shown beside it.

For machine-level work, the benchmark should be boring. The interesting part is the boundary and checksum, not a clever harness. Prefer deterministic in-memory inputs, a warmup, an iteration loop around the exact boundary, and a checksum or domain invariant that prevents dead-code elimination and catches behavior changes.

Benchmark reports should identify the exact function or public entrypoint under timing. If a change adds `processInto`, `Prepared.process`, or another hot API beside an existing public call, report each relevant boundary separately instead of blending setup, wrapper, and hot call into one ambiguous timing.

Keep benchmark-only bookkeeping outside the timed boundary unless it is part of the user-visible work. Precompute active counts, expected totals, labels, and fixture metadata before timing; keep the timed loop focused on the boundary plus the minimal checksum needed to prove the result was consumed.

## Build Modes

Use project steps when they exist:

```sh
zig build --list-steps
zig build <bench-step> -Doptimize=ReleaseFast --summary all
zig build <bench-step> -Doptimize=ReleaseFast -- <bench-args>
```

For single-file tasks:

```sh
zig test src/main.zig -OReleaseFast
zig run src/main.zig -OReleaseFast -- --bench
```

Use `ReleaseSafe` for optimized safety validation:

```sh
zig build <step> -Doptimize=ReleaseSafe --summary all
zig build-exe src/main.zig -OReleaseSafe -fno-emit-bin
```

## Useful Benchmark Shape

A useful benchmark reports:

- boundary name;
- number of items;
- iterations and warmup;
- elapsed time;
- ns/item or items/s when applicable;
- checksum or domain invariant;
- build command.

Structured benchmark metadata is reporting hygiene, not a differentiator by itself. The decisive evidence is the measured same-boundary workload with a matching invariant.

Example output shape:

```text
bench boundary=evaluateRulesInto records=1000000 iterations=20 warmup=2 elapsed_ns=26600000 ns_per_record=1.33 checksum=27997959000
```

For outer-command timing, use a tool such as `hyperfine` only after the program itself reports a stable internal boundary:

```sh
hyperfine --warmup 2 './zig-out/bin/bench --bench'
```

This is useful for executable-level regressions, startup cost, and end-to-end timing. Pair it with in-program timing when the claim is about one kernel, one parser pass, or one reused workspace call.

## Setup Vs Hot Path

Time setup separately from steady-state execution when setup can be reused:

- parsing/loading;
- preparation;
- workspace allocation;
- cache warmup;
- hot loop;
- final evaluation;
- diagnostics/report writing.

Comparable speedups keep setup placement consistent across both measurements.

If the optimization prepares dense state, reports should show both costs when they matter:

```text
prepare elapsed_ns=180000 unique_keys=64
run boundary=analyzePrepared batches=20 samples=1000000 elapsed_ns=13920000 checksum=2050740
```

This keeps "we moved work to setup" distinct from "the repeated boundary is faster."

When the task says one stable rule set, weight table, plan, cache, or model is applied to many batches, make that workload visible in the benchmark:

```text
bench boundary=scoreSegments weights=4 batches=1000 batch_size=64 iterations=40 warmup=3 elapsed_ns=2857000 checksum=5054062585016
bench boundary=PreparedWeights.score weights=4 batches=1000 batch_size=64 iterations=40 warmup=3 elapsed_ns=2483000 checksum=5054062585016
```

This is a different question from repeating one large full-slice call. Keep both numbers when the public one-shot API remains, but use the many-batch prepared boundary for claims about reused controls.

When a prepared API is introduced, benchmark both the honest one-shot public boundary and the prepared repeated boundary when both are relevant. A prepared-state design is only proven for repeated use when the benchmark times reuse of the prepared object rather than rebuilding it every call.

Size the benchmark so it stresses the cost your source shape claims to remove. If preparation avoids scanning controls, rules, weights, routes, schemas, or model state, include enough of that stable input to make repeated preparation measurable. Tiny fixtures are useful smoke tests, but they are weak evidence for setup-removal claims unless the real workload is also tiny.

## When No Benchmark Exists

For small fixes, run optimized correctness and state when runtime is unmeasured. If the task is explicitly performance-sensitive, add an exploratory or retained benchmark around the smallest meaningful boundary.

Exploratory benchmarks are fine for investigation. Retained benchmarks are better when the repo already has a benchmark or evidence location.

## Final Timing Report

Report concise evidence:

```text
Correctness: zig build test
Boundary: analyzeSamplesInto, 1,000,000 samples, 1,024 thresholds, 20 iterations
Build: zig run src/main.zig -OReleaseFast -- --bench
Before: 336 ms
After: 3.27 ms
Invariant: accepted/alert counts match
Risk: no CPU counter profile; benchmark is single machine
```
