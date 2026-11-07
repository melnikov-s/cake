# Live widget theme

For HTML/React widgets and Session Plugins. Static `html.present` does not receive live theme tokens.

## Public contract

The host supplies Cake's effective theme before first paint and updates it live without iframe navigation, including OS changes when Cake uses System.
Use live semantic variables directly:

```css
.widget {
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  font-family: var(--font-sans);
}
.card {
  background: var(--card);
  color: var(--card-foreground);
}
.primary {
  background: var(--primary);
  color: var(--primary-foreground);
}
```

Other roles: `--muted`, `--muted-foreground`, `--accent`, `--success`, `--attention`, `--warning`, `--destructive`, `--font-mono`.
The public mechanism is these variables, host-owned `html[data-theme="light"]` / `html[data-theme="dark"]` and CSS `color-scheme`. No theme SDK import or custom message listener is needed for CSS.

## Do not create a competing theme

The host resolves System. Do not use prefers-color-scheme, override root theme/tokens, persist a separate theme setting or snapshot resolved colors on mount.
Imperative canvases/editors can observe root data-theme/style changes and reread computed variables. Redraw without recreating the editor, losing saved state, navigation or current interaction.
Cake prototypes use live tokens inside frames as well as the chooser. `--p-bg:var(--background)` stays live; copied dark screenshot colors do not.

## Palette exceptions and verification

Other apps retain intentional brand/data/artwork colors. Select supplied light/dark palettes using the host's effective data-theme, not creation-time mode; do not automatically recolor artwork.
Check dark→light→dark and System effective changes on open and reopened widgets. Navigation, disclosures, selection and editor state must survive.
Retained initial-state PNGs are immutable evidence and do not retheme. Existing fixed-palette widgets need an explicit source revision; never rewrite saved artifacts or user choices automatically.
