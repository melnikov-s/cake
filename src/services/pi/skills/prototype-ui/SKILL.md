---
name: prototype-ui
description: Prototype UI faithful to an existing app, presenting five alternatives in one interactive widget with a saved choice.
---

# Prototype UI

Build one interactive widget containing five distinct prototypes of the requested UI. The goal is to help the user choose a direction that belongs in their actual app, not to produce a generic design gallery.

## Gather the app's design context

Do this in the parent Project Session before calling the widget specialist. If you are Cake Chat and the task concerns a registered project, delegate the prototyping task to that project.

- Read applicable project instructions and `DESIGN.md` or `design.md` when present.
- Inspect the relevant screens, shared components, theme tokens, typography, icons, spacing, and navigation patterns. Follow the app's existing implementation conventions.
- Inspect existing screenshots or capture the relevant running app using its documented verification workflow when feasible. If the app cannot be run, use its source and any supplied screenshots; say briefly what reference is missing.
- Gather the screen's purpose, representative content, important states, platform, theme, and intended viewport from the request and app. Ask only about information that materially changes the prototypes.

Carry a concise design brief with concrete token values, component patterns, reference paths, and observed screen details into generation. Do not merely tell the specialist to "read the repo": it can read skill resources but has no arbitrary workspace or app-capture access. Ancestor context contains completed parent work, not unfinished tool calls.

## Choose the rendering approach

Prefer interactive React recreations inside the widget. The app's implementation language is not the deciding factor: a Rust backend with a web UI is still web UI. A native SwiftUI, AppKit, or Rust UI can often be represented faithfully in React without compiling the native app. WebAssembly does not automatically turn native UI frameworks into browser UI, and Cake's widget pipeline currently compiles React/TSX rather than arbitrary applications.

When a web recreation cannot convey the design well, use image generation with the app references. Read Cake's model guidance and Pi's codemode documentation and use the configured image-model selection workflow. Generation happens in the parent, not the restricted widget specialist. Supply images as self-contained widget data only when the complete artifact can fit Cake's publication limit; otherwise explain the constraint and offer inline images rather than pretending they are an interactive widget. Do not use images merely because the app is written in a native language.

## Present five alternatives in one widget

Read `widget.md` before preparing the brief. Request the `widgets` topic and use `widgets.present` once, with:

- One stable artifact ID for this exploration.
- Five meaningful alternatives, each with a stable ID such as `option-1` through `option-5`, a short name, and a complete prototype. Vary layout, information hierarchy, or interaction where appropriate; do not present five color swaps.
- The same realistic content, theme, and intended viewport across alternatives so the comparison is useful.
- The gathered app-specific design context. Match the existing app by default; make a redesign only when requested.
- The absolute path to this skill's `widget.md`, and an instruction for the specialist to read it.
- `initialState: { "schema": "cake.prototype-ui/v1", "selectedOptionId": null }`.
- A short Markdown fallback describing the five directions.

The specialist writes the React source. Give it the design intent, evidence, state contract, and interactions rather than writing the widget source yourself. All five prototypes live in this one generation branch. Keep subsequent refinements in the same artifact with `artifacts.replace`; revisions inherit its generation history rather than rediscovering the app. Pass new parent findings explicitly in revision instructions.

## Read the choice and continue

"Choose this" saves the chosen stable option ID under `selectedOptionId` using artifact-scoped state. This is the choice, not a separate confirmation form.

When the user asks to continue, read the artifact with `artifacts.state.read`. Check that `value.schema` is `cake.prototype-ui/v1` and `value.selectedOptionId` identifies one of the current options. Do not infer a choice from whichever prototype is currently open. Saving state does not automatically start a parent turn; after publishing, ask the user to choose in the widget and tell you when to continue.

For refinements, preserve the five IDs and saved choice. Before implementing the selected design, inspect the exact approved artifact revision's rendered preview using `artifacts.preview` or its resolved `preview.png`, and inspect the selected prototype's source when the initial capture does not show it. Follow Cake's artifact handoff guidance; the generation brief alone is not the approved design.
