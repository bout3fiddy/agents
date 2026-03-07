---
name: cloudflare
description: Cloudflare platform skill covering Workers, R2 object storage, web analytics, and observability. Use for Cloudflare development tasks involving these products. Biases towards retrieval from Cloudflare docs over pre-trained knowledge.
---

# Cloudflare Platform Skill

Skill for building on the Cloudflare platform. Use the routing table below to load detailed references.

Your knowledge of Cloudflare APIs, types, limits, and pricing may be outdated. **Prefer retrieval over pre-training** — the references in this skill are starting points, not source of truth.

## Retrieval Sources

Fetch the **latest** information before citing specific numbers, API signatures, or configuration options. Do not rely on baked-in knowledge or these reference files alone.

| Source | How to retrieve | Use for |
|--------|----------------|---------|
| Cloudflare docs | `cloudflare-docs` search tool or `https://developers.cloudflare.com/` | Limits, pricing, API reference, compatibility dates/flags |
| Workers types | `npm pack @cloudflare/workers-types` or check `node_modules` | Type signatures, binding shapes, handler types |
| Wrangler config schema | `node_modules/wrangler/config-schema.json` | Config fields, binding shapes, allowed values |
| Product changelogs | `https://developers.cloudflare.com/changelog/` | Recent changes to limits, features, deprecations |

When a reference file and the docs disagree, **trust the docs**. This is especially important for: numeric limits, pricing tiers, type signatures, and configuration options.

## Routing

| Intent | Reference | Use for |
|--------|-----------|---------|
| Workers code, handlers, bindings, config | [workers/](references/workers/) | API, configuration, patterns, gotchas, frameworks |
| R2 object storage, S3-compatible buckets | [r2/](references/r2/) | API, configuration, patterns, gotchas |
| Client-side RUM, page analytics | [web-analytics/](references/web-analytics/) | Configuration, integration, patterns, gotchas |
| Workers logs, real-time debugging | [observability/](references/observability/) | API, configuration, patterns, gotchas |

For Workers best practices and anti-pattern reviews, load `skills/cloudflare-workers-best-practices/SKILL.md`.
For web performance auditing (Core Web Vitals, Lighthouse), load `skills/cloudflare-web-perf/SKILL.md`.
