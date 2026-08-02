---
name: performance-engineering
description: Measure and improve runtime, allocation, memory traffic, data layout, or hot-path behavior. Use for explicit performance investigations, profiling, benchmarking, or optimization work; do not use for ordinary implementation, bug fixes, or general code review.
---

# Performance Engineering

Use evidence to change the repeated runtime boundary without changing observable
behavior.

## Workflow

1. Name the public boundary, repeated workload, hot path, and data it reads or
   writes.
2. Establish a correctness gate and a representative baseline before changing
   source shape.
3. State one concrete hypothesis: which allocation, copy, lookup, branch, call,
   conversion, or scattered read should disappear?
4. Change one relevant source-shape decision at a time. Prefer explicit state,
   compact hot data, caller-owned or reusable buffers, and preparation outside
   repeated work when the contract supports them.
5. Measure the same boundary, workload, build mode, warmup, worker count, and
   validation conditions before and after.
6. Use one focused secondary probe when it answers the hypothesis: allocation
   counts, trace output, compiler output, disassembly, hardware counters, struct
   layout, or copied-byte accounting.
7. Keep the change only when correctness passes and the relevant boundary
   improves. Report exact commands, results, and remaining unmeasured risk.

## Instrumentation boundary

- Start with existing benchmarks and profiling hooks. For mature repositories,
  put exploratory harnesses in `/tmp` or another ignored scratch location.
- Product code may expose a narrow opt-in signal, but it should not know about
  trace files, report formats, profiler configuration, or dashboards.
- Do not commit exploratory instrumentation unless the user requests retained
  evidence or the repository has an established benchmark area.
- Speed, allocation, and memory claims require measurements. Cleaner source or
  nicer generated code alone is not proof of a workload improvement.

## Review checks

- Correctness covers the caller-visible entrypoint, including important edge
  cases.
- The benchmark exercises the changed path and preserves a checksum or other
  invariant.
- Setup, steady-state work, diagnostics, formatting, and teardown are separated
  when their costs differ.
- A new prepared or reuse-oriented API does not hide a regression in the
  existing public API.
- Compatibility paths, speculative hooks, and permanent scaffolding were not
  added without a current contract.
