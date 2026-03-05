# Long Parameter List

Category: Bloaters

## Signals
- Methods require many positional arguments.
- Call sites repeatedly pass the same argument groups.
- API usage is error-prone due to argument overload.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Constructor-style function with sprawling argument list

```pseudo
create_user(
    first_name,
    last_name,
    email,
    phone,
    country,
    timezone,
    locale,
    marketing_opt_in
)
```

Reviewer heuristic: long positional calls with weak grouping are prone to swapped arguments and hard-to-read call sites.

## Typical refactor directions
- Introduce Parameter Object.
- Preserve Whole Object.
- Replace Parameter with Method Call.
