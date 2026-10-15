# Agent-facing session references

Session identity remains the canonical UUID in Pi history, Cake storage, family
membership, scheduling, coordination metadata, and internal APIs. A short reference
is an agent-boundary projection, not another stored identity or a name alias.

## Syntax and resolution

Agents may target a session with its full UUID or `s:<suffix>`, where suffix is
8–32 trailing hexadecimal characters of the UUID with hyphens removed. Matching
is case-insensitive for suffix hex. The default emitted suffix is eight characters;
collisions extend it one character at a time until unique in the relevant live
roster. UUIDv7 prefixes are intentionally not used because nearby creations share
them. Titles are readable labels, never routing identities.

For example, `01957936-0000-7000-8000-000112345678` normally projects to
`s:12345678`. If another session ends in `000212345678`, the references become
`s:112345678` and `s:212345678`. The eight-character reference is then ambiguous
and must fail, not route to whichever session was listed first.

Resolution uses current catalog facts, not a persisted reference registry. Exact
catalog identities pass through unchanged. Unknown, malformed, or ambiguous
references fail before the targeted operation acquires or routes to a recipient.
References can become ambiguous after another session is created; rediscover the
roster, use a longer suffix, or supply the full UUID. Authorization and family
scope checks still run on the resolved canonical identity.

## Boundaries and projection

Project Session runtime controls resolve references before family messaging,
renderer application controls, pending queues, and child worktree operations.
Global coordinator controls resolve before task-input authorization. The renderer's
shared targeted-control gate also resolves against its canonical live catalog;
multi-target lifecycle operations validate every target before making a mutation.

Roster, family, receipt, and other Cake operation text projects session identity
fields without rewriting user text, paths, family IDs, message IDs, or thread IDs.
Human titles remain readable. Structured outputs project identity fields only when
the resulting value still satisfies the operation's declared output schema. A
UUID-constrained typed field remains canonical while its text presentation uses a
short reference. No typed output contract is silently weakened.

Cross-session envelopes and generated notice headers are shortened in disposable
provider context, both for regular Pi and Pi Durable. Persisted envelopes and
renderer provenance retain canonical routing metadata. This does not create a
second transcript or modify Pi originals.

## Exact message references

An exact message reference is also its user-openable link:
`cake://session/<canonical-session-id>?message=<Pi-entry-id>`. It preserves Pi's
entry ID, not a renderer part ID, a cross-session delivery ID, or a summarized
replacement. Forward this opaque string unchanged through `messageRefs`; resolving
or forwarding it does not require reading its body. No reference registry or
second transcript is persisted.

- `messages.list` returns bounded metadata only: exact `ref`/`link`, session and
  entry identity, role, timestamp, active-branch status, and attachment `inputRefs`
  (identity, name, MIME type, byte length). It defaults to 25 chronological active
  branch messages; `branch: all` includes original inactive branches. `nextOffset`
  continues discovery, including pages shortened to keep metadata bounded.
- `messages.read` explicitly reads one exact original across Pi's full tree. It
  defaults to 4,000 characters, permits at most 20,000, and returns `nextOffset`
  for continuation. It never returns inline image bytes. Missing/non-message
  entries fail; no text search, current-context, or summary fallback is used.
- `messages.open` delegates to `sessions.open` and its user-only, invoking-window
  navigation permission. The identical link remains manually usable when agents
  cannot navigate. Markdown preserves the `message` query through sanitization.
- Message links are agent- and Markdown-facing; the transcript has no per-message copy
  action. Navigation marks the exact visible message. If the source is on an inactive or Tool Compact
  branch, a bounded read-only original preview opens without changing the Pi
  branch or model context. Preview pages are transient, never Conversation entries
  or window snapshot data.

Pi remains the authority through restart, ordinary compaction and Tool Compact.
Deleting the source transcript removes its evidence; references do not promise
an independent retained copy. These operations address Project Sessions and permanent
Cake Chat originals, not process-local investigators or private side-chat transcripts.
Bounded investigators receive only explicitly selected exact references and expose
`messages.read` behind that allowlist, never broad discovery or navigation.

Attachments use `cake://session/<authorized-session-id>?attachment=<input-id>`.
This is the existing vault input identity, not a new attachment record. Markdown
preserves the attachment query; clicking opens a transient image or bounded text
preview through `sessionChats.readAttachment`, authorized for the named session.
No storage paths or contents are exposed by copying/opening a link into agent context.
File/input chips and previews expose **Copy attachment link**; message metadata retains
pinned `inputReference` identities from Project attachment envelopes. Message reads
strip those envelopes so reading a message does not implicitly read its attachments.

The contract and link codec live in
`src/contracts/conversations/message-reference.ts`; Pi entry projection lives in
`src/services/pi/runtime/message-references.ts`; domain controls and operation
help live in `src/domain/conversations/messageReferences.ts` and
`cake-message-operations.ts`.

## Reusable helpers

`src/contracts/project-sessions/session-reference.ts` is the pure shared boundary:

- `sessionReference(sessionId, knownSessionIds)` emits a collision-aware reference.
- `resolveSessionReference(reference, knownSessionIds)` returns
  `{ ok: true, sessionId }` or `{ ok: false, error }`.
- `projectSessionReferences(value, knownSessionIds)` projects JSON session identity
  fields, including board audiences and receipt authors, without mutating its input.

`src/domain/project-sessions/sessionReferences.ts` supplies live catalog operations
and scoped helpers. `SessionReferenceEntry` contains `sessionId` and optional
`title`. `resolveIn(reference, roster)` returns a canonical ID or a typed
`ProjectSessionError`; `projectIn(value, roster)` projects JSON; `labelIn(id, roster)`
adds a readable title. `catalog()`, `resolve(reference)`, and `project(value)` use
registered Project roots, Managed Worktrees, retained family membership, archived
sessions, and available saved Drafts.

Workboards use their already-authorized family roster with the scoped helpers;
reminders can use the same roster and labels. Scope selection remains with the
owning domain operation. The `SessionReferenceControl` callback contract exposes
`resolve(reference, signal)`, `project(value, signal)`, and `ids(signal)` to runtime
adapters without allowing Services to import domain implementation modules.
