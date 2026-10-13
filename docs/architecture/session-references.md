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
