# Widgets and interviews

Read before presenting interactive widgets or gathering structured requirements.

## Static HTML

For simple HTML/CSS mockups, headers, and layouts, call `html.present` with `{ id, title, html, height? }` directly. Write an HTML fragment with inline CSS or a style element. This isolated iframe receives no host theme tokens, app CSS or fonts: supply a complete self-contained palette and typography for the stated app/theme, with no unresolved required variables. Scripts and network access are disabled; unlike HTML/React widgets, static HTML has no live Cake theme delivery.

Set height (120–1600 CSS pixels; default 240) for readable content. Stack alternatives with scrolling or use separate artifacts rather than shrinking full screens into thumbnails. No specialist, React or repository file is needed. The artifact appears inline and survives reopening; use `artifacts.present` to show it again. Before recommending a prototype or claiming visual readiness, inspect every alternative's rendered appearance using the project's supported capture workflow or a supplied screenshot. Static HTML has no retained `artifacts.preview`; if visual checks are unavailable, say “published, visually unverified” and name the missing check. Publication alone is not visual verification.

## Widgets

Use Cake's Markdown/media and interactive HTML/React widgets when useful, especially when requested. Call `cake widgets`.

- Request `widget.language: "html"` for simple self-contained experiences: inline CSS/JavaScript, no packages or bundling.
- React is the default for component-heavy UI, installed libraries and prototype-ui manifests.
- Both require browser render and visual acceptance. Repairs preserve language.

## Interviews

For multiple requirements questions or design decisions, call `cake interview`. Put recommended defaults first. Collect independent answers in one structured form. Ask one at a time only for dependent questions or when the user wants to discuss each decision. Use chat for follow-ups that depend on submitted answers.
