# Discussions, session assistant, and avatars

## Discussion Sessions

UI “side chats” are independent lightweight Pi Sessions: session discussions,
assistant-message discussions, source-anchored reviews, and the composer-avatar
session assistant. Cake owns parent scope and optional anchors; Pi owns replies.
Before each reply, Cake regenerates a read-only Markdown projection of the parent's
current active branch. Ordinary discussions receive their scope/anchor, nearby
context, their own transcript, and read-only file tools. Changing the source
anchor does not change authority or record work in the parent transcript.

Each sidecar has its own Conversation projection driven by the shared reducer and
ChatStore. The parent Discussion catalog contains only thread metadata and a
persisted preview, so refreshes cannot disturb live side chats. A derived Markdown
thread index is available to the parent through ordinary Project tools.

## Composer assistant

Each Project Session has at most one durable avatar-assistant Discussion Session.
Quick bubble and full chat are presentations of that same transcript and compose
shared `Chat`/`ChatStore`. The assistant uses the configured utility model, not an
eager dump of parent tool calls, and retains history across restarts.

Its explicitly user-directed tools include standard file/shell tools and the full
validated Cake application-control gateway, including VS Code navigation.
`sessions.cake` discovers/invokes the parent's live registry without copying tools
or rebinding the sidecar. Singular forwarded operations use parent authority:
“this session” means the parent. The system prompt eagerly includes the protocol
generated from its actual registry. A non-empty parent-composer selection is
snapshotted when the avatar opens and supplied as contextual data, not a tool result.

`SessionAssistantStore` owns window-local draft, selection snapshot, cancellation,
quick processing/response presentation, and single-turn-at-a-time policy. Primary
click opens a focused one-shot composer, replaces it with animated processing,
then displays an auto-closing compact response. Secondary click opens full chat.
The assistant never copies messages into the parent transcript.

## Read-only Session inspection

`sessions.history`, `sessions.compactions`, `sessions.tree`, `sessions.context`,
`sessions.usage`, and `sessions.commands` inspect target Pi authority through
`sessionChats`. History combines text, entry type, role, tool name, timestamp, and
branch filters before pagination/clipping. It defaults to the active branch;
compactions/tree default to all branches. Compaction evidence includes current-branch
membership and source references, distinguishing current Tool Compact from other
branches. Arbitrary hidden custom-entry payloads are not exposed as transcript text.

## Avatars

The pending Session avatar sits beside the composer and opens the compact assistant
to its left. It remains after activation. Labels are available through the sidebar
avatar picker; assistant-message gutter avatars are non-interactive identity markers.

Only the composer avatar follows the pointer and plays occasional blinks, hops,
wobbles, and stretches. Shared `Avatar` owns these disposable DOM effects; they
pause in hidden documents and respect reduced motion.

Sidebar avatars use row-local feedback: hover glances right, leaving centers,
selection briefly blinks and bobs. They have no idle timers or pointer tracking.
Transforms animate without React frame updates. State is mount-local, unpersisted,
and overlapping animations cancel/replace on the same shape.

## Verification

- [Discussion domain](../../tests/app/domain/discussionSessions.test.ts)
- [Avatar presentation](../../tests/app/renderer/avatar.test.tsx)
- [Avatar physics](../../tests/app/renderer/avatar-physics.test.ts)
