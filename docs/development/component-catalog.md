# Shared component catalog

Authoritative primitives live in [`src/renderer/components/ui/`](../../src/renderer/components/ui/).
Compose these before creating a new control. Props, styling, interaction details and
examples belong in their source, callers and focused tests—not a second API specification.
See `AGENTS.md` for renderer implementation rules.

## Controls and disclosure

| Component                                                                                                                                                               | Use for                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Button](../../src/renderer/components/ui/button.tsx), [IconButton](../../src/renderer/components/ui/icon-button.tsx)                                                   | Labeled and icon-only actions; icon-only actions need an accessible name and tooltip.                                 |
| [Input](../../src/renderer/components/ui/input.tsx), [Textarea](../../src/renderer/components/ui/textarea.tsx), [Select](../../src/renderer/components/ui/select.tsx)   | Text and choice inputs; opt prose Textareas into dictation, not paths or configuration syntax.                        |
| [Switch](../../src/renderer/components/ui/switch.tsx), [SegmentedControl](../../src/renderer/components/ui/segmented-control.tsx)                                       | Boolean settings and mutually exclusive choices.                                                                      |
| [Slider](../../src/renderer/components/ui/slider.tsx), [SettingSlider](../../src/renderer/components/ui/setting-slider.tsx)                                             | Range input; SettingSlider aligns value and explanation, stacking controls below text in narrow containers.           |
| [Chip](../../src/renderer/components/ui/chip.tsx), [DismissibleChip](../../src/renderer/components/ui/dismissible-chip.tsx)                                             | Compact actions; independent primary and removal actions without nested buttons.                                      |
| [Badge](../../src/renderer/components/ui/badge.tsx), [Callout](../../src/renderer/components/ui/callout.tsx)                                                            | Status and explanatory feedback.                                                                                      |
| [DisclosureTrigger](../../src/renderer/components/ui/disclosure-trigger.tsx)                                                                                            | Expand/collapse actions.                                                                                              |
| [Dialog](../../src/renderer/components/ui/dialog.tsx), [Popover](../../src/renderer/components/ui/popover.tsx), [Tooltip](../../src/renderer/components/ui/tooltip.tsx) | Shared overlay behavior rather than feature-local substitutes.                                                        |
| [FatalErrorSurface](../../src/renderer/components/ui/fatal-error-surface.tsx)                                                                                           | Non-dismissible fatal diagnostics in Chromium's modal top layer, above ordinary portals and stacking contexts.        |
| [SearchableChoiceDialog](../../src/renderer/components/ui/searchable-choice-dialog.tsx)                                                                                 | Searchable destination/option picker; caller supplies filtering, selection policy, and optional shared row rendering. |
| [ContextActionMenu](../../src/renderer/components/ui/context-action-menu.tsx)                                                                                           | Client-backed device action menu.                                                                                     |
| [ExecutionChoice](../../src/renderer/components/ui/execution-choice.tsx)                                                                                                | One-shot workflow execution choice with script disclosure.                                                            |
| [Link](../../src/renderer/components/ui/link.tsx)                                                                                                                       | Shared anchors, source references and Cake links with destination tooltips.                                           |
| [LoadingState](../../src/renderer/components/ui/loading-state.tsx)                                                                                                      | Shared loading treatments.                                                                                            |

[`SearchInput`](../../src/renderer/components/ui/search-input.tsx) composes `Input` with a search icon, accessible clear action and Escape-to-clear. Callers own the query and filtering.

`StatusDot` exports `statusDotGapClassName` for the shared compact dot-to-label gap
used by disclosure, tool, subagent, reasoning and work-log rows.

`DisclosureTrigger` also supports leading disclosure triangles and wrapping titles
for source outlines. Keep context expansion state and lazy provenance reads in the
conversation's `ContextInspectorStore`, not in the shared control.

`SearchableChoiceDialog` composes [`SearchableChoiceInput`](../../src/renderer/components/ui/searchable-choice-input.tsx)
for local draft text and transition-scheduled filtering. Its choice callback must not
write reactive state. Results are paged in batches of 25; arrow-key navigation crosses
pages and all matches remain reachable. The optional `filters` slot composes shared controls.

`Textarea.focusAnchorRef` exposes a non-editable, programmatically focusable wrapper.
Focusing it positions native forward Tab at the textarea without activating dictation;
it does not add a tab stop or intercept normal Tab/Shift+Tab navigation.
After a manual chat send while dictation is unmuted, consecutive plain Enter presses
can steer, then stop-and-send that exact input without focusing the textarea.
`ChatStore` owns this transient continuation; the mounted chat routes DOM cancellation
on another key, pointer/wheel interaction, selection, focus departure, window blur,
or pane/session departure. Arrival focus and automatic voice sends do not arm it.
Admission identity, not text or queue position, links the receipt to the runtime queue.

