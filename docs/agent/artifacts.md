# Artifacts

Keep ordinary work/reports in chat. Text artifacts need a request or shared durable spec; no repository task records. Maintained documentation, executable code/tests and requested file deliverables remain repository files.

## Publish and revise

Create/revise the same artifact; share exact revisions, not copied files. Content is not preloaded: discover, resolve, read relevant content. Publish Markdown with `artifacts.create`, not a temporary repository document.
Markdown update/replace needs expectedRevision; projection files are read-only. `artifacts.update` matches unique, non-overlapping edits against the original revision; `artifacts.replace` rewrites Markdown/files or requests widget source/behavior changes.
Include the exact approved reference in assignments. If you cannot publish, ask the owning Project Session rather than creating a repository substitute.

## Approved designs and selections

Approved designs: inspect exact @rN preview pixels before implementation; confirm selected state too. Compare real implementation pixels. Source/descriptions are not visual proof.
An accepted PNG covers bounded initial state, not every interaction/theme/viewport or later selection. Use `artifacts.preview` or read resolved `preview.png`; request matching live-state pixels when needed. Disclose unavailable pixels.
selection.capture pins revision/selection evidence. Receiver links exactRef, discovers artifacts.source modules, reads selected dependencies. Drift needs recapture; no latest/all-options fallback.
[Design handoff details](artifact-designs.md): exact evidence, selected-source manifests, module paging and recipient scope.

## Widgets

Loaded skill templates: call widgets.instantiate directly; no extra discovery/generation/install.
HTML widgets use cakeArtifact state; React uses @cake/artifact-sdk. Preserve language on repairs. Await hydration and handle version conflicts.
[Widget authoring](widget-authoring.md): language, saved state, links, speech and skill-template behavior.

## Live widget theme

Widgets receive live theme variables/data-theme; do not freeze colors or override host theme. Use semantic CSS variables, including inside Cake prototype frames; static `html.present` is different.
[Live theme contract](widget-theme.md): tokens, System changes, canvas redraws, palette exceptions, reopen checks and immutable previews.

## Global tools and runtimes

globals/viewing finds identities; inspect/tools/call exposes semantic APIs. Do not replace private state as an API.
runtime.publish/schedules manage independent backend logic; inspect receipts. Historical views must not duplicate effects; handlers cannot synchronously control their own runtime.
[Runtime authoring](artifact-runtime.md): retention/deletion, command bridge, shell, scheduling, lifecycle and receipts.

To show existing content, use `artifacts.present`; [presentation](presentation.md) explains scope and links. Consult exact operation help only when its contract is unfamiliar.
