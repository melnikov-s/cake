# Focused feature guides

Read only the guide relevant to the task. Shared ownership, process, and trust rules
live in [Cake architecture](../architecture/cake-architecture.md); these guides hold
feature behavior and point to its tests. Change timings, limits, animations, and
workflow details here or in their owning tests, not in the architecture overview.

| Feature                                                                    | Guide                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Transcript presentation, compaction, queues, schedules, retries, scrolling | [Conversation](./conversation.md)                                                                        |
| Sidebar, catalogs, statuses, observation retention, staged/saved drafts    | [Session navigation](./session-navigation.md)                                                            |
| Panes, VS Code, terminals, creation and continuation                       | [Workspace presentation](./workspace-presentation.md)                                                    |
| Sidecar discussions, avatar assistant, avatar animation                    | [Session assistant](./session-assistant.md)                                                              |
| Utility title generation and worktree naming/setup                         | [Utility naming](./utility-naming.md)                                                                    |
| Hidden bounded workers, concurrency, cancellation, follow-up               | [Private subagents](./subagents.md)                                                                      |
| Renderer application gateway and notification debounce                     | [Application controls](./application-controls.md)                                                        |
| Draw playback, geometry, autosave, undo, export                            | [Draw](./draw.md), [authoring examples](../development/draw-authoring.md)                                |
| Durable controls and atomic state patches                                  | [Session Plugins](./session-plugins.md)                                                                  |
| Artifact library, inline previews, publication                             | [Artifact presentation](./artifact-presentation.md), [protocol](../architecture/s4-artifact-protocol.md) |
| Recursive full Project Sessions and family coordination                    | [Session Family contract](../architecture/session-family-contract.md)                                    |
| Permanent Cake Chat singleton and summary memory                           | [Memory](../development/cake-chat-memory.md), [durable runtime](../development/cake-chat-durable.md)     |
| Backend sharing, browser and remote desktop                                | [Headless backend](../development/headless-backend.md)                                                   |
| Voice conversation and dictation                                           | [Conversation mode](../development/conversation-mode.md), [dictation](../development/dictation.md)       |
