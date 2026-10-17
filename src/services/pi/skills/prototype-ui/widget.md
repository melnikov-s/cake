# Five-prototype widget contract

This file is for the widget specialist. Implement the parent brief as one React artifact widget containing five complete UI prototypes.

## Presentation

Make the prototypes the main content. Provide a compact way to switch among all five alternatives and inspect each at a useful size, with "Choose this" available for each. Do not shrink five entire screens into unreadable thumbnails. A comparison overview can accompany a large active preview. Keep the outer controls modest; do not add a tutorial, repeated labels explaining what a prototype is, or a banner.

Switching the visible prototype does not choose it. "Choose this" saves that option's stable ID, and the saved choice remains apparent when switching views or reopening the widget.

Reproduce the reference app's typography, colors, spacing, density, components, icons, and layout conventions inside the prototypes. Cake's semantic variables belong to the outer chooser, not to an unrelated app's design. Use the supplied app tokens inside the prototype frames. Keep all alternatives on comparable content and viewports. Match the platform shown in the brief rather than turning every app into a dashboard.

Vary meaningful design decisions while retaining the app's visual language. Each alternative should be substantial enough to evaluate the requested task and its important interactions. Use the five stable IDs supplied by the parent; preserve them through revisions.

## Separately addressable source (required)

Return one `cake-react` fence whose complete body is `export default <JSON>;`, where `<JSON>` is a strict JSON literal (double-quoted keys/strings, no comments, spreads, expressions or trailing commas):

```json
{
  "schema": "cake.prototype-source/v1",
  "chooser": {
    "id": "chooser",
    "source": "<complete chooser TSX>",
    "dependencies": [
      "react",
      "@cake/artifact-sdk",
      "cake:prototype/option-1",
      "cake:prototype/option-2",
      "cake:prototype/option-3",
      "cake:prototype/option-4",
      "cake:prototype/option-5"
    ]
  },
  "options": [
    {
      "id": "option-1",
      "source": "<complete default-exported React component TSX>",
      "dependencies": []
    },
    {
      "id": "option-2",
      "source": "<complete default-exported React component TSX>",
      "dependencies": []
    },
    {
      "id": "option-3",
      "source": "<complete default-exported React component TSX>",
      "dependencies": []
    },
    {
      "id": "option-4",
      "source": "<complete default-exported React component TSX>",
      "dependencies": []
    },
    {
      "id": "option-5",
      "source": "<complete default-exported React component TSX>",
      "dependencies": []
    }
  ],
  "shared": []
}
```

The placeholders above describe the format, not runnable source: fill every source string with real TSX, JSON-escaping newlines and quotes. Cake compiles the chooser as the entry component and resolves each `cake:prototype/<id>` import to exactly that module. Keep all five options in this single artifact and generation branch. Source remains bounded by the artifact publication limit.

IDs match `^[a-z][a-z0-9-]{0,63}$`, are unique across chooser/options/shared, and stay stable through revisions. Use the parent-supplied five option IDs. The `dependencies` array must exactly enumerate the distinct static import and re-export specifiers in that module (including packages and type-only imports). JSX automatic runtime needs no explicit dependency. No dynamic imports, require, relative paths or file imports. Packages must already be installed. Each option is a complete default-exported React component; the chooser imports all five options and default-exports the interactive chooser component.

Only the chooser may import option modules. Options and shared modules may import other shared modules via `cake:prototype/<id>` and installed packages. No module may import the chooser; no dependency cycles. Put reusable tokens, styling, icons, realistic content and helpers in shared modules only when needed; declare transitive imports too. Keep option-specific code in its own option module, never in the chooser/shared modules, and do not duplicate other alternatives there. Keep styling/assets self-contained in the appropriate module. This lets another session retrieve one chosen component and its required shared dependencies reliably without loading the chooser or other alternatives.

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
