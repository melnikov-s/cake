# Cake

## Overview

Cake is a conversation-first macOS desktop workspace for working with coding
agents. Its visual identity draws directly from native macOS desktop conventions:
a quiet, cool-toned environment with compact utility chrome, tactile push
controls, translucent floating surfaces, and hairline split-pane dividers that
step back so conversations and source code remain primary. It should feel like a
focused native utility—closer to Xcode, Finder, or Notes than a web dashboard of
equally prominent cards.

This is a prose-first guide to visual intent, following the
[DESIGN.md format](https://github.com/google-labs-code/design.md). It intentionally
has no YAML token inventory or generated theme. Exact implemented values remain
in [styles.css](src/renderer/styles.css), and component variants remain in their
source. Implementation requirements belong in the
[renderer implementation guide](docs/development/renderer-implementation.md);
this document complements rather than replaces them. Update this guide when
approved visual direction changes, not for every local UI adjustment.

## Colors

The palette uses cool, low-chroma macOS system neutrals paired with a crisp
system-blue accent. Light mode pairs a bright near-white content canvas with a
softly tinted source-list sidebar and crisp white elevated controls; dark mode
layers graphite and slate surfaces (`background`, `sidebar`, `card`, `popover`)
with hairline borders rather than flat pure black. Preserve the same hierarchy
and semantic roles in both modes, using Cake's theme rather than a
feature-specific palette.

Use the semantic roles in [styles.css](src/renderer/styles.css):

- `background` / `foreground`: the main window canvas and ordinary readable content.
- `card` / `card-foreground` and `popover` / `popover-foreground`: elevated
  control surfaces, sheets, and translucent floating overlays with their paired
  text colors.
- `primary` / `primary-foreground`: high-emphasis push actions and active pills.
  Cake's primary is a high-contrast neutral, distinct from the system-blue accent.
- `secondary`, `muted`, and `muted-foreground`: recessed tracks, quiet fills, and
  supporting metadata. Secondary labels should recede without losing legibility.
- `accent` and `ring`: macOS system-blue emphasis, active toggles, and soft
  keyboard focus rings—never a decorative wash across every panel.
- `sidebar`, `sidebar-hover`, and `sidebar-active`: source-list navigation
  states. Selection remains clearly identifiable when the pointer leaves.
- `composer` and `user-message` / `user-message-foreground`: distinguish the
  input well and user-authored prompts from assistant prose.
- `success`, `attention`, `warning`, and `destructive`: semantic status and
  feedback, accompanied by a label or icon rather than color alone.

Use the shared component's existing treatment before assembling a new color
combination. Preserve contrast across normal, hover, active, selected, disabled,
and focus states in both themes.

## Typography

Use the native macOS font stacks: `font-sans` (`SF Pro Text` / `-apple-system`)
for interface controls and prose, `font-display` (`SF Pro Display`) for surface
titles, and `font-mono` (`SF Mono`) for code, paths, and technical metadata.
Subtle negative letter-spacing on compact controls and `tabular-nums` on
counters, timestamps, and metrics maintain native desktop poise.

Follow macOS desktop density while preserving root-relative scaling: navigation
rows, toolbar actions, inputs, and metadata use relative tokens (`text-xs`,
`text-sm`, `text-base`) rather than arbitrary pixel overrides, while conversation
prose has comfortable line height and measure for sustained reading. Establish
hierarchy through restrained size and medium/semibold weight shifts rather than
oversized web headings or all-caps labels. Long messages, code, and paths must
remain readable and inspectable; truncate navigation labels only where the full
value remains accessible.

## Layout

Keep the conversation primary in ordinary chat surfaces. The transcript needs
generous room for explanations and diffs, anchored by a stable, clearly framed
composer. Source-list navigation helps users locate projects and sessions;
inspector and accessory panes provide detail without turning the window into a
wall of competing toolbars.

The existing [app shell](src/renderer/components/app-shell-layout.tsx) owns the
macOS split-view arrangement: traffic-light-safe titlebar drag regions,
collapsible source-list sidebar, central workspace canvas, and resizable
accessory pane. Immersive editor, browser, and drawing workspaces make the task
surface primary while keeping conversation available through the shared
[workspace chat layout](src/renderer/components/workspace-chat-layout.tsx).
Reuse these layouts rather than imposing a second shell.

Separate panes with single-pixel hairline borders (`border-border/65` to
`border-border/75`) and interactive [ResizeHandle](src/renderer/components/ui/resize-handle.tsx)
splitters rather than heavy margins or nested card boxes. Keep dense lists
compact and reading surfaces comfortable. Preserve flexible widths, independent
scroll regions, and composer access as panes resize or the window narrows.

## Elevation & Depth

Model depth after macOS desktop materials:

- **Everyday hierarchy:** rely on tonal surface shifts (`sidebar` vs.
  `background` vs. `card`), 1px hairline borders, and subtle micro-shadows
  (`shadow-2xs` / `shadow-xs`) on push buttons, text fields, and active
  segmented-control thumbs. Do not wrap every panel region in a heavy drop-shadow card.
- **Floating and modal surfaces:** reserve stronger ambient shadows, translucent
  fills (`bg-popover/95`, `bg-card/95`), backdrop blur (`backdrop-blur-md` to
  `backdrop-blur-xl`), and subtle outer/inner border rings for floating overlays.
  The shared [Dialog](src/renderer/components/ui/dialog.tsx),
  [Popover](src/renderer/components/ui/popover.tsx),
  [FloatingToolbar](src/renderer/components/ui/floating-toolbar.tsx), and
  [Tooltip](src/renderer/components/ui/tooltip.tsx) own those treatments.

Depth should clarify what sits on the window canvas, what is a tactile control,
and what floats above the workspace.

## Shapes

Use a tight, native macOS corner-radius scale rooted at `--radius: 0.5rem` (8px)
in [styles.css](src/renderer/styles.css): `rounded-sm` (6px), `rounded-md` (8px),
and `rounded-lg` (10px). Standard push buttons, inputs, selects, and navigation
rows use crisp `rounded-md` corners; sheets, popovers, and dialogs use
`rounded-lg` to `rounded-xl`; status badges and switches use `rounded-full`. Do
not introduce oversized web-style rounded cards or inconsistent per-feature
radii.

Icons come from the shared [icon catalog](src/renderer/components/ui/icons.tsx)
with crisp 1.5px–1.75px stroke geometry suited to 28px–32px desktop targets.
Project and session artwork uses the shared identity components rather than a
feature-local icon style.

## Components

The [component catalog](docs/development/component-catalog.md) is the entry point
for choosing controls; the files in
[components/ui](src/renderer/components/ui/) own their visual and interactive
variants. Compose existing primitives before adding a genuinely new pattern.

- **Actions:** Use `Button` for labeled push buttons (compact 28px `sm` and 32px
  `default` heights with tactile active press feedback and subtle `shadow-2xs`
  elevation on solid and outline variants) and `IconButton` (28px square toolbar
  target) for icon-only actions with an accessible name and tooltip. Destructive
  styling communicates a destructive operation, not general prominence.
- **Navigation:** Use `NavItem` and `SessionListItem` for macOS source-list rows
  with compact vertical rhythm, persistent selection fill (`sidebar-active`),
  subtle hover highlights (`sidebar-hover`), metadata, and trailing actions.
- **Inputs and choices:** Reuse `Input`, `Textarea`, `Select`, `Switch`, and
  `SegmentedControl`. Inputs and selects share compact 28px–32px desktop heights,
  crisp borders, and a soft 3px macOS focus halo (`focus-visible:ring-3
focus-visible:ring-ring/25`). `SegmentedControl` uses a recessed track with a
  raised `bg-card` active thumb; `Switch` uses an accent-filled active track with
  a crisp white thumb.
- **Feedback:** Use `Badge`, `Callout`, and `LoadingState` to present compact
  status pills, hairline-bordered callouts, and pending work without decorative
  banners.
- **Conversation:** Every chat surface uses the shared
  [Chat](src/renderer/components/chat.tsx). Preserve the distinction between
  user messages, assistant reading surfaces, tool activity, and inspectable
  context. Reuse [AI Elements](src/renderer/components/ai-elements/) for Markdown,
  code, and source presentation rather than styling raw text as a new viewer.
- **Supporting surfaces:** Reuse shared panels, disclosures, attachments, and
  translucent overlays (`Dialog`, `Popover`, `Tooltip`, `SidePanel`). Show rich
  content when it helps the task, not to replace a clear conversational answer
  with extra chrome.

## Do's and Don'ts

- Do keep the user's current conversation or task visually dominant.
- Do maintain compact macOS desktop control heights, hairline borders, and
  consistent concentric corner radii.
- Do reuse semantic tokens and shared variants before introducing new styling.
- Do keep hover, active press, selection, keyboard focus halo, and status
  distinguishable in both light and dark modes.
- Do preserve readable contrast, accessible labels, and full keyboard access.
- Do use restrained, spring-tuned motion to explain transitions and respect
  reduced motion.
- Do review actual affected surfaces in both themes and at relevant window sizes;
  use the [visual harness](docs/development/visual-capture.md) for visual changes
  and the [verification guide](docs/development/agent-verification.md) for behavior.
- Don't use oversized web-marketing typography, bloated control heights, or
  heavy card-in-card drop shadows for ordinary workspace layout.
- Don't hard-code a feature palette, add decorative fonts, or duplicate token
  values here as a second theme source.
- Don't build feature-local substitutes for shared controls or conversation UI.
- Don't hide essential meaning behind color, hover-only disclosure, or animation.
- Don't treat this guide as an automatic renderer, accessibility proof, or reason
  to redesign otherwise consistent existing UI.
