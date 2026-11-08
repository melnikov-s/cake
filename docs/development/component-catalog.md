# Shared component catalog

Authoritative primitives live in [`src/renderer/components/ui/`](../../src/renderer/components/ui/).
Compose these before creating a new control. Props, styling, interaction details and
examples belong in their source, callers and focused tests—not a second API specification.
See `AGENTS.md` for renderer implementation rules.

[`WorkspaceHeader`](../../src/renderer/components/ui/workspace-header.tsx) keeps conversation, Browser and VS Code breadcrumbs and right-aligned workspace actions on shared rows. Its title row stays stable independently of the embedded editor's native title bar; narrow action rows scroll rather than wrap. The drop-down chat uses its compact variant.

## Controls and disclosure

[`ModelReferenceInput`](../../src/renderer/components/ui/model-reference-input.tsx) edits ordinary message text with atomic inline model references; it exposes the composer's text/selection API and reuses `ModelPicker` through its caller. [`ModelReferenceChip`](../../src/renderer/components/ui/model-reference-chip.tsx) is the noninteractive transcript equivalent. Both share compact chip styling; canonical text lives in `contracts/model-presets/model-reference.ts`, never separate draft metadata.

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
| [Link](../../src/renderer/components/ui/link.tsx)                                                                                                                       | Shared anchors, source references and Cake links with destination tooltips.                                           |
| [LoadingState](../../src/renderer/components/ui/loading-state.tsx)                                                                                                      | Shared loading treatments.                                                                                            |

`Input` with `type="checkbox"` preserves native selection semantics and sizing instead of text-field styling; provide an accessible label and controlled checked state.

[`RadioGroup`](../../src/renderer/components/ui/radio-group.tsx) presents a compact, labeled set of native radio inputs with every option visible. Use it for mutually exclusive form settings instead of a dropdown when there are only a few choices.

[ThemePreviewCard](../../src/renderer/components/ui/theme-preview-card.tsx) composes a selectable button with [ThemePreviewScene](../../src/renderer/components/ui/theme-preview-scene.tsx), a decorative miniature Cake window. Scoped light/dark variables, the shared color-data mapper, and the syntax worker keep neighboring previews independent of the active app theme. Appearance composes these cards into separate light/dark galleries: clicking a card immediately saves that slot, independent of the Light/Dark/System appearance mode. Gallery headings identify each saved theme and which slot is active; card checks indicate saved selections. The mode selector is a `SegmentedControl`, not a theme card.

[FilePicker](../../src/renderer/components/ui/file-picker.tsx) opens a native file or folder chooser and supplies only user-selected `File` data. It supports JSON/JSONC source sets for theme imports.

[`AnnotationColorPicker`](../../src/renderer/components/ui/annotation-color-picker.tsx) is a compact dot trigger and preset-dot popover for image annotations. Its explicit image colors are independent of Cake's theme; screenshot preferences own the selected value.

[`NumberedIconButton`](../../src/renderer/components/ui/numbered-icon-button.tsx) composes `IconButton` and `Badge` for toolbar counts. The opaque `card` bubble sits inside a minimum 32px target that grows for multi-digit counts. Zero is shown; an undefined count omits the bubble. Supply count meaning in the accessible label or description. `PopoverNumberedIconTrigger` supplies the same popover semantics and focus restoration as `PopoverIconTrigger`.

`PopoverContent` accepts `initialFocusSelector` to prefer an input over toolbar controls once an opening is visible, without refocusing on content updates. `dismissOnEscapeCapture` lets an explicit-dismissal popup handle Escape before an input consumes it.

[`ContextMenu`](../../src/renderer/components/ui/context-menu.tsx) composes `Popover` and `Button` for pointer/keyboard context actions, expandable submenus and in-place interactive panels.

[`Calendar`](../../src/renderer/components/ui/calendar.tsx) wraps React DayPicker with Cake buttons and theme tokens, following shadcn’s calendar approach. [`DateTimePicker`](../../src/renderer/components/ui/date-time-picker.tsx) combines it with separate local date/time inputs; callers own validation and conversion to an instant.

