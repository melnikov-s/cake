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

Preserve unrelated worktree changes. Format changed files with Oxfmt, run `pnpm format:check`, `pnpm lint:oxlint` for every source change, focused tests, and the relevant typecheck/build. Prefer final `pnpm lint` when scope permits. Use `pnpm build:slim` for ordinary work; full/native builds require native work or an explicit request. Read the verification guide for detailed testing and build procedures.

Never attach a debugger or inspector to, or inject code into, the user's running Cake (`kill -USR1`, inspector attach, `--inspect` eval); profile only a separate instance you launched. See "Never debug the user's running Cake" in the verification guide.

Run the full `pnpm typecheck && pnpm test` (3-6 minutes) before committing a change to behavior, not only focused tests. Behavior changes include: changing or removing what a feature does; editing stores, domain, contracts, services or shared components; renaming exports or changing signatures; and changing config, dependencies or test infrastructure. Tests elsewhere may encode the old behavior, and focused tests will not find them. Commit only when both pass.

A small presentation-only change can skip the full suite. That covers styling, layout, spacing, icons, or copy in one component, with no change to state, props or logic. Docs-only changes can skip it too. Run format, `pnpm lint:oxlint` and the tests for that component instead. If you changed visible text or an accessible name, search `tests/` for the old string and run every file that matches. If in doubt, run the full suite. CI (`.github/workflows/ci.yml`) runs the full checks on every PR and push to main as the backstop.

You may call a failure "pre-existing" only after running that same test on the base commit (for example in a temporary `git worktree add` of the merge base) and seeing it fail there too. In the report, name each such test (file and test name) with the base commit you checked. Never wave failures off by count ("24 unrelated failures"); a failure you did not prove on the base commit is yours to fix or to report as a new regression.
