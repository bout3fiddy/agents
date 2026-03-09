---
name: workos
description: Identify which WorkOS reference to load based on the user's task — covers AuthKit, Python SDK, SSO, directory sync, management, and API references.
---

# WorkOS Skill Router

## How to Use

When a user needs help with WorkOS, consult the tables below to route to the right reference.

## Loading References

**All references** are topic files in the `references/` directory. Read the file and follow its instructions (fetch docs first, then use gotchas to avoid common traps).

## Topic → Reference Map

### AuthKit (Read `references/{name}.md`)

| User wants to...               | Read file                                |
| ------------------------------ | ---------------------------------------- |
| AuthKit architecture reference | `references/workos-authkit-base.md`      |
| Install AuthKit in vanilla JS  | `references/workos-authkit-vanilla-js.md`|
| AuthKit API Reference          | `references/workos-api-authkit.md`       |

### Backend SDK (Read `references/{name}.md`)

| User wants to...               | Read file                    |
| ------------------------------ | ---------------------------- |
| Install AuthKit in Python      | `references/workos-python.md`|

### Features (Read `references/{name}.md`)

| User wants to...           | Read file                             |
| -------------------------- | ------------------------------------- |
| Configure Single Sign-On   | `references/workos-sso.md`            |
| Set up Directory Sync      | `references/workos-directory-sync.md` |
| Set up Audit Logs          | `references/workos-audit-logs.md`     |
| Enable Admin Portal        | `references/workos-admin-portal.md`   |
| Configure email delivery   | `references/workos-email.md`          |
| Set up IdP integration     | `references/workos-integrations.md`   |

### Management (Read `references/{name}.md`)

| User wants to...                         | Read file                         |
| ---------------------------------------- | --------------------------------- |
| Manage WorkOS resources via CLI commands | `references/workos-management.md` |

## Routing Decision Tree

Apply these rules in order. First match wins.

### 1. API Reference Request

**Triggers**: User explicitly asks about "API endpoints", "request format", "response schema", "API reference".

**Action**: For features with topic files (SSO, Directory Sync, Audit Logs, Admin Portal), read the feature topic file — it includes an endpoint table. For AuthKit API, read `references/workos-api-authkit.md`.

### 2. Feature-Specific Request

**Triggers**: User mentions a specific WorkOS feature by name (SSO, Directory Sync, Audit Logs, Admin Portal, Email, Integrations).

**Action**: Read `references/workos-[feature].md` where `[feature]` is the lowercase slug.

### 3. AuthKit Installation

**Triggers**: User mentions authentication setup, login flow, sign-up, session management, or explicitly says "AuthKit".

**Action**: For Python projects, read `references/workos-python.md`. For vanilla JS / general, read `references/workos-authkit-vanilla-js.md`. For architecture questions, read `references/workos-authkit-base.md`.

### 4. Integration Setup

**Triggers**: User mentions connecting to external IdPs, configuring third-party integrations.

**Action**: Read `references/workos-integrations.md`.

### 5. Management / CLI Operations

**Triggers**: User mentions managing WorkOS resources (organizations, users, roles, permissions).

**Action**: Read `references/workos-management.md`.

### 6. Vague or General Request

**Triggers**: User says "help with WorkOS", "WorkOS setup", or provides no feature-specific context.

**Action**:
1. WebFetch https://workos.com/docs/llms.txt
2. Summarize capabilities and ASK the user what they want to accomplish.

**Do NOT guess a feature** — force disambiguation by showing options.
