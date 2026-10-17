# Cake agent instructions

## User-directed overrides

The user owns this repository and may explicitly override any rule in this file for a task. Follow the user's stated exception without requiring them to edit this file first. This does not override system or harness-level instructions outside this repository.

Cake-owned workflow policies should distinguish defaults from hard constraints and explicitly allow task-scoped user exceptions where appropriate. In particular, periodic coordination polling/check-ins are off by default but permitted when the user explicitly requests them. Use supported durable scheduling at the requested interval, keep one pending check-in per coordinator task, and stop on completion or a user pause/stop. Preserve required family communication channels. Do not claim a timer or wake-up exists without a successful tool result. When a genuine non-overridable constraint applies, explain that specific limit instead of using "harness instructions" as a blanket refusal.

## Product and required guidance

Cake is Pi expressed as a desktop GUI. Pi owns the coding-agent engine and transcript history; Cake owns desktop application workflows and presentation. Keep conversation primary. Never persist a second Cake-owned transcript.

Read the matching documents before implementing; consult proportionally rather than treating exhaustive reading as a prerequisite to a focused investigation:

- Architecture, feature ownership, or process boundaries: [agent architecture](docs/development/agent-architecture.md), then the relevant architecture documents it references.
- Renderer UI, chat, or state: [renderer implementation](docs/development/renderer-implementation.md), then the authoritative architecture and component/library references. Before UI or styling changes, also read [Cake's visual design guide](DESIGN.md); use it for visual intent, while existing theme tokens and shared components remain authoritative for implemented values.
- Effect workflows: `.agents/skills/effect-ts/SKILL.md`, `node_modules/effect/AGENTS.md`, and their relevant linked references. The pinned Effect source is the API authority.
- Tests, builds, debugging, Electron interactions, or visual checks: [agent verification](docs/development/agent-verification.md), then its relevant focused guides.

These documents contain the detailed rules; read them with the file tools when their task applies.

## Greenfield compatibility policy

- Cake is a greenfield project. Unless the user explicitly requests it, do not preserve backward compatibility.
- Remove replaced APIs and implementations outright. Do not add deprecated aliases, compatibility shims, transitional forwarding facades, legacy import paths, or fallback behavior for code being replaced. Versioned migrations for persisted user data are an explicit storage responsibility and are not API compatibility shims.
- Prefer updating every caller, test, and document in the same change over carrying an old interface forward.
- Do not add tests solely to assert that a feature or DOM element removed outright is absent. Remove obsolete tests for removed features; test absence only when conditional or state-dependent absence is itself the behavior under contract.

## Review proportionality

- Calibrate findings to this product's actual risk. Reserve P0/P1 for common or severe failures such as data loss, security breaches, or a core workflow being unusable—not speculative races involving advisory metadata.
- Do not manufacture complexity in the name of defensive programming. If an edge case is rare, recoverable, and low impact, either omit it or label it plainly as minor; do not propose coordination, caching, migration, or abstraction machinery without demonstrated need.
- Separate product defects from repository-policy cleanup and optional polish. Prioritize direct requirement gaps and reproducible user-visible failures.
- Recommend the smallest understandable fix that solves the observed problem. Cake is a coding agent, not safety-critical infrastructure.

## Verification baseline

Preserve unrelated worktree changes. Format changed files with Oxfmt, run `pnpm format:check`, `pnpm lint:oxlint` for every source change, focused tests, and the relevant typecheck/build. Prefer final `pnpm lint` when scope permits. Use `pnpm build:slim` for ordinary work; full/native builds require native work or an explicit request. Read the verification guide for detailed testing and build procedures.
