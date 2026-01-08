---
description: "Run one iteration of DRY-SOLID refactoring"
argument-hint: "[path to refactor doc or module name]"
---

# DRY-SOLID Refactoring Loop - Single Iteration

Process ONE refactoring item, respecting dependencies.

## Step 1: Load the Refactor Doc or Identify Target

If argument provided, use that path/module. Otherwise, look for:
- `docs/refactor-*.md` files
- Or analyze current file for DRY/SOLID violations

## Step 2: Select Next Item (Dependency-Aware)

Parse all `[ ]` (pending) items. Select the BEST next item:

### Priority Order:
1. **Highest priority first**: Critical > High > Medium > Low
2. **Within same priority, prefer items with no pending dependencies**
3. **Skip blocked items**: If an item depends on a failed/blocked item, skip it

## Step 3: Execute the Refactor

### 3a. Read and Analyze
1. Read the target file completely
2. Identify the exact code that violates the principle
3. Find similar patterns in codebase to follow

### 3b. Plan the Fix

| Violation | Required Pattern |
|-----------|-----------------|
| **DRY** | Extract duplicated logic into reusable function/class |
| **SRP** | Split large class into focused classes (<200 LOC each) |
| **OCP** | Add Protocol/ABC for extension, use strategy pattern |
| **LSP** | Ensure subclasses fully honor parent contracts |
| **ISP** | Break large interface into smaller focused ones |
| **DIP** | Accept dependencies via constructor, use Protocols |

### 3c. Implement
- Make MINIMAL changes - only fix this specific violation
- Do NOT refactor unrelated code
- Match existing code style

### 3d. Add Tests (MANDATORY)

**DO test:**
- Business logic behavior (inputs → outputs)
- Edge cases (empty, None, boundary values)
- Error conditions

**DO NOT test:**
- Private methods
- Implementation details
- Exact mock call counts

## Step 4: Verify

Run type checking and tests on changed files.

## Step 5: Report

```
## Refactoring Complete

**Item**: [file.py violation type]
**Fix**: [what was done]
**Files Changed**: [list]
**Tests Added**: [list]
```
