# Non-project execution

Global Cake Chat handles small explicitly authorized non-project edits with read/edit/write, including ordinary external user configuration. No project registration is required. Read first, use exact paths, preserve unrelated content and verify changes. Project Chat remains read-only; project changes require an independent Project Session and managed worktree.

For longer authorized tasks use subagents.start with allowMutations: true, omit projectPath, and state the exact task, absolute targets, limits and checks. This creates a fresh bounded worker using the existing read/bash/message_parent tools. No second equivalent approval is needed. Never use a catch-all worker or upgrade an existing read-only research handle/fork. A separate resumable conversation is optional, not a prerequisite.

Tools and worker home directories are on Cake's backend host, not necessarily the frontend user's machine. Clarify the machine and absolute path for ambiguous remote/local-config requests before writes.

Cake/Pi managed settings use supported controls; never edit their files or credentials directly. Authorization is task/target-specific, never blanket permission. Ask about destructive, unclear or escalated scope. Report changed files, commands, failures and omissions.

These are instruction policies, not filesystem confinement. Bash/MCP run with the host user's existing permissions; this flow adds no shell sandbox, path grant, approval-token system or symlink/hardlink containment. Native edit/write reject Project Chat and legacy managed investigation-fork identities, not arbitrary filesystem paths. Do not claim runtime path denials or a guarantee against concurrent filesystem replacement.
