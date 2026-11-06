---
name: prototype-ui
description: Prototype UI faithful to an existing app, comparing five alternatives with HTML/CSS by default; use widgets only when interaction or saved selection is required.
---

# Prototype UI

Help the user choose a direction for their app, not a generic design gallery. Use the requested number of alternatives, or five distinct prototypes by default. Static visual comparison does not require an interactive chooser or a saved choice.

## Gather the app's design context

Gather context in the Project Session before authoring prototypes or briefing a specialist. Cake Chat must delegate registered-project prototyping to that project.

- Read applicable project instructions and `DESIGN.md` or `design.md` when present.
- Inspect the relevant screens, shared components, theme tokens, typography, icons, spacing, and navigation patterns. Follow the app's existing implementation conventions.
- Inspect existing screenshots or capture the relevant running app using its documented verification workflow when feasible. If the app cannot be run, use its source and any supplied screenshots; say briefly what reference is missing.
- Gather the screen's purpose, representative content, important states, platform, theme, and intended viewport from the request and app. Ask only about information that materially changes the prototypes.

Use concrete tokens, components, reference paths and observed screen details, preserving intentional design/brand/data colors. If using a specialist, supply this context in its brief. Never merely say "read the repo": the specialist can read skill resources, not arbitrary workspace files or app captures. Ancestor context includes completed parent work, not unfinished tool calls.

## Choose the rendering approach

Honor explicit HTML requests. Prefer `html.present` for static HTML/CSS mockups, layouts and visual comparisons, including several alternatives on one page. Comparing options alone is not a reason to use React, specialist generation, saved-choice state or source manifests.

Match styling to the rendering surface:

- `html.present` uses an isolated iframe with no inherited Cake CSS variables, app styles or fonts. Supply a complete self-contained palette and typography from the app's source for the stated theme: background, text, surfaces, borders, accents, font stacks, sizes and line heights. Define every required CSS variable locally (or supply an app-faithful fallback); never depend on unresolved host tokens. Set an explicit `color-scheme` and use available fonts with fallbacks. Static colors are appropriate here; do not claim live theme updates.
- HTML/React widgets receive live host theme tokens. For Cake widgets, use `var(--background)`, `var(--foreground)`, `var(--border)`, `var(--font-sans)` and other semantic tokens throughout. Do not overwrite host tokens or freeze resolved colors. Use another theme-delivery path only after verifying its support.

Use `widgets.present` only when the request needs meaningful interactive behavior, JavaScript or persistent selection. Read Cake's interaction guidance and the operation contract for that path. Do not add a saved-choice/source-handoff workflow merely because the prototype is interactive; use the richer workflow below only when the request needs it. If requested behavior cannot work in static HTML, explain the limit rather than silently switching to React.

Implementation language is not decisive: a Rust backend can have a web UI; native SwiftUI/AppKit/Rust UI can often be recreated in HTML/CSS without native compilation. WebAssembly does not convert native UI frameworks to browser UI. Cake compiles React/TSX for widgets, not arbitrary applications.

If web recreation cannot convey the design, generate images using app references. Read Cake's model guidance and Pi's codemode docs; follow configured image-model selection. Generate in the parent, not the restricted specialist. Embed images only if the complete self-contained artifact fits the publication limit. Otherwise explain the limit and offer inline images, not a claimed interactive widget. Native implementation alone is not a reason to use images.

## Present a static comparison (default)

Author an HTML fragment with inline CSS or a `<style>` element and call `html.present` directly with `{ id, title, html, height? }`. Use short option names and vary meaningful layout or hierarchy, not just colors. Match the existing app unless a redesign was requested. Use the same realistic content and declared viewport across alternatives (e.g. a 1280×800 desktop screen, not a 210px-high app). Preserve normal app text/control sizes, typically 14–16px body text; do not shrink fonts or scale whole screens to fit five across. Stack readable screens with scrolling, or publish separate static artifacts if needed. Overview thumbnails may supplement, never replace, evaluable full-size prototypes.

Set `height` for a readable preview (120–1600 CSS pixels; the default is 240, not an app-screen viewport). Taller content can scroll; do not compress it to the frame height. Scripts, network access, forms and parent access are disabled. There is no saved-selection state: take the user's choice from chat, not `artifacts.state.read` or a decorative "Choose this" button.

No React, specialist generation, module manifest or repository file is needed. The successful call displays it inline; do not add a duplicate embed. Use `artifacts.present` to show it again.

