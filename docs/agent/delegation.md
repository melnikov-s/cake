# Delegating from permanent chats

Read before starting/following up with workers or Project Sessions. Also read `communication.md` for delivery and `sessions.md` for full sessions.

## Choose the scope

Prefer `sessions.fork` for project tasks, including implementation and investigation. It creates a Side Session with Pi Durable's native inherited context, its own executable identity and a new Cake-managed worktree. Pass the authorized registered project root as `workspacePath`, a `worktreeName`, `name` and focused `initialPrompt`. A Project Chat can fork tasks only for its own project; global Cake Chat can use an authorized registered project. Permanent chats never create Session Family children.

The source stays open and unchanged. Omit `entryId` to fork at its latest completed reply, or select an exchange explicitly. The unfinished current exchange is outside that settled boundary: include its task specifics in the new assignment. No completed reply means an explicit failure, not a task-only replacement. History remains Pi-owned, not copied into a task prompt. The Side Session inherits the model and originating Cake permissions; coding tools run in the managed worktree. Inherited explicit user restrictions still apply.

Launch asynchronously with `resultDelivery: "reply"` for an answer owed or dependent next action, `"notification"` for background review. The application correlates completion with that assignment; no manual completion message or polling is needed. Use the returned Side Session thread to continue the conversation. Use `sessions.create` only when a fresh independent context is wanted.

Default to a fresh scoped session for each distinct implementation task. A new Side Session can inherit context without reusing an old task session; use `sessions.create` when fresh independent Project Session context is wanted. Sessions are cheap: do not conserve session count or preserve a session by growing or reviving it for a new task. Sharing a broad feature label such as navigation is not enough reason to reuse a coordinator: panel placement, tree aggregation and a separate Back to project chat control can be distinct tasks. Reuse only for genuine continuation of the same task when its accumulated context is materially useful. Keep same-task follow-ups coherent; do not fragment a single task gratuitously. Creating the appropriate fresh session for already-authorized work needs no extra user permission.

Keep project scoping, safety boundaries and authorized worktree/concurrency limits. Cheap sessions do not authorize uncontrolled recursive spawning, redundant inter-agent communication or unrelated work. Creating a fresh session does not implicitly merge worktrees, delete sessions or resolve old work.

## Explicit private workers

Private subagents remain available when the user specifically asks for them; do not substitute them for context-forked Side Sessions.

Project investigators receive applicable project instructions, skills, extensions and MCP, but omit edit/write. Supply the exact registered project root. General researchers have read/bash/message_parent, no repository resources or guaranteed search/browser; omit projectPath. Read-only shell retrieval may work when network access permits. Distinguish retrieved evidence from prior knowledge and disclose access failures.

Both worker kinds are investigation-only unless launched with `allowMutations: true`. This is not a filesystem sandbox. For bounded requested operational changes, name exact targets/limits and require a report of actual changes. The flag cannot be added to an existing handle. Mutation workers must avoid shared-branch Git changes unless explicitly instructed. Repository implementation normally belongs in a context-forked Side Session.

## Launch and follow up

For explicitly requested private workers, use `subagents.start` asynchronously; run/parallel/wait block and require an explicit user request. Workers cannot delegate recursively. Omit model overrides unless explicitly requested; read `models.md` for defaults.

Keep worker handles for same-task follow-ups when their context is materially useful, until closed or expired after 30 idle minutes; active turns never expire. Handles, exact capability grants and Pi-owned history survive backend restart. Safe unfinished work resumes automatically; uncertain tool effects require review instead of replay. Follow-ups are asynchronous. Recheck evidence if the checkout may have changed.

Subagents default to `continuation: "resume"` (reply); `"none"` means notification. Follow-ups inherit unless overridden. Choose using `communication.md`; do not poll unless explicitly requested.

Workers auto-compact near their context window. A worker that still runs out of room, or whose final response fails, reports `error` with the reason (for example "Context exhausted: …"), never `complete`; its last text is unfinished work, not a report.

## Use context within the task boundary

Choose by task scope first, not context size or cache warmth. For genuine same-task continuation, weigh the session's accumulated knowledge and `sessions.list` context estimate/cache freshness. Large context can be useful; cache expiry does not prove a miss. Reuse relevant reports or transfer concise findings to a fresh session rather than reviving an old coordinator for a distinct task. Bundle same-task follow-ups and avoid trivial or redundant wakes. Read `session-discovery.md` before interpreting estimates; never wake a session just to ask its size.
