# Machine-Level Hypotheses

Use this reference when the task is performance-sensitive and the next step is deciding what shape the code should have. Assembly and compiler output are useful when they answer one concrete question about whether the machine problem became simpler.

## Hypothesis Template

Before editing, write a short hypothesis:

```text
Boundary: analyzeSamplesInto, one batch after setup
Source change: prepare thresholds into enum-indexed dense storage
Expected machine symptom: hash-map and threshold-scan calls absent from the hot symbol; direct indexed loads by kind
Correctness gate: existing tests plus black-box threshold cases
Timing gate: ReleaseFast same-boundary benchmark with checksum
Risk: code size may grow from unrolling or specialization
```

Good hypotheses name both source and machine symptoms. "Use a cache" is vague. "Replace per-sample hash lookup with prepared dense indexes and confirm no hash-map/grow call remains under the hot symbol" is useful.

## Common Source Shapes And Machine Symptoms

| Source shape | Good machine symptom | Suspicious machine symptom |
| --- | --- | --- |
| Caller-owned output | Allocator-free hot symbol with clean ownership edges | `alloc`, `free`, `munmap`, `ensureTotalCapacity`, or error-cleanup branches |
| Prepared dense table | Direct indexed loads or active list walk | Hash-map probe, sort, string compare, repeated linear scan |
| Mode-specialized function | Smaller hot symbol or one branch-free loop body | A large combined symbol with both rare and common paths |
| Invariant runtime flag | One branch before the loop or separated loop bodies | Flag branch inside the per-item loop |
| Struct-of-arrays | Fewer scattered loads for loops consuming one field | Repeated wide record loads or pointer chasing |
| Bounded top-k | Fixed small storage and predictable compare path | Full sort or allocation per batch |
| Reused workspace | Growth only during setup or capacity changes | Grow path reachable during steady state |

Treat these as questions until confirmed. The compiler may already turn a source branch into separate loop bodies, or it may keep a helper call because aliasing, error handling, safety, or visibility prevents the transform you expected.

For stats-plus-output analyzers, prepare the tiny control table first, then make each sample or record do one pass that updates stats, checks thresholds, and writes alerts or classifications. The machine-level target is one streaming hot loop rather than separate stats and alert passes over the same data.

## Empirical Intuition

Use these as prompts for what to check; benchmark claims still come from the current code and machine.

- A dense prepared lookup can remove an inner dynamic scan, but the resulting symbol can be larger because LLVM may unroll or specialize the direct-index loop. Check both timing and code size when the hot binary footprint matters.
- An invariant boolean may already compile into separated loop bodies. Specialization can still reduce symbol size, while the branch itself may be less central than it first appears.
- Caller-owned output removes more than allocator time. It removes allocation calls, failure paths, cleanup edges, and allocator metadata traffic from the hot symbol. Return-allocated transforms can still vectorize arithmetic while carrying allocator and deallocation calls.
- Dynamic containers usually leave fingerprints. Hash-map growth, capacity checks, sort helpers, string compares, formatting helpers, and allocator calls are often visible in symbols or focused disassembly.
- Linked executables may hide the helper you want to inspect because it was inlined, folded, stripped, or not exported. Emitted assembly can show pre-link functions; a temporary dynamic library with exported functions can preserve symbols for focused disassembly.
- CPU sampling needs a long enough run. A short benchmark may finish before `sample` or Instruments catches the hot line. Increase iteration count for profiler investigation, then keep final runtime numbers from a low-overhead benchmark.

## Reading Assembly Productively

Read generated output one question at a time:

- "Does this hot symbol still call an allocator?"
- "Is there a branch on this mode inside the per-item loop?"
- "Did the helper inline?"
- "Did the direct-index table replace the dynamic lookup?"
- "Is this loop using multiply-add/vector instructions or scalar calls?"
- "Did formatting, diagnostics, tracing, or panic paths survive in the hot symbol?"

Then extract one symbol, grep for the relevant instructions or calls, and stop when the question is answered.

## When The Compiler Surprises You

If compiler output contradicts the source-level story:

- Trust the output enough to revise the hypothesis.
- Re-check that the artifact was built with the same target, CPU, optimize mode, and build step as the benchmark.
- Confirm the inspected symbol is actually reachable from the measured boundary.
- Prefer a smaller source change when the compiler already did the transform.
- Prefer a layout or ownership change when the compiler cannot remove dynamic allocation, lookup, or aliasing by itself.

Good Zig performance work is a loop: source hypothesis, correctness gate, focused compiler evidence, same-boundary timing, and a clear statement of what remains unmeasured.
