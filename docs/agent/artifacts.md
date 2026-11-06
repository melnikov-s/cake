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

A preview covers one bounded initial-state view, not all interactions, themes or viewports. Compare the implementation's real screenshot against the same approved revision and verify relevant interactions. A matching revision is not enough: Initial state may show A while the user selected C. For an approved interactive selection, request a screenshot and confirm its artifact revision and selected state before implementation.

Saved lineage state is advisory. Do not infer unavailable widget-local state or variants from source. Never claim visual verification from source or an image description alone. If nested tool forwarding returns text only, call the image tool directly or read with an image-capable tool; disclose missing pixels.

## Source-only prototype handoff

`artifacts.selection.capture` pins an exact revision/digest, stable option ID and observed saved-selection/version evidence. It returns a bounded reference, no code or pixels. Forward only that reference (Workboard within a family). The receiver links its exactRef, calls `artifacts.source` to discover the selected option's transitive shared dependencies, then reads individual module pages.

This requires a validated prototype module manifest; legacy widgets fail explicitly. Revision/state drift requires deliberate recapture, never latest/all-options fallback. Screenshots, other alternatives and generation history are not attached. Source-only retrieval is not visual verification and requires no screenshot; request visual evidence separately when needed.

Permanent Project Chat/global Cake Chat expose linking, inline presentation, saved-state read,
capture and selected-source operations, plus artifact metadata/global discovery and semantic
tool invocation. Widget generation remains the Project Session workflow.

## Global artifacts and semantic tools

Use `artifacts.globals` to discover globally retained artifacts and `artifacts.viewing`
to identify visible/active references in the correct window, including fullscreen.
Do not assume the creator's artifact is what the user means by "this". Inspect one
identity with `artifacts.inspect`, discover its typed operations with `artifacts.tools`,
then invoke `artifacts.call({lineageId,name,input})`. These handlers work with the
view closed; do not inspect or overwrite private saved state as a substitute API.

`artifacts.set-global({lineageId,global:true})` retains any artifact kind independently
of creator-session deletion. Global does not mean installed app. Use the existing
Library, pinning and fullscreen presentation. `artifacts.delete` stops execution,
removes schedules and deletes Cake-owned artifact data; it does not delete arbitrary
outside files. Titles/descriptions are ordinary artifact metadata.

