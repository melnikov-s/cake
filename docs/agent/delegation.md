# Delegation

## Choose a task session

From permanent chats, select by task; never use family children:

- Implementation/code changes -> sessions.create: a fresh independent Project Session, normally the default for "do work". Give it its own scoped task, managed worktree, relevant findings/constraints and acceptance checks. It does not inherit conversation history. Never use sessions.fork for coding delegation.
- Investigation/research with useful existing context, where implementation is not yet clear -> sessions.fork: an inline/side context fork for read-only investigation. If code changes become needed, return findings for handoff to a fresh Project Session via sessions.create; never silently expand research into coding.
- Investigation with an explicitly requested different model -> private subagent directly with the requested model, not sessions.fork or sessions.create as a research workaround.
- Investigation where existing context is not helpful -> a private subagent is also authorized. Otherwise use the contextual fork for investigation.

For sessions.create/fork pass the authorized registered root as workspacePath, worktreeName, name and focused initialPrompt. Project Chat targets only its own project; global Cake Chat can target authorized registered projects.
[Context fork details](sessions.md#permanent-chat-context-forks) explains settled context, source lifetime and continuation.

Default to a fresh scoped session for each distinct implementation task. Fresh independent Project Sessions need meaningful task context, not whole transcripts. Sessions are cheap; never grow/revive a session merely to conserve session count or preserve it. Sharing a broad feature label such as navigation is not enough reason: panel placement, tree aggregation and a separate Back to project chat control can be distinct tasks.
Reuse only for genuine continuation of the same task when its accumulated context is materially useful; do not fragment a single task gratuitously. Creating a fresh session for already-authorized work needs no extra user permission.
Keep project scoping, safety boundaries and authorized worktree/concurrency limits. Cheap sessions do not authorize uncontrolled recursive spawning, redundant inter-agent communication or unrelated work. A fresh session does not implicitly merge worktrees, delete sessions or resolve old work.

## Private investigators

For permanent-chat investigation, an explicitly requested different model requires a private subagent; unhelpful existing context also permits one without a separate request for subagents. Otherwise use sessions.fork for useful-context investigation. Repository implementation belongs in a fresh independent Project Session via sessions.create, not a private investigator. Project Session private delegation otherwise retains its explicit-request policy.
Project investigator: exact registered projectPath. General researcher: omit projectPath; no project resources or guaranteed web.
Investigators stay read-only; never turn research into code changes. Bounded user-requested non-code operations may use allowMutations: true with exact operational targets; it is not an implementation workaround. Existing handles cannot gain mutation mode. This flag is not a filesystem sandbox.
Project investigators inherit instructions/skills/extensions/MCP but omit edit/write. General workers have read/bash/message_parent; distinguish retrieval from prior knowledge and disclose access failures.

## Launch and follow up

Launch asynchronously/non-blocking with resultDelivery: notification by default, reply for owed answers/dependencies. Use the returned Project Session or context-fork thread for same-task follow-ups; minimize cross-session chatter. Application completion needs no manual message/polling.
subagents.start is asynchronous. Blocking run/parallel/wait needs explicit user request. Private workers cannot recursively delegate.
For private investigators explicitly choose continuation: none (notification) by default, resume for owed answers/dependencies; the tool's omitted-field default is resume. Follow-ups inherit. Omit model overrides unless requested.
Keep same-task worker handles until closed or expired after 30 idle minutes; active turns never expire. Capabilities/history survive backend restart. Safe unfinished work resumes; uncertain tool effects require review, not replay. Context exhaustion/final-response failure yields error, not a finished report.

## Context within the task

Choose by task scope first, not context size or cache warmth. Reuse reports or transfer concise findings rather than reviving an old coordinator for a distinct task. Bundle same-task follow-ups; recheck changed files. Large context can be useful; cache expiry does not prove a miss. No polling unless requested; never wake a session just to ask its size.
[Delivery](communication.md) explains continuation; [sessions](sessions.md) covers full sessions; [reports](reports.md) covers retained results. Use exact operation help for unfamiliar arguments.