[`ReadableData`](../../src/renderer/components/ui/readable-data.tsx) renders complete literal values as readable documents, ordered arrays and definition lists, with optional section disclosure and embedded raster-image previews. It never fetches remote image references or interprets strings as Markdown. Use it for literal attachment previews; syntax-highlighted source remains owned by AI Elements.

[`ActivityDisclosure`](../../src/renderer/components/ui/activity-disclosure.tsx) composes
Button and StatusDot into a compact pill or attached composer strip. Clicking the
bar or its chevron toggles a bounded, scrollable inline list of inspect/open rows;
Enter and Space toggle it, and Escape collapses it and returns focus to the trigger.
Per-row type icons retain accessible labels and tooltips, separate from status dots.
Conversation owners supply only currently running work and derive the summary/count
from those same rows, omitting the disclosure when none remain. Activity-only caps
join the composer without reserved vertical space.

[`ComposerCap`](../../src/renderer/components/ui/composer-cap.tsx) frames supporting
controls attached above the shared composer. Activity occupies its top band, with
worktree tools beneath it when present. Empty caps collapse without reserved space.

[`SessionResultNotice`](../../src/renderer/components/ui/session-result-notice.tsx) contains one title-and-chevron disclosure per application-delivered report or unique batch note, independently of model prose. Repeated exact reports are consolidated; `SessionUpdateEntry` reuses `InlineMessageSource` for lazy original access. Batch-only notes expand in place. Each attributed entry keeps its linked to-do row outside the disclosure so it remains visible when collapsed.

`ContextUsageButton` presents a compact context icon and estimated total/limit, with a subtle cache-freshness underline. It opens the shared Context Browser, which retains the full system, memory, messages and baseline accounting. The accessible description includes the breakdown; cache color never represents context health or retention.

## Navigation and layout

| Component                                                                                                                                    | Use for                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [NavItem](../../src/renderer/components/ui/nav-item.tsx)                                                                                     | Accessible navigation rows with labels, descriptions, badges and trailing controls.       |
| [NavigationHighlight](../../src/renderer/components/ui/navigation-highlight.tsx)                                                             | Decorative moving hover/selection backgrounds; keep navigation authority with the caller. |
| [AnimatedList](../../src/renderer/components/ui/animated-list.tsx)                                                                           | Position transitions for keyed lists.                                                     |
| [ReorderControls](../../src/renderer/components/ui/reorder-controls.tsx), [SortableItem](../../src/renderer/components/ui/sortable-item.tsx) | Keyboard controls and drag-and-drop wrappers for ordered items.                           |
| [Avatar](../../src/renderer/components/ui/avatar.tsx)                                                                                        | Shared project/session identity artwork.                                                  |
| [ThinkingBubble](../../src/renderer/components/ui/thinking-bubble.tsx), [StepProgress](../../src/renderer/components/ui/step-progress.tsx)   | Processing and stepped progress presentation.                                             |
| [ContentTransition](../../src/renderer/components/ui/content-transition.tsx)                                                                 | Visual handoff between changing content; not a navigation or loading owner.               |
| [SidePanel](../../src/renderer/components/ui/side-panel.tsx), [ResizeHandle](../../src/renderer/components/ui/resize-handle.tsx)             | Shared panel and resizing presentation.                                                   |
| [WorkspacePanelToggle](../../src/renderer/components/ui/workspace-panel-toggle.tsx)                                                          | Workspace sidebar/chat visibility controls.                                               |

[`ProjectChatHeaderLink`](../../src/renderer/components/project-chat-header-link.tsx) composes
`IconButton` and `Avatar` for header navigation to the owning registered Project's existing
Project Chat, shared by Project Sessions and Project Chat itself.

