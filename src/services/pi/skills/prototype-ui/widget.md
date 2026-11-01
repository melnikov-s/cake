# Five-prototype widget contract

This file is for the widget specialist only when the parent has chosen the optional persistent five-option chooser and selected-source handoff workflow in `SKILL.md`. It does not apply to static HTML/CSS comparisons or interactive prototypes that do not need that workflow. Honor explicit HTML requests; use `html.present` for static comparisons, with the user's choice expressed in chat rather than saved artifact state.

For this richer workflow, implement the parent brief as one React artifact widget containing five complete UI prototypes.

## Presentation

Make prototypes the main content. Use compact controls to switch among five readable previews, each with "Choose this". An overview may accompany the large active preview; never shrink five screens to unreadable thumbnails. No tutorial, repeated prototype labels or banner.

Switching the visible prototype does not choose it. "Choose this" saves that option's stable ID, and the saved choice remains apparent when switching views or reopening the widget.

Match the reference app's typography, colors, spacing, density, components, icons and layout. Cake variables style the outer chooser. When prototyping Cake itself, use the host's live semantic CSS variables throughout the prototype frames too, not dark/light values copied from the brief or screenshot. Scoped aliases must stay live, e.g. `--p-bg:var(--background); --p-fg:var(--foreground); --p-border:var(--border)`. For another app, retain intentional design/brand/data colors; select supplied light/dark palettes via the host's effective `data-theme`. Use comparable content/viewports. Match the brief's platform, not a generic dashboard.

Vary meaningful design decisions while retaining the app's visual language. Each alternative should be substantial enough to evaluate the requested task and its important interactions. Use the five stable IDs supplied by the parent; preserve them through revisions.

The host supplies semantic color/font variables before first paint and updates them live, including System effective changes, without resetting interaction state. Use `var(--background)`, `var(--foreground)`, paired card/primary colors, `var(--muted-foreground)`, `var(--border)`, `var(--accent)`, `var(--success)`, `var(--attention)` and `var(--font-sans)` directly. For unavoidable theme-specific CSS, select `html[data-theme="light"]` or `html[data-theme="dark"]`; the host owns that effective attribute and `color-scheme`. Do not use `prefers-color-scheme`, override host tokens/root theme, copy resolved colors once, or add a competing theme setting. Check dark→light→dark and System changes while a prototype is open; navigation, disclosures and saved choice must survive theme changes.

## Separately addressable source (required)

Write each module as its own widget file, one file per tool call:

- `widget/chooser.tsx`: the interactive chooser. It imports all five options as `cake:prototype/<id>` and default-exports the chooser component.
- `widget/options/<id>.tsx`: exactly five files, one per parent-supplied option ID. Each is a complete default-exported React component.
- `widget/shared/<id>.tsx`: optional shared modules for reusable tokens, styling, icons, realistic content and helpers.

Cake assembles these files into the `cake.prototype-source/v1` module manifest, computes each module's dependency list from its imports and validates the result. Do not write the manifest or dependency lists yourself. Cake compiles the chooser and resolves each `cake:prototype/<id>` to that exact module. All five options stay in one artifact/generation branch, within the publication limit.

IDs match `^[a-z][a-z0-9-]{0,63}$`, are unique across options/shared (`chooser` is reserved), and stay stable through revisions. Use the parent-supplied five option IDs. Use only static imports of installed packages and `cake:prototype/<id>` modules. No dynamic imports, require, relative paths or file imports.

Only the chooser may import option modules. Options and shared modules may import shared modules and installed packages. No module may import the chooser; no dependency cycles. Keep option-specific code in its own option file, never in the chooser/shared modules, and do not duplicate other alternatives there. Keep styling/assets self-contained in the appropriate module. This lets another session retrieve one chosen component and its required shared dependencies reliably without loading the chooser or other alternatives.

## Persisted choice

Use `useArtifactState` from `@cake/artifact-sdk` with this exact initial value:

```json
{
  "schema": "cake.prototype-ui/v1",
  "selectedOptionId": null
}
```

Wait for hydration; its value is authoritative. On "Choose this", await `save({ ...value, selectedOptionId: option.id })` before reporting success. Keep navigation/hover local. Never overwrite saved choice during mounting, switching or visual review. React state/localStorage alone is insufficient: the parent reads `value.selectedOptionId` through `artifacts.state.read`.

There is no parent-message capability in this artifact. Do not import the Session Plugin SDK or invent a submit callback. Preserve the state shape and option IDs when refining the source. If an option must be removed, tell the parent so it can deliberately clear or replace that choice.
