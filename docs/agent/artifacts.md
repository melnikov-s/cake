# Artifacts and design handoffs

Read before publishing/sharing artifacts or implementing an approved design. Read `presentation.md` before showing existing artifacts, links or images.

## Keep ordinary work in chat

Keep investigations, explanations, ordinary implementation details, progress, and reports in chat by default. Create text/Markdown artifacts only when the user explicitly requests them, with one exception: a spec may become a text artifact without an explicit artifact request when it serves as a shared, durable reference that this session can read after compaction or child sessions can read for coordinated implementation.

Shared-reference usefulness—not length, formatting, or merely being an investigation—is the purpose of these artifacts. This text/Markdown policy does not restrict non-text visual artifacts or explicitly requested file deliverables. Do not create repository Markdown files or duplicate artifacts in the workspace for task records; existing documentation is not precedent. Repository files remain appropriate for maintained project documentation, executable code/tests, or an explicitly requested file deliverable.

Cake streams GitHub-flavored Markdown, code, math, Mermaid and small tables in the transcript. Use these inline for ordinary conversation regardless of length or formatting.

## Share exact references

Share artifact references with other sessions rather than copying documents or relying on shared checkout files. Content is not automatically loaded: recipients must discover or link the artifact and inspect the relevant exact revision. Revise the same artifact; use an exact revision for an approved spec or assignment baseline. If your tools cannot publish artifacts, have the owning Project Session publish the document, never a repository substitute.

## Verify an approved design

Publication supplies the accepted review PNG as a native image to the caller. The live interactive rendering shown to the user is a separate surface; it does not prove agent inspection.

Before implementation, inspect the approved exact @rN preview with `artifacts.preview` directly or read resolved `preview.png`. The brief describes intent; it is not the approved visual design. Read projected source.tsx.txt/source.html.txt selectively for ambiguous layout/dynamic behavior; do not import private generation conversation history.

A preview covers one bounded initial-state view, not all interactions, themes or viewports. Compare the implementation's real screenshot against the same approved revision and verify relevant interactions. A matching revision is not enough: Initial state may show A while the user selected C. For an approved interactive selection, ask for Attach current view on that widget. Inspect the draft's matching pixels and exact-revision evidence before implementation.

Saved lineage state is advisory. Do not infer unavailable widget-local state or variants from source. Never claim visual verification from source or an image description alone. If nested tool forwarding returns text only, call the image tool directly or read with an image-capable tool; disclose missing pixels.

## Source-only prototype handoff

`artifacts.selection.capture` pins an exact revision/digest, stable option ID and observed saved-selection/version evidence. It returns a bounded reference, no code or pixels. Forward only that reference (Workboard within a family). The receiver links its exactRef, calls `artifacts.source` to discover the selected option's transitive shared dependencies, then reads individual module pages.

This requires a validated prototype module manifest; legacy widgets fail explicitly. Revision/state drift requires deliberate recapture, never latest/all-options fallback. Screenshots, other alternatives and generation history are not attached. Source-only retrieval is not visual verification and requires no screenshot; request visual evidence separately when needed.

Permanent Project Chat/global Cake Chat expose linking, inline presentation, saved-state read, capture and selected-source operations, not publication or broad inspection.

## Widget language and state

`widgets.present` accepts `widget.language: "html"` for self-contained HTML with inline CSS/JavaScript: no JSX, packages, external scripts or bundling. React is the default for installed libraries, component-heavy UI and prototype-ui manifests. Both use the same sandbox, mandatory browser/visual review, immutable revisions, fallback and retained accepted PNG. Replacements preserve language.

HTML saved state uses `globalThis.cakeArtifact.read()`, `getSnapshot()`, `subscribe(listener)` and `replace(jsonValue, expectedVersion)`; await hydration and handle conflicts. React uses `@cake/artifact-sdk`. The maintained artifact protocol has an HTML state example.

## Publish and revise

When the user requests a text artifact or a spec qualifies as a shared durable reference, discover `artifacts` and publish Markdown directly with `artifacts.create`. Do not first write a repository document.

- Revise it with `artifacts.update` for targeted Markdown edits: unique, non-overlapping `oldText`/`newText` matches against the original revision.
- Use `artifacts.replace` for full Markdown rewrites, replacement file snapshots, or widget revision instructions.
- Both require `expectedRevision` and publish immutable revisions. Never edit read-only artifact projection files directly.

Include the artifact reference and relevant revision in child-session assignments; ask recipients to read it before implementing the spec.
