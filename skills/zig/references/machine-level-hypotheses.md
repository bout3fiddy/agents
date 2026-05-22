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
| Ordered rule/control table | One keyed load to the selected rule or control | Candidate scan per item, private rule-count cap, or slow fallback above the cap |
| Bounded ordered lookup | Pre-expanded winner table preserving priority | Per-item candidate scan across bounded key combinations |
| Reusable prepared state | Small public wrapper around private dense storage | Public API exposes bit-packed or encoded table details without a semantic name |
| Large item iteration | Pointer or index walk over only consumed fields | By-value copies of wide records carrying labels/provenance/cold fields |
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
- For ordered rule, threshold, or policy evaluators, compare the source-level choices before polishing one path: a direct table keyed by consumed fields, per-key candidate lists or bitsets, and a fallback scan. A bitset can compile neatly and still lose when each item keeps scanning candidates or when a private cap sends larger rule sets to a slower path.
- If the key domain is bounded enough to enumerate, precompute the winning rule/control for each key tuple during preparation and make the hot loop a direct lookup. Preserve ordered semantics by filling only unset slots or by comparing explicit priority during preparation, not by scanning candidates per item.
- For repeated scoring with stable weights or controls, a benchmark over many small batches can reveal setup and per-call overhead that one repeated full-slice call hides. Match the benchmark to the user's reuse shape before deciding which implementation is better.
- Copying a wide record by value is easy to miss in source review. If the struct includes labels, provenance, diagnostics, or padding and the loop reads only numeric fields, iterate by pointer or index and confirm the benchmark still solves the same problem.
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

Broad symbol or assembly greps are useful triage. Performance claims should point to the measured hot symbol, a caller that contains the inlined hot loop, or a runtime counter around the measured boundary. When the claim is allocation-free steady state, a warmed no-allocation test or counting allocator gives stronger evidence than symbol absence alone.

## When The Compiler Surprises You

If compiler output contradicts the source-level story:

- Trust the output enough to revise the hypothesis.
- Re-check that the artifact was built with the same target, CPU, optimize mode, and build step as the benchmark.
- Confirm the inspected symbol is actually reachable from the measured boundary.
- Prefer a smaller source change when the compiler already did the transform.
- Prefer a layout or ownership change when the compiler cannot remove dynamic allocation, lookup, or aliasing by itself.

When focused assembly is clean, move the question up a level. Compare the same workload before and after, check whether runtime controls were accidentally optimized as literals, and look for source shapes that change the amount of work: prepared control tables, fused passes, caller-owned workspaces, narrower hot structs, and bounded top-k state. If those checks show no stronger source shape for the public contract, keep the simple implementation and report that ceiling clearly. When the codegen ladder is available, `.decision_card.decision == "ceiling_or_source_probe"` is the cue for that source-level comparison.

Clean compiler evidence for one design is not a comparison against the best design. For runtime control tables, include one rival shape in the evidence loop when the first attempt introduces a cap, fallback, candidate scan, large stack table, or extra public API. Useful probes are small: rule count at the benchmark size, rule count just above any fast-path cap, prepared-state size, and same-boundary elapsed time with matching checksum.

Converge once a shape is good enough for the contract. If the public boundary is faster, correctness gates pass, and focused compiler evidence matches the hypothesis, keep the implementation and put additional ideas in the report. Continue the source-shape search when timing regresses, correctness changes, a private cap appears, or the measured boundary no longer matches the optimized path.

Threshold comparisons are part of the source hypothesis. Strict versus inclusive boundaries can change both correctness and active-set size, so confirm the wording from prompts and tests before interpreting timing. An equal-to-threshold regression is cheap and prevents benchmark comparisons from measuring different work.

Diagnostic allocation removal can also be a behavior change. If the old debug path could fail with `OutOfMemory`, decide whether that failure is contractual before replacing heap formatting with bounded stack formatting, then cover the active diagnostic case.

Summary words carry ordering semantics. A `latest_tick` or `max_timestamp` field should usually mean the maximum value seen, not the last arrival in the current input order; use an out-of-order regression when optimizing dense decoders or bounded top-k summaries.

Caller-owned slices usually mean "write the result here." For batch analyzers, initialize returned stats inside the public API and validate stats/output lengths with typed errors before relying on the storage. Accumulation across batches is a different contract and deserves a distinct function name or explicit option.

Never read, increment, or summarize caller-owned result storage before establishing its initial value for this call. Undefined or stale caller memory can make benchmarks look fast while black-box callers observe accumulated counts, arbitrary totals, or old output slots.

Make caller-owned output counts part of the semantic shape. Returning only a capacity-sized buffer or an unqualified slice can make it ambiguous whether the caller should read all slots, accepted slots, alert slots, or a derived count. Prefer a small result struct such as counts plus narrowed output slices when the function writes variable-length results.

Variable-length outputs need a capacity story. When every accepted item can produce an alert or match, a worst-case preflight is often the simplest correctness shape. When the exact count is much smaller and the API needs all-or-nothing writes, use a count/prepare pass and measure whether the extra pass is worth the cleaner contract.

Heap formatting in a repeated scoring or diagnostic path is both a semantics and machine-level question. If the string is part of the contract, prefer bounded caller-owned or stack formatting with explicit truncation/error behavior; if it is only benchmark reporting, keep it outside the timed boundary.

For grid and stencil kernels, boundary checks can be the remaining machine problem after allocation and calls disappear. A split interior loop removes edge branches from most cells; a single loop can still win for small images or simple kernels. Treat the split as a hypothesis and keep the faster same-boundary version.

Arithmetic width is a machine-level choice. If a kernel sums a bounded number of `u8` values, prove the maximum score and use the smallest type that safely holds it; widening every pixel to `u32` can add register pressure or extra instructions without improving correctness. Raw pointers are similar: slices in ReleaseFast may already compile to clean address arithmetic, so switch to pointers only when focused output or timing shows a benefit.

Good Zig performance work is a loop: source hypothesis, correctness gate, focused compiler evidence, same-boundary timing, and a clear statement of what remains unmeasured.
