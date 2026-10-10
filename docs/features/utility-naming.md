# Utility naming

Utility titles and worktree slugs use the configured utility model through Pi's
model runtime. Missing configuration skips title generation and leaves worktree
creation's random naming fallback intact. Neither feature silently substitutes the
conversation model. Results are advisory until validated and committed.

## Session titles

For a new UI Session, the creation Store requests a bounded utility title at
submission alongside checkout preparation, without blocking the first prompt.
Before Pi starts, a successful title is pending display metadata. After startup,
Pi's session-name API commits it atomically only if still unnamed. A manual name
always wins over an outstanding result.

Submission-time naming suppresses the duplicate runtime request for that initial
message, but not automatic labels or later unnamed-session eligibility. Other
callers attempt naming when Pi accepts the first user message, not when the turn
finishes. Live title events update cataloged Sessions and started Sessions still
awaiting catalog registration.

Saving a Cake-owned draft attempts the same naming work; its title remains pending
until activation. A failed draft attempt allows normal first-message naming to
retry after activation. Configuring a utility model later makes an unnamed active
Session eligible after its next interaction; named Sessions are never automatically
regenerated.

The completion token budget is independent of the 80-character display limit.
Failure or empty output retries once with a fresh 15-second attempt deadline.
Exhausted failures are logged without blocking conversation or replacing the
first-message display fallback. Cancellation and invalid configuration are not
retried.

Tool Compact retains the Pi Session identity and title. A fork inherits the
source's current title through Pi metadata and does not trigger new title generation.

## Managed Worktree preparation

When the first prompt creates a Managed Worktree, Cake attempts a bounded naming
completion before creating the checkout or Pi Session. A valid result is an exact
three-part lowercase hyphenated branch slug. The prompt stays optimistically visible
and navigation shows the pending Session during preparation.

Each Project may replace the default creation command and supply a post-creation
setup script. Cake substitutes documented shell-quoted Project, worktree, branch,
and base-revision variables, runs creation from the repository root, then setup
from the new Working Directory before starting Pi. Failure aborts startup and
removes the incomplete checkout. Missing utility configuration, timeout, provider
failure, or invalid output falls back to the worktree service's random naming scheme.

## Verification

- [Utility work policy](../../tests/app/domain/utilityWork.test.ts)
- [Creation workflow](../../tests/app/renderer/worktree-creation-workflow.test.tsx)
- [Creation command templates](../../tests/app/services/worktrees/worktree-command-template.test.ts)
- [Live automatic titles](../../tests/electron/automatic-session-title.smoke.spec.ts)
