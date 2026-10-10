# Navigation component catalog

Authoritative primitives live in `src/renderer/components/ui/`.

| Component             | Responsibility                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContextActionMenu`   | Accessible tab-local device action menu. Renders client-backed actions from `BrowserMenuStore`, closes on Escape/backdrop and resolves the pending action exactly once. |
| `NavItem`             | Accessible row action, label, description, badges, and trailing controls. Opt-in `motionFeedback` gives titles a springy hover/selection offset and press response.     |
| `NavigationHighlight` | Shared moving selection and hover backgrounds across descendant navigation rows, including separate groups.                                                             |
| `AnimatedList`        | Position transitions when keyed list items reorder; composes with `NavigationHighlight`.                                                                                |
| `ReorderControls`     | Accessible move-up/move-down actions within an ordered group, with disabled boundary positions.                                                                         |
| `SortableItem`        | Native drag-and-drop wrapper for persistently ordered navigation items.                                                                                                 |
| `Avatar`              | Deterministic project/session artwork; stationary 12×12 rounded session squares via `variant="square"`; opt-in artwork interactions and resolution animations.          |
| `ThinkingBubble`      | Compact, reduced-motion-safe conversational processing indicator.                                                                                                       |
| `StepProgress`        | Segmented progress for multi-step flows such as stepped interview forms; segments become jump targets when `onSelect` is supplied.                                      |

Sidebar session icons use `Avatar`'s square variant by default.
Settings → Appearance → **Show session characters** opts into session character
artwork and row interactions; the preference is persisted in the window snapshot.
Project icons (generated or custom) are unchanged, including in the activity feed.
The project/session avatar visibility switches remain independent.

## Searchable choice dialog

`SearchableChoiceDialog` composes the shared Dialog, Input, Button, and IconButton
primitives for a compact searchable destination picker. Callers own filtering and
selection policy; the primitive owns active-option highlighting, wrapping arrow-key
navigation, Enter selection, Escape/backdrop dismissal, focus containment and
restoration. The search input uses combobox/listbox semantics. Mount it only while
open. Supply `initialActiveId` to preselect a choice on opening (missing choices
fall back to the first). The New session workflow uses it for Cake Chat and
registered Projects, remembering the last new-session Project choice in the
window snapshot; opening Cake Chat or cancelling does not replace that choice.

## Screen capture

`CaptureCanvas` is the controlled screenshot gesture surface: pixel-coordinate pointer capture,
frozen-image rendering, annotated arrows/labels, and a non-exported crop guide. It delegates
crop/annotation policy to its owner. `CaptureToolbar` composes shared controls for mode switching,
undo, full-display attachment, and cancellation. `CaptureDestinationPicker` groups editable
sessions by Project, pins New session first, and reveals a Project selector for new destinations.
The overlay defaults to the last visited chat; successful captures append to the chosen draft
without sending, creating a fresh Project Session only when New session was selected. Arrow
annotations put the head at pointer-down and the tail/label at pointer-up. These controls stay
outside the exported image; only the flattened screenshot and annotations enter a chat draft.

## Context pills

`ContextPill` composes `Chip` to disclose exact system/reminder/extension context
as plain text. Expansion is ephemeral DOM state, not persisted workflow state.
Consecutive context parts share a wrapping horizontal group in the authoritative
Chat transcript. Removed historical context stays inspectable with a
“removed from context” label after Tool Compact.

## Markdown tables and fullscreen content

`MarkdownTable` presents Streamdown's parsed React cells with its existing table-copy
control and Cake's shared `FullscreenButton`. The caller owns the fullscreen intent;
`Markdown` keeps the rendered table above the parser lifecycle and displays it in
`FullscreenSurface`, preserving cell formatting and link actions. Fullscreen tables,
diagrams, images, responses, and artifacts all use that surface and its window-local
`FullscreenSurfaceStore`. Electron tracks the set of open surfaces per connection;
native VS Code and browser views remain hidden until the last surface closes, then
restore only if their latest requested bounds are visible. Fullscreen visibility is
transient presentation state, never a workspace-mode change or persisted preference.

## Inline links

`Link` is the shared anchor for Markdown, source citations, session links, and
artifact references. It inherits the surrounding text color, with semibold weight
and a persistent solid underline, strengthened on hover, plus a visible keyboard
focus outline.
It composes `useTooltip` and `TooltipBubble` to show the destination on hover or
keyboard focus (not a native title popup), and exposes it as an accessible
description. The tooltip defaults to `href`: use real destinations, not Markdown's
sanitizer-only Cake paths. File links preserve query parameters and line ranges;
Cake links expose their `cake://` URI. Supply an `onClick` handler to route through
the owning surface without changing the presentation. Hover/focus state is local,
ephemeral DOM state; tooltips dismiss on pointer exit, blur, or activation.

