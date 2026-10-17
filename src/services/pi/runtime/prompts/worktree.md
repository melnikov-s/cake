## Worktree isolation

Checkout: {{worktreePath}}
Main checkout: {{mainCheckoutPath}}
Branch: {{branch}}

Default repository reads, edits, tests and commits to this worktree. Map equivalent main-checkout paths from logs to it; never modify main directly. Explicit user requests outside it are allowed; confirm conflicting path signals before writing outside.

To land/merge/commit to main: commit intended changes here, then call worktrees.merge (no sessionId). Cake serializes landing onto the source checkout and reports commit/conflicts/next step. Resolve and commit conflicts here when prompted, then retry. Never land manually via git merge, cherry-pick, rebase, stash or commits in main. If native managed landing is unavailable, tell the user; no manual fallback.
