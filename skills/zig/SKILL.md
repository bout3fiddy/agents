---
name: zig
description: Performance evidence for Zig systems code. Use for explicit Zig optimization, allocation removal, benchmarking, hot-loop, batch API, data-layout, compiler-output, or module-readiness work; do not trigger for ordinary Zig syntax or general implementation help.
---

# Zig Performance Evidence

Keep Zig performance work tied to caller-visible correctness, comparable timing,
and one focused machine-level hypothesis.

## First reads

For concrete optimization, review, or implementation work, read:

- [machine-level-hypotheses.md](references/machine-level-hypotheses.md)
- [benchmarking.md](references/benchmarking.md)

Read follow-up references only when the evidence gap requires them:

- [compiler-evidence.md](references/compiler-evidence.md) for build truth,
  symbols, assembly, IR, source mapping, and CPU tools.
- [allocation-evidence.md](references/allocation-evidence.md) for counting
  allocators, no-allocation tests, and setup-versus-hot-loop boundaries.

## Evidence loop

1. Name the public entrypoint, repeated workload, hot loop, and fields read or
   written.
2. Separate setup, preparation, steady-state work, diagnostics, formatting, and
   final evaluation.
3. Define the correctness command, representative workload, optimized build
   mode, warmup, and checksum or invariant.
4. State which allocation, lookup, branch, copy, call, division, conversion, or
   scattered load should disappear.
5. Change one source-shape decision at a time.
6. Run caller-visible correctness, same-boundary timing, and one targeted
   compiler or allocation check.
7. Report exact commands, measured results, and remaining unmeasured risk.

Correctness failures outrank timing and generated-code evidence. A faster leaf
microbenchmark is not a workload win when the public boundary regresses or was
not measured. When adding a prepared or caller-owned API, measure the existing
public API as well as the new repeated-use boundary.

## Codegen ladder

Prefer the bundled JSON interface over ad hoc compiler-log reading:

```sh
skills/zig/scripts/codegen-ladder.sh \
  --source src/main.zig \
  --symbol hotFunction \
  --run-arg --bench \
  --json-out "$perf_scratch/codegen.json"
```

Inspect `.decision_card` first, follow only relevant suggested checks, and use
`scripts/codegen-ladder.sh diff --before before.json --after after.json` for
matched before/after reports. If workload, build mode, checksum, warmup, or
symbol differs, rerun comparable evidence before making a speed claim.

Keep the source shape when correctness passes, the relevant boundary improves,
and the focused low-level check supports the hypothesis. Stop when further
assembly work would not distinguish a new source-level decision.
