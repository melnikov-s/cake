# Five-prototype widget contract

This file is for the widget specialist. Implement the parent brief as one React artifact widget containing five complete UI prototypes.

## Presentation

Make the prototypes the main content. Provide a compact way to switch among all five alternatives and inspect each at a useful size, with "Choose this" available for each. Do not shrink five entire screens into unreadable thumbnails. A comparison overview can accompany a large active preview. Keep the outer controls modest; do not add a tutorial, repeated labels explaining what a prototype is, or a banner.

Switching the visible prototype does not choose it. "Choose this" saves that option's stable ID, and the saved choice remains apparent when switching views or reopening the widget.

Reproduce the reference app's typography, colors, spacing, density, components, icons, and layout conventions inside the prototypes. Cake's semantic variables belong to the outer chooser, not to an unrelated app's design. Use the supplied app tokens inside the prototype frames. Keep all alternatives on comparable content and viewports. Match the platform shown in the brief rather than turning every app into a dashboard.

Vary meaningful design decisions while retaining the app's visual language. Each alternative should be substantial enough to evaluate the requested task and its important interactions. Use the five stable IDs supplied by the parent; preserve them through revisions.

## Persisted choice

Use `useArtifactState` from `@cake/artifact-sdk` with this exact initial value:

```json
{
  "schema": "cake.prototype-ui/v1",
  "selectedOptionId": null
}
```

Wait for hydration before saving. Use the hydrated value as authoritative. On "Choose this", await `save({ ...value, selectedOptionId: option.id })`. Do not report a saved choice until that Promise succeeds. Keep navigation/hover state local; never overwrite a saved choice during mounting, switching previews, or visual review. Do not put the selected option only in React state or localStorage: the parent reads `value.selectedOptionId` with `artifacts.state.read`.

There is no parent-message capability in this artifact. Do not import the Session Plugin SDK or invent a submit callback. Preserve the state shape and option IDs when refining the source. If an option must be removed, tell the parent so it can deliberately clear or replace that choice.
