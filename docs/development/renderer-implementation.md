## Renderer implementation standard

Before implementing renderer UI:

1. Inspect `src/renderer/components`, especially `components/ui` for primitives
   and `components/ai-elements` for conversation, Markdown, code, tool, and
   source surfaces.
2. Identify the existing primitive, product component, Store, and Model that
   own the behavior. Existing one-off implementations are migration debt, not
   precedent.
3. Follow the architecture doc's
   [renderer state ownership](../architecture/cake-architecture.md#renderer-state-ownership)
   contract for state, Model/Store organization, and every chat surface.

### Tailwind and styling

- Tailwind utilities and shared UI primitives are the sole styling mechanism for
  renderer components.
- Do not add product-specific, layout, or component-specific CSS classes to
  `src/renderer/styles.css`. Do not create component stylesheets, CSS modules,
  CSS-in-JS, or inline styles for static presentation.
- `styles.css` is strictly restricted to Tailwind directives, theme variables and
  mappings, base element rules, keyframes, third-party integration selectors (such
  as Shiki syntax tokens), and browser or Electron behavior that Tailwind cannot express.
- Dynamic geometry may use a narrowly typed React style object, preferably to
  set CSS custom properties. It must not encode static colors, spacing,
  typography, borders, shadows, or other ordinary presentation.
- Compose conditional classes with `cn()` from
  `src/renderer/lib/utils.ts`. Do not manually concatenate class strings.
- Reuse existing semantic theme tokens. A new semantic color requires light
  and dark variables plus an `@theme inline` mapping. Do not hard-code product
  colors in components.

### Components and controls

- Whenever introducing a visual or interactive pattern, it must be created as a
  shared UI component in `src/renderer/components/ui/` and added to the component
  catalog. Never build one-off, inline interactive elements or feature-local
  substitute widgets.
- Feature TSX files must **never** render raw interactive HTML elements directly
  (e.g. `<button>`, `<input>`, `<select>`, `<textarea>`). All interactive
  surfaces must compose authoritative components from `src/renderer/components/ui/`
  (`Button`, `IconButton`, `NavItem`, `DisclosureTrigger`, `ActionCard`, `Chip`,
  `Input`, `Select`, `Textarea`, `Switch`, `SegmentedControl`, `Badge`, `Card`,
  `Callout`, `Dialog`, `Popover`, `EmptyState`, etc.).
- Raw HTML interactive elements are strictly restricted to the internal
  implementation of authoritative primitives in `src/renderer/components/ui/`.
- Compose the closest existing primitive or product component before creating
  a component. Do not recreate an existing control, source viewer, syntax
  highlighter, layout primitive, or interaction under another name.
- Do not create a feature-local button, input, select, textarea, dialog,
  popover, tooltip, toggle, loading treatment, code viewer, or source viewer
  when an authoritative component exists.
- Add a component only when it has a genuinely distinct responsibility that
  cannot be expressed by composing or extending the existing component set.
- A feature source file exports exactly one named React component.
  Independently meaningful subcomponents belong in separate files. Exceptions
  are cohesive compound primitive APIs, the centralized icon catalog, and tiny
  private render helpers with no independent responsibility.

### Icons

- `src/renderer/components/ui/icons.tsx` is the sole icon authority.
- Do not define inline SVGs, SVG path data, icon wrapper components, Unicode
  glyph substitutes, or feature-local icon components. Add a missing icon to
  the shared catalog and reuse it.
- Decorative icons must be `aria-hidden`. Icon-only actions must use the shared
  `IconButton` and provide a tooltip and accessible name.
