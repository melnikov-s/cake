# Widgets and interviews

Read before presenting interactive widgets or gathering structured requirements.

## Static HTML

For simple HTML/CSS mockups, headers, and layouts, call `html.present` with `{ id, title, html, height? }` directly. Write an HTML fragment with inline CSS or a style element. Keep requested alternatives together; set height (120–1600 CSS pixels) to fit. No specialist, React, repository file, browser opening, or screenshot review is needed. Scripts and network access are disabled. The artifact appears inline and survives reopening. Use `artifacts.present` to show an existing result again. Do not claim visual inspection from publication alone.

## Widgets

Use Cake's Markdown/media and interactive HTML/React widgets when useful, especially when requested. Call `cake widgets`.

- Request `widget.language: "html"` for simple self-contained experiences: inline CSS/JavaScript, no packages or bundling.
- React is the default for component-heavy UI, installed libraries and prototype-ui manifests.
- Both require browser render and visual acceptance. Repairs preserve language.

## Interviews

For multiple requirements questions or design decisions, call `cake interview`. Put recommended defaults first. Collect independent answers in one structured form. Ask one at a time only for dependent questions or when the user wants to discuss each decision. Use chat for follow-ups that depend on submitted answers.
