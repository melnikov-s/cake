# Shared component catalog

Authoritative primitives live in [`src/renderer/components/ui/`](../../src/renderer/components/ui/).
Compose these before creating a new control. Props, styling, interaction details and
examples belong in their source, callers and focused tests—not a second API specification.
See `AGENTS.md` for renderer implementation rules.

## Controls and disclosure

| Component                                                                                                                                                               | Use for                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Button](../../src/renderer/components/ui/button.tsx), [IconButton](../../src/renderer/components/ui/icon-button.tsx)                                                   | Labeled and icon-only actions; icon-only actions need an accessible name and tooltip.          |
| [Input](../../src/renderer/components/ui/input.tsx), [Textarea](../../src/renderer/components/ui/textarea.tsx), [Select](../../src/renderer/components/ui/select.tsx)   | Text and choice inputs; opt prose Textareas into dictation, not paths or configuration syntax. |
| [Switch](../../src/renderer/components/ui/switch.tsx), [SegmentedControl](../../src/renderer/components/ui/segmented-control.tsx)                                       | Boolean settings and mutually exclusive choices.                                               |
| [Slider](../../src/renderer/components/ui/slider.tsx), [SettingSlider](../../src/renderer/components/ui/setting-slider.tsx)                                             | Range input, optionally composed with label, value, scope and explanation.                     |
| [Chip](../../src/renderer/components/ui/chip.tsx), [DismissibleChip](../../src/renderer/components/ui/dismissible-chip.tsx)                                             | Compact actions; independent primary and removal actions without nested buttons.               |
| [Badge](../../src/renderer/components/ui/badge.tsx), [Callout](../../src/renderer/components/ui/callout.tsx)                                                            | Status and explanatory feedback.                                                               |
| [DisclosureTrigger](../../src/renderer/components/ui/disclosure-trigger.tsx)                                                                                            | Expand/collapse actions.                                                                       |
| [Dialog](../../src/renderer/components/ui/dialog.tsx), [Popover](../../src/renderer/components/ui/popover.tsx), [Tooltip](../../src/renderer/components/ui/tooltip.tsx) | Shared overlay behavior rather than feature-local substitutes.                                 |
| [SearchableChoiceDialog](../../src/renderer/components/ui/searchable-choice-dialog.tsx)                                                                                 | Searchable destination/option picker; caller supplies filtering and selection policy.          |
| [ContextActionMenu](../../src/renderer/components/ui/context-action-menu.tsx)                                                                                           | Client-backed device action menu.                                                              |
| [ExecutionChoice](../../src/renderer/components/ui/execution-choice.tsx)                                                                                                | One-shot workflow execution choice with script disclosure.                                     |
| [Link](../../src/renderer/components/ui/link.tsx)                                                                                                                       | Shared anchors, source references and Cake links with destination tooltips.                    |
| [LoadingState](../../src/renderer/components/ui/loading-state.tsx)                                                                                                      | Shared loading treatments.                                                                     |

`Textarea.focusAnchorRef` exposes a non-editable, programmatically focusable wrapper.
Focusing it positions native forward Tab at the textarea without activating dictation;
it does not add a tab stop or intercept normal Tab/Shift+Tab navigation.
After a manual chat send while dictation is unmuted, consecutive plain Enter presses
can steer, then stop-and-send that exact input without focusing the textarea.
`ChatStore` owns this transient continuation; the mounted chat routes DOM cancellation
on another key, pointer/wheel interaction, selection, focus departure, window blur,
or pane/session departure. Arrival focus and automatic voice sends do not arm it.
Admission identity, not text or queue position, links the receipt to the runtime queue.

[`ReadableData`](../../src/renderer/components/ui/readable-data.tsx) renders complete literal values as readable documents, ordered arrays and definition lists, with optional section disclosure and embedded raster-image previews. It never fetches remote image references or interprets strings as Markdown. Use it for reading captured context; copy operations retain the original serialized body, and syntax-highlighted source remains owned by AI Elements.

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

[`SessionListItem`](../../src/renderer/components/ui/session-list-item.tsx) is the authoritative
session row shared by the sidebar and screenshot destination picker: identity, labels,
family depth, worktree context, relative time and activity. Callers own ordering and actions.
[`FloatingToolbar`](../../src/renderer/components/ui/floating-toolbar.tsx) provides a
content-sized, draggable toolbar with viewport-clamped transient geometry and keyboard movement.
Only its actual footprint intercepts input on the underlying canvas.

### Workspace and chat shell

[`WorkspaceChatLayout`](../../src/renderer/components/workspace-chat-layout.tsx)
composes the sidebar, primary workspace, authoritative Chat drawer and terminal dock.
Use it for immersive workspace modes rather than rebuilding layout/resize behavior.
Every conversation surface uses [`Chat`](../../src/renderer/components/chat.tsx)
and [`ChatStore`](../../src/renderer/stores/ChatStore.ts).

## Conversation and media

[`SessionMessage`](../../src/renderer/components/ui/session-message.tsx) presents
incoming session communication as an expanded card with an explicit attribution
header and a source-session link. Use recorded provenance; do not infer the sender
from message text. Missing source identity/title is disclosed, not invented.
System/reminder context remains `ContextPill`.

| Component                                                                                                                                                                                                                                 | Use for                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [AttachmentTile](../../src/renderer/components/ui/attachment-tile.tsx), [TextAttachment](../../src/renderer/components/ui/text-attachment.tsx)                                                                                            | Shared attachment labels, image thumbnails, removal and inspectable text previews.        |
| [ContextPill](../../src/renderer/components/ui/context-pill.tsx)                                                                                                                                                                          | Disclosure of exact system/reminder/extension context.                                    |
| [MarkdownTable](../../src/renderer/components/ui/markdown-table.tsx), [FullscreenButton](../../src/renderer/components/ui/fullscreen-button.tsx)                                                                                          | Parsed table presentation and shared fullscreen action.                                   |
| [ArtifactDisclosure](../../src/renderer/components/ui/artifact-disclosure.tsx)                                                                                                                                                            | Artifact expand/collapse presentation without owning fetching or persistence.             |
| [CaptureCanvas](../../src/renderer/components/ui/capture-canvas.tsx), [CaptureToolbar](../../src/renderer/components/ui/capture-toolbar.tsx), [CaptureDestinationPicker](../../src/renderer/components/ui/capture-destination-picker.tsx) | Screenshot gestures, editing controls and destination selection.                          |
| [DictationIndicator](../../src/renderer/components/ui/dictation-indicator.tsx), [VoiceMeter](../../src/renderer/components/ui/voice-meter.tsx)                                                                                            | Dictation status/action and decorative microphone-level presentation.                     |
| [TextareaProvisionalText](../../src/renderer/components/ui/textarea-provisional-text.tsx)                                                                                                                                                 | Decorative provisional text; the real textarea retains input and accessibility ownership. |
| [VoiceConversationControls](../../src/renderer/components/ui/voice-conversation-controls.tsx)                                                                                                                                             | Voice entry, input mute, countdown cancellation and exit presentation.                    |

`AttachmentTile` uses `imageSrc` for contained image thumbnails and opens originals
in the shared fullscreen preview; non-image attachments retain labels. Thumbnails
are renderer presentation only: Cake Chat still admits opaque input references,
not image payloads, to its model context.

[`icons.tsx`](../../src/renderer/components/ui/icons.tsx) is the sole icon authority.
Inspect [`components/ai-elements/`](../../src/renderer/components/ai-elements/)
for existing conversation, Markdown, code, tool and source surfaces.
