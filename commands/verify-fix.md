---
description: "Verify an issue exists and fix it"
argument-hint: "[issue description or file:line reference]"
---

# Verify and Fix

First verify the issue exists, then fix it.

## Step 1: Verify the Issue

1. Read the referenced code
2. Reproduce the problem (run tests, check behavior)
3. Confirm the issue is real, not a false positive

If the issue cannot be verified:
- Report "Issue not reproduced" with evidence
- Stop here

## Step 2: Root Cause Analysis

1. Identify the exact cause
2. Check if the same issue exists elsewhere (DRY violation)
3. Understand the intended behavior

## Step 3: Implement Fix

1. Make the minimal change to fix the issue
2. Don't refactor unrelated code
3. Match existing code style

## Step 4: Add Regression Test

Create a test that:
1. Would have FAILED before the fix
2. PASSES after the fix
3. Prevents regression

## Step 5: Verify Fix

1. Run the new test
2. Run related existing tests
3. Check for side effects

## Step 6: Report

```markdown
## Fix Applied

**Issue**: [description]
**Root Cause**: [what was wrong]
**Fix**: [what was changed]
**Test Added**: [test name]
**Verification**: [test results]
```
