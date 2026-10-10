# Artifact presentation

The [artifact protocol](../architecture/s4-artifact-protocol.md) owns detailed
lineage, revisions, links, deletion, blocking requests, and widget sandbox contracts.
An artifact is an explicit substantial/reusable deliverable, not a syntax-derived
presentation choice. Ordinary Markdown, Mermaid, and small tables remain inline.
Architecture diagrams normally use native editable Draw; custom explorable UI uses
delegated widgets when Draw cannot express it.

## Renderer owners

`ArtifactLibraryStore` owns search, filters, paging, and active-Session scope.
`ArtifactDetailStore` owns selected lineage/revision, history, comparison, and
restore coordination. Window-owned `ArtifactReferencePreviewStore` owns bounded
metadata previews and shared link/materialization actions. All use `ArtifactCatalog`,
not copied entities.

The Session header opens the accessory panel; artifact creation opens/selects it.
Family-session creation links the lineage to the family by default. Branch changes
and Tool Compact do not move/duplicate artifacts. Stable refs use
`cake://artifact/<lineage-id>`; exact revisions append `@rN`.

Visual publication references may expand inline through shared `ArtifactHost` with
exact revisions carried by Pi projection. Standalone Markdown artifact-image
paragraphs explicitly opt into disclosure; prose references remain links.
`InlineArtifactPreviewStore` owns lazy reads and per-mount disclosure only. Payloads
remain in the shared catalog. Inline/panel hosts share storage and receive live
theme/font tokens without reload; widgets report growth/shrinkage independently of
viewport height.

## Agent access and publication

Agents explicitly discover linked artifacts through Cake operations. The system
prompt has static trusted guidance and, only when links exist, a metadata-free
capability hint. Payloads/metadata are never automatically injected. File tools
read disposable, read-only, digest-verified exact-revision projections under Cake's
cache root; generated widget source is excluded.

Widget generation/repair runs in separate tool-less Pi Sessions. Main compile-checks
and reviews actual widget-only screenshots in a serialized hidden offscreen Electron
host before publication, allowing at most two replacements. Historical graph blobs
and Pi pointers remain immutable; readable Markdown fallbacks replace a parallel
graph renderer.

Conservative lineage collection runs after permanent Session/family deletion commits
and at startup. Surviving direct/family links and exact Pi pointers retain all
history; unverifiable reachability retains rather than deletes. Projection-cache
cleanup is independent of durable storage.

## Verification

- [Library workflow](../../tests/app/renderer/artifact-library-workflow.test.tsx)
- [Session artifacts](../../tests/app/renderer/session-artifacts-workflow.test.tsx)
- [Reference previews](../../tests/app/renderer/artifact-reference-preview.test.tsx)
- [Collection policy](../../tests/app/domain/artifactGarbageCollection.test.ts)