Artifact references in prose use the Markdown label (or the resolved artifact
title for bare URIs), not a card. `ArtifactDisclosure` composes `DisclosureTrigger`
and `Link` for block-level visual artifact references with separate expansion and
open actions. Its content is mounted only while expanded, and `aria-controls` identifies
that content. It owns no fetching or persistence; `InlineArtifactPreviewStore` owns the
workflow, and `ArtifactHost` renders the shared exact-revision payload. Standalone
Markdown artifact-image paragraphs opt in; mixed prose remains ordinary links.
Linking and materialization controls belong in
the Artifact Library detail surface.

## Dictation-enabled writing fields

`Textarea` accepts `dictation` to opt a Cake-owned prose field into the window's
`DictationStore`. `ComposerInput` opts in for all shared Chat consumers. Leave it
unset for paths, search, code, and configuration syntax. Embedded surfaces never
participate. Existing keyboard and controlled-value handlers remain authoritative.

`TextareaProvisionalText` is the shared decorative mirror for a provisional dictated span.
Raw words appear immediately in `text-muted-foreground`; typed prefixes/suffixes retain their
normal color. The original native textarea still owns value, selection, focus, keyboard input
and accessibility. The mirror is aria-hidden and pointer-transparent, follows the native scroll
position and measured padding/indent (including composer accessories), and never owns a draft.
Exact-value span matching prevents stale highlighting after manual edits. `Textarea` can receive
`provisionalText` from voice mode; ordinary dictation supplies its registered insertion span.
Cleanup completion, fallback, opting out, focus changes and sealing edits restore normal styling.

`DictationIndicator` sits at the beginning of the focused writing field by default.
In shared Chat composers, `DictationIndicatorContext` supplies a DOM portal destination
at the bottom-left of the toolbar, before attachments and configuration. A circular
`IconButton` contains a compact `VoiceMeter`; clicking toggles mute/unmute, with a
crossed waveform while muted. Tooltips and accessible names describe the action,
and `aria-pressed` reflects mute. The control remains visible while muted, and
pointer or keyboard activation returns focus to writing. Mute is window-local,
survives field changes, and never changes the Dictation mode preference.
Listening/mute are announced accessibly, not displayed as a popup. Preparing and
finishing replace the meter with the shared `LoadingSpinner` inside the circle;
`aria-busy` reflects loading and all status text is screen-reader-only, including
failures. Errors use a destructive crossed-waveform icon with details in its tooltip.
Inline fields reserve only the first line for the circle in every state; wrapped lines
use the normal writing edge. Chat composers use the normal writing edge on every line
and reserve no input rows for dictation. Settings omit the changing capture-status paragraph.
See [local dictation](dictation.md) for lifecycle details.

`VoiceMeter` is a decorative seven-bar microphone-level display. Supply a normalized
`level` from 0 to 1; silence leaves short bars and louder input raises them. It has
no microphone, timers, or simulated animation, and respects reduced motion.
Its `size="sm"` variant fits within the dictation circle and inherits its color.
`DictationStore` derives its ephemeral level from the existing PCM capture at
roughly 20Hz and resets it on finishing, blur, mute or capture replacement.

## Voice conversation controls

`VoiceConversationControls` is a shared stateless toolbar pattern composed from
`Button`, `IconButton` and `LoadingSpinner`. Supply preparing/active, input-only mute, disabled and
enter/mute/exit intents. The entry action is an outlined, rounded “Voice” button with
the shared `AudioLinesIcon` waveform, distinguishing voice conversation from dictation. Once active, an accent-tinted
`EarIcon` on a transparent circular target combines listening status and input mute; clicking it switches to an
unhighlighted `EarOffIcon` with a diagonal slash. Tooltips and accessible names
explain the mute/unmute action, and `aria-pressed` reflects input being enabled.
The shared `IconButton` supports `pressedAppearance="subtle"` for tint-only pressed states; other controls retain the default solid pressed treatment.
During the two-second send countdown, `sendProgress` adds a thin accent ring outside the ear with breathing room and its action becomes cancel-send (`onCancelSend`), retaining the draft and continuing capture. Resuming speech resets the ring. Outside the countdown it still toggles mute.
A separate `StopIcon` exits conversation mode. Preparing shows the shared spinner
inside a disabled circular `IconButton` with `aria-busy`, the same size as the active
ear control. Status changes never add a badge or wrap the controls into another row.
It owns no microphone,
provider requests, timers or workflow state. `ChatConversationControls` maps the focused
window `ConversationModeStore` and Project Session target into this primitive;
other Chat kinds omit the capability. In Chat, the controls sit in the right-hand
composer toolbar immediately before Send. See [conversation mode](conversation-mode.md).

