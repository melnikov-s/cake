# Cake development

Cake is Pi's desktop GUI. Pi owns execution/transcripts; Cake owns workflows/presentation. Never persist a second transcript.

Current explicit user direction overrides Cake workflow defaults, including family channels/check-ins, not security boundaries or tool limits. No instruction-file edit or repeated approval needed. Name concrete limits; verify execution, not just posting. Poll only when requested; cancel check-ins on completion/stop.

## Implement

- Keep conversation primary. Cut helper copy; fix confusing layouts.
- Consult only relevant docs as needed: `docs/development/agent-architecture.md`, `renderer-implementation.md`, `agent-verification.md`. No prerequisite reading chain. UI changes use `DESIGN.md` and existing tokens/components. Effect work uses the local effect-ts skill and pinned Effect API.
- System-prompt authoring/review: use the [style standard and golden example](docs/development/agent-architecture.md#system-prompt-style).
- Settings need discoverable tool read/write parity through the UI's validation, authority, persistence and live updates. Test coverage against omissions. Credentials, user permissions and OS-only actions stay user-owned; document gaps.
- Greenfield: remove replaced APIs outright; update callers/tests/docs. No compatibility facades unless requested. Persisted-data migrations remain separate.
- Preserve unrelated changes. Don't add hypothetical race/security machinery: explain concrete risk and complexity simply, then wait for approval. Prefer the smallest observed fix.

## Verify

Choose acceptance checks up front by behavior/risk. New scope needs explicit cost discussion. Defer validation (tests, typechecks, lint, builds) until implementation is complete; run required checks together at the end, not after each edit.

- Oxfmt changed files; `pnpm format:check`. Source: `pnpm lint:oxlint`, focused tests; prefer final `pnpm lint`.
- Behavior/state/contract/config changes: final `pnpm typecheck && pnpm test`. Batch broad checks once; rerun only if invalidated.
- Copy/layout-only: focused checks, no full suite. Search tests for changed text and run matches. UI proof uses repository visual/Electron harnesses; focus/selection requires isolated Electron. Docs-only: formatting/links.
- Ordinary builds: `pnpm build:slim`. Full/native builds only when required/requested. Never inspect/debug/inject into the user's running Cake; launch an isolated instance. Never focus test windows without permission.
- Failures don't expand scope. Fix attributable regressions; report others as unclassified blockers. Claim pre-existing only after reproducing on named base commit/test.
- After two failed hypotheses/repair cycles on one blocker, stop and report evidence plus smallest next experiment. Never weaken tests.

Report implementation, focused checks, broad blockers and readiness separately. Checkpoint commits may retain unresolved work; ready/merge requires all required checks green. No automatic merge.
