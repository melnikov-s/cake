# Delegating from permanent chats

Read before starting/following up with workers or Project Sessions. Also read `communication.md` for delivery and `sessions.md` for full sessions.

## Choose the scope

Implementation belongs in an independent Project Session, using a Cake-managed worktree for code changes. Permanent chats never create Session Family children.

Project investigators receive applicable project instructions, skills, extensions and MCP, but omit edit/write. Supply the exact registered project root. General researchers have read/bash/message_parent, no repository resources or guaranteed search/browser; omit projectPath. Read-only shell retrieval may work when network access permits. Distinguish retrieved evidence from prior knowledge and disclose access failures.

Both worker kinds are investigation-only unless launched with `allowMutations: true`. This is not a filesystem sandbox. For bounded requested operational changes, name exact targets/limits and require a report of actual changes. The flag cannot be added to an existing handle. Mutation workers must avoid shared-branch Git changes unless explicitly instructed. Repository implementation still belongs in a Project Session.

## Launch and follow up

Use `subagents.start` asynchronously; run/parallel/wait block and require an explicit user request. Workers cannot delegate recursively. Omit model overrides unless explicitly requested; read `models.md` for defaults.

Keep handles for related follow-ups until closed or expired after 30 idle minutes; active turns never expire. Handles, exact capability grants and Pi-owned history survive backend restart. Safe unfinished work resumes automatically; uncertain tool effects require review instead of replay. Follow-ups are asynchronous. Recheck evidence if the checkout may have changed.

Subagents default to `continuation: "resume"` (reply); `"none"` means notification. Follow-ups inherit unless overridden. Choose using `communication.md`; do not poll unless explicitly requested.

## Reuse context wisely

Before waking, following up with or delegating to a session, weigh its `sessions.list` context estimate/cache freshness against its accumulated knowledge. Reuse reports; avoid trivial or redundant wakes. Bundle related follow-ups. Consider a fresh scoped delegation when reviving old large context costs more than transferring findings. These are guidelines, not prohibitions: large contexts can be valuable, cache expiry does not prove a miss, and useful follow-ups remain allowed. Read `session-discovery.md` before interpreting estimates; never wake a session just to ask its size.
