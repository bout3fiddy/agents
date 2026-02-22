---
description: Canonical code smell checklist derived from Refactoring.Guru's smells catalog.
---
# Refactoring.Guru Smells Catalog

Source: https://refactoring.guru/refactoring/smells (accessed 2026-02-22)

Use this list to classify findings with exact smell names, then recommend focused refactoring options.

## Bloaters

### Long Method
- Signals: very long functions, mixed responsibilities, deep nesting.
- Typical refactor direction: Extract Method, Replace Temp with Query, Decompose Conditional.

### Large Class
- Signals: classes with too many fields/methods or unrelated responsibilities.
- Typical refactor direction: Extract Class, Extract Interface, Move Method/Field.

### Primitive Obsession
- Signals: overuse of primitives for domain concepts, repeated validation/parsing logic.
- Typical refactor direction: Replace Data Value with Object, Introduce Parameter Object, Replace Type Code with Subclasses/State/Strategy.

### Long Parameter List
- Signals: many positional arguments and repeated argument groups.
- Typical refactor direction: Introduce Parameter Object, Preserve Whole Object, Replace Parameter with Method Call.

### Data Clumps
- Signals: same small field groups appearing together across many methods/classes.
- Typical refactor direction: Extract Class, Introduce Parameter Object.

## Object-Orientation Abusers

### Switch Statements
- Signals: repeated type/enum switches across code paths.
- Typical refactor direction: Replace Conditional with Polymorphism, Replace Type Code with Subclasses/State/Strategy.

### Temporary Field
- Signals: fields set only in certain situations, otherwise unused/null.
- Typical refactor direction: Extract Class, Introduce Null Object.

### Refused Bequest
- Signals: subclasses inheriting methods/fields they do not use or actively reject.
- Typical refactor direction: Replace Inheritance with Delegation, Push Down/Extract methods.

### Alternative Classes with Different Interfaces
- Signals: classes doing equivalent work with incompatible method names/shapes.
- Typical refactor direction: Rename Method, Move Method, Introduce Adapter.

## Change Preventers

### Divergent Change
- Signals: one class repeatedly changed for multiple unrelated reasons.
- Typical refactor direction: Extract Class, Split responsibilities by change axis.

### Shotgun Surgery
- Signals: one logical change requires many tiny edits in many files.
- Typical refactor direction: Move Method/Field, Inline Class, consolidate ownership.

### Parallel Inheritance Hierarchies
- Signals: adding a subtype in one hierarchy forces matching subtype changes in another.
- Typical refactor direction: Collapse hierarchies, Replace Inheritance with Composition.

## Dispensables

### Comments
- Signals: comments explain confusing code instead of intent; commented-out code remains.
- Typical refactor direction: Rename symbols, Extract Method, remove dead/commented code.

### Duplicate Code
- Signals: same logic copied across functions/modules/services.
- Typical refactor direction: Extract Method, Pull Up Method, consolidate shared utilities.

### Lazy Class
- Signals: class abstraction has too little behavior to justify its existence.
- Typical refactor direction: Inline Class, Collapse Hierarchy.

### Data Class
- Signals: classes are mainly getters/setters with little behavior.
- Typical refactor direction: Move behavior to the data owner, Encapsulate/Hide delegation.

### Dead Code
- Signals: unreachable branches, unused functions/types/files, stale flags.
- Typical refactor direction: remove safely with tests and dependency checks.

### Speculative Generality
- Signals: abstractions/hooks built for futures that never arrived.
- Typical refactor direction: Inline Class/Method, remove premature abstraction.

## Couplers

### Feature Envy
- Signals: methods depend more on another object's data than their own.
- Typical refactor direction: Move Method, Extract Method.

### Inappropriate Intimacy
- Signals: classes know too much about each other's internals.
- Typical refactor direction: Hide Delegate, Move Method/Field, tighten boundaries.

### Message Chains
- Signals: long call chains (`a.b().c().d()`) reveal traversal leakage.
- Typical refactor direction: Hide Delegate, Move Method.

### Middle Man
- Signals: class mostly delegates to another class without adding value.
- Typical refactor direction: Remove Middle Man, Inline simple delegation.

### Incomplete Library Class
- Signals: library type needs repeated wrappers/workarounds scattered across code.
- Typical refactor direction: Introduce Extension/Adapter layer in one place.

## Review output format

For each finding, report:
1. Smell name (exact canonical label)
2. Evidence (path + line/function or behavioral proof)
3. Impact (readability, change cost, reliability, performance)
4. Recommended refactoring options
5. Risk/effort estimate

When no smells are found, explicitly say so and mention residual risks/testing gaps.
