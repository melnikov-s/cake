# Auto-merge settings and landing

For how projects land ready work. [Reports](reports.md#auto-merge-readiness) covers declaring readiness.

Project settings choose Merge with Cake (`worktreeLanding: "merge"`) or Merge outside Cake (`"pull-request"`). Outside-Cake projects use external review/CI/merge queues: no Cake merge, merge-and-resolve or readiness declaration. Managed worktrees, diffs, history, Resolve and explicit Discard remain available. Resolve preserves uncommitted work and branches under the existing retirement policy; it is not permission to discard.

Each project’s Sessions header has a user-owned Auto-merge toggle. It defaults off and persists per project. Outside-Cake projects do not show a toggle. There is no global override. With Cake merging enabled, manual Merge is available even when Auto-merge is off.

Switching off stops automatic landing; valid ready work remains listed for manual merging or a later opt-in. Conflicts/failures remain unresolved and require repair, validation and a fresh declaration; uncertain interrupted Git attempts are never blindly replayed. A durable successful landing with committed resolution intent can recover resolution only. Cake also retains one backend-authored system-reminder for the originating Project Chat with the session link, target branch, landed commit and resolution success or partial/failure outcome. It survives source-session resolution and rides the next real user input without a new wake. Read autoMerge on sessions.completions for retained outcomes; no Project Chat action or duplicate report is needed.
