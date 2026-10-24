# Agent-facing session references

Session identity remains the canonical UUID in Pi history, Cake storage, family
membership, scheduling, coordination metadata, and internal APIs. A short reference
is an agent-boundary projection, not another stored identity or a name alias.

## Syntax and resolution

Agents may target a session with its canonical identity or a bare hexadecimal suffix:
8–32 trailing characters for UUIDs (hyphens removed), or 8–64 for Project Chat hashes.
Global Cake Chat uses the distinct `cake-chat` label. Matching
is case-insensitive for suffix hex. General operation results retain canonical
identities. Where an authoritative roster is already available, the default emitted
suffix is eight characters; collisions extend it one character at a time until
unique in that roster. UUIDv7 prefixes are intentionally not used because nearby creations share
them. Titles are readable labels, never routing identities.

For example, in a roster with no suffix collision,
`01957936-0000-7000-8000-000112345678` projects to `12345678`.
If another session ends in `000212345678`, the references become
`112345678` and `212345678`. The eight-character reference is then ambiguous
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

General Cake operation results retain canonical session identities in text and
structured data, except for global Cake Chat's fixed `cake-chat` label. Cosmetic
projection performs no global catalog or archive discovery: a cheap read must not
scan every Project and Worktree merely to abbreviate its result. This also keeps
references unambiguous against identities outside the result without caching a
potentially stale global roster.

Operations that already own an authoritative roster, such as Workboards, may
project session identity fields using that roster. Projection never rewrites user
text, paths, family IDs, message IDs, or thread IDs. Human titles remain readable.
Structured outputs project identity fields only when the resulting value still
satisfies the operation's declared output schema. No typed output contract is
silently weakened.

Cross-session envelopes and generated notice headers are shortened in disposable
provider context, both for regular Pi and Pi Durable. Persisted envelopes and
renderer provenance retain canonical routing metadata. This does not create a
second transcript or modify Pi originals.

## Human-facing presentation

Session-ID links display collision-aware bare trailing suffixes. Markdown identity-only link labels
(including inline-code labels) use this presentation; authored titles stay intact.
Known short link targets resolve against the live roster before rendering so the
link destination and tooltip retain the canonical Pi UUID. Unresolved or ambiguous
short targets keep the existing navigation error behavior, never a guessed identity.
Workboard author, audience and receipt metadata and missing-title fallbacks in the
artifact's Linked sessions section use the same bare-suffix links.
Storage and internal routing retain canonical identities; only agent/display references shorten them.

## Exact message references

An exact message reference is also its user-openable link:
`cake://session/<canonical-session-id>?message=<Pi-entry-id>`. It preserves Pi's
entry ID, not a renderer part ID, a cross-session delivery ID, or a summarized
replacement. Forward this opaque string unchanged through `messageRefs`; resolving
or forwarding it does not require reading its body. No reference registry or
second transcript is persisted.

- `messages.list` returns bounded metadata only. Text uses compact role/active/images/
  timestamp/ref rows; attachment input rows belong to the preceding message. The
  exact opaque reference appears once rather than duplicating ref/link and embedded
  session/entry identities. Declared typed data retains full `ref`/`link`, session and
  entry identity, parent, role, timestamp, active-branch status, and attachment `inputRefs`
  (identity, name, MIME type, byte length). It defaults to 25 chronological active
  branch messages; `branch: all` includes original inactive branches. `nextOffset`
  continues discovery, including pages shortened to keep metadata bounded.
- `messages.read` explicitly reads one exact original across Pi's full tree. It
  defaults to 4,000 characters, permits at most 20,000, and returns `nextOffset`
  for continuation. It never returns inline image bytes. Missing/non-message
  entries fail; no text search, current-context, or summary fallback is used.
- `messages.present({ ref })` checks the existing message-read access boundary and returns
  only exact source metadata. Its successful Pi tool-result original projects a collapsed
  **Full agent response** disclosure, including after reload in permanent Project/global
  Chat. The shared transcript also presents exact message refs in assistant text,
  correlated replies, notification digests and subagent reports automatically, regardless
  of the authored link label; repeated refs within one part produce one disclosure.
  No assistant tool relay or additional completion notice/turn is required. Ordinary
  session-only and unrelated links remain navigation links. Source title, canonical link, entry identity, role and timestamp
  retain provenance. Expansion pages at most 20,000 characters through the existing
  reader; pages stay transient and do not enter model context. Formatting uses shared
  Markdown, with image loading disabled and attachment metadata explicitly uninspected.
  Missing/inaccessible originals show an explicit error and retry, never latest/summary
  substitution. Deleting the source removes evidence; this is not an archival copy.
  Presentation never changes source history, ownership, artifacts or resultDelivery.
  Regular producer originals are read directly through the stateless Pi disk adapter,
  not by assembling an agent or restoring a resolved worktree.
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
Cake Chat originals, not private side-chat transcripts. Subagent navigation uses
`cake://subagent/<encoded-parent>/<public-handle>?message=<original-entry-or-part>`:
it opens the retained worker conversation under its parent and marks that exact
response, never a private Pi session or the recipient's serialized reminder. Deferred
report list/read results expose this canonical `ref`; older reports without an exact
message identity link only the retained public conversation. Reminder wrappers remain
inspectable originals, but must not be selected as Full agent response sources.
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
- `projectSessionReferences(value, knownSessionIds?)` projects JSON session identity
  fields, including board audiences and receipt authors, without mutating its input.
  Without a roster it retains canonical IDs, except for Cake Chat's fixed label.

`src/domain/project-sessions/sessionReferences.ts` supplies live catalog operations
and scoped helpers. `SessionReferenceEntry` contains `sessionId` and optional
`title`. `resolveIn(reference, roster)` returns a canonical ID or a typed
`ProjectSessionError`; `projectIn(value, roster)` projects JSON; `labelIn(id, roster)`
adds a readable title. `catalog()` and short-reference `resolve(reference)` use
registered Project roots, Managed Worktrees, retained family membership, archived
sessions, and available saved Drafts. Canonical resolution bypasses that discovery;
`project(value)` is storage-free and preserves canonical IDs except for Cake Chat's
fixed label.

Workboards use their already-authorized family roster with the scoped helpers;
reminders can use the same roster and labels. Scope selection remains with the
owning domain operation. The `SessionReferenceControl` callback contract exposes
`resolve(reference, signal)`, `project(value, signal)`, and `ids(signal)` to runtime
adapters without allowing Services to import domain implementation modules.
