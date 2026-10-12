# Cake

## Overview

Cake is a conversation-first desktop for working with coding agents. Its visual
identity is a quiet, cool-toned workspace: readable conversations, compact
navigation, and tools that support the current task without competing for
attention. It should feel like a focused working environment, not a dashboard
of equally prominent cards.

This is a prose-first guide to visual intent, following the
[DESIGN.md format](https://github.com/google-labs-code/design.md). It intentionally
has no YAML token inventory or generated theme. Exact implemented values remain
in [styles.css](src/renderer/styles.css), and component variants remain in their
source. Implementation requirements belong in the
[renderer implementation guide](docs/development/renderer-implementation.md);
this document complements rather than replaces them. Update this guide when
approved visual direction changes, not for every local UI adjustment.

## Colors

The palette uses cool, low-chroma neutrals with a blue accent. Light mode has a
near-white workspace and a softly tinted sidebar; dark mode uses layered dark
surfaces rather than pure black. Preserve the same hierarchy and semantic roles
in both modes, using Cake's theme rather than a feature-specific palette.

Use the semantic roles in [styles.css](src/renderer/styles.css):

- `background` / `foreground`: the workspace and its ordinary readable content.
- `card` / `card-foreground` and `popover` / `popover-foreground`: contained
  content and floating surfaces, with their paired text colors.
- `primary` / `primary-foreground`: high-emphasis actions. Cake's primary is
  neutral, not a synonym for its blue accent.
- `secondary`, `muted`, and `muted-foreground`: supporting surfaces and metadata.
  Supporting text should recede without becoming difficult to read.
- `accent` and `ring`: selective emphasis and visible keyboard focus, not a
  decorative wash across every panel.
- `sidebar`, `sidebar-hover`, and `sidebar-active`: distinct navigation states.
  Selection should remain identifiable when the pointer leaves.
- `composer` and `user-message` / `user-message-foreground`: distinguish input
  and user-authored content from the rest of the conversation.
- `success`, `attention`, `warning`, and `destructive`: meaningful status and
  feedback, accompanied by a label or icon rather than color alone.

Use the shared component's existing treatment before assembling a new color
combination. Preserve contrast in normal, hover, selected, disabled, and focus
states in both themes.

## Typography

Use the existing system font stacks: `font-sans` for interface and prose,
`font-display` for surface headings, and `font-mono` for code and technical
values. These keep Cake familiar on the host desktop and make source content
distinct without introducing decorative typefaces.

Navigation and metadata are compact; conversation prose has more breathing room.
Use existing component sizes and weights rather than inventing a separate type
scale per feature. Establish hierarchy through restrained size and weight
changes, not oversized marketing headings or widespread uppercase labels.
Long messages, code, and paths must remain readable and inspectable; truncate
navigation labels only where the full value can still be accessed.

## Layout

Keep the conversation primary in ordinary chat surfaces. The transcript needs
room for long explanations and code, with a stable, clearly identifiable
composer. Navigation helps users locate projects and sessions; supporting panes
provide detail without turning the workspace into a wall of controls.

The existing [app shell](src/renderer/components/app-shell-layout.tsx) owns the
sidebar, central surface, and accessory pane arrangement. Immersive editor,
browser, and drawing workspaces can make the task surface primary while keeping
conversation available through the shared
[workspace chat layout](src/renderer/components/workspace-chat-layout.tsx).
Reuse these layouts rather than imposing a second shell.

Keep dense lists compact and reading surfaces comfortable. Use the shared
components' padding and Tailwind spacing utilities to group related content;
do not define a competing spacing scale. Preserve flexible widths, independent
scroll regions, and access to the composer as panes resize or the window narrows.

## Elevation & Depth

Use tonal surface differences and subtle borders for everyday hierarchy. Avoid
putting every region inside a raised card: navigation, conversation, and
accessory surfaces already have distinct roles.

Reserve stronger shadows and backdrop treatments for floating or modal content.
The shared [Dialog](src/renderer/components/ui/dialog.tsx),
[Popover](src/renderer/components/ui/popover.tsx), and
[Tooltip](src/renderer/components/ui/tooltip.tsx) define those treatments.
Depth should explain what sits above the workspace, not decorate ordinary rows.

## Shapes

Use the existing rounded, softly geometric language. Theme-backed `rounded-sm`,
`rounded-md`, and `rounded-lg` form the shared radius scale; overlays and compact
pills use the variants already defined by their primitives. Do not assign each
feature its own corner treatment or globally make controls pill-shaped.

Icons come from the shared [icon catalog](src/renderer/components/ui/icons.tsx).
Project and session artwork uses the shared identity components rather than a
new feature-local icon style.

## Components

The [component catalog](docs/development/component-catalog.md) is the entry point
for choosing controls; the files in
[components/ui](src/renderer/components/ui/) own their visual and interactive
variants. Compose existing primitives before adding a genuinely new pattern.

- **Actions:** Use `Button` for labeled actions and `IconButton` for compact
  actions with an accessible name and tooltip. Default buttons emphasize the
  main action; outline and ghost variants support quieter actions. Destructive
  styling communicates a destructive operation, not general prominence.
- **Navigation:** Use `NavItem` and `SessionListItem` for consistent compact rows,
  identity, selection, metadata, and trailing actions.
- **Inputs and choices:** Reuse `Input`, `Textarea`, `Select`, `Switch`, and
  `SegmentedControl` so focus, disabled states, and sizing remain consistent.
- **Feedback:** Use `Badge`, `Callout`, and `LoadingState` to distinguish compact
  status, explanation, and pending work without adding decorative banners.
- **Conversation:** Every chat surface uses the shared
  [Chat](src/renderer/components/chat.tsx). Preserve the distinction between
  user messages, assistant reading surfaces, tool activity, and inspectable
  context. Reuse [AI Elements](src/renderer/components/ai-elements/) for Markdown,
  code, and source presentation rather than styling raw text as a new viewer.
- **Supporting surfaces:** Reuse shared panels, disclosures, attachments, and
  overlays. Show rich content when it helps the task, not to replace a clear
  conversational answer with extra chrome.

## Do's and Don'ts

- Do keep the user's current conversation or task visually dominant.
- Do reuse semantic tokens and shared variants before introducing new styling.
- Do keep hover, selection, keyboard focus, and status distinguishable.
- Do preserve readable contrast, accessible labels, and keyboard access.
- Do use restrained motion to explain transitions and respect reduced motion.
- Do review actual affected surfaces in both themes and at relevant window sizes;
  use the [visual harness](docs/development/visual-capture.md) for visual changes
  and the [verification guide](docs/development/agent-verification.md) for behavior.
- Don't hard-code a feature palette, add decorative fonts, or duplicate token
  values here as a second theme source.
- Don't build feature-local substitutes for shared controls or conversation UI.
- Don't hide essential meaning behind color, hover-only disclosure, or animation.
- Don't treat this guide as an automatic renderer, accessibility proof, or reason
  to redesign otherwise consistent existing UI.
