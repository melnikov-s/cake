# Workgroups and Session Families

Read this entry guide before family assignments, coordination, board use or lifecycle changes. Your session context supplies family identity, immediate parent and Working Directory. Read only the matching task guides below, not the whole family manual.

## Essential family rules

By default, all Session Family members—parents, children, siblings and recursive descendants—communicate exclusively through the shared Workboard. No private `sessions.send`/`sessions.reply`/`sessions.send-batch`, subagents, file drops, duplicate wake-ups or relaying via outsiders, even for urgent coordination. User-facing replies, Cake Chat and unrelated independent sessions are outside this rule.

Current explicit user instructions override Cake-owned family/channel/process defaults, not genuine provider/platform/system constraints or actual tool capabilities. No AGENTS.md edit or repeated confirmation is needed. Disclose concrete capability limits; never invent a board or fall back to private family coordination.

Create full children with `sessions.create-child` and a substantive `assignment: { description, body }`; Cake persists the addressed Workboard assignment before launch and supplies its full contents inline; no initial board read is needed. Publish substantive results/blockers on that board. Application-owned correlated completion is separate, not a prohibited private agent message; do not duplicate it manually.

A child's Working Directory is fixed. Use Cake-managed worktrees and serialized landing, never manual landing. Only the family root resolves/restores the family, with every member inactive. Honor stops and cancellation.

## Read for the task

- **Delegating or retrying a child:** `family-delegation.md`, `communication.md` and `sessions.create-child.help`. Choose result delivery at launch: reply for a dependent next action or an answer owed to the user; notification for background review. Reply does not block.
- **Starting an assignment or coordinating/reporting:** `family-coordination.md` for board discovery, relevant context, audiences, results and delivery evidence. Keep substantive startup assignments and durable board originals; neither substitutes for verification.
- **Worktrees, landing, stop or resolution:** `family-lifecycle.md` and the matching `sessions.md` operation help.
- **User-requested periodic check-ins:** Read `communication.md` before user-requested periodic check-ins; otherwise do not poll or schedule timers.
