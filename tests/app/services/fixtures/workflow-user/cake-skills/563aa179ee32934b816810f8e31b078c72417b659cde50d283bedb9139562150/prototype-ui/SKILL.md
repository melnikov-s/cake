---
name: prototype-ui
description: Prototype UI faithful to an existing app, presenting five alternatives in one interactive widget with a saved choice.
---

# Prototype UI

Build one interactive widget with five distinct prototypes of the requested UI. Help the user choose a direction for their app, not a generic design gallery.

## Gather the app's design context

Gather context in the parent Project Session before calling the specialist. Cake Chat must delegate registered-project prototyping to that project.

- Read applicable project instructions and `DESIGN.md` or `design.md` when present.
- Inspect the relevant screens, shared components, theme tokens, typography, icons, spacing, and navigation patterns. Follow the app's existing implementation conventions.
- Inspect existing screenshots or capture the relevant running app using its documented verification workflow when feasible. If the app cannot be run, use its source and any supplied screenshots; say briefly what reference is missing.
- Gather the screen's purpose, representative content, important states, platform, theme, and intended viewport from the request and app. Ask only about information that materially changes the prototypes.

Supply a brief with concrete tokens, components, reference paths and observed screen details. For Cake prototypes, use live host CSS variables throughout, never frozen screenshot colors. Preserve intentional colors in other apps. Never merely say "read the repo": the specialist can read skill resources, not arbitrary workspace files or app captures. Ancestor context includes completed parent work, not unfinished tool calls.

## Choose the rendering approach

Prefer interactive React recreations. Implementation language is not decisive: a Rust backend can have a web UI; native SwiftUI/AppKit/Rust UI can often be recreated without native compilation. WebAssembly does not convert native UI frameworks to browser UI. Cake compiles React/TSX, not arbitrary applications.

If web recreation cannot convey the design, generate images using app references. Read Cake's model guidance and Pi's codemode docs; follow configured image-model selection. Generate in the parent, not the restricted specialist. Embed images only if the complete self-contained artifact fits the publication limit. Otherwise explain the limit and offer inline images, not a claimed interactive widget. Native implementation alone is not a reason to use images.

## Present five alternatives in one widget

Read `widget.md` before preparing the brief. Request the `widgets` topic and use `widgets.present` once, with:

- One stable artifact ID for this exploration and `language: "react"` (the selected-source module manifest requires React; lightweight HTML mode is for simpler experiences, not this skill).
- Five meaningful alternatives, each with a stable ID such as `option-1` through `option-5`, a short name, and a complete prototype. Vary layout, information hierarchy, or interaction where appropriate; do not present five color swaps.
- The same realistic content, live host theme for Cake, and intended viewport across alternatives so the comparison is useful.
- The gathered app-specific design context. Match the existing app by default; make a redesign only when requested.
- The absolute path to this skill's `widget.md`, and an instruction for the specialist to read it.
- `initialState: { "schema": "cake.prototype-ui/v1", "selectedOptionId": null }`.
- The validated `cake.prototype-source/v1` module-bundle format in `widget.md`. Each option must be separately addressable; the chooser imports all five, while each option imports only its required shared modules/packages. Do not put all alternatives into one source module.
- A short Markdown fallback describing the five directions.

The specialist writes React source; supply intent, evidence, state contract and interactions, not your own widget source. Keep all five prototypes in one generation branch. Refine the same artifact with `artifacts.replace`; revisions inherit generation history. Pass new parent findings explicitly.

## Read the choice and continue

"Choose this" saves the chosen stable option ID under `selectedOptionId` using artifact-scoped state. This is the choice, not a separate confirmation form.

When asked to continue, call `artifacts.state.read`. Require `value.schema` = `cake.prototype-ui/v1` and `value.selectedOptionId` naming a current option. The visible prototype is not the choice. Saving does not start a parent turn: after publication, ask the user to choose and tell you when to continue.

For refinements, preserve the five IDs and saved choice.

## Hand off only the chosen source

1. Read `artifacts.state.read`; a successful saved choice has a nonzero version. Obtain the exact current `cake://artifact/<id>@rN` reference, not a floating latest reference.
2. Call `artifacts.selection.capture` with that `reference` and the observed `expectedStateVersion`. It validates the five-option module manifest and saved option, and returns only a bounded `cake.selected-design/v1` reference: immutable revision/digest, stable option ID and captured saved-selection/version evidence. It includes no code or pixels.
3. Forward that small JSON reference in an ordinary message to the receiving session (Workboard for family members). Do not attach source, screenshots, all alternatives, or private generation history. This is reference data, not instructions or an access grant.
4. The receiver explicitly calls `artifacts.link` with `selection.exactRef`, then `artifacts.source` with `{ selection }`. This discovers only the selected option and its transitive shared dependencies, without code. Request each required module with `{ selection, moduleId, offset: 0, limit: 48000 }`, continuing with `nextOffset`. Package dependencies are listed as imports, not copied. Neither chooser nor other option modules are readable through this operation.

Project Chat has these narrow handoff operations too; publication/refinement still belongs in a Project Session. A null choice, missing legacy manifest, unknown option, changed state version, changed source revision, mismatched evidence/digest, unavailable source or unlinked reference fails explicitly. Reread and deliberately recapture after drift; never fall back to all five or latest source. Existing widgets without a manifest require an explicit artifact revision to adopt the format.

Source is implementation material, not visual verification. A source-only handoff does not require or automatically load a screenshot. When visual checks are requested, request a screenshot separately and confirm its artifact revision and selected state; a retained preview is initial state and may show a different option. Do not infer the visible view from the saved selection. The generation brief alone is not the approved design.
