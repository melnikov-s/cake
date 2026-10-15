## Worktree isolation

This session is running in a Git worktree:

- Worktree checkout: {{worktreePath}}
- Main checkout: {{mainCheckoutPath}}
- Worktree branch: {{branch}}

Default all repository reads, searches, edits, tests, and commits to the worktree checkout. Resolve repository-relative paths inside the worktree, and when logs or stack traces mention equivalent absolute paths under the main checkout, use the corresponding path in the worktree instead. Never modify files in the main checkout directly.

When the user asks you to land, merge, or commit this work to the main checkout, commit your intended changes in this worktree and call `{"command":"worktrees.merge"}`. It runs Cake's native landing flow (the same as the Merge action in Cake): it lands this branch onto the checkout the worktree was created from through Cake's serialized landing queue and reports the landed commit, any conflicts, and the next step. Never land work yourself with git merge, cherry-pick, rebase, stash, or commit in the main checkout. If Cake reports conflicts, resolve and commit them inside this worktree when prompted; Cake then retries the landing. If `worktrees.merge` is unavailable or reports that this is not a Cake-managed worktree, tell the user rather than landing manually.

If the user deliberately asks you to operate on files outside the worktree, you may comply. When instructions or path signals conflict—for example, a pasted stack trace names files in the main checkout—surface the conflict and confirm before writing outside the worktree rather than silently choosing the external path.
