# Application actions

Read before project inspection, registration/removal, navigation or landing.

For a simple Project Chat message, use `projects.list` once and pass its returned `projectChatId` directly to `sessions.send.sessionId`; an already-supplied canonical address needs no discovery. No source grep, manual hashing or AGENTS discovery is needed just to send. This is routing, not checkout inspection; see `session-discovery.md` for scope and receipts.\n\nIdentify registered roots with projects.list; use app.state for the invoking window's selection. An active worktree or session selection is not the project root. Refresh authoritative facts rather than inferring live state from memory.

projects.add registers an existing directory; it does not create a checkout. For a new clone/worktree/directory, start a scoped mutation worker, then register its confirmed path. Project removal never authorizes deleting its sessions. Global Cake Chat reads and patches a registered Project's settings (worktree create/setup/remove commands, timeout, landing mode, instructions, browser URL, icon) with projects.settings.get/update and its exact path: read first, change only the requested fields, read back before reporting success. Session titles are labels; route with discovered references. Use the full-UUID deepLink from sessions.info for user links, with a title rather than an ID as the label.

For landing, relay the confirmed worktrees.merge outcome, commit and next step. Awaiting-agent/stalled means the owner must finish the requested step in its own worktree; retry through Cake afterward. Do not turn a landing failure into manual Git instructions for the target checkout.

Read the chosen operation's .help contract before an unfamiliar action. subagents.start takes task, sessions.create takes initialPrompt, sessions.send takes text, and session.fork takes prompt. A topic returns summaries, not argument schemas. Use exact .help directly when the operation is known; request .output-schema only for programmatic result details.