[`SearchInput`](../../src/renderer/components/ui/search-input.tsx) composes `Input` with a search icon, accessible clear action and Escape-to-clear. Callers own the query and filtering, and may pass input attributes such as combobox semantics and a key handler that runs after Escape-to-clear.

[`SearchableChoiceList`](../../src/renderer/components/ui/searchable-choice-list.tsx) is popover content for picking one item from a short list: a focused `SearchInput`, a scrollable listbox of two-line rows (title, muted description, leading icon aligned to the title line, check for the current choice), and an empty-state message. Arrow keys move the active row and Enter selects it while focus stays in the field; Escape clears the query, then reaches the popover's dismissal. Callers supply filtering through `choices(query)`. Use `SearchableChoiceDialog` for larger modal destination searches.

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
Focusing it parks focus without activating dictation and does not add a tab stop.
The window-owned plain Tab shortcut explicitly focuses the active chat input, or the
highest popup's input when open. An input-less popup retains focus within its surface.
Modified Tab, IME, and embedded editor/terminal keyboard ownership remain unchanged.
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

[`SessionResultNotice`](../../src/renderer/components/ui/session-result-notice.tsx) contains one `SessionMessage` card per application-delivered report or unique batch note, independently of model prose. Repeated exact reports are consolidated; `SessionUpdateEntry` passes the exact original to the card for lazy access. Batch-only notes expand in place.

`ContextUsageButton` presents a compact context icon and estimated total/limit, with a subtle cache-freshness underline. With an inspection action it opens the shared Context Browser, which retains the full system, memory, messages and baseline accounting. Without that action (side chats), it is a read-only indicator of active context against the current model window. The accessible description includes a breakdown only when supplied; unavailable metrics stay unavailable. Cache color never represents context health or retention. Composer context badges respond to their named `context-composer` container, not the viewport: full token counts at 40rem and above, icon and percentage from 28rem, and a 28px icon-only outline below that. Exact counts remain in the accessible description and hover/focus tooltip; inspection actions remain available at every size.

[`QrCode`](../../src/renderer/components/ui/qr-code.tsx) renders locally encoded QR images without sending their contents to an external service.

[`ChangeStats`](../../src/renderer/components/ui/change-stats.tsx) displays compact Git additions/deletions and explicitly identifies binary files without inventing line counts.

## Navigation and layout

[`NavigationRail`](../../src/renderer/components/ui/navigation-rail.tsx) reveals project/action labels as an overlay on hover or focus-within, with a touch-only focus affordance and independently scrolling sections. `IconButton.label` supplies visible labels for the rail, including existing popover triggers. The transient `ProjectRailStore` reserves the overlay edge in native editor/browser bounds without moving the conversation layout.

| Component                                                                                                                                    | Use for                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [NavItem](../../src/renderer/components/ui/nav-item.tsx)                                                                                     | Accessible navigation rows with labels, descriptions, badges and trailing controls.       |
| [NavigationHighlight](../../src/renderer/components/ui/navigation-highlight.tsx)                                                             | Decorative moving hover/selection backgrounds; keep navigation authority with the caller. |
| [AnimatedList](../../src/renderer/components/ui/animated-list.tsx)                                                                           | Keyed reorders and arrivals; grouped rows and inert removal fades are opt-in.             |
| [ReorderControls](../../src/renderer/components/ui/reorder-controls.tsx), [SortableItem](../../src/renderer/components/ui/sortable-item.tsx) | Keyboard controls and drag-and-drop wrappers for ordered items.                           |
| [Avatar](../../src/renderer/components/ui/avatar.tsx)                                                                                        | Shared project/session identity artwork.                                                  |
| [ThinkingBubble](../../src/renderer/components/ui/thinking-bubble.tsx), [StepProgress](../../src/renderer/components/ui/step-progress.tsx)   | Processing and stepped progress presentation.                                             |
| [ContentTransition](../../src/renderer/components/ui/content-transition.tsx)                                                                 | Visual handoff between changing content; not a navigation or loading owner.               |
| [SidePanel](../../src/renderer/components/ui/side-panel.tsx), [ResizeHandle](../../src/renderer/components/ui/resize-handle.tsx)             | Shared panel (including compact chat headers) and resizing presentation.                  |
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
[`ActivityCount`](../../src/renderer/components/ui/activity-count.tsx) pairs an activity glyph
with a running count (muted at zero), or a green status dot with an unread count (hidden
at zero). Both cap visually at `99+`, retaining exact accessible labels and tooltips.
The Workspace Sessions tab uses the existing reactive active navigation tree's `running`
and `unread` counts: Project Chat and unresolved Project Sessions in the selected project,
or only Cake Chat without a project. Private side chats and subagents remain in their
owner's menu, outside these counts. Search, collapsed branches and pagination do not
narrow the counts; resolved history is excluded. Each session ID counts once per status;
canonical own unread is independent of running/outcome display precedence and never
inherited by a parent. Inherited working does not make an idle parent count again.
The tab tooltip gives exact running, unread and total counts. No new observations,
polling or transcript/history reads are introduced.