Executable widgets can publish trusted backend logic/typed tools with
`artifacts.runtime.publish`. Their view is disposable; independent QuickJS logic
and artifact-scoped persistence are backend-owned. Both view and runtime have the
canonical Cake-command bridge, including supported filesystem/network/shell operations
and explicit-destination, artifact-attributed chat. Agent calls carry the actual
calling session; background calls invent no session. Discover bridge schemas with
`artifacts.commands`; `artifacts.command` has the same supported bridge semantics.
`shell.run({command,cwd,timeoutSeconds?,env?})` runs shell syntax on the backend with
required absolute `cwd`, inherited environment plus overlays, and separate bounded
stdout/stderr, exit status and timeout/truncation flags. It needs no session/view;
GUI PATH may need an explicit `env.PATH` or absolute CLI path. Use a timeout for
shell work inside admitted semantic handlers. See the
[authoring guide](../development/global-artifact-authoring.md#shell-backed-cli-integrations).
This is not a promise that every Pi tool is a Cake command. A handler must not
synchronously invoke/control/publish its own runtime through Cake; these operations
reject before changes rather than waiting on the handler itself. Use an external
caller for lifecycle control. Read-only discovery and other artifacts remain usable.

`artifacts.schedules.configure/list/remove` use the existing durable automation
worker to invoke handlers without an LLM or conversation message. Overdue work
catches up once after restart; backend-off means no execution. Runtime pause stops
logic and pauses background until explicit resume. Opening/start/restart does not
silently resume schedules; tools remain discoverable. Check runtime/schedule
receipts rather than claiming success from configuration alone. Historical views
must not activate duplicate side effects. See the maintained
[authoring API](../development/global-artifact-authoring.md) for source, lifecycle,
SDK, persistence and schedule examples. Never claim a live PR integration from the
deterministic example's fake network/chat tests.

## Skill widget templates

A loaded skill can supply `widget.json` (`language` and skill-relative `source`).
Cake prepares its renderer internally at fresh-session startup using already-added
widget libraries. Create an independent document directly with
`widgets.instantiate({template: "<skill name>", id, title, initialState, fallback})`.
Use the skill's complete call and data instructions: no editor/artifact searches,
codemode, additional renderer reads, package/settings discovery or code generation
belongs in ordinary creation. Setup failures remain explicit; never silently install
a library or generate a substitute. This is generic skill/library support, not a
built-in integration for any drawing library. Preparation may compile at startup;
the creation call reuses retained output without compilation or model review.

## Widget language and state

Ordinary `<a href="https://…" target="_blank">` links open through the viewing device’s host, including React-rendered links. `window.open(url)` also opens a URL through that host but returns `null`: do not rely on popup handles, `document.write`, named-window reuse or window features. Downloads and local hash navigation remain ordinary anchors; do not replace them with `window.open`.

`widgets.present` accepts `widget.language: "html"` for self-contained HTML with inline CSS/JavaScript: no JSX, packages, external scripts or bundling. React is the default for installed libraries, component-heavy UI and prototype-ui manifests. Both use the same sandbox, mandatory browser/visual review, immutable revisions, fallback and retained accepted PNG. Replacements preserve language.

HTML saved state uses `globalThis.cakeArtifact.read()`, `getSnapshot()`, `subscribe(listener)` and `replace(jsonValue, expectedVersion)`; await hydration and handle conflicts. React uses `@cake/artifact-sdk`. The maintained artifact protocol has an HTML state example.

Artifact widgets and Session Plugins can read text aloud in the user's configured voice: `globalThis.cakeSpeech` (HTML) or `useSpeech()` (React SDKs) with `speak(text)`, `pause()`, `resume()`, `stop()` and sentence-chunk progress (`chunk`, `chunks`, `start`, `end`) for highlighting. Request it in the widget brief, for example an article reader with Play, Pause/Resume and Stop. Speech errors (for example not configured) reach the widget as a readable message.

## Live widget theme

HTML and React widgets receive Cake's current effective theme before first paint and live updates without iframe navigation, including OS changes when Cake selects System. Use semantic CSS variables directly: `color:var(--foreground); background:var(--background); border:1px solid var(--border)`. Paired surfaces include `--card`/`--card-foreground` and `--primary`/`--primary-foreground`; supporting roles include `--muted`, `--muted-foreground`, `--accent`, `--success`, `--attention`, `--warning`, `--destructive`, `--font-sans` and `--font-mono`.

The public theme mechanism is these live variables plus host-owned `html[data-theme="light"]` / `html[data-theme="dark"]` and CSS `color-scheme`. The host resolves System; widgets must not independently use `prefers-color-scheme`, override root theme/tokens, persist a theme setting, or snapshot resolved colors on mount. No theme SDK import or custom message listener is needed for CSS. Imperative drawing can observe the root's `data-theme`/`style` changes and reread computed variables without recreating the editor or losing state.

For Cake prototypes, use live tokens inside prototype frames as well as the chooser. Aliases such as `--p-bg:var(--background)` remain live; copied dark screenshot colors do not. Other apps retain intentional brand/data/artwork colors; select any supplied light/dark palettes with the host's effective `data-theme`, not creation-time mode. Check dark→light→dark and System effective changes on open and reopened widgets. Retained initial-state PNGs are immutable evidence and do not retheme. A fixed-palette existing widget needs an explicit source revision; do not rewrite saved artifacts or choices automatically.

## Publish and revise

When the user requests a text artifact or a spec qualifies as a shared durable reference, discover `artifacts` and publish Markdown directly with `artifacts.create`. Do not first write a repository document.

- Revise it with `artifacts.update` for targeted Markdown edits: unique, non-overlapping `oldText`/`newText` matches against the original revision.
- Use `artifacts.replace` for full Markdown rewrites, replacement file snapshots, or widget revision instructions.
- Both require `expectedRevision` and publish immutable revisions. Never edit read-only artifact projection files directly.

Include the artifact reference and relevant revision in child-session assignments; ask recipients to read it before implementing the spec.
