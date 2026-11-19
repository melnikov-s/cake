# Permanent-chat context forks

For sessions.fork inputs and boundaries after choosing a read-only context fork. [Sessions](sessions.md#permanent-chat-context-forks) covers when to fork; [workers](delegation.md) covers private subagents.

Pass authorized workspacePath (registered project root), worktreeName, name and initialPrompt. Project Chat is restricted to its project. The context fork has its own executable identity and managed worktree; Pi Durable owns inherited history, model and originating Cake permissions. Tool availability does not authorize code changes; inherited user restrictions still apply.
Source stays open/unchanged. Omit entryId for the latest completed reply or select an exchange explicitly. The unfinished exchange is outside that settled boundary: include current task specifics in initialPrompt. No completed reply fails explicitly, never falls back to a task-only prompt.

Existing legacy native Side Chat IDs remain Discussion Sessions, not Project Sessions; no automatic migration or interruption. Use the returned ID for sessions.info, sessions.abort, sessions.open and exact messages.list/read references, also after restart. To-do source links retain that identity; session associations follow the Discussion's resolved status, not whether execution finished. Existing task Side Chats can identify their own managed worktree for landing committed work. They remain read-only: recover uncommitted work or conflicts into an independent Project Session rather than asking a research fork to implement repairs.