Workspace mode controls use borderless `IconButton`s with a subtle selected fill; a single hairline separates the Terminal action from the three modes.

[`FloatingToolbar`](../../src/renderer/components/ui/floating-toolbar.tsx) provides a
content-sized, draggable toolbar with viewport-clamped transient geometry and keyboard movement.
Only its actual footprint intercepts input on the underlying canvas.

[`ResizableSurface`](../../src/renderer/components/ui/resizable-surface.tsx) provides a
600px initial canvas with a discoverable pointer/keyboard resize grip (240–1200px).
Geometry is local to the mounted view, never artifact document data; fullscreen
restores the same inline height. Its expanded target uses atomic DOM moves to
preserve the live iframe browsing context rather than remounting an editor. Its
`fill` mode fills a shared accessory pane without adding an inline height or resize
grip; the owning pane supplies resizing and chrome.

[`AccessoryPanelLayout`](../../src/renderer/components/ui/accessory-panel-layout.tsx) owns the responsive, resizable right-hand accessory slot. All accessories, including Changes, sit beside the conversation when the surface is at least 860px wide and replace it on narrower surfaces. Closing the accessory restores the conversation.

### Workspace and chat shell

[`AppShellLayout`](../../src/renderer/components/app-shell-layout.tsx) owns the persistent
project/global rail and exclusive To-dos/Sessions Workspace accessory across conversation
and native tool modes. [`ConversationBreadcrumb`](../../src/renderer/components/conversation-breadcrumb.tsx)
shows clickable public ownership lineage and the registered route home.
[`WorkspaceChatLayout`](../../src/renderer/components/workspace-chat-layout.tsx) composes
the primary tool workspace and optional authoritative Chat companion for that same focused
conversation. Use it inside the shared shell rather than rebuilding layout/resize behavior.
Every conversation surface uses [`Chat`](../../src/renderer/components/chat.tsx)
and [`ChatStore`](../../src/renderer/stores/ChatStore.ts).
Permanent Project Chat and global Cake Chat opt into a shared `IconButton` reply action
beside message copy: it appends a readable persisted-entry reference to the existing draft
and focuses its new final line. Regular Project Sessions and nested chats do not opt in.

## Conversation and media

[`ChatComposer`](../../src/renderer/components/chat-composer.tsx) owns the shared
composer frame. Its inline variant is used by both quick session-assistant prompts
and annotation comments: the same dictation slot, expanding `ComposerInput`, and
[`ComposerSubmitButton`](../../src/renderer/components/ui/composer-submit-button.tsx)
keep voice, text and submit on one centerline. Consumers own labels, draft state,
submission and dismissal; do not recreate the compact form in a popup.

[`CopyButton`](../../src/renderer/components/ui/copy-button.tsx) copies text or runs an explicit clipboard action on demand with pending and success feedback and delegates errors to its owner. Linked-message views read the complete original across source pages without moving the displayed page.