[`SessionListItem`](../../src/renderer/components/ui/session-list-item.tsx) is the authoritative
session row shared by the sidebar, screenshot destination picker, and session search: identity, labels,
family depth, worktree context, relative time and activity. Its shared
[SessionActivityTime](../../src/renderer/components/ui/session-activity-time.tsx) leaf shows time before
worktree context and ticks elapsed working time from the runtime-owned start, without rerendering
the list. Unknown starts show only Working. Callers own ordering and actions;
the sidebar opts into `revealWhenSelected` so a newly selected row scrolls into view if needed.
Its shared [`SessionActivityIndicator`](../../src/renderer/components/session-activity-indicator.tsx)
is also used by Project Chat entries: blue while running (including when selected), green for
unread completion, amber while waiting, red for errors, and no dot for idle/read or deliberately
stopped work. Selection and read acknowledgement do not introduce a neutral/gray dot.
[`FloatingToolbar`](../../src/renderer/components/ui/floating-toolbar.tsx) provides a
content-sized, draggable toolbar with viewport-clamped transient geometry and keyboard movement.
Only its actual footprint intercepts input on the underlying canvas.

[`ResizableSurface`](../../src/renderer/components/ui/resizable-surface.tsx) provides a
600px initial canvas with a discoverable pointer/keyboard resize grip (240–1200px).
Geometry is local to the mounted view, never artifact document data; fullscreen
restores the same inline height. Its expanded target uses atomic DOM moves to
preserve the live iframe browsing context rather than remounting an editor.

### Workspace and chat shell

[`WorkspaceChatLayout`](../../src/renderer/components/workspace-chat-layout.tsx)
composes the sidebar, primary workspace, authoritative Chat drawer and terminal dock.
Use it for immersive workspace modes rather than rebuilding layout/resize behavior.
Every conversation surface uses [`Chat`](../../src/renderer/components/chat.tsx)
and [`ChatStore`](../../src/renderer/stores/ChatStore.ts).

## Conversation and media

[`CopyButton`](../../src/renderer/components/ui/copy-button.tsx) copies text on demand with pending and success feedback and delegates errors to its owner. Linked-message views read the complete original across source pages without moving the displayed page.

