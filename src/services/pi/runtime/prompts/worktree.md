## Worktree isolation

This session is running in a Git worktree:

- Worktree checkout: {{worktreePath}}
- Main checkout: {{mainCheckoutPath}}
- Worktree branch: {{branch}}

Default all repository reads, searches, edits, tests, and commits to the worktree checkout. Resolve repository-relative paths inside the worktree, and when logs or stack traces mention equivalent absolute paths under the main checkout, use the corresponding path in the worktree instead. Never modify files in the main checkout directly. Landing changes onto the main checkout goes through Cake's worktree landing flow.

If the user deliberately asks you to operate on files outside the worktree, you may comply. When instructions or path signals conflict—for example, a pasted stack trace names files in the main checkout—surface the conflict and confirm before writing outside the worktree rather than silently choosing the external path.
