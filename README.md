# 🌙 Night Crew

> Move a card into **Queue** — wake up to merged PRs.

Night Crew is an autonomous agent daemon that watches your Trello board, picks up queued cards, invokes Claude Code to do the work, opens a GitHub PR, and moves the card to Human Review. Zero API credits. Uses your signed-in Claude Code CLI. Supports single repos, multi-repo workspaces, and monorepos with per-package isolation.

---

## How It Works

```
You drop cards into Queue before bed.

Night Crew wakes up every 2 minutes, finds them,
spins up isolated git worktrees, invokes Claude Code,
commits the changes, opens draft PRs, and parks the
cards in Human Review for your morning review.
```

### Board layout

Set up these columns on your Trello board:

```
Backlog  →  Queue  →  In Progress  →  Plan Review  →  Approved  →  Human Review  →  Done
```

| Column           | Who moves cards here | Purpose                                         |
| ---------------- | -------------------- | ----------------------------------------------- |
| **Queue**        | You                  | Cards ready for the agent to pick up            |
| **In Progress**  | Daemon               | Automatically set while agent is working        |
| **Plan Review**  | Daemon               | Agent-written plan parked here for your review  |
| **Approved**     | You                  | Move from Plan Review to trigger code execution |
| **Human Review** | Daemon               | PR is open and ready for your review            |
| **Done**         | You                  | After you merge and close                       |

---

## Prerequisites

