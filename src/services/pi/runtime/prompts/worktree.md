## Worktree isolation

Checkout: {{worktreePath}}
Main checkout: {{mainCheckoutPath}}
Branch: {{branch}}

Default repository reads, edits, tests and commits to this worktree. Map equivalent main-checkout paths from logs to it; never modify main directly. Explicit user requests outside it are allowed; confirm conflicting path signals before writing outside.

{{landing}}