[`CopyReferenceButton`](../../src/renderer/components/ui/copy-reference-button.tsx) copies an
exact attachment link with shared feedback. It never reads message bodies; the parent
supplies the addressable session identity. Original-message previews reuse `FullscreenSurface` with bounded source pages.
[`InlineMessageSource`](../../src/renderer/components/inline-message-source.tsx) composes
`MessageDisclosure` with a title-only header, shared Markdown and pagination for lazy
source access within every chat surface. Consolidated notifications, receipt-only
session cards and linked originals use this same viewer. Opening reads the exact
source on demand. The expanded header contains only its linked response/session title
and copy action, followed directly by the content. There is no separate collapsed
summary; loading, unavailable and
empty states appear inside the disclosure. The transcript scroll owner pauses
bottom-follow before expansion to preserve the response start.
It reuses `MessageReferencePreviewStore`;
only the exact reference persists in Pi, never the retrieved body. Expanding loads supported
Markdown images from any local path, resolving relative paths against the producer's
Working Directory (never the viewer's active project), and attachment images through the
producer's attachment context. Other attachments remain metadata;
inline Pi image blocks without vault references show an explicit source-reader limitation.
[`AttachmentReference`](../../src/renderer/components/ui/attachment-reference.tsx) presents
a metadata-only file/input link with the same copy affordance; previews fetch the
original through the session-authorized attachment boundary, never a backend path.
[`TranscriptImageAttachment`](../../src/renderer/components/transcript-image-attachment.tsx)
shows a user's image in one fixed frame whether it is pending, saved with pixels, or a
vaulted Cake Chat reference; the caption becomes the `AttachmentReference` once saved.
Vaulted pixels come from the conversation's renderer-only `TranscriptAttachmentImagesStore`:
a sent image hands its pixels to the saved reference, older ones load for display only.

[`SessionIdLink`](../../src/renderer/components/ui/session-id-link.tsx) displays a bare,
collision-aware session suffix while retaining the canonical UUID in its link and
destination tooltip. Use it for identity metadata where the session context is clear.

[`MessageDisclosure`](../../src/renderer/components/ui/message-disclosure.tsx) owns the shared incoming-message dropdown layout: leading chevron, wrapping title, quiet hover/focus treatment and bounded content area. Source readers, batch notes and worker assignment details use it rather than assembling their own layouts. Owners supply expansion state and lazy loading. Delivered inline messages start expanded so immediate prompts remain readable; exact originals remain lazy. To-do associations stay outside the collapsible area.

[`SessionMessage`](../../src/renderer/components/ui/session-message.tsx) presents
incoming session communication with lightweight attribution (source-session link
and status/metadata badges) inside the standard message outline, without a shaded
header, nested border, or transport-envelope UI.
Delivered messages use assistant-style Markdown and copy-only actions; exact
original references remain available through lazy `InlineMessageSource` disclosures.
Use recorded provenance;
do not infer the sender from message text. Missing source identity/title is
disclosed, not invented. Badges and bodies come from
[`crossSessionPresentation`](../../src/renderer/lib/cross-session-presentation.ts),
which reads Cake's own report/notice wording through the parser colocated with the
envelope format in `cross-session-message.ts`. System/reminder context remains `ContextPill`.

| Component                                                                                                                                                                                                                                 | Use for                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [AttachmentTile](../../src/renderer/components/ui/attachment-tile.tsx), [TextAttachment](../../src/renderer/components/ui/text-attachment.tsx)                                                                                            | Shared attachment labels, image thumbnails, removal and inspectable text previews.        |
| [ContextPill](../../src/renderer/components/ui/context-pill.tsx)                                                                                                                                                                          | Disclosure of exact system/reminder/extension context.                                    |
| [MarkdownTable](../../src/renderer/components/ui/markdown-table.tsx), [FullscreenButton](../../src/renderer/components/ui/fullscreen-button.tsx)                                                                                          | Parsed table presentation and shared fullscreen action.                                   |
| [ArtifactDisclosure](../../src/renderer/components/ui/artifact-disclosure.tsx)                                                                                                                                                            | Artifact expand/collapse and superseded-version badge; no fetching or persistence.        |
| [CaptureCanvas](../../src/renderer/components/ui/capture-canvas.tsx), [CaptureToolbar](../../src/renderer/components/ui/capture-toolbar.tsx), [CaptureDestinationPicker](../../src/renderer/components/ui/capture-destination-picker.tsx) | Screenshot gestures, editing controls and destination selection.                          |
| [DictationIndicator](../../src/renderer/components/ui/dictation-indicator.tsx), [VoiceMeter](../../src/renderer/components/ui/voice-meter.tsx)                                                                                            | Dictation status/action and decorative microphone-level presentation.                     |
| [TextareaProvisionalText](../../src/renderer/components/ui/textarea-provisional-text.tsx)                                                                                                                                                 | Decorative provisional text; the real textarea retains input and accessibility ownership. |
| [VoiceConversationControls](../../src/renderer/components/ui/voice-conversation-controls.tsx)                                                                                                                                             | Voice entry, input mute, countdown cancellation and exit presentation.                    |

`AttachmentTile` uses `imageSrc` for contained image thumbnails and opens originals
in the shared fullscreen preview; non-image attachments retain labels. Thumbnails
are renderer presentation only: Cake Chat still admits opaque input references,
not image payloads, to its model context.

`NavItem.associated` and `SessionListItem.associated` share a faint tinted, dashed-outline
relationship cue for the selected Project Chat or global Cake Chat to-do and its linked
sidebar sessions.
This is not navigation selection: active/selected rows keep their stronger treatment,
while association leaves action semantics, hover and keyboard focus intact. Subagent work links
use `cake://subagent/<encoded-parent>/<public-handle>` and the shared Markdown navigation to
open the existing worker chat/report under its parent. Private Pi IDs are never session links.
Subagent call rows use the same advisory cue; worker completion/release is not to-do resolution.

`NavItem.activateOnMouseDown` opens sidebar conversations on primary press and
ignores the following pointer click, while retaining native keyboard/assistive
activation and control-click semantics. `SessionListItem` forwards this opt-in;
search and destination pickers keep their default click activation. Nested row
controls remain independent siblings of the navigation button.

`NavItem.wholeRowAction` extends the primary action to non-interactive row content
and whitespace without nesting controls. It retains the native action button for
keyboard activation and focus, and supports `aria-pressed` selection and temporary
`aria-disabled` busy states that do not blur the action. Opt into
`selectableText` for readable rows such as to-dos: native text selection stays enabled,
and selection drags do not activate the row or nested controls; ordinary clicks and
keyboard activation remain independent.

Structured work/source links reuse `MarkdownLink` from
[`Markdown`](../../src/renderer/components/ai-elements/markdown.tsx), the same destination
handler as conversation prose (sessions/messages/attachments, artifact references,
web URLs and workspace source locations). `Link` remains the visual anchor primitive;
its `showIcon` option adds a decorative inline link affordance without changing prose
wrapping. Markdown text links and artifact references use it; linked images do not.
Destination tooltips appear on hover or keyboard focus and dismiss with Escape.

[`icons.tsx`](../../src/renderer/components/ui/icons.tsx) is the sole icon authority.
Inspect [`components/ai-elements/`](../../src/renderer/components/ai-elements/)
for existing conversation, Markdown, code, tool and source surfaces.
