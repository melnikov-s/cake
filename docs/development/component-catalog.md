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
title for bare URIs), not a card. Linking and materialization controls belong in
the Artifact Library detail surface.

## Dictation-enabled writing fields

`Textarea` accepts `dictation` to opt a Cake-owned prose field into the window's
`DictationStore`. `ComposerInput` opts in for all shared Chat consumers. Leave it
unset for paths, search, code, and configuration syntax. Embedded surfaces never
participate. Existing keyboard and controlled-value handlers remain authoritative.

`DictationIndicator` is the shared silent, non-interactive status attached to the
focused field: Preparing, Listening, Finishing, or a failure. It composes the
shared spinner and microphone icon and never takes focus. See
[local dictation](dictation.md) for lifecycle and installation details.

## Voice conversation controls

`VoiceConversationControls` is a shared stateless toolbar pattern composed from
`IconButton` and `Badge`. Supply preparing/active, input-only mute, disabled and
enter/mute/exit intents. The entry action uses the shared `AudioLinesIcon` waveform
to distinguish voice conversation from dictation. Once active, an accent-tinted
`EarIcon` on a transparent circular target combines listening status and input mute; clicking it switches to an
unhighlighted `EarOffIcon` with a diagonal slash. Tooltips and accessible names
explain the mute/unmute action, and `aria-pressed` reflects input being enabled.
The shared `IconButton` supports `pressedAppearance="subtle"` for tint-only pressed states; other controls retain the default solid pressed treatment.
During the two-second send countdown, `sendProgress` adds a thin accent ring outside the ear with breathing room and its action becomes cancel-send (`onCancelSend`), retaining the draft and continuing capture. Resuming speech resets the ring. Outside the countdown it still toggles mute.
A separate `StopIcon` exits conversation mode. Preparing retains its status badge.
It owns no microphone,
provider requests, timers or workflow state. `ChatConversationControls` maps the focused
window `ConversationModeStore` and Project Session target into this primitive;
other Chat kinds omit the capability. See [conversation mode](conversation-mode.md).

## Slider

`Slider` is the shared native range input with keyboard support, semantic accent/focus styling, and value-change/commit callbacks. Speech output settings use a compact 1×–1.2× range; changing the thumb updates the local draft and releasing it or a keyboard key commits the speed to native settings.

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