| Tool                                  | Install                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| [Bun](https://bun.sh)                 | `curl -fsSL https://bun.sh/install \| bash`             |
| [Claude Code](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` then sign in |
| [GitHub CLI](https://cli.github.com)  | `brew install gh` then `gh auth login`                  |
| Git                                   | Pre-installed on most systems                           |

---

## Setup

### 1. Get Trello credentials

1. API key → https://trello.com/app-key
2. Token → click the **Token** link on that same page
3. Board ID → open your Trello board, append `.json` to the URL, copy the top-level `id` field

### 2. Find your List IDs

```bash
TRELLO_API_KEY=your_key TRELLO_TOKEN=your_token bun run setup YOUR_BOARD_ID
```

This prints every list name and ID on the board.

### 3. Configure

```bash
cp projects.example.json projects.json
```

Edit `projects.json` with your credentials, list IDs, and repo paths. See the [Configuration Reference](#configuration-reference) section below.

### 4. Verify tools are ready

```bash
claude --print "Say hello"   # must respond without prompting for login
gh auth status               # must show authenticated
```

### 5. Start

```bash
bun start
```

For overnight / always-on use, run inside tmux so it survives terminal closes:

```bash
tmux new-session -s nightcrew
bun start
# Ctrl+B then D to detach
# tmux attach -t nightcrew to return
```

---

## Card Syntax

Add an ` ```agent ` block at the top of any card description to control how the agent handles it. Everything below the block is the task description passed to Claude.

**All directives are optional.** A card with no agent block uses all defaults — the agent just picks it up and gets it done.

### Simple card (no directives needed)

```
Title: Fix typo in onboarding copy

Change "Welcom to the app" to "Welcome to the app" in
src/screens/OnboardingScreen.tsx
```

### Card with directives

````
Title: Add forgot password flow

```agent
mode: plan-execute
repo: platform
package: web
tests: write-new
think: deep
context: src/screens/auth/**, src/api/auth.ts
```

When the user taps "Forgot Password" on the login screen, show a modal
asking for their email. POST to /api/auth/forgot-password. On success
show a confirmation message. On error show the API error.

Use the existing Modal component from src/components/Modal.tsx.
````

### Directive reference

| Directive      | Options                                  | Default        | Description                                                                      |
| -------------- | ---------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `mode`         | `gsd`, `plan`, `plan-execute`, `careful` | `gsd`          | How the agent approaches the task                                                |
| `repo`         | any alias from `repos` in config         | `defaultRepo`  | Which repo to work in                                                            |
| `package`      | any alias from `packages` in repo config | —              | Which monorepo package to target                                                 |
| `context`      | comma-separated glob paths               | —              | Hint to the agent where to look first                                            |
| `ignore`       | comma-separated glob paths               | —              | Paths the agent must not touch                                                   |
| `tests`        | `required`, `skip`, `write-new`          | `required`     | Test behaviour                                                                   |
| `concurrency`  | `solo`, `exclusive`, `low`               | `solo`         | Slot priority                                                                    |
| `max-attempts` | integer                                  | `1`            | Times to retry before giving up                                                  |
| `on-failure`   | `queue`, `notify`                        | `queue`        | On failure: bounce back to Queue, or stay In Progress                            |
| `pr`           | `draft`, `ready`, `skip`                 | `draft`        | PR creation mode                                                                 |
| `branch`       | any string                               | auto-generated | Override the branch name                                                         |
| `think`        | `fast`, `deep`                           | `fast`         | Reasoning depth — deep is slower but better for complex tasks                    |
| `persona`      | `strict`, `creative`                     | `strict`       | Strict: follow description exactly. Creative: agent may propose better solutions |

### Mode behaviours

| Mode           | What happens                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `gsd`          | Agent reads card, writes code, commits, opens PR → **Human Review**                                       |
| `careful`      | Like `gsd` but writes/updates tests first and adds comments to every changed function                     |
| `plan`         | Agent reads the repo, writes an implementation plan as a card comment → **Plan Review** (no code written) |
| `plan-execute` | Same as `plan`, but once you move the card to **Approved**, the agent executes the plan → PR              |

---

## Multi-Repo Support

One board can dispatch to multiple repos. Define them as named aliases under `repos` in `projects.json` and reference them with `repo:` on cards.

### Config

```json
{
  "defaultRepo": "platform",
  "repos": {
    "platform": {
      "path": "/Users/alex/code/platform",
      "baseBranch": "main",
      "systemContext": "React/Bun/TypeScript. Run `bun test` to validate."
    },
    "api": {
      "path": "/Users/alex/code/api",
      "baseBranch": "develop",
      "systemContext": "Hono API. Use Zod for validation. Run `bun test`."
    },
    "marketing": {
      "path": "/Users/alex/code/marketing",
      "baseBranch": "main",
      "systemContext": "Next.js. Tailwind. Keep components simple."
    }
  }
}
```

### Cards

````
```agent
repo: api
```
Add a health check endpoint at GET /health
````

Cards without a `repo:` directive use `defaultRepo`. Multiple cards targeting different repos run in parallel — each agent works in its own isolated git worktree.

---

## Monorepo Support

Night Crew has first-class monorepo support. Enable it with `"monorepo": true` on a repo config, define your packages, and use `package:` on cards to scope agents to the right part of the codebase.

### How it works

- Each agent runs Claude Code from inside the target package directory (e.g. `apps/api/`) with the package's test command and context
- Git worktrees are still created at the repo root so cross-package commits work correctly
- `dangerousPackages` are serialized — only one agent at a time per dangerous package, no matter how many cards are queued
- If `packageRequired: true`, cards without a `package:` directive post a helpful error comment and stay in Queue

### Config

```json
{
  "repos": {
    "platform": {
      "path": "/Users/alex/code/platform",
      "baseBranch": "main",
      "systemContext": "Turborepo monorepo. TypeScript throughout.",

      "monorepo": true,
      "packageRequired": true,
      "rootTestCmd": "bun run test",

      "dangerousPackages": ["packages/shared", "packages/config"],

      "packages": {
        "web": {
          "path": "apps/web",
          "testCmd": "bun test",
          "systemContext": "React 19, Tailwind v4. Components in src/components/."
        },
        "api": {
          "path": "apps/api",
          "testCmd": "bun test",
          "systemContext": "Hono API. Routes in src/routes/. Use Zod for validation."
        },
        "mobile": {
          "path": "apps/mobile",
          "testCmd": "bun test",
          "systemContext": "Expo / React Native. Use NativeWind for styling."
        },
        "shared": {
          "path": "packages/shared",
          "testCmd": "bun test",
          "systemContext": "Shared types and utilities. Do not remove or rename exports."
        },
        "root": {
          "path": ".",
          "testCmd": "bun run test",
          "systemContext": "Use for cross-package work: CI config, root tooling, dependency updates."
        }
      }
    }
  }
}
```

### Monorepo config options

| Field               | Type                                | Description                                                                        |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `monorepo`          | `boolean`                           | Enables package-aware mode                                                         |
| `packages`          | `Record<string, MonoPackageConfig>` | Named packages — each with `path`, `testCmd`, `systemContext`                      |
| `packageRequired`   | `boolean`                           | If `true`, cards without `package:` error with a helpful comment                   |
| `dangerousPackages` | `string[]`                          | Package paths that serialize (one agent at a time) and get extra warnings injected |
| `rootTestCmd`       | `string`                            | Test command run from repo root for cross-package or root-level work               |

### Monorepo card examples

**Simple feature in a single package:**

````
Title: Add dark mode toggle to settings screen

```agent
repo: platform
package: web
tests: required
context: src/screens/Settings.tsx, src/components/Toggle.tsx
```

Add a dark mode toggle to the Settings screen. Persist the preference
to localStorage. Apply it via a `dark` class on the root element.
Use the existing Toggle component.
````

**Complex task — plan first before touching shared code:**

````
Title: Add UserPreferences type to shared package

```agent
repo: platform
package: shared
mode: plan-execute
think: deep
```

Add a `UserPreferences` interface to packages/shared/src/types.ts.
It should include: theme (light/dark/system), locale (string),
notifications (boolean). Export it from the package index.

This type will be consumed by web, api, and mobile — plan carefully
before making any changes.
````

**Cross-package / root-level work:**

````
Title: Upgrade all packages to React 19

```agent
repo: platform
package: root
mode: plan
think: deep
```

Audit all packages for React 18 dependencies and plan the upgrade
path to React 19. Flag any breaking changes or packages that need
separate migration steps.
````

**Parallel overnight batch — all safe to run at the same time:**

```
Card 1: "Add loading skeleton to feed"      package: web
Card 2: "Add pagination to /posts endpoint" package: api
Card 3: "Fix crash on Android back gesture" package: mobile
```

All three run simultaneously. Each agent works in its own worktree, in its own package directory, with its own test command.

### Dangerous packages

Packages listed in `dangerousPackages` (typically shared utilities, config packages, or anything that affects the whole codebase) are treated specially:

- Only **one agent at a time** can work in that package — additional cards targeting it stay in Queue and are picked up automatically once the current job completes
- A warning is injected into the agent's prompt: _"This is a shared dependency. Changes here affect all packages. Do not remove or rename existing exports."_
- Cards targeting dangerous packages with `mode: plan` or `mode: plan-execute` are strongly recommended

---

## Parallel Execution

Night Crew is designed to run many agents at once. Here's how concurrency works:

- `maxConcurrent` in `projects.json` controls the total number of simultaneous agents for a project
- Different repos run in fully independent worktrees — no conflict possible
- Same monorepo, different packages — fully parallel, each agent scoped to its package directory
- Same monorepo, same `dangerousPackage` — serialized, one at a time
- Approved (plan-execute second pass) jobs run outside the `maxConcurrent` pool

**Recommended settings:**

| Machine                     | `maxConcurrent` |
| --------------------------- | --------------- |
| Laptop, light overnight use | `2`             |
| Laptop, aggressive batch    | `3`             |
| Dedicated desktop / server  | `4–5`           |

> Claude Code spawns a full process per agent. Beyond ~5 concurrent you'll see RAM and CPU pressure, and may hit Claude's concurrent session limits.

---

## Writing Good Cards

The agent is only as good as your descriptions. More context = better code.

### What to include

- **What** you want built or changed
- **Where** the relevant code lives (file paths, component names)
- **How** it should work (API contracts, existing patterns to follow)
- **Why** if it affects architectural decisions

### Use checklists for multi-step tasks

Trello checklists are read by the agent and treated as ordered sub-tasks:

```
Title: Implement email verification flow

Checklist — Steps:
[ ] Add verified_at column to users table (migration)
[ ] Send verification email on signup via EmailService
[ ] Add GET /auth/verify?token=... endpoint
[ ] Redirect to app on success, show error on invalid token
[ ] Add resend verification email button to settings
```

### Card quality examples

**Good — specific, contextual:**

````
Title: Add rate limiting to password reset

```agent
repo: platform
package: api
tests: write-new
context: src/routes/auth/**
```

Rate limit POST /auth/reset-password to 3 attempts per hour per email.
Use the existing Redis client at src/lib/redis.ts.
Return HTTP 429 with a Retry-After header when exceeded.
Match the error format used in src/routes/auth/login.ts.
````

**Less good — vague:**

```
Title: rate limit password reset
```

**Good — dangerous shared package with plan mode:**

````
Title: Add CurrencyAmount type to shared

```agent
repo: platform
package: shared
mode: plan-execute
think: deep
```

Add a `CurrencyAmount` type: `{ amount: number; currency: "USD" | "GBP" | "EUR" }`.
Export it from packages/shared/src/index.ts.
Do not change any existing exports.
````

---

## Configuration Reference

### Full `projects.json` structure

```json
[
  {
    "id": "my-workspace",

    "trelloApiKey": "...",
    "trelloToken": "...",
    "trelloBoardId": "...",

    "queueListId": "...",
    "inProgressListId": "...",
    "planReviewListId": "...",
    "approvedListId": "...",
    "humanReviewListId": "...",

    "defaultRepo": "platform",
    "maxConcurrent": 3,

    "repos": {
      "platform": {
        "path": "/absolute/path/to/repo",
        "baseBranch": "main",
        "systemContext": "Optional: injected into every prompt for this repo",

        "monorepo": true,
        "packageRequired": true,
        "rootTestCmd": "bun run test",
        "dangerousPackages": ["packages/shared"],

        "packages": {
          "web": {
            "path": "apps/web",
            "testCmd": "bun test",
            "systemContext": "Optional: package-specific context"
          }
        }
      }
    }
  }
]
```

### Project-level fields

| Field               | Required | Description                                        |
| ------------------- | -------- | -------------------------------------------------- |
| `id`                | ✅       | Unique identifier shown in logs                    |
| `trelloApiKey`      | ✅       | Trello API key                                     |
| `trelloToken`       | ✅       | Trello auth token                                  |
| `trelloBoardId`     | ✅       | Board ID                                           |
| `queueListId`       | ✅       | ID of your Queue column                            |
| `inProgressListId`  | ✅       | ID of your In Progress column                      |
| `planReviewListId`  | ✅       | ID of your Plan Review column                      |
| `approvedListId`    | ✅       | ID of your Approved column                         |
| `humanReviewListId` | ✅       | ID of your Human Review column                     |
| `defaultRepo`       | ✅       | Repo alias used when card has no `repo:` directive |
| `maxConcurrent`     | —        | Max simultaneous agents (default: `2`)             |
| `repos`             | ✅       | Map of repo alias → repo config                    |

### Repo-level fields

| Field               | Required | Description                                         |
| ------------------- | -------- | --------------------------------------------------- |
| `path`              | ✅       | Absolute path to the repo on disk                   |
| `baseBranch`        | ✅       | Branch agents branch off from and PRs target        |
| `systemContext`     | —        | Injected into every agent prompt for this repo      |
| `monorepo`          | —        | Enable monorepo mode (default: `false`)             |
| `packages`          | —        | Package definitions (required if `monorepo: true`)  |
| `packageRequired`   | —        | Error on cards without `package:` directive         |
| `dangerousPackages` | —        | Package paths to serialize and add caution warnings |
| `rootTestCmd`       | —        | Test command for root-level work                    |

### Package-level fields

| Field           | Required | Description                                   |
| --------------- | -------- | --------------------------------------------- |
| `path`          | ✅       | Relative path from repo root, e.g. `apps/web` |
| `testCmd`       | —        | Test command run from within this package     |
| `systemContext` | —        | Injected in addition to repo-level context    |

---

## Troubleshooting

| Symptom                               | Fix                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Card bounces back to Queue            | Check daemon logs for the full error                                                                                  |
| "Unknown repo alias"                  | `repo:` value must match a key in `repos` config                                                                      |
| "Unknown package"                     | `package:` value must match a key in `packages` config                                                                |
| "Package required" comment on card    | Repo has `packageRequired: true` — add `package:` to your agent block                                                 |
| "No changes to commit"                | Card description too vague — add file paths, more detail                                                              |
| Worktree errors on restart            | Run `git worktree prune` in your repo                                                                                 |
| `gh` errors                           | Run `gh auth login`, check you have write access to the repo                                                          |
| Claude not responding                 | Run `claude --print "hello"` to verify sign-in status                                                                 |
| Dangerous package card stuck in Queue | Another agent is currently working in that package — it will be picked up automatically when the current job finishes |

---

## File Structure

````
src/
  daemon.ts       — Polling loop, job dispatch, concurrency tracking, plan/execute routing
  agent.ts        — Worktree lifecycle, Claude Code invocation, PR creation
  config.ts       — Types, monorepo resolver, projects.json loader
  directives.ts   — ```agent block parser and defaults
  trello.ts       — Trello REST API client
  github.ts       — gh CLI helpers
  logger.ts       — Timestamped console logger
  setup.ts        — One-time helper to find Trello list IDs
projects.example.json
package.json
````
