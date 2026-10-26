# Five-prototype widget contract

This file is for the widget specialist. Implement the parent brief as one React artifact widget containing five complete UI prototypes.

## Presentation

Make prototypes the main content. Use compact controls to switch among five readable previews, each with "Choose this". An overview may accompany the large active preview; never shrink five screens to unreadable thumbnails. No tutorial, repeated prototype labels or banner.

Switching the visible prototype does not choose it. "Choose this" saves that option's stable ID, and the saved choice remains apparent when switching views or reopening the widget.

Match the reference app's typography, colors, spacing, density, components, icons and layout. Cake variables style the outer chooser. When prototyping Cake itself, use the host's live semantic CSS variables throughout the prototype frames too, not dark/light values copied from the brief or screenshot. Scoped aliases must stay live, e.g. `--p-bg:var(--background); --p-fg:var(--foreground); --p-border:var(--border)`. For another app, retain intentional design/brand/data colors; select supplied light/dark palettes via the host's effective `data-theme`. Use comparable content/viewports. Match the brief's platform, not a generic dashboard.

Vary meaningful design decisions while retaining the app's visual language. Each alternative should be substantial enough to evaluate the requested task and its important interactions. Use the five stable IDs supplied by the parent; preserve them through revisions.

The host supplies semantic color/font variables before first paint and updates them live, including System effective changes, without resetting interaction state. Use `var(--background)`, `var(--foreground)`, paired card/primary colors, `var(--muted-foreground)`, `var(--border)`, `var(--accent)`, `var(--success)`, `var(--attention)` and `var(--font-sans)` directly. For unavoidable theme-specific CSS, select `html[data-theme="light"]` or `html[data-theme="dark"]`; the host owns that effective attribute and `color-scheme`. Do not use `prefers-color-scheme`, override host tokens/root theme, copy resolved colors once, or add a competing theme setting. Check dark→light→dark and System changes while a prototype is open; navigation, disclosures and saved choice must survive theme changes.

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

Replace placeholders with real TSX, JSON-escaping newlines/quotes. Cake compiles the chooser entry and resolves each `cake:prototype/<id>` to that exact module. All five options stay in one artifact/generation branch, within the publication limit.

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

Wait for hydration; its value is authoritative. On "Choose this", await `save({ ...value, selectedOptionId: option.id })` before reporting success. Keep navigation/hover local. Never overwrite saved choice during mounting, switching or visual review. React state/localStorage alone is insufficient: the parent reads `value.selectedOptionId` through `artifacts.state.read`.

There is no parent-message capability in this artifact. Do not import the Session Plugin SDK or invent a submit callback. Preserve the state shape and option IDs when refining the source. If an option must be removed, tell the parent so it can deliberately clear or replace that choice.