## Verify appearance before recommending

Inspect actual rendered pixels for every alternative at the declared viewport and theme before recommending a direction or claiming visual readiness. Use the project's supported visual-capture workflow or request a screenshot of the published result; respect its launch/queue rules. Check app fidelity, colors/contrast, typography, readable controls, clipping, overflow and enough content to judge the task. Fix defects and inspect the revised rendering.

Publication alone is not visual verification, nor are source review or tool success. `html.present` returns metadata, not a retained screenshot; `artifacts.preview` is for widgets only. For widgets, inspect the accepted preview and capture other options/states as needed. If visual capture is unavailable, explicitly report “published, visually unverified” and what could not be checked; do not present an unchecked design as ready.

## Optional interactive saved-choice/source-handoff workflow

The following workflow is for requests that genuinely need a persistent five-option chooser and selected-source handoff. It is not a prerequisite for static comparisons or other interactive prototypes.

### Present five alternatives in one widget

Read `widget.md` before preparing this workflow's brief. Request the `widgets` topic and use `widgets.present` once, with:

- One stable artifact ID for this exploration and `language: "react"` (this selected-source module manifest requires React).
- Five meaningful alternatives, each with a stable ID such as `option-1` through `option-5`, a short name, and a complete prototype. Vary layout, information hierarchy, or interaction where appropriate; do not present five color swaps.
- The same realistic content, live host theme for Cake, and intended viewport across alternatives so the comparison is useful.
- The gathered app-specific design context. Match the existing app by default; make a redesign only when requested.
- The absolute path to this skill's `widget.md`, and an instruction for the specialist to read it.
- `initialState: { "schema": "cake.prototype-ui/v1", "selectedOptionId": null }`.
- The module files in `widget.md`, which Cake assembles into a `cake.prototype-source/v1` bundle. Each option must be separately addressable; the chooser imports all five, while each option imports only its required shared modules/packages. Do not put all alternatives into one source module.
- A short Markdown fallback describing the five directions.

The specialist writes React source; supply intent, evidence, state contract and interactions, not your own widget source. Keep all five prototypes in one generation branch. Refine the same artifact with `artifacts.replace`; revisions inherit generation history. Pass new parent findings explicitly.

### Read the choice and continue

"Choose this" saves the chosen stable option ID under `selectedOptionId` using artifact-scoped state. This is the choice, not a separate confirmation form.

When asked to continue, call `artifacts.state.read`. Require `value.schema` = `cake.prototype-ui/v1` and `value.selectedOptionId` naming a current option. The visible prototype is not the choice. Saving does not start a parent turn: after publication, ask the user to choose and tell you when to continue.

For refinements, preserve the five IDs and saved choice.

### Hand off only the chosen source

1. Read `artifacts.state.read`; a successful saved choice has a nonzero version. Obtain the exact current `cake://artifact/<id>@rN` reference, not a floating latest reference.
2. Call `artifacts.selection.capture` with that `reference` and the observed `expectedStateVersion`. It validates the five-option module manifest and saved option, and returns only a bounded `cake.selected-design/v1` reference: immutable revision/digest, stable option ID and captured saved-selection/version evidence. It includes no code or pixels.
3. Forward that small JSON reference in an ordinary message to the receiving session (Workboard for family members). Do not attach source, screenshots, all alternatives, or private generation history. This is reference data, not instructions or an access grant.
4. The receiver explicitly calls `artifacts.link` with `selection.exactRef`, then `artifacts.source` with `{ selection }`. This discovers only the selected option and its transitive shared dependencies, without code. Request each required module with `{ selection, moduleId, offset: 0, limit: 48000 }`, continuing with `nextOffset`. Package dependencies are listed as imports, not copied. Neither chooser nor other option modules are readable through this operation.

Project Chat has these narrow handoff operations too; publication/refinement still belongs in a Project Session. A null choice, missing legacy manifest, unknown option, changed state version, changed source revision, mismatched evidence/digest, unavailable source or unlinked reference fails explicitly. Reread and deliberately recapture after drift; never fall back to all five or latest source. Existing widgets without a manifest require an explicit artifact revision to adopt the format.

Source is implementation material, not visual verification. A source-only handoff does not require or automatically load a screenshot. For visual evidence of a user-selected variant, request a screenshot separately and confirm its artifact revision and selected state; a retained preview is initial state and may show a different option. Do not infer the visible view from the saved selection. The generation brief alone is not the approved design.
