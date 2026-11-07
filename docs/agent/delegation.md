# Delegation

## Choose a task session

Prefer sessions.fork for project implementation/investigation: a Side Session inherits Pi Durable context, executable identity, model and originating Cake permissions, with a new managed worktree. Permanent chats never create family children. Use sessions.create for intentionally fresh independent context.
Pass the authorized registered root as workspacePath, worktreeName, name and focused initialPrompt. Project Chat targets only its own project; global Cake Chat can target authorized registered projects.
[Session fork details](sessions.md#permanent-chat-side-sessions) explains settled context, source lifetime and continuation.

Default to a fresh scoped session for each distinct implementation task. A new Side Session can inherit context without reusing an old task session. Sessions are cheap; never grow/revive a session merely to conserve session count or preserve it. Sharing a broad feature label such as navigation is not enough reason: panel placement, tree aggregation and a separate Back to project chat control can be distinct tasks.
Reuse only for genuine continuation of the same task when its accumulated context is materially useful; do not fragment a single task gratuitously. Creating a fresh session for already-authorized work needs no extra user permission.
Keep project scoping, safety boundaries and authorized worktree/concurrency limits. Cheap sessions do not authorize uncontrolled recursive spawning, redundant inter-agent communication or unrelated work. A fresh session does not implicitly merge worktrees, delete sessions or resolve old work.

## Explicit private workers

Private subagents require an explicit user request; do not substitute them for context-forked Side Sessions. Repository implementation normally uses a Side Session.
Project investigator: exact registered projectPath. General researcher: omit projectPath; no project resources or guaranteed web.
Workers are read-only unless launched with allowMutations: true. Name exact operational targets; Git changes require explicit scope. Existing handles cannot gain mutation mode. This flag is not a filesystem sandbox.
Project investigators inherit instructions/skills/extensions/MCP but omit edit/write. General workers have read/bash/message_parent; distinguish retrieval from prior knowledge and disclose access failures.

## Launch and follow up

Launch sessions asynchronously with resultDelivery: reply for owed answers/dependencies, notification for background review. Use the returned Side Session thread for follow-ups; application completion needs no manual message/polling.
subagents.start is asynchronous. Blocking run/parallel/wait needs explicit user request. Private workers cannot recursively delegate.
continuation: resume for owed answers/dependencies, none for background review. Follow-ups inherit. Omit model overrides unless requested.
Keep same-task worker handles until closed or expired after 30 idle minutes; active turns never expire. Capabilities/history survive backend restart. Safe unfinished work resumes; uncertain tool effects require review, not replay. Context exhaustion/final-response failure yields error, not a finished report.

## Context within the task

Choose by task scope first, not context size or cache warmth. Reuse reports or transfer concise findings rather than reviving an old coordinator for a distinct task. Bundle same-task follow-ups; recheck changed files. Large context can be useful; cache expiry does not prove a miss. No polling unless requested; never wake a session just to ask its size.
[Delivery](communication.md) explains continuation; [sessions](sessions.md) covers full sessions; [reports](reports.md) covers retained results. Use exact operation help for unfamiliar arguments.