[`CopyReferenceButton`](../../src/renderer/components/ui/copy-reference-button.tsx) copies an
exact attachment link with shared feedback. It never reads message bodies; the parent
supplies the addressable session identity. Original-message previews reuse `FullscreenSurface` with bounded source pages.
[`MessageSourceBody`](../../src/renderer/components/message-source-body.tsx) renders an
exact original with shared Markdown and pagination inside a `SessionMessage` card.
Consolidated notifications, receipt-only session cards and linked originals use this
same viewer; the card owns the linked title, expansion and copy action.
A delivered message that has its own text shows the original behind a nested
`OriginalResponse` disclosure instead. Opening reads the exact source on demand;
loading, unavailable and empty states appear in the body. The transcript scroll owner
pauses bottom-follow before expansion to preserve the response start.
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
The caption’s chevron collapses/expands pixels with native keyboard activation; transcript-local disclosure survives task folding and virtualization. Attachments before a user body follow that body’s to-do section, including unresolved turns. Composer tiles are unchanged.
Vaulted pixels come from the conversation's renderer-only `TranscriptAttachmentImagesStore`:
a sent image hands its pixels to the saved reference, older ones load for display only.

[`SessionIdLink`](../../src/renderer/components/ui/session-id-link.tsx) displays a bare,
collision-aware session suffix while retaining the canonical UUID in its link and
destination tooltip. Use it for identity metadata where the session context is clear.

[`Message`](../../src/renderer/components/ai-elements/message.tsx) owns the shared
message frame, hover/focus action row below the content, and top-right fullscreen
control. Ordinary assistant replies and incoming linked responses reuse this chrome.

[`OriginalHistoryGroup`](../../src/renderer/components/original-history-group.tsx) folds
Pi-owned inherited originals under **Original history**, separately from new side-chat
dialogue, using the shared disclosure control. The durable composer’s **Send to side chat**
icon creates a fresh fork of the main conversation, including when invoked from a side chat;
ordinary Send keeps its existing destination.

[`SessionMessage`](../../src/renderer/components/session-message.tsx) specializes that
assistant-message frame for every message from another session (replies, requests, notices, worker reports, batch notes
and exact originals) as one summary row: chevron, the sender's title (shown once, never
repeated in the body), status badges, a one-line preview while collapsed, and an
icon-only Done checkbox per linked to-do whose tooltip names the to-do. Expanding shows
the whole message with no height cap or nested scroller, then a footer with the linked
to-do titles. The sender's title links to the exact original when available, otherwise
the source conversation; title navigation is independent of disclosure.
Delivered inline messages start expanded so immediate prompts
remain readable; exact originals start collapsed and load lazily. Done checkboxes stay
in the row, so associations remain visible when collapsed. The shared top-right fullscreen
control opens the same content in `FullscreenSurface` with a scrolling reader. Exact references
load all source pages in an independent reader, preserving the inline disclosure and
current page when fullscreen closes. Markdown, images, source links and to-do actions
remain available in fullscreen.
Delivered messages use assistant-style Markdown and copy-only actions.
Use recorded provenance;
do not infer the sender from message text. A missing source title reads "Untitled
session" and missing identity "Source session unavailable", never an invented name. Badges and bodies come from
[`crossSessionPresentation`](../../src/renderer/lib/cross-session-presentation.ts),
which reads Cake's own report/notice wording through the parser colocated with the
envelope format in `cross-session-message.ts`. System/reminder context remains `ContextPill`.

