---
name: zig
description: "Performance-first Zig guidance for systems code. Use for Zig speed, allocation, benchmark, batch API, module-readiness, hot-loop, compiler-output, and machine-level performance work. Read the machine-level and benchmarking references first, use compiler/allocation references when the evidence gap needs them, and match the response to the user's request: design discussion, implementation, review, or evidence report."
---

# Zig Performance Evidence

## Purpose

Use this skill to keep Zig performance work tied to source shape, correctness, same-boundary timing, and focused machine evidence.

This skill is an evidence and workflow guide rather than a general Zig style guide. Assume competent Zig by default; use the instructions here to choose the evidence loop, local tools, and reference files.

Keep the user's requested level of commitment. A design or investigation prompt can stay conversational. An implementation prompt should carry the change through correctness, timing, and one targeted low-level check.

## First Reads

For substantial Zig coding, module-readiness, batch API, performance, benchmark, optimization, "too slow", allocation, or hot-loop prompts, begin with:

- `references/machine-level-hypotheses.md`
- `references/benchmarking.md`

Resolve paths from the directory containing this `SKILL.md`.

Use follow-up references only when the evidence gap needs them:

- `references/compiler-evidence.md`: build truth, symbols, assembly, IR, source mapping, CPU tools, and the JSON codegen ladder.
- `references/allocation-evidence.md`: counting allocators, no-allocation tests, setup-vs-hot-loop allocation boundaries, and allocator-symbol checks.

## Operating Loop

Use this loop for concrete Zig performance changes, reviews, benchmark design, or implementation plans:

1. Name the repeated boundary: records, rows, samples, packets, pixels, events, states, buffers, or batches.
2. Name the hot loop and the fields it reads or writes.
3. Separate setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation. Choose a workload that makes the claimed removed cost visible.
4. Define the correctness gate, measured workload, build mode, and checksum or invariant. Prefer a public or import-style gate that exercises the same entrypoint a caller will use.
5. Sketch the source-shape choices: direct table, prepared indexes, active list, fused pass, workspace, or narrow hot struct.
6. State the machine-level hypothesis: which allocation, lookup, branch, copy, call, division, conversion, or scattered load should disappear?
7. Run correctness, same-boundary timing, and one targeted compiler/allocation check when the task reaches implementation or review.
8. Change one thing at a time; use timing for speed claims and compiler/allocation output to validate the source hypothesis.

Fast wrong code is a different program. Preserve observable semantics before claiming performance. If local tests cover only a wrapper, build step, or default module set, add the smallest black-box caller check that imports the public module or calls the public API directly.

## Evidence Gate

When implementing or reviewing a concrete Zig performance change, record:

- public boundary, correctness gate, measured workload, and build mode;
- correctness command covering the public entrypoint;
- optimized timing command when speed, throughput, allocation, or hot-loop behavior is part of the task;
- executable/demo command when required behavior lives outside lazy-analyzed tests;
- optimized benchmark or demo run before final when the submitted program exposes one, even if unit tests already pass;
- one targeted low-level check tied to the hypothesis: `--verbose`, emitted assembly, `nm`, `objdump`, allocation counters, or a no-allocation test;
- exact commands, measured result, and remaining unmeasured risk.

Microbenchmarks and focused codegen are hypothesis evidence, not proof of a workload speedup. Before claiming an improvement, look for the closest realistic retained benchmark, trace, or public workload that could invalidate the claim, and run it when available. If that realistic boundary regresses, is stale, or is not run, say `leaf improved, workload unproven/regressed` and stop source-shape experiments until there is a new measured hypothesis.

When adding a faster sibling API, such as a caller-owned `Into` function or a prepared-state entrypoint, time the exact API named in the claim. A better-shaped benchmark harness or a cleaner internal helper is not enough if the submitted public or hot API is slower on the same workload.

Correctness failures outrank benchmark and codegen evidence. Do not present generated-code cleanup, allocation removal, or faster microbenchmarks as a win until the public semantics gate passes.

For design or investigation turns, use the same boundary and evidence vocabulary while keeping the response at the requested level of commitment.

## Codegen Ladder

Prefer the bundled JSON CLI over ad hoc log reading when a low-level check is useful:

```sh
scripts/codegen-ladder.sh --source src/main.zig --symbol hotFunction --run-arg --bench --json-out "$perf_scratch/codegen.json"
```

Inspect `.decision_card` first with `jq`, then follow relevant high or medium `.next_checks.suggestions[]`. Treat `scripts/codegen_ladder/*.py` as tool-maintenance detail; ordinary skill use should stay at the JSON CLI layer.

Use `scripts/codegen-ladder.sh diff --before before.json --after after.json` for before/after reports. If the diff says the benchmark boundary, workload, checksum, warmup, build mode, or symbol differs, rerun matched benchmarks before making speed claims.

Clean focused compiler output is a handoff point. When `.decision_card.decision == "ceiling_or_source_probe"`, compare a source-level rival only if it changes the work done: direct table versus candidate scan, prepared plan versus one-shot setup, fused pass versus repeated pass, or workspace reuse versus fresh allocation.

## Source-Shape Prompts

Keep these prompts in mind before reaching for deeper assembly:

- Stable controls, rules, weights, plans, caches, or models across many batches usually deserve a prepared boundary and a many-batch benchmark.
- Ordered rule or policy evaluators often want a direct table or prepared first-match index rather than per-item candidate scans.
- When ordered rules use bounded categorical keys or small finite levels, compare a pre-expanded direct lookup that preserves first-match priority against candidate-list scans.
- Caller-owned output or retained workspaces should remove allocation calls, cleanup edges, and capacity growth from repeated boundaries.
- Wide records with cold labels, provenance, diagnostics, or payloads are often better walked by pointer or index when the loop reads only hot fields.
- Diagnostics, formatting, tracing, reports, and final-evaluation artifacts belong outside the steady-state boundary unless the user-visible contract requires them there.
- Threshold wording, caller-owned output semantics, short-buffer behavior, and missing-control behavior are correctness contracts, not performance details.
- Caller-owned batch APIs should make written counts observable: return a result struct with counts/slices or document a shape that a caller can validate without guessing from buffer capacity.
- Caller-owned output should be initialized or reset inside the public call unless accumulation is explicitly part of the API name and contract.

## Convergence

A strong performance edit is a verified improvement with a clear stopping point.

Keep the source shape when correctness passes, same-boundary timing improves or is justified, and the targeted low-level check supports the hypothesis. Explore another source shape when timing regresses, correctness changes, a private cap or fallback cliff appears, or the measured boundary no longer matches the optimized path.

When the public entrypoint remains part of the contract, keep it on the improved path. Add prepared APIs or reused-boundary benchmarks when repeated use is central, while still reporting the public-boundary result.

## Reference Router

- Source-shape intuition and expected compiler symptoms: `references/machine-level-hypotheses.md`.
- Same-boundary benchmark design, optimized build modes, warmup, checksums, and timing reports: `references/benchmarking.md`.
- Build truth, compiler IR, symbols, assembly, address-to-source mapping, CPU hotspot tools, code-size attribution, and codegen ladder examples: `references/compiler-evidence.md`.
- Counting allocators, no-allocation tests, setup-vs-hot-loop allocation boundaries, and allocator-symbol checks: `references/allocation-evidence.md`.
