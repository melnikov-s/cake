# Cake agent instructions

## User-directed overrides

Current explicit task-scoped user instructions override earlier user-authored repository instructions and Cake-owned workflow defaults, including Cake policies injected by the harness. Follow the stated exception without an AGENTS.md edit or repeated confirmation. Cake's communication/channel/process defaults are not immutable authority merely because Cake injects them into a prompt. User-authorized family coordination exceptions must not be refused solely because older Cake prose says board-only.

This does not override genuine provider/platform/system constraints, security boundaries or actual tool capabilities, grant missing tools, or authorize unrelated actions. Identify the concrete constraint and a supported alternative; never use a blanket "harness forbids" refusal for an overrideable Cake product policy. Use supported tools and truthful delivery/execution evidence.

Cake-owned workflow policies should distinguish defaults from hard constraints and explicitly allow task-scoped user exceptions where appropriate. In particular, periodic coordination polling/check-ins are off by default but permitted when the user explicitly requests them. Use supported durable scheduling at the requested interval, keep one pending check-in per coordinator task, and stop on completion or a user pause/stop. Preserve the applicable task-scoped family communication policy, honoring explicit user-authorized exceptions to Cake defaults. Do not claim a timer or wake-up exists without a successful tool result. When a genuine non-overridable constraint applies, explain that specific limit instead of using "harness instructions" as a blanket refusal.

## Product and required guidance

Cake is Pi expressed as a desktop GUI. Pi owns the coding-agent engine and transcript history; Cake owns desktop application workflows and presentation. Keep conversation primary. Never persist a second Cake-owned transcript.

Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.

Read the matching documents before implementing; consult proportionally rather than treating exhaustive reading as a prerequisite to a focused investigation:

- Architecture, feature ownership, or process boundaries: [agent architecture](docs/development/agent-architecture.md), then the relevant architecture documents it references.
- Renderer UI, chat, or state: [renderer implementation](docs/development/renderer-implementation.md), then the authoritative architecture and component/library references. Before UI or styling changes, also read [Cake's visual design guide](DESIGN.md); use it for visual intent, while existing theme tokens and shared components remain authoritative for implemented values.
- Effect workflows: `.agents/skills/effect-ts/SKILL.md`, `node_modules/effect/AGENTS.md`, and their relevant linked references. The pinned Effect source is the API authority.
- Tests, builds, debugging, Electron interactions, or visual checks: [agent verification](docs/development/agent-verification.md), then its relevant focused guides.

These documents contain the detailed rules; read them with the file tools when their task applies.

## UI and tool parity

Every user-facing setting must ship with discoverable Cake tool read/write parity,
using the same validation, authority, persistence and live updates as Settings UI.
Meaningful mouse/keyboard capabilities should have semantic tool equivalents where
sensible. Include workflow tests; shared setting registries/projections should have
coverage checks against omissions. Document concrete exceptions (credentials,
user-owned permissions, OS-only interactions) and supported user paths; a missing
tool is a product gap, not an authorization restriction. See the
[UI and Cake tool parity contract](docs/architecture/cake-architecture.md#ui-and-cake-tool-parity).

## Greenfield compatibility policy

- Cake is a greenfield project. Unless the user explicitly requests it, do not preserve backward compatibility.
- Remove replaced APIs and implementations outright. Do not add deprecated aliases, compatibility shims, transitional forwarding facades, legacy import paths, or fallback behavior for code being replaced. Versioned migrations for persisted user data are an explicit storage responsibility and are not API compatibility shims.
- Prefer updating every caller, test, and document in the same change over carrying an old interface forward.
- Do not add tests solely to assert that a feature or DOM element removed outright is absent. Remove obsolete tests for removed features; test absence only when conditional or state-dependent absence is itself the behavior under contract.

## Review proportionality

Before you add code for a race condition or security edge case that is unlikely or purely hypothetical, tell me exactly what would go wrong, how likely that is, and how much complexity the extra code adds, in words a 10-year-old could understand. Then wait for my OK. Don't quietly widen the scope to guard against problems that only exist in theory.

- Calibrate findings to this product's actual risk. Reserve P0/P1 for common or severe failures such as data loss, security breaches, or a core workflow being unusable—not speculative races involving advisory metadata.
- Do not manufacture complexity in the name of defensive programming. If an edge case is rare, recoverable, and low impact, either omit it or label it plainly as minor; do not propose coordination, caching, migration, or abstraction machinery without demonstrated need.
- Separate product defects from repository-policy cleanup and optional polish. Prioritize direct requirement gaps and reproducible user-visible failures.
- Recommend the smallest understandable fix that solves the observed problem. Cake is a coding agent, not safety-critical infrastructure.

## Verification baseline

Agree acceptance criteria and verification scope up front, including for coordinated tasks. Choose checks by affected behavior and risk, not the number of files or components. New requests change scope and cost; make that explicit rather than silently extending nearly finished work.

Preserve unrelated worktree changes. Format changed files with Oxfmt and run `pnpm format:check`. For source changes, run `pnpm lint:oxlint`, focused tests, and the typecheck/build warranted by the affected behavior; prefer final `pnpm lint` when scope permits. Docs-only changes need only applicable documentation formatting/link checks. Use `pnpm build:slim` for ordinary work that needs a build; full/native builds require native work or an explicit request. Read the verification guide for detailed testing and build procedures.

Never attach a debugger or inspector to, or inject code into, the user's running Cake (`kill -USR1`, inspector attach, `--inspect` eval); profile only a separate instance you launched. See "Never debug the user's running Cake" in the verification guide.

Actual behavior changes require final full `pnpm typecheck && pnpm test` verification (3-6 minutes), not only focused tests. These include changing what a feature does, state or logic in stores/domain/services/shared components, contracts or export signatures, and config/dependency/test-infrastructure behavior. Tests elsewhere may encode the old behavior. During iteration, run focused checks; batch warranted broad verification once at the end. Rerun a broad check only when subsequent changes could invalidate its evidence; unchanged code or equivalent checks do not need reruns.

Presentation-only styling, layout, spacing, icon or copy changes may span files and components without triggering the full suite, provided they do not change behavior, state or contracts. Keep format/lint, affected focused tests and appropriate visual proof. If you changed visible text or an accessible name, search `tests/` for the old string and run every file that matches. Docs-only changes also skip the full suite. If scope is uncertain, identify the affected behavior and risk before choosing checks rather than automatically broadening verification. CI (`.github/workflows/ci.yml`) runs the full checks on every PR and push to main as the backstop.

A failed check is not permission to expand scope. Fix attributable regressions within the authorized scope; report other failures as unresolved/unclassified blockers without automatically investigating or fixing them. Call a failure "pre-existing" only after reproducing the same test failure on the base commit, naming the test file, test name and base commit in the report. Base reproduction is required for that claim, not for every unclassified failure. Never weaken tests or claim readiness with known failures.

After two unsuccessful repair/verification cycles on the same blocker, stop expanding work and report the evidence, exact blocker and smallest next experiment or decision. Preserve the verification guide's two-failed-hypothesis debugging discipline; neither rule authorizes automatic architectural work or imposes a global wall-clock timeout.

Report implementation complete, focused verification passed, broad verification blocked and ready to land as distinct statuses, as applicable. A clearly labeled checkpoint commit may preserve useful work with unresolved broader failures; it is not a ready/green claim. Ready to land requires all required checks to pass; never merge with unresolved required checks.
