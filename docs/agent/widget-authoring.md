# Widget authoring

For generated widget source, repairs or capability questions. [Interactions](interactions.md) chooses the surface; [themes](widget-theme.md) covers live styling.

## Language and review

`widgets.present` accepts `widget.language:"html"` for a complete self-contained document with inline CSS/JavaScript: no JSX, imports, packages, external scripts or bundling.
React is the default for installed libraries, component-heavy UI and prototype manifests. Both use the widget sandbox, browser/visual acceptance, immutable revisions, fallback and retained accepted PNG. Replacements preserve language.
Give the specialist verified facts, audience, goal, bounded data, interactions and fallback; not a diary or invented facts. Only already-installed libraries are available; dependency authorization happens outside the private generation branch.

Permanent Project Chat and Global Chat publish directly with `widgets.present`; use `widgets` or `widgets.present.help` for discovery. Their specialist receives the supplied brief/data, not inherited chat history. The accepted widget appears on the successful tool result; `plugins.present` mounts session controls and is not a substitute. `artifacts.commands` discovers the artifact bridge, not direct widget publishing.

## Saved JSON state

HTML uses `globalThis.cakeArtifact.read()`, `getSnapshot()`, `subscribe(listener)`, `replace(value,expectedVersion)`. Await hydration/read before mounting an editor or saving. Version zero uses seed; saved null is real data. Save against the observed version, reread conflicts, never blindly retry.
React uses `useArtifactState(initialValue)` from `@cake/artifact-sdk`: value, hydrated, version, save and error. The hydrated value is authoritative; choose the JSON format and save timing.
Display/request widgets have no durable artifact state. Source revisions and live lineage state are separate; a pinned source view may still show current saved state.

## Links and downloads

Ordinary `<a href="https://…" target="_blank">` links, including React links, open through the viewing device's host. `window.open(url)` also opens through that host but returns null.
Do not rely on popup handles, document.write, named-window reuse or window features. Downloads and local hashes remain ordinary anchors; do not replace them with window.open. No opener, parent DOM, Node or Electron access is implied.

## Read aloud

Artifact widgets and Session Plugins use the configured voice: HTML `globalThis.cakeSpeech`; React `useSpeech()` from the appropriate SDK. Request speech in the brief.
Provide speak(text,{from}?), pause, resume and stop. speak returns a Promise; snapshot includes status, error, chunk/chunks and start/end offsets for sentence highlighting. Keep text readable when speech fails.
Only one speaker runs; unmount/close stops it. Missing output configuration gives a readable error. No microphone, voice choice or audio-file capability is granted; display/request widgets have no speech.

## Prepared skill templates

A loaded skill may supply widget.json with language and skill-relative source. Cake prepares its renderer at fresh-session startup from already-added widget libraries; ordinary creation reuses retained output.
Use the skill's complete `widgets.instantiate({template,id,title,initialState,fallback})` call and data instructions directly. Each instance is an independent document.
No artifact/editor search, extra renderer reads, codemode generation, package/settings discovery or silent install/substitute. Setup failures remain explicit. This is generic skill/library support, not a built-in drawing-library integration.
