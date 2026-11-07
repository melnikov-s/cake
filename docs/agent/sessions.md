# Sessions

## Create

Project Session: session.create {name,initialPrompt,worktreeName?}. Permanent chat: sessions.create with project. Family child: sessions.create-child {title,assignment:{description,body},resultDelivery}.
Use reply for dependencies/owed answers, notification for background review. Launch asynchronously.
Children share directory/index unless worktreeName isolates committed HEAD. Fixed directory; no manual worktree substitute. Independent creation without worktreeName uses the Project root.
Permanent chats create independent sessions, never family children. Private subagents are bounded workers, not full children; delegate only when warranted/requested.
[Child assignments/retries](family-delegation.md) and [private workers](delegation.md) cover those paths.

## Permanent-chat Side Sessions

Prefer sessions.fork for project tasks from permanent chats; sessions.create deliberately starts fresh independent context. This is different from singular session.fork below.
Pass authorized workspacePath (registered project root), worktreeName, name and initialPrompt. Project Chat is restricted to its project. The Side Session has its own executable identity and managed worktree; Pi Durable owns inherited history, model and originating Cake permissions. Inherited user restrictions still apply.
The source stays open and unchanged. Omit entryId for the latest completed reply or select an exchange explicitly. The unfinished exchange is outside that settled boundary: include current task specifics in initialPrompt. No completed reply fails explicitly, never falls back to a task-only prompt.
Choose resultDelivery at launch, asynchronously; use the returned thread for follow-ups. No manual completion message/polling. [Task boundaries](delegation.md) explains fresh sessions versus same-task continuation.

## File-backed tasks

promptFiles captures authorized UTF-8 files on sender backend for independent create/send/reply; task instructions, not system authority. Attachments remain data.
Captured text follows inline prompt in array order; recipient need not read source paths. Capture is immutable after admission; smaller tool arguments do not mean smaller model context.
[File prompt details](session-prompt-files.md): authorized paths, provenance, limits and unsupported launch types.

## Fork and lifecycle

session.fork: prompt, optional entryId/resolveSource. Omitted entryId uses latest settled entry. sessions.abort stops without resolving/deleting. sessions.rename uses target sessionId/title; session.rename renames self.
Only family root resolves/restores, all members inactive. Commit in owner worktree; land via worktrees.merge (child sessionId or omitted for self). PR-only projects use PR workflow. No manual landing fallback.
Use pending/cancel-queued/clear-queue for queued inputs; these are lifecycle controls, not family communication channels.
[Family worktrees](family-lifecycle.md) covers shared files, integration ordering and stop authority.

## Messages

Project Session to Cake Chat: sessions.send without sessionId. Complete once; automatic transport needs no duplicate report. Blockers can use sessions.reply outcome: blocked.
Cake Chat must provide a target and cannot message itself; projectChatId routes to permanent Project Chat. Sender label cake-chat is not a routing reference.
When assigned by Cake Chat, lead final answer with one-line outcome; contact separately for blocker/user decision, not duplicate completion.
[Delivery](communication.md) covers result modes; [discovery](session-discovery.md) covers identity; [settings](settings.md) covers lasting instructions. Omit model overrides unless requested.
