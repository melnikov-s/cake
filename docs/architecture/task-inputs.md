# Task-input attachments

Task inputs are original, user-supplied material for a task, not published Artifacts,
Artifact revisions, or Discussion Sessions. Shared Chat presents files, images and
large pasted text as attachments. Paste conversion uses a deterministic threshold
(4,000 characters or 40 lines) before composer insertion; it never calls a model.
Pasted text has an 8 MiB UTF-8 limit and retains whitespace/newlines exactly.

## Ownership and admission

- `ComposerDraftStore` owns unsent attachments and errors. Existing window draft
  snapshots can retain unsent originals; these are not global transcript/memory.
- `AttachmentUploads` remains connection-owned transport staging for remote files
  and images, with its existing limits and ten-minute abandonment cleanup.
- `TaskInputStorage` owns accepted immutable originals under backend state,
  outside checkouts. It snapshots native files (up to 8 MiB), preserves their
  extension, preserves image base64 originals, and stores large text as a file.
  Bounded metadata manifests are separate from payload documents: validating and
  forwarding a reference does not open its contents.
- `prepareTaskInputs` applies kind-specific domain policy before Pi admission.
  Cake Chat gets only validated metadata/opaque IDs. Project Sessions get image
  parts and readable file paths; large logs are not automatically expanded.
- The durable global runtime rejects any payload-bearing attachment, even if a
  caller bypasses the normal domain path. Explicit content access is a separate,
  session-scoped capability, never an input-admission side effect.
- Pi owns the recipient and global transcripts. Storage documents hold inputs and
  forwarding grants only, never a second transcript.

## Forwarding and isolation

`sessions.create` and `sessions.send` accept selected `inputRefs` IDs. The trusted
control boundary validates ownership or an explicit recipient grant and replaces those IDs with
backend-issued forwarding capabilities, never returning those capabilities to
its model. Create grants bind to the first recipient; send grants bind to the
explicit target. Recipient admission validates grants and canonical metadata.
Retries to that recipient resolve the same originals; another recipient cannot
reuse that grant. This is Cake's single-user backend security boundary, not a
multi-tenant or hostile-shell sandbox.

Default global tool projections redact protected recipient titles/content and block
content-bearing inspection/queue operations. Explicit `messages.read`, `attachments.read`
and `app.user-selection` are deliberate reads, not default projections. Reports from a
protected recipient entering Cake Chat through shared cross-session delivery,
backend completion outboxes, or explicit coordinator replies are replaced with an
application-generated notice. Exact message links survive as bounded reference metadata,
not surrounding report text. Read the actual response explicitly through its reference or Project Session.
Linked-response rendering is a separate follow-up; routing, correlation and durable
report receipts are preserved. Backend session creation passes selected input grants
directly to recipient admission without depending on a renderer lookup. Protection follows supported cross-session sends,
Project-local independent sessions, drafts, family children and forks so derived
reports from those descendants cannot bypass the direct-recipient boundary.
This does not automatically grant descendants access to the original references.

## Discovery and explicit inspection

`attachments.list` returns only references authorized for the calling agent, including
older inputs. `attachments.read` accepts an exact input ID, never a path or a target
session ID. Owner access and explicitly granted recipient access survive restarts. A versioned
storage migration rebuilds recipient access metadata from earlier bound grants without
opening originals or creating a transcript index.
A recipient may forward a granted reference onward; possession of an ID alone does
not authorize a read. Bounded investigators receive only the selected input grants,
not the parent's entire attachment collection.

Image inspection returns native PNG/JPEG/GIF/WebP content through Cake's existing
image-result protocol, with no base64 in text or details. UTF-8 text and JSON return
bounded text pages with exact offsets. Unsupported binary/image formats, invalid
ranges, inaccessible files and unauthorized/missing references fail explicitly.
The inspection boundary reads pinned vault originals only; it cannot read arbitrary
local files. Referenced content is data, never privileged instructions.

`messages.list/read` use exact Pi entry IDs and the existing session/message link
convention; `messageRefs` on create/send carries those links without inspecting bodies.
Reading an explicitly referenced message grants access only to attachment inputs its
source is authorized to share. Pi Durable originals provide the same reference behavior
for permanent Cake Chat; regular Pi preserves exact inactive/pre-compaction entries.
See [message references](session-references.md#message-references).

## Retention and limits

Accepted inputs/grants and recipient protection survive restart. They stay pinned
for history/replay: completion, compaction, session resolution and worktree removal
are not deletion. Unbound create grants expire after ten minutes, without deleting
the original input. Expiration alone does not reclaim stored grant documents.
There is intentionally no age-based collection of accepted inputs in this first
version. A future explicit purge/collector must account for all transcript branches,
archives, forks and pending delivery before deletion; retaining replay inputs is
not a durable Artifact publication lifecycle.

Images remain originals in the input vault; recipients also receive an original-file
path for full-fidelity tool access. Pi may resize their conversation image copies.
Unsupported/blocked image models and declared per-message image-count limits fail
explicitly rather than silently dropping images, OCRing them, or changing models.
Arbitrary binary files are tool-readable files, not provider-native file parts.

## Follow-up boundaries

- User previews of accepted references after restart and delivery-state chips.
- Reference-aware deletion, abandoned-input collection, and disk quotas.
- Durable exactly-once create/send receipts: existing delivery does not permit blind
  retries after an ambiguous receipt. Grants are idempotent, but turns are not thereby
  exactly-once; busy Project Session queues retain their existing runtime lifetime.
- Extensions, generated files/shared metadata and deliberate content copying outside
  supported session flows. This is not data-loss-prevention against a trusted Project
  agent actively exfiltrating through filesystem or application mutations.
