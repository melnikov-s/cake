# Navigation component catalog

Authoritative primitives live in `src/renderer/components/ui/`.

| Component             | Responsibility                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NavItem`             | Accessible row action, label, description, badges, and trailing controls. Opt-in `motionFeedback` gives titles a springy hover/selection offset and press response. |
| `NavigationHighlight` | Shared moving selection and hover backgrounds across descendant navigation rows, including separate groups.                                                         |
| `AnimatedList`        | Position transitions when keyed list items reorder; composes with `NavigationHighlight`.                                                                            |
| `SortableItem`        | Native drag-and-drop wrapper for persistently ordered navigation items.                                                                                             |
| `Avatar`              | Deterministic project/session artwork and opt-in disposable avatar interactions.                                                                                    |
| `ThinkingBubble`      | Compact, reduced-motion-safe conversational processing indicator.                                                                                                   |

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
VS Code and Cake Draw supply their own workspace and chat header content rather
than rebuilding resize behavior or a parallel conversation surface.

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