Speech output settings compose the shared `Select`, `Button` and `Callout` for provider
selection and explicit local-model download/progress/cancel/removal; native readiness
comes from `SpeechSettingsStore`, not component-local workflow state. See
[local speech output](local-speech-output.md).

## Slider

`Slider` is the shared native range input with keyboard support, semantic accent/focus styling, and value-change/commit callbacks. Speech output settings use a compact 1×–1.2× range; changing the thumb updates the local draft and releasing it or a keyboard key commits the speed to native settings.

### SettingSlider

`SettingSlider` composes `Slider` with an associated label, formatted value, accessible description, optional scope label and endpoint captions. It owns no preference state or persistence. Speech input uses it for shared dictation/voice detection controls and voice-only send-timing/interruption controls; `SpeechInputSettingsStore` owns their values. Scope labels are visible and included in the accessible description.

## Dismissible chips

`DismissibleChip` composes sibling `Chip` and `IconButton` controls for separate
primary and dismiss actions (never nested buttons). Supply `removeLabel` for the
dismiss button's accessible name and tooltip; both controls respect `disabled`.
VS Code selection pills use the primary action to reveal a range and the dismiss
action to remove just that range. Example:

```tsx
<DismissibleChip
  aria-label="Reveal src/app.ts line 12"
  title="src/app.ts:12"
  removeLabel="Remove src/app.ts line 12"
  onClick={reveal}
  onRemove={remove}
>
  app.ts:12
</DismissibleChip>
```

## Content transitions

`ContentTransition` is a visual-only fade-out / blank / fade-in handoff. Supply
`requestedKey` as navigation begins, `contentKey` for the mounted destination,
and `ready` when its projection is usable. Loading and the new React tree never
wait for animation: an inert, aria-hidden outgoing DOM snapshot fades for 40ms,
then the surface stays blank until the matching destination is ready. Its 80ms
entrance changes opacity without moving the transcript. Interrupted navigation discards the old
visual layer; reduced motion switches immediately. Snapshot DOM and animation
handles are component-local, ephemeral, and never persisted.

Primary Project Session and Cake Chat transcripts opt in through `Chat`'s
`transcriptTransition` prop; sidebar, composer, and secondary chats stay steady.
Project navigation intent belongs to `ProjectWorkbenchStore`, with its existing
latest-request-wins revision policy, not to the animation component.

## Popover motion

`PopoverContent` supports opt-in `motion="bouncy"`, used by `AvatarLabelPicker`.
It expands from the anchor with a soft overshoot and collapses on dismissal.
The closing shell is inert and hidden from assistive technology; reduced motion
skips both animations. Interrupted motion resumes from the displayed transform,
and positioning measures untransformed dimensions so bouncing cannot shift layout.
Other popovers retain their existing immediate behavior. Popovers next to native
surfaces can opt into `boundary="nearest-ancestor"`; positioning then flips and
clamps within the closest ancestor marked with `data-popover-boundary` instead
of allowing the native surface to cover part of the portal.

## Workspace and chat shell

`WorkspaceChatLayout` is the shared product layout for immersive session modes.
It composes the project sidebar, a primary workspace, the existing authoritative
Chat drawer, and an optional terminal dock with persistent Store-owned widths.
VS Code, Browser Mode, and Cake Draw supply their own workspace and chat header
content rather than rebuilding resize behavior or a parallel conversation surface.

`WorkspacePanelToggle` is the shared Browser Mode/Draw header control. Place the
`sidebar` variant on the left and the `chat` variant on the right. Mirrored panel
icons, Open/Close tooltips, and `aria-expanded` reflect the supplied visibility;
the controls remain available when their panels are hidden. Visibility and widths
stay owned by the existing Sidebar and Project Session Stores.

## Moving navigation backgrounds

Wrap the scrolling **content** in `NavigationHighlight`. Mark each row with
`data-navigation-item` and set `data-navigation-active` from its existing selected
prop. Keep row backgrounds transparent; the shared layers supply the semantic
`sidebar-active` and `sidebar-hover` fills. Continue using `NavItem` for actions
and `aria-current`—the highlight is decorative, not a navigation controller.

Selection settles with a subtle overshoot; pointer/focus preview glides more
quickly and fades into selection. Retargeting starts at the displayed position.
Geometry stays local to the mounted primitive, follows row/layout changes, and
scrolls with its content. Motion reduction makes movement immediate. No Store,
selection copy, persistence, or per-frame React updates are introduced.
