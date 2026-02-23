---
description: Signals and refactoring directions for Long Parameter List.
---
# Long Parameter List

Category: Bloaters

## Signals
- Methods require many positional arguments.
- Call sites repeatedly pass the same argument groups.
- API usage is error-prone due to argument overload.

## Typical refactor directions
- Introduce Parameter Object.
- Preserve Whole Object.
- Replace Parameter with Method Call.
