# Sessions

## Create

Project Session: session.create {name,initialPrompt,worktreeName?}. Permanent chat: sessions.create with project. Family child: sessions.create-child {title,assignment:{description,body},resultDelivery}.
Use notification by default, reply for dependencies/owed answers. Launch asynchronously/non-blocking.
Children share directory/index unless worktreeName isolates committed HEAD. Fixed directory; no manual worktree substitute. Independent creation without worktreeName uses the Project root.
Permanent-chat implementation/code changes use sessions.create with a scoped initialPrompt containing meaningful context/constraints and acceptance checks, plus worktreeName for managed isolation. This is a real fresh independent Project Session, not a context fork or family child. Private subagents are bounded workers, not full children; see the investigation exceptions below.
[Child assignments/retries](family-delegation.md) and [private workers](delegation.md) cover those paths.

## Permanent-chat context forks

Use sessions.fork for investigation/research with useful existing context where implementation is not yet clear: a read-only inline/side context fork, not an implementation Project Session. Never use sessions.fork for coding delegation. If code changes become needed, return findings for handoff to a fresh Project Session via sessions.create; do not silently expand research into coding. This is different from singular session.fork below.
Private subagents require an explicit request. Investigation with an explicitly requested different model uses a private subagent directly with that model, not sessions.fork or sessions.create as a research workaround. Investigation where existing context is not helpful may use a private subagent only when explicitly authorized; otherwise use the contextual fork for investigation.
Pass authorized workspacePath (registered project root), worktreeName, name and initialPrompt. Project Chat is restricted to its project. The context fork has its own executable identity and managed worktree; Pi Durable owns inherited history, model and originating Cake permissions. Tool availability does not authorize code changes; inherited user restrictions still apply.
The source stays open and unchanged. Omit entryId for the latest completed reply or select an exchange explicitly. The unfinished exchange is outside that settled boundary: include current task specifics in initialPrompt. No completed reply fails explicitly, never falls back to a task-only prompt.
Native Side Chat IDs remain Discussion Sessions, not Project Sessions. Use the returned ID for sessions.info, sessions.abort, sessions.open and exact messages.list/read references, including after backend restart. To-do source links retain that identity; session associations follow the Discussion's resolved status, not whether execution finished. Existing task Side Chats can identify their own managed worktree for landing committed work. They remain read-only: recover uncommitted work or conflicts into an independent Project Session rather than asking a research fork to implement repairs.
Choose resultDelivery at launch: notification by default, reply for owed answers/dependencies. Launch asynchronously/non-blocking; use the returned thread for same-task follow-ups with minimal chatter. No manual completion message/polling. [Task boundaries](delegation.md) explains fresh sessions versus same-task continuation.

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
For optional user-enabled auto-merge, declare validated completion with worktrees.reportReadiness before the final answer; see [readiness](reports.md#auto-merge-readiness). Never declare checkpoints or pending validation ready.

When assigned by Cake Chat, lead final answer with one-line outcome; contact separately for blocker/user decision, not duplicate completion.
[Delivery](communication.md) covers result modes; [discovery](session-discovery.md) covers identity; [settings](settings.md) covers lasting instructions. Omit model overrides unless requested.