| Component                                                                                                                                                                                                          | Use for                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AttachmentTile](../../src/renderer/components/ui/attachment-tile.tsx), [TextAttachment](../../src/renderer/components/ui/text-attachment.tsx)                                                                     | Shared attachment labels, image thumbnails, removal and inspectable text previews.                                                                                                                                                                                                                                                                                                                        |
| [ContextPill](../../src/renderer/components/ui/context-pill.tsx)                                                                                                                                                   | Disclosure of exact system/reminder/extension context.                                                                                                                                                                                                                                                                                                                                                    |
| [MarkdownTable](../../src/renderer/components/ui/markdown-table.tsx), [FullscreenButton](../../src/renderer/components/ui/fullscreen-button.tsx)                                                                   | Parsed table presentation and shared fullscreen action.                                                                                                                                                                                                                                                                                                                                                   |
| [ArtifactDisclosure](../../src/renderer/components/ui/artifact-disclosure.tsx)                                                                                                                                     | Artifact expand/collapse and superseded-version badge; no fetching or persistence.                                                                                                                                                                                                                                                                                                                        |
| [CaptureCanvas](../../src/renderer/components/ui/capture-canvas.tsx), [CaptureBounds](../../src/renderer/components/ui/capture-bounds.tsx), [CaptureToolbar](../../src/renderer/components/ui/capture-toolbar.tsx) | Screenshot crop/arrow/freehand gestures, editable numbered markers and image-plus-text copy. Hold Enter previews automatic bounds; the shared CaptureBounds surface moves/resizes them before release captures. First-screen destination selection uses [CaptureDestinationPicker](../../src/renderer/components/capture-destination-picker.tsx), shared sidebar rows and its own capture-lifetime Store. |
| [DictationIndicator](../../src/renderer/components/ui/dictation-indicator.tsx), [VoiceMeter](../../src/renderer/components/ui/voice-meter.tsx)                                                                     | Dictation status/action and decorative microphone-level presentation.                                                                                                                                                                                                                                                                                                                                     |
| [TextareaProvisionalText](../../src/renderer/components/ui/textarea-provisional-text.tsx)                                                                                                                          | Decorative provisional text; the real textarea retains input and accessibility ownership.                                                                                                                                                                                                                                                                                                                 |
| [VoiceConversationControls](../../src/renderer/components/ui/voice-conversation-controls.tsx)                                                                                                                      | Voice entry, input mute, countdown cancellation and exit presentation.                                                                                                                                                                                                                                                                                                                                    |

`AttachmentTile` uses `imageSrc` for contained image thumbnails and opens originals
in the shared fullscreen preview; non-image attachments retain labels. Thumbnails
are renderer presentation only: Cake Chat still admits opaque input references,
not image payloads, to its model context.

[`MarginRail`](../../src/renderer/components/ui/margin-rail.tsx) renders an unbordered task heading above its messages at every width, outdented up to 6rem from the centered message column, bounded by the transcript's safe left inset. The continuation rule begins below the complete title heading, including wrapped text, and task switches leave a gap in the rule. Rich artifact/widget rows break the rule, not the heading. Each heading has sibling keyboard-operable actions: the content-sized title opens the existing To-do pane without selecting next-message context or folding the conversation; the focus action focuses that to-do and reveals its latest transcript message; the remaining space and far-right chevron toggle its contiguous stretch, with `aria-expanded`. Focus is view-only, never composer context. The leading done/open status is read-only.

[`SelectionBar`](../../src/renderer/components/ui/selection-bar.tsx) shows a caller-provided label, compact truncating selection context and an accessible clear action beneath a surface header, outside its scrolling content.

`NavItem.associated` and `SessionListItem.associated` share a faint tinted, dashed-outline
relationship cue for inspected to-dos and linked sidebar sessions.
`NavItem.viewFocused` and `IconButton.viewFocused` share a stronger accent ring and tint
for persistent task view focus. The to-do row and toolbar button use it independently of
pane visibility, keyboard focus, needs-attention and navigation selection; the entire
numbered toolbar button receives the treatment. Clearing view focus removes it.
Association leaves action semantics, hover and keyboard focus intact. Subagent work links
use `cake://subagent/<encoded-parent>/<public-handle>` and the shared Markdown navigation to
open the existing worker chat/report under its parent. Private Pi IDs are never session links.
Subagent call rows use the same advisory cue; worker completion/release is not to-do resolution.

`NavItem.activateOnMouseDown` opens sidebar conversations on primary press and
ignores the following pointer click, while retaining native keyboard/assistive
activation and control-click semantics. `SessionListItem` forwards this opt-in;
search and destination pickers keep their default click activation. Nested row
controls remain independent siblings of the navigation button. `NavItem.labelAction`
places a control immediately after the label rather than at the row's trailing edge,
without nesting it inside the primary button.

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

[`IconIndicator`](../../src/renderer/components/ui/icon-indicator.tsx) displays a read-only icon in the same square slot as `IconButton`, with an accessible image label and native tooltip, without button semantics.

[`icons.tsx`](../../src/renderer/components/ui/icons.tsx) is the sole icon authority.
Inspect [`components/ai-elements/`](../../src/renderer/components/ai-elements/)
for existing conversation, Markdown, code, tool and source surfaces.
